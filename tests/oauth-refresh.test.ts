import {refreshAuthorization} from '@modelcontextprotocol/sdk/client/auth.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SQLiteDatabase} from '../runtime/sqlite.ts';
import {createSession} from '../backend/auth.ts';
import {handleOAuth,museRedirect,pkceChallenge,oauthMetadata} from '../backend/oauth.ts';
import {handleApi} from '../backend/service.ts';
import {handleMcp} from '../backend/mcp.ts';
import {hash} from '../backend/contracts.ts';
import {refreshIdleSeconds} from '../backend/oauth-refresh.ts';

async function fixture(){
 const origin='https://dealoop.example',resource=origin+'/mcp',sqlite=new SQLiteDatabase(':memory:');sqlite.migrate('drizzle');const db=sqlite.asD1();
 const owner=await createSession(new Request(origin),db,{uid:'refresh-owner',email:'owner@example.test',emailVerified:true,name:'Owner',provider:'google.com'},false);
 const other=await createSession(new Request(origin),db,{uid:'other-owner',email:'other@example.test',emailVerified:true,name:'Other',provider:'google.com'},false);
 const oauth=(path:string,method='GET',body?:string,headers:Record<string,string>={})=>handleOAuth(new Request(origin+path,{method,headers,...(body===undefined?{}:{body})}),db);
 const form=(path:string,fields:Record<string,string>,headers:Record<string,string>={})=>oauth(path,'POST',new URLSearchParams(fields).toString(),{'Content-Type':'application/x-www-form-urlencoded',...headers});
 const register=async(renewable=true)=>{const r=await oauth('/oauth/register','POST',JSON.stringify({redirect_uris:[museRedirect],token_endpoint_auth_method:'none',grant_types:renewable?['authorization_code','refresh_token']:['authorization_code']}),{'Content-Type':'application/json'});assert.equal(r.status,201);return (await r.json() as any).client_id as string;};
 const client=await register();
 async function grant(clientId=client,legacyPending=false){
  const verifier='x'.repeat(64),scope='identity:read posts:read';
  const page=await oauth('/oauth/authorize?'+new URLSearchParams({client_id:clientId,redirect_uri:museRedirect,response_type:'code',scope,resource,code_challenge:await pkceChallenge(verifier),code_challenge_method:'S256',state:'synthetic'}),'GET',undefined,{Cookie:'thread_session='+owner.token});
  assert.equal(page.status,200);const html=await page.text();
  const id=html.match(/name="request_id" value="([^"]+)"/)![1],csrf=html.match(/name="csrf" value="([^"]+)"/)![1];
  if(clientId===client)assert.match(html,/90 days without renewal/);
  assert.match(html,/24 hours/);
  if(legacyPending)await db.prepare('UPDATE oauth_requests SET renewable=0 WHERE id=?').bind(id).run();
  const approval=await form('/oauth/authorize',{request_id:id,csrf,decision:'approve','allow_identity:read':'yes','allow_posts:read':'yes'},{Origin:origin,Cookie:'thread_session='+owner.token+'; '+page.headers.get('set-cookie')!.split(';')[0]});assert.equal(approval.status,303);
  const fields={grant_type:'authorization_code',client_id:clientId,redirect_uri:museRedirect,code:new URL(approval.headers.get('location')!).searchParams.get('code')!,code_verifier:verifier,resource};
  const response=await form('/oauth/token',fields);assert.equal(response.status,200);const token=await response.json() as any;
  const row=await db.prepare('SELECT connection_id FROM oauth_requests WHERE id=?').bind(id).first<{connection_id:string}>();
  return {token,id:row!.connection_id,exchange:()=>form('/oauth/token',fields)};
 }
 const renew=(refresh:string,extra:Record<string,string>={})=>form('/oauth/token',{grant_type:'refresh_token',client_id:client,refresh_token:refresh,...extra});
 const api=(path:string,session=owner.token,method='GET')=>handleApi(new Request(origin+'/api/v1'+path,{method,headers:{Cookie:'thread_session='+session,Origin:origin,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})}),{DB:db});
 const read=(access:string,name='get_my_identity')=>handleMcp(new Request(resource,{method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{}}})}),{DB:db});
 return {sqlite,db,client,register,grant,renew,form,api,read,owner,other,resource};
}

