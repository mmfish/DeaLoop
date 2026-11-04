import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SQLiteDatabase} from '../runtime/sqlite.ts';
import {createSession} from '../backend/auth.ts';
import {handleApi} from '../backend/service.ts';
import {handleOAuth,museRedirect,pkceChallenge,oauthScope} from '../backend/oauth.ts';
import {awsOpenapi} from '../backend/aws-discovery.ts';

test('independent consent tabs remain valid when opened and submitted in the same browser',async()=>{
 const origin='https://dealoop.example',sqlite=new SQLiteDatabase(':memory:');sqlite.migrate('drizzle');const db=sqlite.asD1();
 const owner=await createSession(new Request(origin),db,{uid:'parallel-owner',email:'owner@example.test',emailVerified:true,name:'Owner',provider:'google.com'},false);
 const jar=new Map([['thread_session',owner.token]]);
 const call=async(path:string,method='GET',body?:string,extra:Record<string,string>={})=>{
  const response=await handleOAuth(new Request(origin+path,{method,headers:{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),Origin:origin,...extra},...(body===undefined?{}:{body})}),db);
  const cookie=response.headers.get('set-cookie');if(cookie){const [name,value]=cookie.split(';')[0].split('=');if(cookie.includes('Max-Age=0'))jar.delete(name);else jar.set(name,value);}
  return response;
 };
 try{
  const registration=await call('/oauth/register','POST',JSON.stringify({redirect_uris:[museRedirect],token_endpoint_auth_method:'none'}),{'Content-Type':'application/json'});
  const client=await registration.json() as any;
  const query={client_id:client.client_id,redirect_uri:museRedirect,response_type:'code',scope:'identity:read posts:read',resource:origin+'/mcp',code_challenge:await pkceChallenge('x'.repeat(64)),code_challenge_method:'S256'};
  const open=async(state:string)=>{const r=await call('/oauth/authorize?'+new URLSearchParams({...query,state}));assert.equal(r.status,200);const html=await r.text();return {request_id:html.match(/name="request_id" value="([^"]+)"/)![1],csrf:html.match(/name="csrf" value="([^"]+)"/)![1],decision:'approve','allow_identity:read':'yes','allow_posts:read':'yes'};};
  const first=await open('first-tab'),second=await open('second-tab');
  const submit=(fields:Record<string,string>)=>call('/oauth/authorize','POST',new URLSearchParams(fields).toString(),{'Content-Type':'application/x-www-form-urlencoded'});
  const firstApproval=await submit(first);assert.equal(firstApproval.status,303,'opening a second tab must not invalidate the first');
  assert.equal(new URL(firstApproval.headers.get('location')!).searchParams.get('state'),'first-tab');
  const secondApproval=await submit(second);assert.equal(secondApproval.status,303,'approving the first tab must not clear the second tab cookie');
  assert.equal(new URL(secondApproval.headers.get('location')!).searchParams.get('state'),'second-tab');
  assert.equal((await submit(first)).status,403,'cleared browser nonce cannot be reused');
  const third=await open('third-tab'),fourth=await open('fourth-tab');
  assert.equal((await submit({...third,csrf:fourth.csrf})).status,403,'a different tab nonce must never authorize this request');
  const recovery=await call('/oauth/authorize','POST',new URLSearchParams({...third,csrf:fourth.csrf}).toString(),{'Content-Type':'application/x-www-form-urlencoded',Accept:'text/html'});
  assert.equal(recovery.status,403);assert.match(recovery.headers.get('content-type')!,/text\/html/);
  const recoveryHtml=await recovery.text();assert.match(recoveryHtml,/Connection not completed/);assert.match(recoveryHtml,/click <strong>Connect<\/strong> again/);assert(!recoveryHtml.includes(third.csrf));assert(!recoveryHtml.includes(fourth.csrf));
  assert.equal((await submit({...fourth,decision:'deny'})).status,303);
  assert.equal((await submit(third)).status,303,'cancelling another tab must not invalidate this one');
  const legacy=await open('previous-release-tab');jar.delete('dealoop_oauth_consent_'+legacy.request_id);jar.set('dealoop_oauth_consent',legacy.csrf);
  assert.equal((await submit(legacy)).status,303,'a pending legacy cookie remains hash-bound during the rollout');
 }finally{sqlite.close();}
});

