import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SQLiteDatabase} from '../runtime/sqlite.ts';
import {handleApi} from '../backend/service.ts';
import {handleOAuth,museRedirect,pkceChallenge} from '../backend/oauth.ts';
import {handleMcp} from '../backend/mcp.ts';
import {createSession} from '../backend/auth.ts';

const origin='https://policy.example';
const post={type:'for_sale',title:'A portable speaker',description:'Used portable speaker.',category:'Electronics',price:100,condition:'Good',location:'San Jose',delivery:'local_pickup'};
function setup(){
 const sqlite=new SQLiteDatabase(':memory:');sqlite.migrate('drizzle');const DB=sqlite.asD1();
 const call=(path:string,body?:unknown,user?:string,token?:string,key?:string)=>handleApi(new Request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',...(user?{'oai-authenticated-user-id':user,'oai-authenticated-user-email':user+'@example.test'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),{DB});
 return {sqlite,DB,call};
}

test('new manual and paired grants use 72h, six-hour pending requests and 200-post bounds',async()=>{
 const {sqlite,DB,call}=setup(),originalNow=Date.now;let clock=originalNow();Date.now=()=>clock;
 try{
  const manual=await call('/connections/api-key',{name:'Policy agent',can_write:true},'owner');assert.equal(manual.status,201);
  const m=await manual.json() as {access_token:string;connection_id:string;expires_at:string};assert.equal(Date.parse(m.expires_at)-clock,72*3600000);
  const grant=await DB.prepare('SELECT max_posts FROM connections WHERE id=?').bind(m.connection_id).first<{max_posts:number}>();assert.equal(grant?.max_posts,200);
  const pair=await call('/agent-connections',{name:'Paired agent'});assert.equal(pair.status,201);const p=await pair.json() as {expires_in:number;user_code:string;device_code:string};assert.equal(p.expires_in,6*3600);
  clock+=5*3600000;
  assert.equal((await call('/connections/approve',{user_code:p.user_code,can_write:true},'owner')).status,200);
  const tokenResponse=await call('/agent-token',{device_code:p.device_code});assert.equal(tokenResponse.status,200);const paired=await tokenResponse.json() as {expires_in:number;connection:{max_posts:number}};assert.equal(paired.expires_in,72*3600);assert.equal(paired.connection.max_posts,200);
  const expired=await (await call('/agent-connections',{name:'Expired pending'})).json() as {user_code:string};clock+=6*3600000+1;
  assert.equal((await call('/connections/approve',{user_code:expired.user_code,can_write:true},'owner')).status,404);
  assert.equal((await call('/posts',post,undefined,m.access_token,'post-first')).status,201);
  const first=sqlite.raw.prepare('SELECT * FROM posts WHERE agent_id=?').get(m.connection_id)!;
  const columns=Object.keys(first),insert=sqlite.raw.prepare('INSERT INTO posts('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')');
  for(let i=1;i<199;i++)insert.run(...Object.values({...first,id:crypto.randomUUID(),idempotency_key:'fixture-'+i}));
  assert.equal((await call('/posts',post,undefined,m.access_token,'post-200')).status,201);
  assert.equal((await call('/posts',post,undefined,m.access_token,'post-201')).status,403);
  clock=originalNow()+71*3600000;assert.equal((await call('/me',undefined,undefined,m.access_token)).status,200);
  clock=Date.parse(m.expires_at)+1;assert.equal((await call('/me',undefined,undefined,m.access_token)).status,401);
 }finally{Date.now=originalNow;sqlite.close();}
});

test('OAuth consent lasts six hours, code ten minutes, access stays 24h and posts allowance is 200',async()=>{
 const {sqlite,DB}=setup(),originalNow=Date.now;let clock=originalNow();Date.now=()=>clock;
 const request=(path:string,body?:string,extra:Record<string,string>={})=>handleOAuth(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{...extra},...(body===undefined?{}:{body})}),DB);
 const form=(path:string,fields:Record<string,string>,extra:Record<string,string>={})=>request(path,new URLSearchParams(fields).toString(),{'Content-Type':'application/x-www-form-urlencoded',...extra});
 try{
  const owner=await createSession(new Request(origin),DB,{uid:'oauth-policy',email:'owner@example.test',name:'Owner',provider:'google.com'},false);
  const scopes='identity:read posts:read posts:write';
  const reg=await request('/oauth/register',JSON.stringify({redirect_uris:[museRedirect],token_endpoint_auth_method:'none',scope:scopes}),{'Content-Type':'application/json'});assert.equal(reg.status,201);const client=await reg.json() as {client_id:string};
  const verifier='v'.repeat(64),resource=origin+'/mcp';
  const open=async()=>{
   const r=await request('/oauth/authorize?'+new URLSearchParams({client_id:client.client_id,redirect_uri:museRedirect,response_type:'code',scope:scopes,resource,state:'policy',code_challenge:await pkceChallenge(verifier),code_challenge_method:'S256'}),undefined,{Cookie:'thread_session='+owner.token});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie')!,/Max-Age=21600/);
   const html=await r.text();return {id:html.match(/name="request_id" value="([^"]+)"/)![1],csrf:html.match(/name="csrf" value="([^"]+)"/)![1],cookie:r.headers.get('set-cookie')!.split(';')[0]};
  };
  const consent=await open(),lateConsent=await open();
  const pending=await DB.prepare('SELECT expires_at FROM oauth_requests WHERE id=?').bind(consent.id).first<{expires_at:number}>();assert.equal(pending!.expires_at-clock,6*3600000);
  const approve=(c:typeof consent)=>form('/oauth/authorize',{request_id:c.id,csrf:c.csrf,decision:'approve','allow_identity:read':'yes','allow_posts:read':'yes','allow_posts:write':'yes'},{Origin:origin,Cookie:'thread_session='+owner.token+'; '+c.cookie});
  clock+=5*3600000;const approved=await approve(consent);assert.equal(approved.status,303);
  const row=await DB.prepare('SELECT code_expires_at FROM oauth_requests WHERE id=?').bind(consent.id).first<{code_expires_at:number}>();assert.equal(row!.code_expires_at-clock,10*60000);
  const code=new URL(approved.headers.get('location')!).searchParams.get('code')!;
  const exchange=()=>form('/oauth/token',{grant_type:'authorization_code',client_id:client.client_id,redirect_uri:museRedirect,code,code_verifier:verifier,resource});
  clock+=9*60000;const token=await exchange();assert.equal(token.status,200);const t=await token.json() as {expires_in:number};assert.equal(t.expires_in,86400);
  assert.equal((await DB.prepare('SELECT max_posts FROM connections WHERE owner_id=?').bind(owner.ownerId).first<{max_posts:number}>())?.max_posts,200);
  assert.equal((await exchange()).status,400,'code remains single-use');
  const expiredCode=await open();const second=await approve(expiredCode);assert.equal(second.status,303);clock+=10*60000+1;
  const rejected=await form('/oauth/token',{grant_type:'authorization_code',client_id:client.client_id,redirect_uri:museRedirect,code:new URL(second.headers.get('location')!).searchParams.get('code')!,code_verifier:verifier,resource});assert.equal(rejected.status,400);
  clock=pending!.expires_at+1;assert.equal((await approve(lateConsent)).status,400);
 }finally{Date.now=originalNow;sqlite.close();}
});

