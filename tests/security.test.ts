import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {handleApi} from '../backend/service.ts';
import {handleMcp} from '../backend/mcp.ts';
import {createSession} from '../backend/auth.ts';
import {hash} from '../backend/contracts.ts';

const origin='https://thread.example';
// Minimal valid headers: the dimension parser reads headers only, so a small
// file can honestly claim huge dimensions (the pixel-bomb shape).
const png=(w:number,h:number)=>{const b=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]).copy(b);b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);Buffer.from([8,2,0,0,0]).copy(b,24);return new Uint8Array(b);};
const jpeg=(w:number,h:number)=>{const b=Buffer.from([255,216,255,192,0,11,8,0,0,0,0,1,1,17,0,255,217]);b.writeUInt16BE(h,7);b.writeUInt16BE(w,9);return new Uint8Array(b);};
const riff=(tag:string,payload:Buffer)=>{const padded=payload.length%2?Buffer.concat([payload,Buffer.alloc(1)]):payload;const head=Buffer.alloc(20);head.write('RIFF');head.writeUInt32LE(4+8+padded.length,4);head.write('WEBP',8);head.write(tag,12);head.writeUInt32LE(payload.length,16);return new Uint8Array(Buffer.concat([head,padded]));};
const webpLossy=(w:number,h:number)=>riff('VP8 ',Buffer.from([0,0,0,0x9D,1,0x2A,w&0xFF,(w>>8)&0x3F,h&0xFF,(h>>8)&0x3F]));
const webpLossless1=()=>riff('VP8L',Buffer.from([0x2F,0,0,0,0]));
const webpExtended=()=>{const x=Buffer.alloc(18);x.write('VP8X');x.writeUInt32LE(10,4);const inner=Buffer.concat([Buffer.from('VP8 '),Buffer.from([10,0,0,0,0,0,0,0x9D,1,0x2A,1,0,1,0])]);const body=Buffer.concat([x,inner]);const head=Buffer.alloc(12);head.write('RIFF');head.writeUInt32LE(4+body.length,4);head.write('WEBP',8);return new Uint8Array(Buffer.concat([head,body]));};

async function setup(){
 const dir=mkdtempSync(join(tmpdir(),'thread-security-'));
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'test-db'},d1Persist:dir,r2Buckets:['BUCKET'],cf:false});
 const DB=await mf.getD1Database('DB') as unknown as D1Database,BUCKET=await mf.getR2Bucket('BUCKET') as unknown as R2Bucket;
 for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())for(const sql of readFileSync('drizzle/'+file,'utf8').split('--> statement-breakpoint'))if(sql.trim())await DB.prepare(sql).run();
 const env={DB,BUCKET};
 const call=async(path:string,method='GET',value?:unknown,user?:string)=>{const headers:Record<string,string>={'Content-Type':'application/json',Origin:origin};if(user){headers['oai-authenticated-user-id']=user;headers['oai-authenticated-user-email']=user+'@example.test';}const r=await handleApi(new Request(origin+'/api/v1'+path,{method,headers,...(value!==undefined?{body:JSON.stringify(value)}:{})}),env);return {status:r.status,data:await r.json() as Record<string,unknown>};};
 const upload=async(bytes:Uint8Array,type:string,user:string)=>{const r=await handleApi(new Request(origin+'/api/v1/photos',{method:'POST',headers:{Origin:origin,'oai-authenticated-user-id':user,'oai-authenticated-user-email':user+'@example.test','Content-Type':type,'Content-Length':String(bytes.length)},body:bytes as BodyInit}),env);return {status:r.status,data:await r.json() as Record<string,unknown>};};
 const saturate=async(key:string,limit:number)=>{const bucket=Math.floor(Date.now()/900000),expires=(bucket+1)*900000,k=await hash(key+':'+bucket);await DB.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=?,expires_at=?').bind(k,limit,expires,limit,expires).run();};
 return {dir,mf,DB,env,call,upload,saturate,close:async()=>{await mf.dispose();rmSync(dir,{recursive:true,force:true});}};
}

test('public reads, MCP and human POSTs enforce rate limits',async()=>{
 const t=await setup();
 try{
  assert.equal((await t.call('/posts')).status,200);
  const rpc=()=>handleMcp(new Request(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'search_posts',arguments:{}}})}),t.env);
  assert.equal((await rpc()).status,200);
  await t.saturate('public:null',600);
  assert.equal((await t.call('/posts')).status,429);
  assert.equal((await t.call('/capabilities')).status,429);
  assert.equal((await t.call('/demo','POST',{},'alice')).status,200);
  await t.saturate('mcp:null',600);
  assert.equal((await rpc()).status,429);
  await t.saturate('demo:alice',10);
  assert.equal((await t.call('/demo','POST',{},'alice')).status,429);
 }finally{await t.close();}
});

