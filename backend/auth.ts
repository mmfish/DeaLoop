import firebaseConfig from '../config/firebase.json' with {type:'json'};
import {createRemoteJWKSet, jwtVerify} from 'jose';
import type {JWTVerifyGetKey} from 'jose';
import {hash, secret, fail} from './contracts.ts';
import {isAws,allowedEmail} from './deployment.ts';

export const firebaseProject = 'thread-marketplace';
export const sessionCookie = 'thread_session';
const sessionSeconds = 12 * 60 * 60;
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));
const oauthKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export const googleClientId = '329895217851-45a2pq4s2cafod5ui7epudblsauaikih.apps.googleusercontent.com';
export type Identity = {uid:string;name:string;email:string;provider:string;emailVerified?:boolean;googleSubject?:string;providerSubject?:string};
export type Human = {userId:string;displayName:string;email:string;fullName:string|null;provider:string};

export async function verifyFirebaseToken(token:string, keys:JWTVerifyGetKey=googleKeys):Promise<Identity>{
 const {payload:p}=await jwtVerify(token,keys,{issuer:`https://securetoken.google.com/${firebaseProject}`,audience:firebaseProject,algorithms:['RS256'],requiredClaims:['exp','iat','sub','auth_time']});
 const now=Math.floor(Date.now()/1000), provider=(p.firebase as {sign_in_provider?:string}|undefined)?.sign_in_provider;
 if(!p.sub || p.sub.length>128 || typeof p.iat!=='number' || p.iat>now || typeof p.auth_time!=='number' || p.auth_time>now || now-p.auth_time>300 || !['google.com','facebook.com'].includes(provider||''))throw Error('Invalid or stale sign-in');
 const providerIds=(p.firebase as {identities?:Record<string,unknown>})?.identities?.[provider!];
 const googleIds=(p.firebase as {identities?:Record<string,unknown>})?.identities?.['google.com'];
 return {uid:p.sub,name:typeof p.name==='string'?p.name.slice(0,80):'Community member',email:typeof p.email==='string'?p.email.slice(0,320):'',provider:provider!,emailVerified:p.email_verified===true,providerSubject:Array.isArray(providerIds)&&typeof providerIds[0]==='string'?providerIds[0]:undefined,googleSubject:Array.isArray(googleIds)&&typeof googleIds[0]==='string'?googleIds[0]:undefined};
}

// Separate-provider Firebase accounts omit profile claims. Verify the provider's
// signed ID token and bind its subject to the independently verified Firebase ID.
// Never trust client profile fields or match two credentials by email alone.
export async function withGoogleProfile(identity:Identity,token:string,keys:JWTVerifyGetKey=oauthKeys):Promise<Identity>{
 if(identity.provider!=='google.com'||!identity.googleSubject)throw Error('Missing Google identity binding');
 const {payload:p}=await jwtVerify(token,keys,{issuer:['https://accounts.google.com','accounts.google.com'],audience:googleClientId,algorithms:['RS256'],requiredClaims:['sub','iat','exp']});
 const now=Math.floor(Date.now()/1000);
 if(p.sub!==identity.googleSubject||typeof p.iat!=='number'||p.iat>now||now-p.iat>300||typeof p.email!=='string'||p.email_verified!==true)throw Error('Invalid Google profile');
 return {...identity,email:p.email.slice(0,320),emailVerified:true,name:typeof p.name==='string'?p.name.slice(0,80):identity.name};
}

// Read the signed-in provider's profile from Firebase, not browser-supplied
// names or the editable top-level Firebase account displayName. In separate-
// provider mode Facebook's ID token can omit these profile fields entirely.
export async function withFirebaseProviderProfile(identity:Identity,idToken:string,fetcher:typeof fetch=fetch):Promise<Identity>{
 if(!['google.com','facebook.com'].includes(identity.provider)||!identity.providerSubject)throw Error('Missing provider identity binding');
 const response=await fetcher('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key='+encodeURIComponent(firebaseConfig.apiKey),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken}),redirect:'error',signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw Error('Provider profile lookup failed');
 const data=await response.json() as {users?:Array<{localId?:string;disabled?:boolean;providerUserInfo?:Array<{providerId?:string;rawId?:string;displayName?:unknown}>}>};
 if(!Array.isArray(data.users)||data.users.length!==1)throw Error('Invalid provider account');
 const account=data.users[0];
 if(account.localId!==identity.uid||account.disabled)throw Error('Provider account mismatch');
 const profile=Array.isArray(account.providerUserInfo)?account.providerUserInfo.find(p=>p.providerId===identity.provider&&p.rawId===identity.providerSubject):undefined;
 if(!profile)throw Error('Provider identity mismatch');
 return {...identity,name:typeof profile.displayName==='string'&&profile.displayName.trim()?profile.displayName.trim().slice(0,80):'Community member'};
}