test('renewable MCP consent rotates credentials across access expiry without changing identity, permissions or connection',async()=>{
 const f=await fixture();try{
  const {token,id}=await f.grant();assert.match(token.refresh_token,/^dlr_[a-f0-9]{64}$/);assert.equal(token.expires_in,86400);
  assert.equal((await f.read(token.access_token)).status,200);
  assert.equal((await f.read(token.refresh_token)).status,401,'refresh credentials cannot call tools');
  const stored=await f.db.prepare('SELECT * FROM oauth_refresh_tokens WHERE connection_id=?').bind(id).first() as any;
  assert.equal(stored.token_hash,await hash(token.refresh_token));assert.notEqual(stored.token_hash,token.refresh_token);
  await f.db.prepare('UPDATE connections SET expires_at=0 WHERE id=?').bind(id).run();
  assert.equal((await f.read(token.access_token)).status,401);
  const list=await (await f.api('/connections')).json() as any;assert.equal(list.connections.find((c:any)=>c.id===id).status,'active','connection persists when short token expires');
  // Resource omission inherits the binding, as OAuth clients commonly omit it on refresh.
  const response=await f.renew(token.refresh_token);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const rotated=await response.json() as any;
  assert.notEqual(rotated.access_token,token.access_token);assert.notEqual(rotated.refresh_token,token.refresh_token);assert.equal(rotated.scope,token.scope);
  assert.equal((await f.read(token.access_token)).status,401);assert.equal((await f.read(rotated.access_token)).status,200);assert.equal((await f.read(rotated.access_token,'publish_post')).status,403);
  const connection=await f.db.prepare('SELECT owner_id,oauth_scope,oauth_refresh_expires_at FROM connections WHERE id=?').bind(id).first() as any;
  assert.equal(connection.owner_id,f.owner.ownerId);assert.equal(connection.oauth_scope,'identity:read posts:read');assert(Math.abs(connection.oauth_refresh_expires_at-Date.now()-refreshIdleSeconds*1000)<5000);
  const final=await refreshAuthorization('https://dealoop.example',{metadata:oauthMetadata('https://dealoop.example'),clientInformation:{client_id:f.client,redirect_uris:[museRedirect],token_endpoint_auth_method:'none'},refreshToken:rotated.refresh_token,resource:f.resource,fetchFn:async(input,init)=>handleOAuth(new Request(input,init),f.db)});assert.equal((await f.read(final.access_token)).status,200);
  assert.equal((await f.api('/connections/'+id+'/revoke',f.other.token,'POST')).status,404);
  assert.equal((await f.api('/connections/'+id+'/revoke',f.owner.token,'POST')).status,200);
  assert.equal((await f.read(final.access_token)).status,401);assert.equal((await f.renew(final.refresh_token!)).status,400);
 }finally{f.sqlite.close();}
});

test('refresh rejects different clients, resources and scopes; valid replay disconnects the whole family',async()=>{
 const f=await fixture();try{
  const {token}=await f.grant(),otherClient=await f.register();
  for(const extra of [{client_id:otherClient},{resource:'https://other.test/mcp'},{scope:'identity:read posts:read posts:write'},{scope:'identity:read'}] as Record<string,string>[])assert.equal((await f.renew(token.refresh_token,extra)).status,400);
  assert.equal((await f.read(token.access_token)).status,200,'invalid bindings do not revoke the legitimate grant');
  assert.equal((await f.form('/oauth/revoke',{client_id:otherClient,token:token.refresh_token})).status,200);assert.equal((await f.read(token.access_token)).status,200);
  const rotated=await (await f.renew(token.refresh_token)).json() as any;
  assert.equal((await f.renew(token.refresh_token)).status,400,'reuse detected');
  assert.equal((await f.read(rotated.access_token)).status,401);assert.equal((await f.renew(rotated.refresh_token)).status,400);
  const fresh=await f.grant();const twins=await Promise.all([f.renew(fresh.token.refresh_token),f.renew(fresh.token.refresh_token)]);assert.deepEqual(twins.map(r=>r.status).sort(),[200,400]);
  const winning=await twins.find(r=>r.status===200)!.json() as any;assert.equal((await f.read(winning.access_token)).status,401,'a concurrent replay cannot leave a live family');assert.equal((await f.renew(winning.refresh_token)).status,400);
 }finally{f.sqlite.close();}
});

