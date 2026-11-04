import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {handleApi} from '../backend/service.ts';
const origin='https://thread.example';
const body={type:'wanted',title:'A working used commuter bicycle',description:'Working brakes and gears; medium frame.',category:'Bicycles',price:150,condition:'Good',location:'Oakland, CA',delivery:'local_pickup',image:null};

test('owner-approved agents: scope, ownership, revocation, limits, idempotency and durable records',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'thread-tests-'));
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'test-db'},d1Persist:dir,r2Buckets:['BUCKET'],cf:false});
 try{
 const DB=await mf.getD1Database('DB');const BUCKET=await mf.getR2Bucket('BUCKET');
 for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())for(const sql of readFileSync('drizzle/'+file,'utf8').split('--> statement-breakpoint'))if(sql.trim())await DB.prepare(sql).run();
 const env={DB:DB as unknown as D1Database,BUCKET:BUCKET as unknown as R2Bucket};
 async function call(path:string,method='GET',value?:unknown,user?:string,token?:string,key?:string,originHeader=origin){
  const headers:Record<string,string>={'Content-Type':'application/json','Origin':originHeader};if(user){headers['oai-authenticated-user-id']=user;headers['oai-authenticated-user-email']=user+'@example.test';headers['oai-authenticated-user-full-name']=user;}
  if(token)headers.Authorization='Bearer '+token;if(key)headers['Idempotency-Key']=key;
  const response=await handleApi(new Request(origin+'/api/v1'+path,{method,headers,...(value!==undefined?{body:JSON.stringify(value)}:{})}),env);
  const data=await response.json() as any;assert.equal(response.headers.get('x-request-id'),data.request_id);return {status:response.status,...data};
 }
 assert.equal((await call('/posts','POST',body)).status,401);
 assert.equal((await call('/posts','POST',body,'alice',undefined,'csrf','https://evil.example')).status,403);
 const pending=await call('/agent-connections','POST',{name:'Muse'});assert.equal(pending.status,201);
 assert.equal((await call('/agent-token','POST',{device_code:pending.device_code})).status,428);
 assert.equal((await call('/connections/approve','POST',{user_code:pending.user_code,can_write:true})).status,401);
 assert.equal((await call('/connections/approve','POST',{user_code:pending.user_code,can_write:true},'alice')).status,200);
 const grant=await call('/agent-token','POST',{device_code:pending.device_code});assert.equal(grant.status,200);const token=grant.access_token;
 assert.equal((await call('/agent-token','POST',{device_code:pending.device_code})).status,400);
 const me=await call('/me','GET',undefined,undefined,token);assert.equal(me.account_id,'alice');assert.equal(me.actor,'agent');
 assert.equal((await call('/connections/approve','POST',{user_code:'unknown',can_write:true},'alice',token)).status,403);
 assert.equal((await call('/posts','POST',{...body,owner_id:'bob'},undefined,token,'owner-spoof')).status,400);
 // Existing stored price limits no longer constrain publishing.
 await DB.prepare('UPDATE connections SET max_price=100 WHERE id=?').bind(grant.connection.id).run();
 assert.equal((await call('/posts','POST',{...body,price:1.005},undefined,token,'fraction')).status,400);
 assert.equal((await call('/posts','POST',body,undefined,token)).status,400);
 const pair=await Promise.all([call('/posts','POST',body,undefined,token,'same-operation'),call('/posts','POST',body,undefined,token,'same-operation')]);
 assert.deepEqual(pair.map(x=>x.status).sort(),[200,201]);assert.equal(pair[0].post.id,pair[1].post.id);const id=pair[0].post.id;
 const publicRead=await call('/posts/'+id);assert.equal(publicRead.post.created_by,'agent');assert.equal(publicRead.post.price,150);assert.equal(publicRead.post.owner_id,undefined);
 assert.equal((await call('/posts','POST',{...body,price:140},undefined,token,'same-operation')).status,409);
 assert.equal((await call('/activity','GET',undefined,'alice')).events.filter((e:any)=>e.kind==='post_published').length,1);
 assert.equal((await call('/my-posts','GET',undefined,'bob')).posts.length,0);
 assert.equal((await call('/activity','GET',undefined,'bob')).events.length,0);
 assert.equal((await call('/posts/'+id+'/archive','POST',{},'bob')).status,404);
 assert.equal((await call('/posts/'+id+'/archive','POST',{},undefined,token)).status,403);
 const connection=await DB.prepare('SELECT * FROM connections WHERE id=?').bind(grant.connection.id).first() as any;
 assert.notEqual(connection.token_hash,token);assert.notEqual(connection.device_hash,pending.device_code);
 await DB.prepare('UPDATE connections SET max_posts=1 WHERE id=?').bind(grant.connection.id).run();
 assert.equal((await call('/posts','POST',body,undefined,token,'over-count')).status,403);
 assert.equal((await call('/posts','POST',body,undefined,token,'same-operation')).status,200);
 assert.equal((await call('/connections/'+grant.connection.id+'/revoke','POST',{},'bob')).status,404);
 assert.equal((await call('/connections/'+grant.connection.id+'/revoke','POST',{},'alice')).status,200);
 assert.equal((await call('/me','GET',undefined,'alice',token)).status,401);
 assert.equal((await call('/posts','POST',body,undefined,token,'revoked')).status,401);
 assert.equal((await call('/posts/'+id+'/archive','POST',{},'alice')).status,200);
 assert.equal((await call('/posts')).posts.length,0);
 const readOnly=await call('/agent-connections','POST',{name:'Reader'});
 await call('/connections/approve','POST',{user_code:readOnly.user_code,can_write:false},'bob');
 const readGrant=await call('/agent-token','POST',{device_code:readOnly.device_code});
 assert.equal((await call('/posts','POST',body,undefined,readGrant.access_token,'no-write')).status,403);
 await DB.prepare('UPDATE connections SET expires_at=0 WHERE id=?').bind(readGrant.connection.id).run();
 assert.equal((await call('/me','GET',undefined,undefined,readGrant.access_token)).status,401);
 assert.equal((await call('/demo','POST',{},'alice')).status,200);assert.equal((await call('/posts')).posts.length,8);
 assert.equal((await call('/demo','POST',{},'alice')).status,200);assert.equal((await call('/posts')).posts.length,8);
 const browse=await call('/posts?type=for_sale&category=Bicycles&max_price=150');assert.equal(browse.posts.length,1);assert.equal(browse.posts[0].demo,true);
 const human=await call('/posts','POST',{...body,type:'for_sale'},'bob',undefined,'human-sale');assert.equal(human.status,201);assert.equal(human.post.created_by,'human');
 const photoBytes=readFileSync('public/images/chair.jpg');
 const photoResponse=await handleApi(new Request(origin+'/api/v1/photos',{method:'POST',headers:{Origin:origin,'oai-authenticated-user-id':'bob','oai-authenticated-user-email':'bob@example.test','Content-Type':'image/jpeg','Content-Length':String(photoBytes.length)},body:photoBytes}),env);
 assert.equal(photoResponse.status,201);const photo=await photoResponse.json() as any;
 assert(await BUCKET.get(photo.image.split('/').pop()));
 assert.equal((await call('/posts','POST',{...body,image:photo.image},'alice',undefined,'foreign-photo')).status,403);
 assert.equal((await call('/posts','POST',{...body,image:photo.image},'bob',undefined,'own-photo')).status,201);
 assert.equal((await DB.prepare('SELECT COUNT(*) n FROM posts WHERE demo=0').first() as any).n,3);
 }finally{await mf.dispose();rmSync(dir,{recursive:true,force:true});}
});
