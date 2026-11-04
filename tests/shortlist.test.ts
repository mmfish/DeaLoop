import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SQLiteDatabase} from '../runtime/sqlite.ts';
import {createSession} from '../backend/auth.ts';
import {handleApi} from '../backend/service.ts';
import {Shortlists} from '../backend/shortlist.ts';
import {handleMcp} from '../backend/mcp.ts';
import {hash} from '../backend/contracts.ts';
const origin='https://dealoop.example';
async function fixture(){
 const sqlite=new SQLiteDatabase(':memory:');sqlite.migrate('drizzle');sqlite.migrate('drizzle');const db=sqlite.asD1();
 const sessions=await Promise.all(['Owner','Buyer1','Buyer2','Buyer3','Buyer4','Other'].map(name=>createSession(new Request(origin),db,{uid:name,email:name+'@example.test',emailVerified:true,name,provider:'google.com'},false)));
 const call=async(who:number|null,path:string,body?:unknown,key=crypto.randomUUID())=>{
  const response=await handleApi(new Request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json','Idempotency-Key':key,...(who===null?{}:{Cookie:'thread_session='+sessions[who].token})},...(body===undefined?{}:{body:JSON.stringify(body)})}),{DB:db});
  return {status:response.status,data:await response.json() as any};
 };
 const ok=async(who:number|null,path:string,body?:unknown,key?:string)=>{const r=await call(who,path,body,key);assert.ok(r.status<300,JSON.stringify(r));return r.data;};
 const terms={price:900,item:'Private item description',condition:'Good',delivery:'local_pickup',terms:'Private terms: call me at SECRET-CONTACT',expires_at:new Date(Date.now()+3600000).toISOString()};
 const makePost=async(type='for_sale',who=0)=>(await ok(who,'/posts',{type,title:'Laptop',description:'Used laptop with charger',category:'Electronics',price:1000,condition:'Good',location:'San Jose',delivery:'local_pickup'})).post;
 const post=await makePost();const offers:{id:string;revision:number}[]=[];
 for(let i=1;i<=4;i++)offers.push((await ok(i,'/posts/'+post.id+'/offers',{...terms,price:800+i*25})).offer);
 const entry=(i:number)=>({offer_id:offers[i].id,expected_revision:1,summary:'Charger included',reason:'Preferred pickup time'});
 const path='/posts/'+post.id+'/shortlist';
 return {sqlite,db,sessions,call,ok,terms,makePost,post,offers,entry,path};
}

test('owner chooses exact order; public shortlist redacts private data and follows revision/lifecycle changes',async()=>{
 const f=await fixture();const {ok,call,db,path,offers,entry,terms}=f;
 try{
  assert.deepEqual((await ok(null,path)).shortlist.entries.map((e:any)=>e.price),[900,875,850]);
  const body={expected_version:0,entries:[entry(2),entry(0),entry(1)]};
  const saved=await ok(0,path,body,'save-ranking');assert.equal(saved.version,1);
  const publicList=(await ok(null,path)).shortlist;
  assert.deepEqual(publicList.entries.map((e:any)=>e.price),[875,825,850]); // Not price-sorted.
  assert.deepEqual(publicList.entries.map((e:any)=>e.rank),[1,2,3]);
  const exposed=JSON.stringify(publicList);
  for(const secret of ['Private','SECRET-CONTACT','Buyer1','offer_id','offer_revision','owner_id','current_revision',offers[0].id])assert.ok(!exposed.includes(secret),secret);
  const readPost=await ok(null,'/posts/'+f.post.id);assert.deepEqual(readPost.shortlist,publicList);
  const replay=await ok(0,path,body,'save-ranking');assert.equal(replay.replayed,true);assert.equal(replay.version,1);
  assert.equal((await call(0,path,{...body,entries:[entry(0)]},'save-ranking')).status,409);
  // An unranked new offer never displaces the saved choices.
  await ok(4,'/posts/'+f.post.id+'/offers',{...terms,price:10000});
  assert.deepEqual((await ok(null,path)).shortlist.entries,publicList.entries);
  await ok(3,'/offers/'+offers[2].id+'/revise',{...terms,price:850,expected_revision:1});
  assert.deepEqual((await ok(null,path)).shortlist.entries.map((e:any)=>e.rank),[2,3]);
  let management=await ok(0,path+'/manage');assert.equal(management.entries[0].status,'needs_review');
  assert.equal((await call(0,path,{expected_version:1,entries:[entry(2)]})).status,409);
  assert.equal((await ok(0,path+'/manage')).version,1); // No partial delete on failure.
  await ok(0,path,{expected_version:1,entries:[{...entry(2),expected_revision:2},entry(0),entry(1)]});
  assert.equal((await ok(null,path)).shortlist.entries[0].price,850);
  await ok(1,'/offers/'+offers[0].id+'/withdraw',{expected_revision:1});
  await db.prepare('UPDATE offers SET expires_at=? WHERE id=?').bind(Date.now()-1,offers[1].id).run();
  assert.deepEqual((await ok(null,path)).shortlist.entries.map((e:any)=>e.rank),[1]);
  management=await ok(0,path+'/manage');assert.deepEqual(management.entries.map((e:any)=>e.status),['active','unavailable','expired']);
  // Rankings don't accept a deal; the owner may choose an unranked offer.
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM deals').first<{n:number}>())?.n,0);
  await ok(0,'/offers/'+offers[3].id+'/accept',{expected_revision:1});
  assert.deepEqual((await ok(null,path)).shortlist.entries,[]);
  assert.equal((await call(0,path,{expected_version:2,entries:[]})).status,409);
 }finally{f.sqlite.close();}
});

test('atomic replacement rejects stale writers, invalid entries and other owners; pagination and explicit clearing work',async()=>{
 const f=await fixture();const {ok,call,path,entry,makePost,terms,db,offers}=f;
 try{
  const body={expected_version:0,entries:[entry(0)]};
  assert.equal((await call(null,path,body)).status,401);
  assert.equal((await call(1,path,body)).status,404);
  assert.equal((await call(1,path+'/manage')).status,404);
  assert.equal((await call(0,path,{...body,entries:[entry(0),entry(0)]})).status,400);
  assert.equal((await call(0,path,{...body,entries:[entry(0),entry(1),entry(2),entry(3)]})).status,400);
  assert.equal((await call(0,path,{...body,entries:[{...entry(0),summary:''}]})).status,400);
  const otherPost=await makePost('wanted');
  const foreign=(await ok(1,'/posts/'+otherPost.id+'/offers',terms)).offer;
  assert.equal((await call(0,path,{...body,entries:[{...entry(0),offer_id:foreign.id}]})).status,409);
  const concurrent=await Promise.all([call(0,path,body,'writer-a'),call(0,path,{...body,entries:[entry(1)]},'writer-b')]);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
  assert.equal((await ok(0,path+'/manage')).version,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM shortlist_actions').first<{n:number}>())?.n,1);
  // Clearing is an explicit owner update and does not reorder remaining offers automatically.
  await ok(0,path,{expected_version:1,entries:[]});
  assert.deepEqual((await ok(null,path)).shortlist.entries,[]);
  assert.equal((await ok(0,path+'/manage')).version,2);
  for(let i=0;i<36;i++)await db.prepare("INSERT INTO offers(id,post_id,post_owner_id,offerer_id,status,revision,price,item,condition,delivery,terms,expires_at,proposed_by,created_at,updated_at) SELECT ?,post_id,post_owner_id,offerer_id,status,revision,price,item,condition,delivery,terms,expires_at,proposed_by,?,updated_at FROM offers WHERE id=?").bind(crypto.randomUUID(),Date.now()+i,offers[0].id).run();
  const first=await ok(0,path+'/manage'),second=await ok(0,path+'/manage?offset='+first.next_offset);
  assert.equal(first.candidates.length,30);assert.equal(first.next_offset,30);assert.equal(second.candidates.length,10);assert.equal(second.next_offset,null);
  assert.equal(new Set([...first.candidates,...second.candidates].map((e:any)=>e.id)).size,40);
  await ok(0,'/posts/'+otherPost.id+'/shortlist',{expected_version:0,entries:[{...entry(0),offer_id:foreign.id}]});
  assert.equal((await ok(null,'/posts/'+otherPost.id+'/shortlist')).shortlist.entries.length,1); // Wanted works too.
 }finally{f.sqlite.close();}
});

test('MCP exposes rankings and enforces owner, publish/read scopes, resource binding and revocation',async()=>{
 const f=await fixture();const {db,sessions,post,entry}=f,resource=origin+'/mcp';
 try{
  async function grant(scope:string,owner=sessions[0].ownerId){const token='th_'+crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-',''),id=crypto.randomUUID();await db.prepare("INSERT INTO connections(id,device_hash,user_code,name,owner_id,status,token_hash,can_write,can_negotiate,can_accept,expires_at,created_at,oauth_scope,oauth_resource) VALUES(?,?,?,'Test agent',?,'active',?,?,?,0,?,?,?,?)").bind(id,id,id,owner,await hash(token),scope.includes('posts:write')?1:0,scope.includes('offers:read')?1:0,Date.now()+3600000,Date.now(),scope,resource).run();return {token,id};}
  async function rpc(name:string,args:unknown,token?:string){const r=await handleMcp(new Request(resource,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),{DB:db});return {status:r.status,data:await r.json() as any};}
  const read=await rpc('read_shortlist',{post_id:post.id});assert.equal(read.status,200);assert.equal(read.data.result.isError,false);assert.equal(read.data.result.structuredContent.shortlist.ranked_by,'price');assert.deepEqual(read.data.result.structuredContent.shortlist.entries.map((e:any)=>e.price),[900,875,850]);
  assert.equal((await rpc('manage_shortlist',{post_id:post.id})).status,401);
  const reader=await grant('offers:read'),publisher=await grant('posts:write'),both=await grant('offers:read posts:write'),outsider=await grant('offers:read posts:write',sessions[1].ownerId);
  const management=(await rpc('manage_shortlist',{post_id:post.id},reader.token)).data.result.structuredContent;assert.equal(management.default_entries.length,3);assert.match(management.ranking_guidance,/Rerank/);
  const args={post_id:post.id,expected_version:0,entries:[entry(0)],idempotency_key:'rank-mcp'};
  assert.equal((await rpc('update_shortlist',args,reader.token)).status,403);
  assert.equal((await rpc('update_shortlist',args,publisher.token)).data.result.isError,true);
  assert.equal((await rpc('update_shortlist',args,outsider.token)).data.result.isError,true);
  const result=await rpc('update_shortlist',args,both.token);assert.equal(result.data.result.isError,false);assert.equal(result.data.result.structuredContent.version,1);
  const exposed=(await rpc('read_shortlist',{post_id:post.id})).data.result.structuredContent.shortlist;
  assert.equal(exposed.entries[0].price,825);assert.equal(exposed.entries[0].offer_id,undefined);
  await db.prepare("UPDATE connections SET status='revoked' WHERE id=?").bind(both.id).run();
  assert.equal((await rpc('update_shortlist',{...args,expected_version:1},both.token)).status,401);
  assert.equal((await new Shortlists(db).state(post.id)).version,1);
 }finally{f.sqlite.close();}
});

test('price defaults are live, deterministic and private; wanted uses lowest price and owner decisions override',async()=>{
 const f=await fixture();const {ok,db,path,post,offers,terms,entry,makePost}=f;
 try{
  let list=(await ok(null,path)).shortlist;
  assert.equal(list.ranked_by,'price');assert.equal(list.price_order,'highest_first');assert.equal(list.version,0);
  assert.deepEqual(list.entries.map((e:any)=>e.price),[900,875,850]);
  for(const secret of ['Private','SECRET-CONTACT','Buyer','offer_id','offer_revision','owner_id',offers[3].id])assert.ok(!JSON.stringify(list).includes(secret),secret);
  let manage=await ok(0,path+'/manage');
  assert.equal(manage.ranked_by,'price');assert.deepEqual(manage.entries,[]);
  assert.deepEqual(manage.default_entries.map((e:any)=>e.offer_id),[offers[3].id,offers[2].id,offers[1].id]);
  assert.match(manage.ranking_guidance,/Rerank with update_shortlist/);
  // Revised offers enter the default at their latest exact revision.
  await ok(1,'/offers/'+offers[0].id+'/revise',{...terms,price:1000,expected_revision:1});
  manage=await ok(0,path+'/manage');assert.equal(manage.default_entries[0].offer_id,offers[0].id);assert.equal(manage.default_entries[0].offer_revision,2);
  await ok(1,'/offers/'+offers[0].id+'/withdraw',{expected_revision:2});
  await db.prepare('UPDATE offers SET expires_at=? WHERE id=?').bind(Date.now()-1,offers[3].id).run();
  assert.deepEqual((await ok(null,path)).shortlist.entries.map((e:any)=>e.price),[875,850]);
  // Exact ties use creation time, then ID (not a random or unstable DB order).
  await db.prepare('UPDATE offers SET price=85000,created_at=100 WHERE id IN (?,?)').bind(offers[1].id,offers[2].id).run();
  assert.deepEqual((await ok(0,path+'/manage')).default_entries.map((e:any)=>e.offer_id),[offers[1].id,offers[2].id].sort());
  await db.prepare('UPDATE offers SET created_at=99 WHERE id=?').bind(offers[2].id).run();
  assert.equal((await ok(0,path+'/manage')).default_entries[0].offer_id,offers[2].id);
  await ok(0,path,{expected_version:0,entries:[entry(1)]});
  await ok(4,'/posts/'+post.id+'/offers',{...terms,price:10000});
  list=(await ok(null,path)).shortlist;assert.equal(list.ranked_by,'post_owner');assert.equal(list.price_order,null);assert.deepEqual(list.entries.map((e:any)=>e.price),[850]);
  assert.deepEqual((await ok(0,path+'/manage')).default_entries,[]);
  await ok(0,path,{expected_version:1,entries:[]});
  assert.deepEqual((await ok(null,path)).shortlist.entries,[]); // Explicit clear does not restart automatic disclosure.
  const wanted=await makePost('wanted'),wp='/posts/'+wanted.id+'/shortlist';
  assert.deepEqual((await ok(null,wp)).shortlist.entries,[]);
  for(let i=1;i<=4;i++)await ok(i,'/posts/'+wanted.id+'/offers',{...terms,price:700+i*25});
  list=(await ok(null,wp)).shortlist;assert.equal(list.price_order,'lowest_first');assert.deepEqual(list.entries.map((e:any)=>e.price),[725,750,775]);
  assert.deepEqual((await ok(null,'/posts/'+wanted.id)).shortlist,list);
  await db.prepare("UPDATE posts SET status='closed' WHERE id=?").bind(wanted.id).run();
  assert.deepEqual((await ok(null,wp)).shortlist.entries,[]);
  assert.deepEqual((await ok(0,wp+'/manage')).default_entries,[]);
 }finally{f.sqlite.close();}
});
