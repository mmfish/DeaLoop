import {pendingConnectionSeconds,authorizationCodeSeconds,agentPostAllowance} from './policy.ts';
import {accessTokenSeconds,refreshIdleSeconds,renewOAuth} from './oauth-refresh.ts';
import {supportedScopes,parseScopes,mcpResource} from './oauth-scopes.ts';
import {ApiError,fail,hash,secret,now} from './contracts.ts';
import {humanFor,requireSameOrigin} from './auth.ts';

// Exact-callback Muse authorization, with separate identity-proof and MCP grants.
export const oauthScope='identity:read';
export const oauthLifetime=accessTokenSeconds;
// Exact callback reported by a public Muse integration. Confirm against the live
// DCR/authorization request; never broaden to wildcard hosts or caller redirects.
export const museRedirect='https://agent.meta.ai/api/hatch/oauth/callback';
// Chrome applies form-action to the redirect after the consent POST too.
// Allow the fixed Muse callback as well as our own form target; never derive
// CSP destinations from caller input. Server redirect validation stays exact.
// Meta's legacy callback responds 302 to this canonical Muse host. This is a
// browser-navigation allowance only, not a second registered redirect URI.
const museCanonicalCallback='https://muse.ai/api/hatch/oauth/callback';
const consentCsp="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self' "+museRedirect+' '+museCanonicalCallback+"; base-uri 'none'; frame-ancestors 'none'";
const cookieName='dealoop_oauth_consent';
const requestCookieName=(id:string)=>cookieName+'_'+id;
type Client={refresh_enabled:number;id:string;redirect_uri:string;created_at:number};
type Pending={renewable:number;scope:string;resource:string|null;id:string;client_id:string;redirect_uri:string;state:string;challenge:string;owner_id:string;csrf_hash:string;status:string;expires_at:number;code_hash:string|null;code_expires_at:number|null;connection_id:string|null;issued_token_hash:string|null};
export function oauthMetadata(origin:string){return {issuer:origin,authorization_endpoint:origin+'/oauth/authorize',token_endpoint:origin+'/oauth/token',registration_endpoint:origin+'/oauth/register',revocation_endpoint:origin+'/oauth/revoke',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],revocation_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],scopes_supported:[...supportedScopes],response_modes_supported:['query']};}
export function oauthGuide(origin:string){return {service:'DeaLoop OAuth',...oauthMetadata(origin),api_hosts:[new URL(origin).hostname],auth_scheme:'oauth2_code',token_endpoint_auth_method:'none',scope:oauthScope,mcp_resource:mcpResource(origin),marketplace_scopes:[...supportedScopes],expires_in:oauthLifetime,refresh_supported:true,refresh_idle_expires_in:refreshIdleSeconds,instructions:'Use the native secure OAuth authorization-code connector with dynamic registration and PKCE S256. MCP grants require resource='+mcpResource(origin)+' at authorization and token exchange. For standard marketplace onboarding, explicitly list all supported permissions to the owner and include the full scope list in BOTH client registration and the authorization request: identity:read posts:read posts:write offers:read offers:write messages:write events:read deals:accept. This makes every permission visible on the consent page, including final deal selection (deals:accept). If the owner explicitly asks for read-only or narrower access, honor that restriction. Requesting permissions is not approval: let the owner select them; never approve or select checkboxes for the owner. After connecting, call get_my_identity, report the actual granted actions, and explicitly state whether you can select a deal and close a post. If deals:accept is absent, final selection stays with the owner; request fresh consent before expanding access. Register with grant_types authorization_code and refresh_token for a renewable MCP connection. Access tokens last 24 hours; refresh tokens rotate on each use and expire after 90 days without renewal. Serialize refresh requests, securely replace both tokens, and never retry a consumed refresh token. On invalid_grant stop and ask the owner to reconnect. Existing grants are not upgraded. Without resource, only the legacy identity:read proof for GET /api/v1/me is supported. Never approve your own grant or expose credentials in chat.'};}
async function limitedBody(req:Request){const reader=req.body?.getReader();let raw='',size=0;const decoder=new TextDecoder();if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();fail(413,'invalid_request','Request is too large.');}raw+=decoder.decode(value,{stream:true});}return raw+decoder.decode();}
function params(raw:string){const p=new URLSearchParams(raw);for(const key of p.keys())if(p.getAll(key).length!==1)fail(400,'invalid_request','Duplicate parameters are not accepted.');return p;}
async function form(req:Request){if(req.headers.get('content-type')?.split(';')[0]!=='application/x-www-form-urlencoded')fail(415,'invalid_request','Use application/x-www-form-urlencoded.');return params(await limitedBody(req));}
// Same cf-connecting-ip trust as the shared limiter (see rateLimit in
// service.ts): overwritten by Caddy on AWS, set by Cloudflare on Sites.
async function rate(db:D1Database,key:string,limit:number){const time=now(),bucket=Math.floor(time/900000),id=await hash('oauth:'+key+':'+bucket);const out=await db.batch([db.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(time),db.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').bind(id,(bucket+1)*900000),db.prepare('SELECT count FROM rate_limits WHERE key=?').bind(id)]);if(Number((out[2].results[0] as {count:number}).count)>limit)fail(429,'temporarily_unavailable','Too many attempts. Try again later.');}
const escape=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function consentErrorHtml(message:string){return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Connection not completed · DeaLoop</title><style>body{margin:0;background:#f6f8f5;color:#123d32;font:16px/1.6 system-ui,sans-serif}main{max-width:460px;margin:8vh auto;padding:32px;background:white;border:1px solid #dce7df;border-radius:24px}img{width:210px;height:auto}h1{font-size:28px;line-height:1.2}p{color:#52675f}a{color:#123d32}a:focus-visible{outline:3px solid #17b789;outline-offset:4px}@media(max-width:540px){main{margin:24px 16px;padding:24px}}</style></head><body><main><a href="/" aria-label="DeaLoop home"><img src="/brand/dealoop-wordmark.png" alt="DeaLoop AI"></a><h1>Connection not completed</h1><p>${escape(message)}</p><p>Return to the Muse chat where you started this connection and click <strong>Connect</strong> again. Complete the new approval page in the same browser profile.</p><p>This attempt did not grant access.</p><a href="/connections">View your existing connections</a></main></body></html>`;}
function consentHtml(name:string,email:string,id:string,csrf:string,clientId:string,scopes:string[],resource:string|null,renewable:boolean){
 const marketplace=!!resource;
 const labels:Record<string,string>={'identity:read':'Read your account identity and permissions','posts:read':'Read your posts and activity','posts:write':'Publish up to 200 posts and top-offer shortlists (shortlists also require reading offers)','offers:read':'Read your private offers and conversations','offers:write':'Make offers, revise terms, confirm, decline or withdraw','messages:write':'Send messages in your offer conversations','events:read':'Read your private event inbox','deals:accept':'Select an offer and close your post'};
 const choices=scopes.map(scope=>'<label class="choice"><input type="checkbox" name="allow_'+scope+'" value="yes" '+(scope.endsWith(':read')?'checked':'')+'><span>'+labels[scope]+'</span></label>').join('');
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Connect Muse · DeaLoop</title><style>body{margin:0;background:#f6f8f5;color:#123d32;font:16px/1.55 system-ui,sans-serif}main{max-width:460px;margin:8vh auto;padding:32px;background:white;border:1px solid #dce7df;border-radius:24px;box-shadow:0 16px 50px #123d3209}img{width:210px;height:auto}h1{font-size:29px;line-height:1.2;margin:24px 0 12px}p{color:#52675f}.account,.permission{padding:16px;background:#f0f6f2;border-radius:12px;margin:18px 0}.account span{display:block;overflow-wrap:anywhere}small{font-size:13px;color:#52675f}ul{padding-left:22px}li{margin:8px 0}form{margin-top:24px}.buttons{display:flex;gap:12px}.choice{display:flex;gap:10px;margin:14px 0}.choice input{width:18px;height:18px;flex-shrink:0}button{font:inherit;font-weight:600;padding:13px 18px;border-radius:12px;border:1px solid #cddbd3;cursor:pointer;background:white;color:#123d32}.approve{background:#123d32;color:white;flex:1}button:focus-visible,a:focus-visible{outline:3px solid #17b789;outline-offset:4px}a{color:#123d32}.fine{font-size:13px}.client{word-break:break-all}@media(max-width:540px){main{margin:24px 16px;padding:24px}h1{font-size:26px}}</style></head><body><main><a href="/" aria-label="DeaLoop home"><img src="/brand/dealoop-wordmark.png" alt="DeaLoop AI"></a><h1>${marketplace?'Connect Muse to DeaLoop':'Let Muse confirm your account'}</h1><p>${marketplace?'Choose what Muse may do on your behalf. No API key copying is needed.':'Connect without copying an API key. This short test only verifies your DeaLoop identity.'}</p><div class="account"><strong>${escape(name)}</strong><span>${escape(email)}</span><small>Your signed-in DeaLoop account</small></div><form method="post" action="/oauth/authorize"><div class="permission"><strong>What you’re allowing</strong>${marketplace?choices:''}<ul>${marketplace?'':'<li>Read your DeaLoop account ID and connection permissions.</li>'}<li>${renewable?'Stay connected until you disconnect, or after 90 days without renewal. Muse may renew access automatically with these same permissions.':'Access for 24 hours, or until you revoke it.'}</li></ul></div><p>${marketplace?'Give Muse your budget and product requirements directly; DeaLoop does not judge commercial suitability. Deal selection requires all four offer, message and event permissions. No payment or delivery booking.':'No access to your private posts, activity or conversations. No publishing, offers, deal acceptance or payments.'}</p><p class="fine">Approve only if you just asked your Muse to connect. The request uses Muse’s registered callback; the client name alone does not verify who initiated it. You can revoke this connection from <a href="/connections">Your connections</a>.</p><details class="fine"><summary>Connection details</summary><p>Requested scopes: ${escape(scopes.join(' '))}${resource?'<br>Resource: '+escape(resource):''}<br>Callback: agent.meta.ai<br><span class="client">Client: ${escape(clientId)}</span><br>${renewable?'Access tokens expire after 24 hours and renew through your secure connector. Disconnecting stops both access and renewal.':'No automatic renewal.'}</p></details><input type="hidden" name="request_id" value="${escape(id)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><div class="buttons"><button name="decision" value="deny">Cancel</button><button class="approve" name="decision" value="approve">${marketplace?'Allow selected permissions':'Allow identity check'}</button></div></form></main></body></html>`;}
export async function pkceChallenge(verifier:string){const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export async function handleOAuth(req:Request,db:D1Database):Promise<Response>{
 const url=new URL(req.url),path=url.pathname,requestId=crypto.randomUUID();
 const headers={'Cache-Control':'no-store','Pragma':'no-cache','X-Request-ID':requestId,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};
 const json=(body:unknown,status=200)=>Response.json(body,{status,headers});
 const redirect=(location:string,cookie?:string)=>new Response(null,{status:303,headers:{...headers,Location:location,...(cookie?{'Set-Cookie':cookie}:{})}});
 const cookie=(name:string,value:string,age=pendingConnectionSeconds)=>`${name}=${value}; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=${age}${url.protocol==='https:'?'; Secure':''}`;
 try{
  if(req.method==='GET'&&path==='/.well-known/oauth-authorization-server')return json(oauthMetadata(url.origin));
  if(req.method==='GET'&&path==='/oauth/docs')return json(oauthGuide(url.origin));
  if(req.method==='POST'&&path==='/oauth/register'){
   await rate(db,'register:'+req.headers.get('cf-connecting-ip'),20);
   if(req.headers.get('content-type')?.split(';')[0]!=='application/json')fail(415,'invalid_client_metadata','Use application/json.');
   let b:Record<string,unknown>;try{b=JSON.parse(await limitedBody(req));}catch(e){if(e instanceof ApiError)throw e;fail(400,'invalid_client_metadata','Invalid JSON.');}
   if(!b||typeof b!=='object'||Array.isArray(b))fail(400,'invalid_client_metadata','Expected a JSON object.');
   if(!Array.isArray(b.redirect_uris)||b.redirect_uris.length!==1||b.redirect_uris[0]!==museRedirect)fail(400,'invalid_redirect_uri','This proof accepts only the exact registered Muse callback.');
   if(b.token_endpoint_auth_method!=='none'||b.grant_types!==undefined&&(!Array.isArray(b.grant_types)||!b.grant_types.includes('authorization_code')||b.grant_types.some(g=>!['authorization_code','refresh_token'].includes(String(g))))||b.response_types!==undefined&&JSON.stringify(b.response_types)!=='["code"]')fail(400,'invalid_client_metadata','Use a public authorization-code client, no client secret, and supported DeaLoop scopes.');
   const refreshEnabled=Array.isArray(b.grant_types)&&b.grant_types.includes('refresh_token');
   const registeredScopes=parseScopes(b.scope??supportedScopes.join(' ')).join(' ');
   const id='dl_muse_'+secret(),stamp=now();
   await db.prepare('INSERT INTO oauth_clients(id,redirect_uri,created_at,refresh_enabled) VALUES(?,?,?,?)').bind(id,museRedirect,stamp,refreshEnabled?1:0).run();
   return json({client_id:id,client_id_issued_at:Math.floor(stamp/1000),client_name:'Muse — DeaLoop',redirect_uris:[museRedirect],token_endpoint_auth_method:'none',grant_types:refreshEnabled?['authorization_code','refresh_token']:['authorization_code'],response_types:['code'],scope:registeredScopes},201);
  }
  if(req.method==='GET'&&path==='/oauth/authorize'){
   await rate(db,'authorize:'+req.headers.get('cf-connecting-ip'),60);
   const p=params(url.search.slice(1));const client=await db.prepare('SELECT * FROM oauth_clients WHERE id=?').bind(p.get('client_id')||'').first<Client>();
   if(!client||p.get('redirect_uri')!==client.redirect_uri)fail(400,'invalid_request','Unknown client or redirect URI.');
   // Fail locally without redirecting any malformed or downgraded request.
   if(p.get('response_type')!=='code'||p.get('code_challenge_method')!=='S256'||! /^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge')||''))fail(400,'invalid_request','Authorization code with PKCE S256 is required.');
   const requestedScopes=parseScopes(p.get('scope')||oauthScope),resource=p.get('resource');
   if(resource!==null&&resource!==mcpResource(url.origin))fail(400,'invalid_target','Unknown resource.');
   if(!resource&&requestedScopes.join(' ')!==oauthScope)fail(400,'invalid_scope','Marketplace scopes require the MCP resource parameter.');
   const state=p.get('state');if(!state||state.length>1024)fail(400,'invalid_request','A state value of 1–1024 characters is required.');
   if(p.has('response_mode')&&p.get('response_mode')!=='query')fail(400,'invalid_request','Use query response mode.');
   const user=await humanFor(req.headers,db);
   if(!user)return redirect('/login?return_to='+encodeURIComponent(url.pathname+url.search));
   const id=crypto.randomUUID(),csrf=secret(),renewable=!!resource&&!!client.refresh_enabled;
   await db.batch([db.prepare("DELETE FROM oauth_requests WHERE expires_at<? AND status IN ('pending','denied')").bind(now()),db.prepare("DELETE FROM oauth_requests WHERE status='approved' AND code_expires_at<?").bind(now()-86400000),db.prepare("INSERT INTO oauth_requests(id,client_id,redirect_uri,state,challenge,owner_id,csrf_hash,status,expires_at,scope,resource,renewable) VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?)").bind(id,client.id,client.redirect_uri,state,p.get('code_challenge'),user.userId,await hash(csrf),now()+pendingConnectionSeconds*1000,requestedScopes.join(' '),resource,renewable?1:0)]);
   // Native form POSTs use Origin:null under no-referrer. Keep a verifiable
   // same-origin submission while still withholding referrers cross-origin.
   // Other responses (including the callback redirect) remain no-referrer.
   return new Response(consentHtml(user.displayName,user.email,id,csrf,client.id,requestedScopes,resource,renewable),{headers:{...headers,'Referrer-Policy':'same-origin','Content-Type':'text/html; charset=utf-8','Set-Cookie':cookie(requestCookieName(id),csrf),'Content-Security-Policy':consentCsp}});
  }
  if(req.method==='POST'&&path==='/oauth/authorize'){
   requireSameOrigin(req);const user=await humanFor(req.headers,db);if(!user)fail(401,'login_required','Sign in again and restart the connection.');
   const p=await form(req);await rate(db,'consent:'+user.userId,30);
   const row=await db.prepare('SELECT * FROM oauth_requests WHERE id=?').bind(p.get('request_id')||'').first<Pending>();
   if(!row)fail(403,'invalid_request','This connection page has expired or is no longer available.');
   if(row.owner_id!==user.userId)fail(403,'invalid_request','The signed-in account changed after this approval page was opened.');
   // Each tab owns its own nonce cookie. Opening, refreshing or deciding another
   // request must not overwrite or clear this request's browser binding.
   const allCookies=(req.headers.get('cookie')||'').split(';').map(x=>x.trim());
   const scopedName=requestCookieName(row.id);
   // Honor still-pending pages from the previous release for their normal TTL;
   // the stored nonce hash and owner checks still bind that legacy cookie.
   const selectedCookie=allCookies.some(x=>x.startsWith(scopedName+'='))?scopedName:cookieName;
   const cookies=allCookies.filter(x=>x.startsWith(selectedCookie+'=')),csrf=p.get('csrf')||'';
   if(cookies.length!==1||cookies[0]!==selectedCookie+'='+csrf||! /^[a-f0-9]{64}$/.test(csrf)||await hash(csrf)!==row.csrf_hash)fail(403,'invalid_request','This approval page no longer matches this browser. It may have been replaced by another connection attempt, or its cookie is missing.');
   if(row.status!=='pending'||row.expires_at<=now())fail(400,'invalid_request','This connection request has expired or was already decided.');
   const decision=p.get('decision');if(!['approve','deny'].includes(decision||''))fail(400,'invalid_request','Choose Allow or Cancel.');
   const selected=row.resource&&decision==='approve'?parseScopes(row.scope.split(' ').filter(scope=>p.get('allow_'+scope)==='yes').join(' ')).join(' '):row.scope;
   const code=secret(),connectionId=crypto.randomUUID();
   const changed=await db.prepare("UPDATE oauth_requests SET status=?,code_hash=?,code_expires_at=?,connection_id=?,scope=? WHERE id=? AND status='pending' AND expires_at>? RETURNING id").bind(decision==='approve'?'approved':'denied',decision==='approve'?await hash(code):null,now()+authorizationCodeSeconds*1000,connectionId,selected,row.id,now()).first();
   if(!changed)fail(400,'invalid_request','This request was already decided.');
   const dest=new URL(row.redirect_uri);dest.searchParams.set('state',row.state);if(decision==='approve')dest.searchParams.set('code',code);else dest.searchParams.set('error','access_denied');
   return redirect(dest.href,cookie(selectedCookie,'',0));
  }
  if(req.method==='POST'&&path==='/oauth/token'){
   await rate(db,'token:'+req.headers.get('cf-connecting-ip'),120);const p=await form(req);
   if(req.headers.has('authorization')||p.has('client_secret'))fail(401,'invalid_client','This public client uses token_endpoint_auth_method none.');
   if(p.get('grant_type')==='refresh_token')return json(await renewOAuth(db,p));
   if(p.get('grant_type')!=='authorization_code')fail(400,'unsupported_grant_type','Use authorization_code or refresh_token.');
   const code=p.get('code')||'',verifier=p.get('code_verifier')||'';
   if(!/^[a-f0-9]{64}$/.test(code)||!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))fail(400,'invalid_grant','Invalid authorization code or PKCE verifier.');
   const row=await db.prepare('SELECT * FROM oauth_requests WHERE code_hash=?').bind(await hash(code)).first<Pending>();
   if(!row||row.client_id!==p.get('client_id')||row.redirect_uri!==p.get('redirect_uri')||row.challenge!==await pkceChallenge(verifier))fail(400,'invalid_grant','Invalid authorization code, client, redirect URI or PKCE verifier.');
   if((p.get('resource')||null)!==row.resource)fail(400,'invalid_target','Token resource must match the authorization request.');
   if(p.has('scope')&&p.get('scope')!==row.scope)fail(400,'invalid_scope','Scope must match the owner-approved grant.');
   if(row.status==='used'){
    // Reuse of the full bound code/verifier revokes the credential already issued.
    await db.prepare("UPDATE connections SET status='revoked',token_hash=NULL WHERE id=?").bind(row.connection_id).run();
    fail(400,'invalid_grant','This code was already used. Restart the connection.');
   }
   if(row.status!=='approved'||!row.code_expires_at||row.code_expires_at<=now())fail(400,'invalid_grant','Authorization code expired or was denied.');
   const allowed=row.scope.split(' '),write=allowed.includes('posts:write')?1:0,negotiate=allowed.some(s=>s.startsWith('offers:')||s==='messages:write'||s==='events:read')?1:0,accept=allowed.includes('deals:accept')?1:0;
   const token='th_'+secret(),tokenHash=await hash(token),stamp=now();
   const refresh=row.renewable&&row.resource?'dlr_'+secret():null,refreshHash=refresh?await hash(refresh):null,refreshDeadline=refresh?stamp+refreshIdleSeconds*1000:null;
   const results=await db.batch([
    db.prepare("UPDATE oauth_requests SET status='used',issued_token_hash=? WHERE id=? AND status='approved' AND code_expires_at>? RETURNING id").bind(tokenHash,row.id,stamp),
    db.prepare("INSERT INTO connections(id,device_hash,user_code,name,owner_id,status,token_hash,can_write,can_negotiate,can_accept,max_posts,expires_at,created_at,oauth_scope,oauth_resource,oauth_refresh_expires_at) SELECT ?,?,?,?,owner_id,'active',?,?,?,?,?,?,?,?,?,? FROM oauth_requests WHERE id=? AND status='used' AND issued_token_hash=?").bind(row.connection_id,await hash(secret()),secret().slice(0,10).toUpperCase(),row.resource?'Muse — DeaLoop MCP':'Muse — identity check',tokenHash,write,negotiate,accept,write?agentPostAllowance:0,stamp+oauthLifetime*1000,stamp,row.scope,row.resource,refreshDeadline,row.id,tokenHash),
    db.prepare("INSERT INTO activities(id,owner_id,actor,kind,summary,created_at) SELECT ?,owner_id,'You','connection_approved',?,? FROM oauth_requests WHERE id=? AND issued_token_hash=?").bind(crypto.randomUUID(),refresh?'Connected Muse with renewable access and selected permissions. Disconnect anytime.':row.resource?'Connected Muse to DeaLoop MCP with selected permissions for 24 hours.':'Connected Muse for an identity check only, for 24 hours.',stamp,row.id,tokenHash),
    ...(refresh?[db.prepare('INSERT INTO oauth_refresh_tokens(token_hash,connection_id,client_id,resource,expires_at,created_at) SELECT ?,connection_id,client_id,resource,?,? FROM oauth_requests WHERE id=? AND issued_token_hash=?').bind(refreshHash,refreshDeadline,stamp,row.id,tokenHash)]:[])
   ]);
   if(!results[0].results.length){await db.prepare("UPDATE connections SET status='revoked',token_hash=NULL WHERE id=?").bind(row.connection_id).run();fail(400,'invalid_grant','This code was already used. Restart the connection.');}
   return json({access_token:token,token_type:'Bearer',expires_in:oauthLifetime,scope:row.scope,...(refresh?{refresh_token:refresh}:{})});
  }
  if(req.method==='POST'&&path==='/oauth/revoke'){
   await rate(db,'revoke:'+req.headers.get('cf-connecting-ip'),120);const p=await form(req);
   if(req.headers.has('authorization')||p.has('client_secret'))fail(401,'invalid_client','Use public client authentication.');
   const client=await db.prepare('SELECT id FROM oauth_clients WHERE id=?').bind(p.get('client_id')||'').first();if(!client)fail(401,'invalid_client','Unknown client.');
   const token=p.get('token')||'';if(token.length>256)fail(400,'invalid_request','Invalid token.');
   await db.prepare("UPDATE connections SET status='revoked',token_hash=NULL WHERE (token_hash=? OR id IN (SELECT connection_id FROM oauth_refresh_tokens WHERE token_hash=? AND client_id=?)) AND id IN (SELECT connection_id FROM oauth_requests WHERE client_id=?)").bind(await hash(token),await hash(token),p.get('client_id'),p.get('client_id')).run();return new Response(null,{status:200,headers});
  }
  return json({error:'invalid_request',error_description:'Endpoint or method not supported.'},404);
 }catch(e){if(e instanceof ApiError){
  // Diagnostic metadata only: never log query strings, request bodies or tokens.
  console.info('OAuth rejected',JSON.stringify({request_id:requestId,path,method:req.method,status:e.status,error:e.code}));
  if(path==='/oauth/authorize'&&req.headers.get('accept')?.includes('text/html'))return new Response(consentErrorHtml(e.message),{status:e.status,headers:{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"}});
  return json({error:e.code,error_description:e.message},e.status);
 }console.error('OAuth request failed',requestId);return json({error:'server_error',error_description:'Unable to complete this connection.'},500);}
}