test('revocation by refresh or access credential, code replay, and inactivity prevent future renewal',async()=>{
 const f=await fixture();try{
  for(const kind of ['refresh_token','access_token']){
   const {token}=await f.grant();assert.equal((await f.form('/oauth/revoke',{client_id:f.client,token:token[kind],token_type_hint:kind})).status,200);
   assert.equal((await f.read(token.access_token)).status,401);assert.equal((await f.renew(token.refresh_token)).status,400);
  }
  const replay=await f.grant();const rotated=await (await f.renew(replay.token.refresh_token)).json() as any;assert.equal((await replay.exchange()).status,400);assert.equal((await f.renew(rotated.refresh_token)).status,400);
  const idle=await f.grant();await f.db.prepare('UPDATE connections SET oauth_refresh_expires_at=0 WHERE id=?').bind(idle.id).run();assert.equal((await f.renew(idle.token.refresh_token)).status,400);
  const expired=await f.grant();await f.db.prepare('UPDATE oauth_refresh_tokens SET expires_at=0 WHERE connection_id=?').bind(expired.id).run();assert.equal((await f.renew(expired.token.refresh_token)).status,400);
  const reusedRevoke=await f.grant();const next=await (await f.renew(reusedRevoke.token.refresh_token)).json() as any;
  assert.equal((await f.form('/oauth/revoke',{client_id:f.client,token:reusedRevoke.token.refresh_token})).status,200);assert.equal((await f.renew(next.refresh_token)).status,400,'even an earlier refresh token can revoke its family');
 }finally{f.sqlite.close();}
});

test('old clients and pending approvals retain bounded grants; an old access token cannot gain renewal',async()=>{
 const f=await fixture();try{
  for(const grant of [await f.grant(await f.register(false)),await f.grant(f.client,true)]){
   assert.equal(grant.token.refresh_token,undefined);const row=await f.db.prepare('SELECT oauth_refresh_expires_at FROM connections WHERE id=?').bind(grant.id).first() as any;assert.equal(row.oauth_refresh_expires_at,null);
   assert.equal((await f.renew(grant.token.access_token)).status,400);
   await f.db.prepare('UPDATE connections SET expires_at=0 WHERE id=?').bind(grant.id).run();assert.equal((await f.read(grant.token.access_token)).status,401);
  }
 }finally{f.sqlite.close();}
});


test('access lasts exactly 24 hours after issuance and renewal',async(t)=>{
 let stamp=Date.now();t.mock.method(Date,'now',()=>stamp);
 const f=await fixture();try{
  const {token,id}=await f.grant();
  assert.equal(token.expires_in,86400);
  const original=await f.db.prepare('SELECT expires_at FROM connections WHERE id=?').bind(id).first<{expires_at:number}>();
  assert.equal(original!.expires_at,stamp+86400000);
  const docs=await handleOAuth(new Request('https://dealoop.example/oauth/docs'),f.db);
  const guide=await docs.json() as any;assert.equal(guide.expires_in,86400);assert.match(guide.instructions,/24 hours/);
  stamp+=86400000-1;assert.equal((await f.read(token.access_token)).status,200);
  stamp+=1;assert.equal((await f.read(token.access_token)).status,401);
  const response=await f.renew(token.refresh_token);assert.equal(response.status,200);
  const renewed=await response.json() as any;assert.equal(renewed.expires_in,86400);
  const after=await f.db.prepare('SELECT expires_at FROM connections WHERE id=?').bind(id).first<{expires_at:number}>();
  assert.equal(after!.expires_at,stamp+86400000);
  assert.equal((await f.read(renewed.access_token)).status,200);
  assert.equal(renewed.scope,token.scope);
  stamp+=86400000;assert.equal((await f.read(renewed.access_token)).status,401);
 }finally{f.sqlite.close();}
});