test('uploads reject unreadable or oversized dimensions',async()=>{
 const t=await setup();
 try{
  assert.equal((await t.upload(png(1,1),'image/png','bob')).status,201);
  assert.equal((await t.upload(png(9000,9000),'image/png','bob')).status,400);
  assert.equal((await t.upload(jpeg(1,1),'image/jpeg','bob')).status,201);
  assert.equal((await t.upload(jpeg(9000,9000),'image/jpeg','bob')).status,400);
  assert.equal((await t.upload(webpLossy(1,1),'image/webp','bob')).status,201);
  assert.equal((await t.upload(webpLossy(9000,9000),'image/webp','bob')).status,400);
  assert.equal((await t.upload(webpLossless1(),'image/webp','bob')).status,201);
  assert.equal((await t.upload(webpExtended(),'image/webp','bob')).status,201);
  assert.equal((await t.upload(new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]),'image/png','bob')).status,400);
 }finally{await t.close();}
});

test('uploads enforce dimensions on real encoder output',async()=>{
 const t=await setup();
 try{
  const file=(name:string)=>new Uint8Array(readFileSync('tests/fixtures/'+name));
  assert.equal((await t.upload(file('v_lossy_1000x3000.webp'),'image/webp','fixtures')).status,201);
  assert.equal((await t.upload(file('v_lossy_100x9000.webp'),'image/webp','fixtures')).status,201);
  assert.equal((await t.upload(file('v_lossless_64x64.webp'),'image/webp','fixtures')).status,201);
  assert.equal((await t.upload(file('v_vp8x_alpha.webp'),'image/webp','fixtures')).status,201);
  assert.equal((await t.upload(file('v_vp8x_exif.webp'),'image/webp','fixtures')).status,201);
  assert.equal((await t.upload(file('v_anim_50x50.webp'),'image/webp','fixtures')).status,201);
  assert.equal((await t.upload(file('x_anim_canvas6000_frame1x1.webp'),'image/webp','fixtures')).status,201);
  assert.equal((await t.upload(file('x_anim_frame_oob.webp'),'image/webp','fixtures')).status,400);
 }finally{await t.close();}
});

test('photo quota and orphan collection bound stored uploads',async()=>{
 const t=await setup();
 try{
  assert.equal((await t.upload(png(1,1),'image/png','carol')).status,201);
  for(let i=0;i<99;i++)await t.DB.prepare('INSERT INTO photos VALUES(?,?,?,?)').bind(crypto.randomUUID(),'carol','image/png',Date.now()).run();
  const quota=await t.upload(png(1,1),'image/png','carol');assert.equal(quota.status,403);assert.equal((quota.data as {error:{code:string}}).error.code,'photo_quota');
  assert.equal((await t.upload(png(1,1),'image/png','dave')).status,201);
  const orphan=crypto.randomUUID(),attached=crypto.randomUUID(),stale=Date.now()-8*86400000;
  await t.DB.prepare('INSERT INTO photos VALUES(?,?,?,?)').bind(orphan,'dave','image/png',stale).run();
  await t.DB.prepare('INSERT INTO photos VALUES(?,?,?,?)').bind(attached,'dave','image/png',stale).run();
  const post={type:'wanted',title:'Spare office chair',description:'Lightly used, pickup only.',category:'Furniture',price:40,condition:'Good',location:'Oakland, CA',delivery:'local_pickup',image:'/media/'+attached};
  const headers:Record<string,string>={'Content-Type':'application/json',Origin:origin,'oai-authenticated-user-id':'dave','oai-authenticated-user-email':'dave@example.test','Idempotency-Key':'attach-stale'};
  const published=await handleApi(new Request(origin+'/api/v1/posts',{method:'POST',headers,body:JSON.stringify(post)}),t.env);assert.equal(published.status,201);
  assert.equal((await t.upload(png(1,1),'image/png','dave')).status,201);
  assert.equal(await t.DB.prepare('SELECT id FROM photos WHERE id=?').bind(orphan).first(),null);
  assert.notEqual(await t.DB.prepare('SELECT id FROM photos WHERE id=?').bind(attached).first(),null);
 }finally{await t.close();}
});