export function readSessionCookie(headers:Headers):string|null{
 const matches=(headers.get('cookie')||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(sessionCookie+'='));
 return matches.length===0?null:matches.length===1?matches[0].slice(sessionCookie.length+1):'invalid';
}
export function sitesHuman(headers:Headers):Human|null{
 if(isAws())return null;
 const id=headers.get('oai-authenticated-user-id'),email=headers.get('oai-authenticated-user-email');
 if(!id||!email)return null;
 let name='Community member';
 if(headers.get('oai-authenticated-user-full-name-encoding')==='percent-encoded-utf-8')try{name=decodeURIComponent(headers.get('oai-authenticated-user-full-name')||name);}catch{}
 return {userId:id,displayName:name.slice(0,80),fullName:name.slice(0,80),email,provider:'chatgpt'};
}
export async function humanFor(headers:Headers,db:D1Database):Promise<Human|null>{
 const token=readSessionCookie(headers);
 // A stale or logged-out app session must never silently fall back to hosting identity.
 if(token!==null){
  if(!/^[a-f0-9]{64}$/.test(token))return null;
  const row=await db.prepare('SELECT s.owner_id,s.email,s.provider,u.name FROM auth_sessions s JOIN users u ON u.id=s.owner_id WHERE s.token_hash=? AND s.expires_at>?').bind(await hash(token),Date.now()).first<{owner_id:string;email:string;provider:string;name:string}>();
  return row&&allowedEmail(row.email)?{userId:row.owner_id,displayName:row.name,fullName:row.name,email:row.email,provider:row.provider}:null;
 }
 // Trusted only behind Sites dispatch. Keep this integration for existing accounts.
 const legacy=sitesHuman(headers);
 if(!legacy)return null;
 const migrated=await db.prepare('SELECT subject FROM auth_identities WHERE owner_id=? LIMIT 1').bind(legacy.userId).first();
 return migrated?null:legacy;
}
export function requireSameOrigin(req:Request){
 if(req.headers.get('origin')!==new URL(req.url).origin)fail(403,'origin_required','Use a same-origin page to make this change.');
}
export function cookieValue(req:Request,value:string){
 const secure=new URL(req.url).protocol==='https:'?'; Secure':'';
 return `${sessionCookie}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value==='signed-out'?31536000:sessionSeconds}${secure}`;
}