test('5000-character multibyte item traverses MCP and REST; 5001 is rejected',async()=>{
 const {sqlite,DB,call}=setup();try{
  const published=await (await call('/posts',post,'seller',undefined,'speaker')).json() as {post:{id:string}};
  const key=await (await call('/connections/api-key',{name:'Buyer agent',can_write:false,can_negotiate:true},'buyer')).json() as {access_token:string};
  const terms={price:90,item:'界'.repeat(5000),condition:'Good',delivery:'local_pickup',terms:'配'.repeat(2000),expires_at:new Date(Date.now()+3600000).toISOString()};
  const rpc=async(item:string,keyId:string)=>{
   const r=await handleMcp(new Request(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+key.access_token},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'create_offer',arguments:{...terms,item,post_id:published.post.id,idempotency_key:keyId}}})}),{DB});return await r.json() as {result?:{isError?:boolean};error?:unknown};
  };
  const ok=await rpc(terms.item,'long-item');assert.equal(ok.result?.isError,false,JSON.stringify(ok));
  const stored=sqlite.raw.prepare('SELECT item FROM offers WHERE post_id=?').get(published.post.id);assert.equal(stored?.item,terms.item);
  const rejected=await rpc('界'.repeat(5001),'too-long');assert(rejected.error||rejected.result?.isError);
  assert.equal((await call('/posts/'+published.post.id+'/offers',{...terms,item:'x'.repeat(5001)},undefined,key.access_token,'rest-too-long')).status,400);
 }finally{sqlite.close();}
});
