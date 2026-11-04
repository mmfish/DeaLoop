import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SQLiteDatabase} from '../runtime/sqlite.ts';
import {createSession} from '../backend/auth.ts';
import {handleApi} from '../backend/service.ts';
import {Negotiations} from '../backend/negotiation.ts';

test('pending decisions follow persisted lifecycle and protect final selection',async()=>{
 const sqlite=new SQLiteDatabase(':memory:');sqlite.migrate('drizzle');const db=sqlite.asD1(),repo=new Negotiations(db),origin='https://dealoop.example';
 const session=async(name:string)=>createSession(new Request(origin),db,{uid:name,email:name+'@example.test',emailVerified:true,name,provider:'google.com'},false);
 try{
  const owner=await session('Owner'),buyer=await session('Buyer'),other=await session('Other');
  const request=async(who:typeof owner|undefined,path:string,body?:unknown)=>handleApi(new Request(origin+'/api/v1'+path,{method:body?'POST':'GET',headers:{Origin:origin,...(who?{Cookie:'thread_session='+who.token}:{}),'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},...(body?{body:JSON.stringify(body)}:{})}),{DB:db});
  const call=async(who:typeof owner,path:string,body?:unknown)=>{const r=await request(who,path,body);assert.ok(r.ok,await r.clone().text());return await r.json() as any;};
  const terms={price:900,item:'Demo laptop',condition:'Good',delivery:'local_pickup',terms:'Charger included; wiped before pickup.',expires_at:new Date(Date.now()+3600000).toISOString()};
  const {post}=await call(owner,'/posts',{type:'for_sale',title:'Demo laptop',description:'Used laptop with charger.',category:'Electronics',price:1000,condition:'Good',location:'San Jose',delivery:'local_pickup'});
  const {offer}=await call(buyer,'/posts/'+post.id+'/offers',terms),path='/offers/'+offer.id;
  assert.equal((await repo.pendingDecisions(owner.ownerId)).count,1);
  assert.equal((await repo.pendingDecisions(buyer.ownerId)).count,0);
  assert.equal((await repo.pendingDecisions(other.ownerId)).count,0);
  assert.equal((await request(undefined,'/offers?view=pending')).status,401);
  assert.deepEqual((await call(other,'/offers?view=pending')).offers,[]);
  let api=await call(owner,'/offers?view=pending');assert.equal(api.pending_decisions.count,1);assert.equal(api.offers[0].pending_decision,true);
  await call(owner,path+'/revise',{...terms,price:950,expected_revision:1});
  assert.equal((await repo.pendingDecisions(owner.ownerId)).count,0);
  await call(buyer,path+'/confirm',{expected_revision:2});
  assert.equal((await repo.pendingDecisions(owner.ownerId)).count,1);
  await call(owner,path+'/revise',{...terms,expected_revision:2});
  assert.equal((await repo.pendingDecisions(owner.ownerId)).count,0);
  assert.equal((await request(owner,path+'/accept',{expected_revision:2})).status,409);
  await call(buyer,path+'/confirm',{expected_revision:3});
  assert.equal((await request(buyer,path+'/accept',{expected_revision:3})).status,403);
  const competitor=(await call(other,'/posts/'+post.id+'/offers',terms)).offer;
  assert.equal((await repo.pendingDecisions(owner.ownerId)).count,2);
  await call(other,'/offers/'+competitor.id+'/withdraw',{expected_revision:1});
  assert.equal((await repo.pendingDecisions(owner.ownerId)).count,1);
  const declined=(await call(other,'/posts/'+post.id+'/offers',terms)).offer;
  await call(owner,'/offers/'+declined.id+'/decline',{expected_revision:1});
  assert.equal((await repo.pendingDecisions(owner.ownerId)).count,1);
  await db.prepare('UPDATE offers SET expires_at=? WHERE id=?').bind(Date.now()-1,offer.id).run();
  assert.equal((await repo.pendingDecisions(owner.ownerId)).count,0);
  assert.equal((await request(owner,path+'/accept',{expected_revision:3})).status,409);
  await db.prepare('UPDATE offers SET expires_at=? WHERE id=?').bind(Date.now()+3600000,offer.id).run();
  await db.prepare("UPDATE posts SET status='archived' WHERE id=?").bind(post.id).run();
  assert.equal((await repo.pendingDecisions(owner.ownerId)).count,0);
  assert.equal((await repo.detail(offer.id,owner.ownerId)).offer.can_accept,false);
  await db.prepare("UPDATE posts SET status='active' WHERE id=?").bind(post.id).run();
  // SQL filtering/counting precedes the 1000-row display limit.
  for(let i=0;i<1005;i++)await db.prepare("INSERT INTO offers(id,post_id,post_owner_id,offerer_id,status,revision,price,item,condition,delivery,terms,expires_at,proposed_by,created_at,updated_at) SELECT ?,post_id,post_owner_id,offerer_id,status,revision,price,item,condition,delivery,terms,?,offerer_id,created_at,? FROM offers WHERE id=?").bind('fixture-'+i,Date.now()+7200000+i,Date.now()+i,offer.id).run();
  assert.equal((await repo.pendingDecisions(owner.ownerId)).count,1006);
  api=await call(owner,'/offers?view=pending');assert.equal(api.offers.length,1000);assert.equal(api.pending_decisions.count,1006);assert.equal(api.offers[0].id,offer.id);
  // New unconfirmed proposals do not push actionable offers out of the list.
  await db.prepare('UPDATE offers SET proposed_by=post_owner_id,confirmed_revision=NULL,updated_at=? WHERE id=?').bind(Date.now()+9999,'fixture-0').run();
  assert.equal((await repo.list(owner.ownerId,undefined,'inbox'))[0].id,offer.id);
  await call(owner,path+'/accept',{expected_revision:3});
  assert.equal((await repo.pendingDecisions(owner.ownerId)).count,0);
  assert.equal((await request(owner,'/offers/fixture-1/accept',{expected_revision:3})).status,409);
  assert.deepEqual((await call(owner,'/offers?view=pending')).offers,[]);
  assert.equal((await repo.agreements(owner.ownerId)).length,1);
 }finally{sqlite.close();}
});
