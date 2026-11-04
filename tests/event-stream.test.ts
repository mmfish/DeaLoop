import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {SQLiteDatabase} from '../runtime/sqlite.ts';
import {createSession} from '../backend/auth.ts';
import {handleApi,actorFor} from '../backend/service.ts';
import {hash} from '../backend/contracts.ts';
import {openEventStream,streamPath} from '../backend/event-stream.ts';
import {handleMcp} from '../backend/mcp.ts';
const origin='https://dealoop.example',resource=origin+'/mcp';
async function fixture(filename=':memory:'){
 const sqlite=new SQLiteDatabase(filename);sqlite.migrate('drizzle');const db=sqlite.asD1();
 const sessions=await Promise.all(['owner','buyer','stranger'].map(name=>createSession(new Request(origin),db,{uid:name,email:name+'@example.test',emailVerified:true,name,provider:'google.com'},false)));
 const call=async(who:number,path:string,body?:unknown,key=crypto.randomUUID())=>handleApi(new Request(origin+'/api/v1'+path,{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',Cookie:'thread_session='+sessions[who].token,'Idempotency-Key':key},...(body?{body:JSON.stringify(body)}:{})}),{DB:db});
 const ok=async(who:number,path:string,body?:unknown,key?:string)=>{const r=await call(who,path,body,key);const d=await r.json() as any;assert.ok(r.ok,JSON.stringify(d));return d;};
 const post=(await ok(0,'/posts',{type:'for_sale',title:'Laptop',description:'Used laptop',category:'Electronics',price:1000,condition:'Good',location:'San Jose',delivery:'local_pickup'})).post;
 const terms={price:900,item:'PRIVATE-ITEM',condition:'Good',delivery:'local_pickup',terms:'PRIVATE-TERMS',expires_at:new Date(Date.now()+3600000).toISOString()};
 async function grant(owner=0,scope='events:read',target:string|null=resource){const id=crypto.randomUUID(),token='th_'+crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');await db.prepare("INSERT INTO connections(id,device_hash,user_code,name,owner_id,status,token_hash,can_negotiate,expires_at,created_at,oauth_scope,oauth_resource) VALUES(?,?,?,'Agent',?,'active',?,1,?,?,?,?)").bind(id,id,id,sessions[owner].ownerId,await hash(token),Date.now()+3600000,Date.now(),scope,target).run();return {id,token};}
 function request(token?:string,after?:string,signal?:AbortSignal,extra:Record<string,string>={}){return new Request(origin+streamPath+(after===undefined?'':'?after='+after),{headers:{Accept:'text/event-stream',...(token?{Authorization:'Bearer '+token}:{}),...extra},signal});}
 async function stream(token:string,after?:string,signal?:AbortSignal,overrides:Parameters<typeof openEventStream>[3]={}){const req=request(token,after,signal);return openEventStream(req,db,()=>actorFor(req,db,false,resource),{checkMs:15,heartbeatMs:40,lifetimeMs:10000,...overrides});}
 return {sqlite,db,sessions,post,terms,call,ok,grant,request,stream};
}
function frames(response:Response){
 const reader=response.body!.getReader(),decoder=new TextDecoder();let pending='';
 return {cancel:()=>reader.cancel(),async next(){for(;;){const end=pending.indexOf('\n\n');if(end>=0){const frame=pending.slice(0,end);pending=pending.slice(end+2);const lines=frame.split('\n');return {event:lines.find(l=>l.startsWith('event: '))?.slice(7),id:lines.find(l=>l.startsWith('id: '))?.slice(4),data:lines.find(l=>l.startsWith('data: '))?.slice(6),raw:frame};}const timeout=AbortSignal.timeout(2000);const value=await Promise.race([reader.read(),new Promise<never>((_,reject)=>timeout.addEventListener('abort',()=>reject(Error('Stream timed out')),{once:true}))]);if(value.done)return null;pending+=decoder.decode(value.value,{stream:true});}},async event(type:string){for(let i=0;i<100;i++){const f=await this.next();if(!f||f.event===type)return f;}throw Error('Event not found');}};
}

test('SSE sends live committed metadata, isolates owners, resumes across restart and cleans up',async()=>{
 const directory=mkdtempSync(tmpdir()+'/dealoop-sse-test-'),file=directory+'/test.sqlite',f=await fixture(file);
 let reopened:SQLiteDatabase|undefined;
 const open:ReturnType<typeof frames>[]=[];
 try{
  const owner=await f.grant(),buyer=await f.grant(1),stranger=await f.grant(2);
  const ownerResponse=await f.stream(owner.token),ownerFrames=frames(ownerResponse);open.push(ownerFrames);
  assert.match(ownerResponse.headers.get('content-type')!,/text\/event-stream/);assert.match(ownerResponse.headers.get('cache-control')!,/no-store/);
  assert.equal((await ownerFrames.next())?.event,'ready');
  const buyerFrames=frames(await f.stream(buyer.token));open.push(buyerFrames);await buyerFrames.next();
  const outsider=frames(await f.stream(stranger.token));open.push(outsider);await outsider.next();
  const offer=(await f.ok(1,'/posts/'+f.post.id+'/offers',f.terms,'create-once')).offer;
  const created=await ownerFrames.event('marketplace_event'),received=JSON.parse(created!.data!);
  assert.equal(received.kind,'offer_created');assert.equal(received.offer_id,offer.id);assert.equal(received.id,created!.id);
  for(const privateValue of ['PRIVATE','actor_name','owner_id','token','body'])assert.ok(!created!.data!.includes(privateValue));
  assert.equal(JSON.parse((await buyerFrames.event('marketplace_event'))!.data!).offer_id,offer.id);
  assert.match((await outsider.next())!.raw,/heartbeat/); // no foreign offer event
  await f.ok(1,'/posts/'+f.post.id+'/offers',f.terms,'create-once');
  const count=await f.db.prepare('SELECT COUNT(*) n FROM negotiation_events').first<{n:number}>();assert.equal(count?.n,2);
  await f.ok(1,'/offers/'+offer.id+'/messages',{body:'PRIVATE-MESSAGE',expected_revision:1});
  const message=await ownerFrames.event('marketplace_event');assert.equal(JSON.parse(message!.data!).kind,'messages');assert.ok(!message!.data!.includes('PRIVATE-MESSAGE'));
  await Promise.all(open.map(s=>s.cancel()));open.length=0;f.sqlite.close();
  reopened=new SQLiteDatabase(file);reopened.migrate('drizzle');const db=reopened.asD1();
  // Last-Event-ID wins over query cursor, and durable replay survives new DB/process state.
  const req=f.request(owner.token,'0',undefined,{'Last-Event-ID':created!.id!});
  const resumed=frames(await openEventStream(req,db,()=>actorFor(req,db,false,resource)));open.push(resumed);
  await resumed.next();assert.equal((await resumed.event('marketplace_event'))?.id,message!.id);
  const abort=new AbortController(),r=f.request(owner.token,message!.id,abort.signal),stream=frames(await openEventStream(r,db,()=>actorFor(r,db,false,resource)));open.push(stream);await stream.next();abort.abort();assert.equal(await stream.next(),null);
 }finally{await Promise.all(open.map(s=>s.cancel()));if(reopened)reopened.close();else f.sqlite.close();rmSync(directory,{recursive:true,force:true});}
});

test('SSE HTTP rejects wrong scope/resource/origin/cursor; closes on expiry, rotation and revocation',async()=>{
 const f=await fixture(),open:ReturnType<typeof frames>[]=[];
 try{
  const owner=await f.grant(),narrow=await f.grant(0,'posts:read'),wrong=await f.grant(0,'events:read',origin+'/other');
  const status=async(req:Request)=>(await handleApi(req,{DB:f.db})).status;
  assert.equal(await status(f.request()),401);assert.equal(await status(f.request(narrow.token)),403);assert.equal(await status(f.request(wrong.token)),401);
  assert.equal(await status(f.request(owner.token,undefined,undefined,{Origin:'https://other.example'})),403);
  for(const cursor of ['-1','1.2','1e1','9007199254740992'])assert.equal(await status(f.request(owner.token,cursor)),400);
  assert.equal(await status(f.request(owner.token,'1')),409);
  assert.equal(await status(new Request(origin+streamPath+'?access_token=forbidden',{headers:{Authorization:'Bearer '+owner.token}})),400);
  const legacy=await f.grant(0,'',null),legacyStream=frames(await f.stream(legacy.token));open.push(legacyStream);await legacyStream.next();await legacyStream.cancel();
  for(const mode of ['revoked','expiry','rotation','scope']){
   const g=await f.grant(),s=frames(await f.stream(g.token));open.push(s);await s.next();
   if(mode==='revoked')await f.db.prepare("UPDATE connections SET status='revoked' WHERE id=?").bind(g.id).run();
   if(mode==='expiry')await f.db.prepare('UPDATE connections SET expires_at=0 WHERE id=?').bind(g.id).run();
   if(mode==='rotation')await f.db.prepare('UPDATE connections SET token_hash=? WHERE id=?').bind(await hash('replacement'),g.id).run();
   if(mode==='scope')await f.db.prepare("UPDATE connections SET oauth_scope='posts:read' WHERE id=?").bind(g.id).run();
   assert.equal(JSON.parse((await s.event('stream_end'))!.data!).reason,'authorization_changed');assert.equal(await s.next(),null);
  }
  const rpc=await handleMcp(new Request(resource,{method:'POST',headers:{Authorization:'Bearer '+owner.token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_event_stream',arguments:{}}})}),{DB:f.db});
  const info=await rpc.json() as any;assert.equal(info.result.isError,false);assert.equal(info.result.structuredContent.stream.url,origin+streamPath);
  // Companion authorization does not grant general REST access with a resource-bound MCP token.
  assert.equal(await status(new Request(origin+'/api/v1/events',{headers:{Authorization:'Bearer '+owner.token}})),401);
 }finally{await Promise.all(open.map(s=>s.cancel()));f.sqlite.close();}
});

test('SSE bounds connections and slow readers, emits heartbeats and never emits rolled-back events',async()=>{
 const f=await fixture(),open:ReturnType<typeof frames>[]=[];
 try{
  const g=await f.grant(),s=frames(await f.stream(g.token,undefined,undefined,{perOwner:1,lifetimeMs:1000}));open.push(s);await s.next();
  await assert.rejects(()=>f.stream(g.token,undefined,undefined,{perOwner:1}),/Too many open/);
  assert.match((await s.next())!.raw,/heartbeat/);await s.cancel();
  const bounded=frames(await f.stream(g.token,undefined,undefined,{perOwner:1,lifetimeMs:35}));open.push(bounded);await bounded.next();assert.equal(JSON.parse((await bounded.event('stream_end'))!.data!).reason,'reconnect');
  const offer=(await f.ok(1,'/posts/'+f.post.id+'/offers',f.terms)).offer;
  const latest=(await f.db.prepare('SELECT MAX(sequence) n FROM negotiation_events WHERE owner_id=?').bind(f.sessions[0].ownerId).first<{n:number}>())!.n;
  const watcher=frames(await f.stream(g.token,String(latest)));open.push(watcher);await watcher.next();
  await assert.rejects(()=>f.db.batch([f.db.prepare("INSERT INTO negotiation_events(owner_id,kind,offer_id,post_id,revision,actor_name,created_at) VALUES(?,'messages',?,?,1,'PRIVATE',?)").bind(f.sessions[0].ownerId,offer.id,f.post.id,Date.now()),f.db.prepare('INSERT INTO non_existing_table VALUES(1)')]));
  assert.match((await watcher.next())!.raw,/heartbeat/);await watcher.cancel();
  for(let i=0;i<8;i++)await f.ok(1,'/offers/'+offer.id+'/messages',{body:'Message '+i,expected_revision:1});
  const slow=frames(await f.stream(g.token,'0',undefined,{bufferFrames:3,checkMs:10}));open.push(slow);
  await new Promise(resolve=>setTimeout(resolve,40));
  let delivered=0;for(;;){const frame=await slow.next();if(!frame)break;if(frame.event==='marketplace_event')delivered++;}assert.ok(delivered<=3);
  // Cancellation/end released the slot: another stream can be opened.
  const next=frames(await f.stream(g.token,undefined,undefined,{perOwner:1}));open.push(next);await next.next();
 }finally{await Promise.all(open.map(s=>s.cancel()));f.sqlite.close();}
});