// Exercise actual SQL transactions and HTTP interfaces. Never log test credentials.
test('OAuth identity proof binds consent, client, callback and S256; isolates owners, limits scope and enforces lifetime/revocation',async()=>{
 const origin='https://dealoop.example';const sqlite=new SQLiteDatabase(':memory:');sqlite.migrate('drizzle');const db=sqlite.asD1();
 const req=(path:string,method='GET',body?:string,headers:Record<string,string>={})=>new Request(origin+path,{method,headers,...(body===undefined?{}:{body})});
 const oauth=(path:string,method='GET',body?:string,headers:Record<string,string>={})=>handleOAuth(req(path,method,body,headers),db);
 const form=(path:string,fields:Record<string,string>,headers:Record<string,string>={})=>oauth(path,'POST',new URLSearchParams(fields).toString(),{'Content-Type':'application/x-www-form-urlencoded',...headers});
 const register=async(extra:Record<string,unknown>={})=>oauth('/oauth/register','POST',JSON.stringify({redirect_uris:[museRedirect],token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code'],scope:oauthScope,...extra}),{'Content-Type':'application/json'});
 const identity={uid:'oauth-alice',email:'alice@example.test',emailVerified:true,name:'Alice',provider:'google.com'};
 const alice=await createSession(req('/'),db,identity,false),bob=await createSession(req('/'),db,{...identity,uid:'oauth-bob',email:'bob@example.test',name:'Bob'},false);
 const aCookie='thread_session='+alice.token,bCookie='thread_session='+bob.token;
 try{
  const discovery=await (await oauth('/.well-known/oauth-authorization-server')).json() as any;
  assert.deepEqual(discovery.code_challenge_methods_supported,['S256']);assert(discovery.scopes_supported.includes('identity:read'));assert(discovery.scopes_supported.includes('posts:write'));assert.deepEqual(discovery.grant_types_supported,['authorization_code','refresh_token']);
  assert(awsOpenapi().paths['/api/v1/me'].get.security.some((x:any)=>x.DealoopOAuth));
  assert.equal((await register({redirect_uris:['https://evil.test/callback']})).status,400);
  assert.equal((await register({redirect_uris:[museRedirect+'?next=evil']})).status,400);
  assert.equal((await register({token_endpoint_auth_method:'client_secret_post'})).status,400);
  assert.equal((await register({scope:'unknown:scope'})).status,400);
  assert.equal((await register({grant_types:['client_credentials']})).status,400);
  const narrowed=await register({grant_types:['authorization_code','refresh_token']});assert.equal(narrowed.status,201);assert.deepEqual((await narrowed.json() as any).grant_types,['authorization_code','refresh_token']);
  const registration=await register();assert.equal(registration.status,201);const client=await registration.json() as any;assert.equal(client.client_secret,undefined);
  const verifier='x'.repeat(64),challenge=await pkceChallenge(verifier);
  const query={client_id:client.client_id,redirect_uri:museRedirect,response_type:'code',scope:oauthScope,state:'test-client-state',code_challenge:challenge,code_challenge_method:'S256'};
  const authorize=(change:Record<string,string>={},cookie=aCookie)=>oauth('/oauth/authorize?'+new URLSearchParams({...query,...change}), 'GET',undefined,cookie?{Cookie:cookie}:{});
  const unauth=await authorize({},'');assert.equal(unauth.status,303);assert.match(unauth.headers.get('location')!,/^\/login\?return_to=/);
  for(const change of [{redirect_uri:'https://evil.test'},{scope:'identity:read posts:write'},{code_challenge_method:'plain'},{code_challenge:''},{state:''},{response_type:'token'},{client_id:'fake'}] as Record<string,string>[]){const r=await authorize(change);assert.equal(r.status,400);assert.equal(r.headers.get('location'),null);}
  assert.equal((await oauth('/oauth/authorize?'+new URLSearchParams(query)+'&client_id=duplicate')).status,400);
  async function consent(cookie=aCookie){const r=await authorize({},cookie);assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy')!,/frame-ancestors 'none'/);const html=await r.text();assert(!html.includes('sidebar'));const id=html.match(/name="request_id" value="([^"]+)"/)![1],csrf=html.match(/name="csrf" value="([^"]+)"/)![1];return {id,csrf,cookie:cookie+'; '+r.headers.get('set-cookie')!.split(';')[0]};}
  // A native HTML form must retain Origin on same-origin POST, without leaking
  // authorization query parameters to the external callback or other sites.
  assert.equal((await authorize()).headers.get('referrer-policy'),'same-origin');
  const consentPolicy=(await authorize()).headers.get('content-security-policy')!;
  assert.equal(consentPolicy.split(';').map(x=>x.trim()).find(x=>x.startsWith('form-action ')),"form-action 'self' "+museRedirect+' https://muse.ai/api/hatch/oauth/callback','browser must allow both registered and canonical callback hops after form submission');
  assert.equal((await register({redirect_uris:['https://muse.ai/api/hatch/oauth/callback']})).status,400,'CSP navigation permission must not broaden client registration');
  const first=await consent();
  const submit=(c:Awaited<ReturnType<typeof consent>>,decision='approve',headers:Record<string,string>={})=>form('/oauth/authorize',{request_id:c.id,csrf:c.csrf,decision},{Origin:origin,Cookie:c.cookie,...headers});
  assert.equal((await submit(first,'approve',{Origin:'https://evil.test'})).status,403);
  assert.equal((await submit(first,'approve',{Origin:'null'})).status,403);
  assert.equal((await form('/oauth/authorize',{request_id:first.id,csrf:first.csrf,decision:'approve'},{Cookie:first.cookie})).status,403);
  assert.equal((await submit(first,'approve',{Cookie:bCookie+'; '+first.cookie.split('; ')[1]})).status,403);
  assert.equal((await submit(first,'approve',{Cookie:aCookie})).status,403);
  assert.equal((await submit({...first,csrf:'0'.repeat(64)})).status,403);
  const approved=await submit(first);assert.equal(approved.status,303);assert.match(approved.headers.get('set-cookie')!,/Max-Age=0/);assert.equal(approved.headers.get('referrer-policy'),'no-referrer');
  const callback=new URL(approved.headers.get('location')!);assert.equal(callback.origin+callback.pathname,museRedirect);assert.equal(callback.searchParams.get('state'),query.state);const code=callback.searchParams.get('code')!;
  assert.equal((await submit(first)).status,400);
  const exchange=(change:Record<string,string>={})=>form('/oauth/token',{grant_type:'authorization_code',client_id:client.client_id,redirect_uri:museRedirect,code,code_verifier:verifier,...change});
  for(const change of [{code_verifier:'z'.repeat(64)},{client_id:'other'},{redirect_uri:museRedirect+'/'},{scope:'posts:write'}] as Record<string,string>[])assert.equal((await exchange(change)).status,400);
  assert.equal((await exchange({client_secret:'not-accepted'})).status,401);
  const exchanged=await exchange();assert.equal(exchanged.status,200);assert.equal(exchanged.headers.get('cache-control'),'no-store');const token=await exchanged.json() as any;assert.equal(token.scope,'identity:read');assert.equal(token.expires_in,86400);assert.equal(token.refresh_token,undefined);
  const api=(path:string,method='GET',cookie?:string)=>handleApi(req('/api/v1'+path,method,method==='GET'?undefined:'{}',{Authorization:'Bearer '+token.access_token,Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})}),{DB:db});
  const me=await api('/me');assert.equal(me.status,200);const data=await me.json() as any;assert.equal(data.account_id,alice.ownerId);assert.equal(data.actor,'agent');assert.deepEqual(data.scopes,['identity:read']);assert.equal((await (await api('/me','GET',bCookie)).json() as any).account_id,alice.ownerId);
  for(const path of ['/my-posts','/activity','/offers','/events','/connections'])assert.equal((await api(path)).status,403,path);
  for(const path of ['/posts','/photos','/connections/api-key','/connections/approve','/offers/any/messages','/offers/any/accept'])assert.equal((await api(path,'POST')).status,403,path);
  const row=await db.prepare('SELECT * FROM connections WHERE owner_id=? AND oauth_scope=?').bind(alice.ownerId,oauthScope).first() as any;assert(row);assert.notEqual(row.token_hash,token.access_token);assert.equal(row.can_write,0);assert.equal(row.can_negotiate,0);assert.equal(row.can_accept,0);assert.equal(row.max_posts,0);
  const humanRevoke=(cookie:string)=>handleApi(req('/api/v1/connections/'+row.id+'/revoke','POST','{}',{Cookie:cookie,Origin:origin,'Content-Type':'application/json'}),{DB:db});
  assert.equal((await humanRevoke(bCookie)).status,404);assert.equal((await api('/me')).status,200);assert.equal((await humanRevoke(aCookie)).status,200);assert.equal((await api('/me')).status,401);
  const denied=await consent();const deniedRedirect=new URL((await submit(denied,'deny')).headers.get('location')!);assert.equal(deniedRedirect.searchParams.get('error'),'access_denied');assert.equal(deniedRedirect.searchParams.has('code'),false);assert.equal((await submit(denied)).status,400);
  const expired=await consent();await db.prepare('UPDATE oauth_requests SET expires_at=0 WHERE id=?').bind(expired.id).run();assert.equal((await submit(expired)).status,400);
  async function fresh(){const c=await consent();const r=await submit(c);return {c,code:new URL(r.headers.get('location')!).searchParams.get('code')!};}
  const expiredCode=await fresh();await db.prepare('UPDATE oauth_requests SET code_expires_at=0 WHERE id=?').bind(expiredCode.c.id).run();assert.equal((await exchange({code:expiredCode.code})).status,400);
  const concurrent=await fresh();const twins=await Promise.all([exchange({code:concurrent.code}),exchange({code:concurrent.code})]);assert.deepEqual(twins.map(r=>r.status).sort(),[200,400]);const used=await db.prepare('SELECT status FROM connections WHERE id=(SELECT connection_id FROM oauth_requests WHERE id=?)').bind(concurrent.c.id).first() as any;assert.equal(used.status,'revoked');
  const ttl=await fresh();const t=await (await exchange({code:ttl.code})).json() as any;await db.prepare('UPDATE connections SET expires_at=0 WHERE id=(SELECT connection_id FROM oauth_requests WHERE id=?)').bind(ttl.c.id).run();assert.equal((await handleApi(req('/api/v1/me','GET',undefined,{Authorization:'Bearer '+t.access_token}),{DB:db})).status,401);
  const rev=await fresh();const rt=await (await exchange({code:rev.code})).json() as any;const otherClient=await (await register()).json() as any;
  assert.equal((await form('/oauth/revoke',{client_id:otherClient.client_id,token:rt.access_token})).status,200);
  const read=()=>handleApi(req('/api/v1/me','GET',undefined,{Authorization:'Bearer '+rt.access_token}),{DB:db});assert.equal((await read()).status,200);
  assert.equal((await form('/oauth/revoke',{client_id:client.client_id,token:rt.access_token})).status,200);assert.equal((await read()).status,401);assert.equal((await form('/oauth/revoke',{client_id:client.client_id,token:'unknown'})).status,200);
  assert.equal((await form('/oauth/token',{grant_type:'refresh_token',refresh_token:'invalid'})).status,400);
 }finally{sqlite.close();}
});
