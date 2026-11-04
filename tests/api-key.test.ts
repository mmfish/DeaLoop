import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {handleApi} from '../backend/service.ts';
const origin='https://thread.example';
test('human-issued keys remain owner-bound, scoped, hashed, expiring and revocable',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'key-tests'},cf:false});
 try{
 const db=await mf.getD1Database('DB');for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())for(const sql of readFileSync('drizzle/'+file,'utf8').split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql).run();
 const call=async(path:string,method='GET',body?:unknown,user?:string,token?:string,requestOrigin=origin)=>{
  const headers:Record<string,string>={'Content-Type':'application/json',Origin:requestOrigin};if(user){headers['oai-authenticated-user-id']=user;headers['oai-authenticated-user-email']=user+'@example.test';}if(token)headers.Authorization='Bearer '+token;
  const res=await handleApi(new Request(origin+'/api/v1'+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})}),{DB:db as unknown as D1Database});return {status:res.status,headers:res.headers,data:await res.json() as any};
 };
 const grant={name:'Buyer Muse',can_write:true,can_negotiate:true,can_accept:true};
 assert.equal((await call('/connections/api-key','POST',grant)).status,401);
 assert.equal((await call('/connections/api-key','POST',grant,'alice',undefined,'https://evil.example')).status,403);
 for(const invalid of [{max_price:1.001},{max_deal_price:-1},{can_negotiate:false,can_accept:true},{name:''}])assert.equal((await call('/connections/api-key','POST',{...grant,...invalid},'alice')).status,400);
 const created=await call('/connections/api-key','POST',{...grant,owner_id:'bob'},'alice');assert.equal(created.status,201);assert.equal(created.headers.get('cache-control'),'no-store');
 const {access_token:token,connection_id:id,expires_at}=created.data;assert.match(token,/^th_[a-f0-9]{64}$/);assert(Math.abs(Date.parse(expires_at)-Date.now()-72*3600000)<10000);
 const stored=await db.prepare('SELECT * FROM connections WHERE id=?').bind(id).first() as any;assert.equal(stored.owner_id,'alice');assert.notEqual(stored.token_hash,token);assert.equal(stored.token_hash.length,64);
 const me=await call('/me','GET',undefined,undefined,token);assert.equal(me.data.account_id,'alice');assert.equal(me.data.actor,'agent');assert(me.data.scopes.includes('deals:accept'));
 assert.equal((await call('/connections/api-key','POST',grant,'alice',token)).status,403);
 assert.equal((await call('/connections','GET',undefined,'bob')).data.connections.length,0);
 const list=await call('/connections','GET',undefined,'alice');assert.equal(list.data.connections.length,1);assert(!JSON.stringify(list.data).includes(token));assert(!JSON.stringify(list.data).includes(stored.token_hash));
 assert.equal((await call('/connections/'+id+'/revoke','POST',{},'bob')).status,404);
 assert.equal((await call('/connections/'+id+'/revoke','POST',{},'alice')).status,200);assert.equal((await call('/me','GET',undefined,undefined,token)).status,401);
 const readonly=await call('/connections/api-key','POST',{name:'Read-only',can_write:false},'bob');assert.equal(readonly.status,201);
 assert.equal((await call('/offers','GET',undefined,undefined,readonly.data.access_token)).status,403);
 await db.prepare('UPDATE connections SET expires_at=0 WHERE id=?').bind(readonly.data.connection_id).run();assert.equal((await call('/me','GET',undefined,undefined,readonly.data.access_token)).status,401);
 }finally{await mf.dispose();}
});