// Verification is separate so deterministic tests can exercise account ownership against real D1.
export async function createSession(req:Request,db:D1Database,identity:Identity,linkExisting:boolean){
 const current=await humanFor(req.headers,db);
 if(linkExisting&&!current)fail(401,'link_requires_session','Sign in to your existing DeaLoop account before linking.');
 const subject=`${firebaseProject}:${identity.uid}`;
 const existing=await db.prepare('SELECT owner_id FROM auth_identities WHERE subject=?').bind(subject).first<{owner_id:string}>();
 if(existing&&linkExisting&&existing.owner_id!==current!.userId)fail(409,'identity_already_linked','This sign-in belongs to a different DeaLoop account. Sign out and sign in to that account; accounts are not merged automatically.');
 // One-time migration mapping is operator-supplied for known invited owners only.
 // It never accepts owner IDs from a request or unverified email claims.
 // A malformed operator mapping must fail closed with a 503, never 500 every login.
 let migrationBindings:Record<string,string>={};
 if(isAws()){
  try{migrationBindings=JSON.parse(process.env.DEALOOP_OWNER_BINDINGS||'{}');}catch{fail(503,'config_error','Account sign-in is temporarily unavailable.');}
  if(!migrationBindings||typeof migrationBindings!=='object'||Array.isArray(migrationBindings))fail(503,'config_error','Account sign-in is temporarily unavailable.');
 }
 // Existing provider subjects were explicitly linked by their owners. A new
 // provider may be linked only from an authenticated, invited owner's session.
 // Neither path treats an unverified provider email as proof of ownership.
 const boundEmail=existing?Object.entries(migrationBindings).find(([email,owner])=>owner===existing.owner_id&&allowedEmail(email))?.[0]:undefined;
 const admittedEmail=linkExisting?current?.email:boundEmail;
 let sessionEmail=identity.email;
 if(isAws()){
  if(admittedEmail&&allowedEmail(admittedEmail))sessionEmail=admittedEmail;
  else{
   if(!identity.email)fail(403,'email_required','Sign in with Google first, then connect this provider from your account page.');
   if(!identity.emailVerified)fail(403,'email_unverified','Sign in with Google first, then connect this provider from your account page.');
   if(!allowedEmail(identity.email))fail(403,'private_testing','This marketplace is currently limited to invited accounts.');
  }
 }
 const migratedOwner=isAws()&&identity.emailVerified?migrationBindings[identity.email.toLowerCase()]:undefined;
 if(migratedOwner&&!await db.prepare('SELECT id FROM users WHERE id=?').bind(migratedOwner).first())fail(503,'migration_incomplete','Your account migration is not ready.');
 const ownerId=existing?.owner_id||(linkExisting?current!.userId:migratedOwner||'firebase:'+identity.uid);
 const stamp=Date.now();
 // Keep ownership stable; the authenticated SSO provider supplies the profile name.
 await db.batch([
  db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').bind(ownerId,identity.name.trim().slice(0,80)||'Community member',stamp),
  db.prepare('INSERT INTO auth_identities(subject,owner_id,created_at) VALUES(?,?,?) ON CONFLICT(subject) DO NOTHING').bind(subject,ownerId,stamp),
 ]);
 const linked=await db.prepare('SELECT owner_id FROM auth_identities WHERE subject=?').bind(subject).first<{owner_id:string}>();
 if(linked?.owner_id!==ownerId)fail(409,'identity_already_linked','This sign-in was linked elsewhere. Sign in again.');
 const token=secret();
 await db.batch([
  db.prepare('UPDATE users SET name=? WHERE id=? AND EXISTS(SELECT 1 FROM auth_identities WHERE subject=? AND owner_id=?)').bind(identity.name.trim().slice(0,80)||'Community member',ownerId,subject,ownerId),
  db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').bind(stamp),
  db.prepare('INSERT INTO auth_sessions(token_hash,owner_id,email,provider,expires_at,created_at) VALUES(?,?,?,?,?,?)').bind(await hash(token),ownerId,sessionEmail,identity.provider,stamp+sessionSeconds*1000,stamp),
 ]);
 const previous=readSessionCookie(req.headers);
 if(previous&&/^[a-f0-9]{64}$/.test(previous))await db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').bind(await hash(previous)).run();
 return {token,ownerId};
}

export async function authEndpoint(req:Request,db:D1Database,action:string):Promise<Response>{
 const json=(data:unknown,status=200,cookie?:string)=>Response.json(data,{status,headers:{'Cache-Control':'no-store',...(cookie?{'Set-Cookie':cookie}:{})}});
 try{
  if(req.method!=='POST')return json({error:{message:'Use POST.'}},405);
  requireSameOrigin(req);
  if(action==='logout'){
   const token=readSessionCookie(req.headers);
   if(token&&/^[a-f0-9]{64}$/.test(token))await db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').bind(await hash(token)).run();
   // The sentinel is load-bearing on Sites: any present-but-invalid cookie makes
   // humanFor return null instead of falling back to legacy hosting identity.
   // Expiring the cookie would silently re-authenticate an unmapped hosting
   // owner (or a different legacy account) on the next request.
   return json({signed_out:true},200,cookieValue(req,'signed-out'));
  }
  if(action!=='session')return json({error:{message:'Not found.'}},404);
  if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:{message:'Send JSON.'}},415);
  const reader=req.body?.getReader();let raw='',size=0;const decoder=new TextDecoder();
  if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>20000){await reader.cancel();return json({error:{message:'Request too large.'}},413);}raw+=decoder.decode(value,{stream:true});}
  let body:{id_token?:unknown;link_existing?:unknown;google_id_token?:unknown};try{body=JSON.parse(raw);}catch{return json({error:{message:'Invalid JSON.'}},400);}
  if(!body||typeof body.id_token!=='string'||typeof body.link_existing!=='boolean')return json({error:{message:'A sign-in token and linking choice are required.'}},400);
  let identity:Identity;try{
   identity=await verifyFirebaseToken(body.id_token);
   if(identity.provider==='google.com'&&typeof body.google_id_token==='string')identity=await withGoogleProfile(identity,body.google_id_token);
   else identity=await withFirebaseProviderProfile(identity,body.id_token);
  }catch{return json({error:{message:'Sign-in could not be verified. Please try again.'}},401);}
  const {token,ownerId}=await createSession(req,db,identity,body.link_existing);
  return json({account_id:ownerId},200,cookieValue(req,token));
 }catch(error){
  const e=error as {status?:number;code?:string;message?:string};
  return json({error:{code:e.code||'sign_in_failed',message:e.status?e.message:'Sign-in is temporarily unavailable. Please try again.'}},e.status||500);
 }
}
