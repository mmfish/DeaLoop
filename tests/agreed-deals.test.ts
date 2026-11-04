import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SQLiteDatabase} from '../runtime/sqlite.ts';
import {createSession} from '../backend/auth.ts';
import {handleApi} from '../backend/service.ts';
import {Negotiations} from '../backend/negotiation.ts';

test('agreed deals are private, role-filtered frozen agreements separate from the offer inbox',async()=>{
 const sqlite=new SQLiteDatabase(':memory:');sqlite.migrate('drizzle');const db=sqlite.asD1(),origin='https://dealoop.example',repo=new Negotiations(db);
 const session=async(name:string)=>createSession(new Request(origin),db,{uid:name,email:name+'@example.test',emailVerified:true,name,provider:'google.com'},false);
 try{
  const buyer=await session('Buyer'),seller=await session('Seller'),outsider=await session('Outsider');
  const call=async(who:typeof buyer,path:string,body:unknown)=>{
   const r=await handleApi(new Request(origin+'/api/v1'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:'thread_session='+who.token,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(body)}),{DB:db});
   assert.ok(r.ok,await r.clone().text());return await r.json() as any;
  };
  const terms={price:145.75,item:'City bicycle with lights',condition:'Good',delivery:'local_pickup',terms:'Includes lights and lock. Pickup Saturday at the library.',expires_at:new Date(Date.now()+3600000).toISOString()};
  const make=async(type:'wanted'|'for_sale',owner:typeof buyer,responder:typeof buyer)=>{
   const {post}=await call(owner,'/posts',{type,title:'A city bicycle',description:'A used bicycle for city errands.',category:'Bicycles',price:200,condition:'Good',location:'Oakland',delivery:'local_pickup'});
   const {offer}=await call(responder,'/posts/'+post.id+'/offers',terms);
   return {post,offer};
  };
  const wanted=await make('wanted',buyer,seller);
  const agreed=await call(buyer,'/offers/'+wanted.offer.id+'/accept',{expected_revision:1});
  const sale=await make('for_sale',seller,buyer);
  await call(seller,'/offers/'+sale.offer.id+'/accept',{expected_revision:1});
  assert.equal((await repo.agreements(buyer.ownerId,'buying')).length,2);
  assert.equal((await repo.agreements(seller.ownerId,'selling')).length,2);
  assert.deepEqual(await repo.agreements(buyer.ownerId,'selling'),[]);
  assert.deepEqual(await repo.agreements(seller.ownerId,'buying'),[]);
  assert.deepEqual(await repo.agreements(outsider.ownerId),[]);
  assert.deepEqual(await repo.agreements(outsider.ownerId,'all',wanted.post.id),[]);
  assert.equal((await repo.agreements(buyer.ownerId,'all',wanted.post.id))[0].id,agreed.deal.id);
  await assert.rejects(()=>repo.detail(wanted.offer.id,outsider.ownerId));
  // Even a changed source offer cannot rewrite the saved agreement terms.
  await db.prepare('UPDATE offers SET price=99999,terms=? WHERE id=?').bind('Changed proposal',wanted.offer.id).run();
  const frozen=(await repo.agreements(buyer.ownerId,'buying',wanted.post.id))[0];
  assert.equal(frozen.terms.price,145.75);assert.equal(frozen.terms.terms,terms.terms);
  assert.equal((await repo.detail(wanted.offer.id,buyer.ownerId)).deal?.terms.price,145.75);
  // API default still includes accepted offers; the human inbox excludes them.
  assert.equal((await repo.list(buyer.ownerId)).length,2);
  assert.deepEqual(await repo.list(buyer.ownerId,undefined,'inbox'),[]);
  const active=await make('wanted',buyer,seller),expired=await make('wanted',buyer,seller);
  await db.prepare('UPDATE offers SET expires_at=? WHERE id=?').bind(Date.now()-1,expired.offer.id).run();
  assert.deepEqual((await repo.list(buyer.ownerId,undefined,'open')).map(o=>o.id),[active.offer.id]);
  assert.deepEqual((await repo.list(buyer.ownerId,undefined,'history')).map(o=>o.id),[expired.offer.id]);
  // A long run of newer negotiations must not hide older agreements or history.
  for(let i=0;i<1005;i++)await db.prepare("INSERT INTO offers(id,post_id,post_owner_id,offerer_id,status,revision,price,item,condition,delivery,terms,expires_at,proposed_by,created_at,updated_at) SELECT ?,post_id,post_owner_id,offerer_id,status,revision,price,item,condition,delivery,terms,expires_at,proposed_by,created_at,? FROM offers WHERE id=?").bind('new-offer-'+i,Date.now()+i,active.offer.id).run();
  assert.equal((await repo.list(buyer.ownerId,undefined,'inbox')).length,1000);
  assert.deepEqual((await repo.list(buyer.ownerId,undefined,'history')).map(o=>o.id),[expired.offer.id]);
  assert.equal((await repo.agreements(buyer.ownerId)).length,2);
  // Role and post filters also apply before the agreement result limit.
  for(let i=0;i<1005;i++){
   const id='fixture-post-'+i;
   await db.prepare("INSERT INTO posts(id,owner_id,type,title,description,category,price,condition,location,delivery,status,demo,created_at,actor,idempotency_key,request_hash) SELECT ?,owner_id,type,title,description,category,price,condition,location,delivery,status,demo,created_at,actor,?,request_hash FROM posts WHERE id=?").bind(id,id,wanted.post.id).run();
   await db.prepare("INSERT INTO offers(id,post_id,post_owner_id,offerer_id,status,revision,price,item,condition,delivery,terms,expires_at,proposed_by,created_at,updated_at) SELECT ?,?,post_owner_id,offerer_id,status,revision,price,item,condition,delivery,terms,expires_at,proposed_by,created_at,updated_at FROM offers WHERE id=?").bind(id,id,wanted.offer.id).run();
   await db.prepare('INSERT INTO deals(id,post_id,offer_id,revision,buyer_id,seller_id,terms_json,accepted_by,created_at) SELECT ?,?,?,revision,seller_id,buyer_id,terms_json,accepted_by,? FROM deals WHERE id=?').bind(id,id,id,Date.now()+i,agreed.deal.id).run();
  }
  assert.equal((await repo.agreements(buyer.ownerId)).length,1000);
  assert.equal((await repo.agreements(buyer.ownerId,'buying')).length,2);
  assert.equal((await repo.agreements(buyer.ownerId,'all',wanted.post.id)).length,1);
 }finally{sqlite.close();}
});