test('orphan GC filters before limiting so attached photos cannot starve it',async()=>{
 const t=await setup();
 try{
  assert.equal((await t.upload(png(1,1),'image/png','collector')).status,201);
  const stale=Date.now()-8*86400000;
  for(let i=0;i<100;i++){
   const pid=crypto.randomUUID();
   await t.DB.prepare('INSERT INTO photos VALUES(?,?,?,?)').bind(pid,'collector','image/png',stale).run();
   await t.DB.prepare('INSERT INTO posts(id,owner_id,actor,type,title,description,category,price,condition,location,delivery,image,created_at,idempotency_key,request_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),'collector','human:collector','wanted','t','d','Furniture',100,'Good','Oakland, CA','local_pickup','/media/'+pid,stale,'gc-seed-'+i,'hash').run();
  }
  const drafts=[crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID()];
  for(const id of drafts){
   await t.DB.prepare('INSERT INTO photos VALUES(?,?,?,?)').bind(id,'collector','image/png',stale).run();
   await t.env.BUCKET.put(id,new Uint8Array([7]));
  }
  assert.equal((await t.upload(png(1,1),'image/png','collector')).status,201);
  for(const id of drafts){
   assert.equal(await t.DB.prepare('SELECT id FROM photos WHERE id=?').bind(id).first(),null);
   assert.equal(await t.env.BUCKET.get(id),null);
  }
  const kept=await t.DB.prepare('SELECT COUNT(*) n FROM photos WHERE owner_id=?').bind('collector').first<{n:number}>();
  assert.equal(kept?.n,102);
 }finally{await t.close();}
});

test('orphan GC cannot strand a concurrently published photo',async()=>{
 const t=await setup();
 try{
  assert.equal((await t.upload(png(1,1),'image/png','racer')).status,201);
  const staleId=crypto.randomUUID();
  await t.DB.prepare('INSERT INTO photos VALUES(?,?,?,?)').bind(staleId,'racer','image/png',Date.now()-8*86400000).run();
  await t.env.BUCKET.put(staleId,new Uint8Array([1,2,3]));
  let release:()=>void=()=>{};const gate=new Promise<void>(r=>{release=r;});
  let deleting=false;const bucket=t.env.BUCKET;
  const gated={put:(id:string,body:Parameters<R2Bucket['put']>[1],options?:Parameters<R2Bucket['put']>[2])=>bucket.put(id,body,options),get:(id:string)=>bucket.get(id),delete:async(id:string)=>{deleting=true;await gate;return bucket.delete(id);}};
  const gatedEnv={DB:t.DB,BUCKET:gated as unknown as R2Bucket};
  const user={Origin:origin,'oai-authenticated-user-id':'racer','oai-authenticated-user-email':'racer@example.test'};
  const flight=handleApi(new Request(origin+'/api/v1/photos',{method:'POST',headers:{...user,'Content-Type':'image/png','Content-Length':'33'},body:png(1,1) as BodyInit}),gatedEnv);
  for(let i=0;i<200&&!deleting;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(deleting,true,'GC must reach object deletion');
  const post={type:'wanted',title:'Race car seat',description:'Lightly used, pickup only.',category:'Other',price:10,condition:'Good',location:'Oakland, CA',delivery:'local_pickup',image:'/media/'+staleId};
  const pub=await handleApi(new Request(origin+'/api/v1/posts',{method:'POST',headers:{...user,'Content-Type':'application/json','Idempotency-Key':'race-post'},body:JSON.stringify(post)}),t.env);
  release();
  assert.equal((await flight).status,201);
  // Rows are collected before objects, so the mid-flight publish must fail
  // cleanly; had it won the race first, the guarded delete would have spared it.
  if(pub.status===201){
   assert.notEqual(await t.DB.prepare('SELECT id FROM photos WHERE id=?').bind(staleId).first(),null);
   assert.notEqual(await t.env.BUCKET.get(staleId),null);
  }else assert.equal(pub.status,403);
  const dangling=await t.DB.prepare("SELECT p.id FROM posts p WHERE p.image IS NOT NULL AND NOT EXISTS(SELECT 1 FROM photos WHERE '/media/'||id=p.image)").all();
  assert.equal(dangling.results.length,0);
 }finally{await t.close();}
});

test('photo quota counts drafts and delete recovers capacity',async()=>{
 const t=await setup();
 try{
  const up=await t.upload(png(1,1),'image/png','hoarder');assert.equal(up.status,201);
  const firstId=(up.data as {image:string}).image.split('/').pop()!;
  for(let i=0;i<99;i++)await t.DB.prepare('INSERT INTO photos VALUES(?,?,?,?)').bind(crypto.randomUUID(),'hoarder','image/png',Date.now()).run();
  assert.equal((await t.upload(png(1,1),'image/png','hoarder')).status,403);
  const victim=(await t.DB.prepare('SELECT id FROM photos WHERE owner_id=? AND id!=? LIMIT 1').bind('hoarder',firstId).first<{id:string}>())!.id;
  await t.env.BUCKET.put(victim,new Uint8Array([9]));
  assert.equal((await t.call('/photos/'+victim+'/delete','POST',undefined,'hoarder')).status,200);
  assert.equal(await t.DB.prepare('SELECT id FROM photos WHERE id=?').bind(victim).first(),null);
  assert.equal(await t.env.BUCKET.get(victim),null);
  assert.equal((await t.upload(png(1,1),'image/png','hoarder')).status,201);
  assert.equal((await t.call('/photos/'+crypto.randomUUID()+'/delete','POST',undefined,'hoarder')).status,404);
  assert.equal((await t.call('/photos/'+firstId+'/delete','POST',undefined,'stranger')).status,404);
  const post={type:'wanted',title:'Spare chair',description:'A chair for testing.',category:'Furniture',price:5,condition:'Good',location:'Oakland, CA',delivery:'local_pickup',image:'/media/'+firstId};
  const headers:Record<string,string>={'Content-Type':'application/json',Origin:origin,'oai-authenticated-user-id':'hoarder','oai-authenticated-user-email':'hoarder@example.test','Idempotency-Key':'attach-first'};
  assert.equal((await handleApi(new Request(origin+'/api/v1/posts',{method:'POST',headers,body:JSON.stringify(post)}),t.env)).status,201);
  assert.equal((await t.call('/photos/'+firstId+'/delete','POST',undefined,'hoarder')).status,409);
 }finally{await t.close();}
});

test('attached photos do not consume quota and concurrent uploads cap atomically',async()=>{
 const t=await setup();
 try{
  assert.equal((await t.upload(png(1,1),'image/png','gallery')).status,201);
  for(let i=0;i<100;i++){
   const pid=crypto.randomUUID();
   await t.DB.prepare('INSERT INTO photos VALUES(?,?,?,?)').bind(pid,'gallery','image/png',Date.now()).run();
   await t.DB.prepare('INSERT INTO posts(id,owner_id,actor,type,title,description,category,price,condition,location,delivery,image,created_at,idempotency_key,request_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),'gallery','human:gallery','wanted','t','d','Furniture',100,'Good','Oakland, CA','local_pickup','/media/'+pid,Date.now(),'seed-'+i,'hash').run();
  }
  assert.equal((await t.upload(png(1,1),'image/png','gallery')).status,201);
  assert.equal((await t.upload(png(1,1),'image/png','crowd')).status,201);
  for(let i=0;i<97;i++)await t.DB.prepare('INSERT INTO photos VALUES(?,?,?,?)').bind(crypto.randomUUID(),'crowd','image/png',Date.now()).run();
  const results=await Promise.all([0,1,2,3,4].map(()=>t.upload(png(1,1),'image/png','crowd')));
  assert.equal(results.filter(r=>r.status===201).length,2);
  assert.equal(results.filter(r=>r.status===403).length,3);
  const n=await t.DB.prepare("SELECT COUNT(*) n FROM photos WHERE owner_id=? AND NOT EXISTS(SELECT 1 FROM posts WHERE posts.image='/media/'||photos.id)").bind('crowd').first<{n:number}>();
  assert.equal(n?.n,100);
 }finally{await t.close();}
});

test('malformed owner bindings fail closed without operator JSON',async()=>{
 const t=await setup();
 const previous={runtime:process.env.DEALOOP_RUNTIME,bindings:process.env.DEALOOP_OWNER_BINDINGS};
 try{
  process.env.DEALOOP_RUNTIME='aws';process.env.DEALOOP_OWNER_BINDINGS='{oops';
  await assert.rejects(()=>createSession(new Request(origin),t.DB,{uid:'u',email:'u@example.test',emailVerified:true,name:'U',provider:'google.com'},false),/temporarily unavailable/);
 }finally{
  if(previous.runtime===undefined)delete process.env.DEALOOP_RUNTIME;else process.env.DEALOOP_RUNTIME=previous.runtime;
  if(previous.bindings===undefined)delete process.env.DEALOOP_OWNER_BINDINGS;else process.env.DEALOOP_OWNER_BINDINGS=previous.bindings;
  await t.close();
 }
});


test('larger images respect byte, side and total-pixel boundaries',async()=>{
 const t=await setup();try{
  assert.equal((await t.upload(png(12000,1),'image/png','image-boundary')).status,201);
  assert.equal((await t.upload(png(12001,1),'image/png','image-boundary')).status,400);
  assert.equal((await t.upload(png(8000,8000),'image/png','image-boundary')).status,201);
  assert.equal((await t.upload(png(8000,8001),'image/png','image-boundary')).status,400);
  const large=new Uint8Array(10000000);large.set(png(1,1));
  assert.equal((await t.upload(large,'image/png','image-boundary')).status,201);
  const tooLarge=new Uint8Array(10000001);tooLarge.set(png(1,1));
  assert.equal((await t.upload(tooLarge,'image/png','image-boundary')).status,413);
 }finally{await t.close();}
});
