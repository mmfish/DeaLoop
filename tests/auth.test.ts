import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {verifyFirebaseToken,withGoogleProfile,withFirebaseProviderProfile,googleClientId,createSession,humanFor,authEndpoint,firebaseProject} from '../backend/auth.ts';
import {handleApi} from '../backend/service.ts';
import {SQLiteDatabase} from '../runtime/sqlite.ts';

test('Firebase verification rejects foreign, expired, stale and unsupported identities',async()=>{
 const {publicKey,privateKey}=await generateKeyPair('RS256');
 const keys=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'test'}]});
 const now=Math.floor(Date.now()/1000);
 async function token(overrides:Record<string,unknown>={}){return new SignJWT({iss:`https://securetoken.google.com/${firebaseProject}`,aud:firebaseProject,sub:'uid-alice',iat:now,exp:now+3600,auth_time:now,name:'Alice',email:'alice@example.test',firebase:{sign_in_provider:'google.com'},...overrides}).setProtectedHeader({alg:'RS256',kid:'test'}).sign(privateKey);}
 assert.equal((await verifyFirebaseToken(await token(),keys)).uid,'uid-alice');
 const facebook=await verifyFirebaseToken(await token({firebase:{sign_in_provider:'facebook.com',identities:{'facebook.com':['facebook-user']}}}),keys);assert.equal(facebook.providerSubject,'facebook-user');
 for(const change of [{aud:'foreign-project'},{iss:'https://evil.test'},{exp:now-1},{iat:now+60},{auth_time:now-600},{sub:''},{firebase:{sign_in_provider:'anonymous'}}])await assert.rejects(()=>token(change).then(t=>verifyFirebaseToken(t,keys)));
 const other=await generateKeyPair('RS256');
 await assert.rejects(()=>verifyFirebaseToken('not.a.token',keys));
 const forged=await new SignJWT({sub:'uid-alice'}).setProtectedHeader({alg:'RS256',kid:'test'}).sign(other.privateKey);
 await assert.rejects(()=>verifyFirebaseToken(forged,keys));
});

test('sessions preserve explicit ownership, isolate users, revoke on logout and never fall back after expiry',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'auth-test'},cf:false});
 try{
  const db=await mf.getD1Database('DB') as unknown as D1Database;
  for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())for(const sql of readFileSync('drizzle/'+f,'utf8').split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql).run();
  const base='https://thread.example',legacy={'oai-authenticated-user-id':'legacy-alice','oai-authenticated-user-email':'alice@example.test'};
  const request=(cookie?:string,headers:Record<string,string>={})=>new Request(base+'/api/auth/session',{method:'POST',headers:{Origin:base,...headers,...(cookie?{Cookie:'thread_session='+cookie}:{})}});
  const alice={uid:'alice',email:'alice@example.test',name:'Alice',provider:'google.com'};
  const linked=await createSession(request(undefined,legacy),db,alice,true);
  assert.equal(linked.ownerId,'legacy-alice');
  assert.equal(await humanFor(request(undefined,legacy).headers,db),null,'A migrated account must sign in again when its app cookie is gone');
  assert.equal((await humanFor(request(linked.token).headers,db))?.userId,'legacy-alice');
  const stored=await db.prepare('SELECT token_hash FROM auth_sessions').first<{token_hash:string}>();assert.notEqual(stored?.token_hash,linked.token);
  const bob=await createSession(request(),db,{...alice,uid:'bob',name:'Bob'},false);
  assert.notEqual(bob.ownerId,linked.ownerId,'Matching email must not merge accounts');
  await assert.rejects(()=>createSession(request(bob.token),db,alice,true),/different DeaLoop account/);
  await assert.rejects(()=>createSession(request(),db,{...alice,uid:'new'},true),/existing DeaLoop account/);
  const payload={type:'wanted',title:'Used commuter bicycle',description:'Working brakes, pickup this weekend.',category:'Bicycles',price:150,condition:'Good',location:'Oakland, CA',delivery:'local_pickup',image:null};
  const posted=await handleApi(new Request(base+'/api/v1/posts',{method:'POST',headers:{Origin:base,Cookie:'thread_session='+linked.token,'Content-Type':'application/json','Idempotency-Key':'auth-post'},body:JSON.stringify(payload)}),{DB:db});assert.equal(posted.status,201);
  const own=await handleApi(new Request(base+'/api/v1/my-posts',{headers:{Cookie:'thread_session='+bob.token}}),{DB:db});assert.equal((await own.json() as any).posts.length,0);
  const csrf=await authEndpoint(new Request(base+'/api/auth/logout',{method:'POST',headers:{Origin:'https://evil.test',Cookie:'thread_session='+linked.token}}),db,'logout');assert.equal(csrf.status,403);
  const logout=await authEndpoint(request(linked.token),db,'logout');assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie')!,/HttpOnly; SameSite=Lax/);assert.match(logout.headers.get('set-cookie')!,/Secure/);assert.match(logout.headers.get('set-cookie')!,/^thread_session=signed-out;/);
  assert.equal(await humanFor(request(linked.token,legacy).headers,db),null,'Revoked cookie cannot fall back to hosting user');
  assert.equal(await humanFor(request('signed-out',legacy).headers,db),null);
  const fresh={'oai-authenticated-user-id':'legacy-fresh','oai-authenticated-user-email':'fresh@example.test'};
  assert.equal((await humanFor(new Headers(fresh),db))?.userId,'legacy-fresh');
  assert.equal(await humanFor(request('signed-out',fresh).headers,db),null,'Logout sentinel must suppress unmapped legacy hosting identity');
  const expired=await createSession(request(),db,alice,false);await db.prepare('UPDATE auth_sessions SET expires_at=0').run();assert.equal(await humanFor(request(expired.token,legacy).headers,db),null);
  const invalid=await authEndpoint(new Request(base+'/api/auth/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id_token:'forged',link_existing:false})}),db,'session');assert.equal(invalid.status,401);
  const response=await handleApi(new Request(base+'/api/v1/me',{headers:{Cookie:'thread_session='+bob.token,Authorization:'Bearer invalid',...legacy}}),{DB:db});assert.equal(response.status,401);
 }finally{await mf.dispose();}
});


test('Google profile requires signed audience, recent token and Firebase subject binding',async()=>{
 const {publicKey,privateKey}=await generateKeyPair('RS256');
 const keys=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'google-test'}]});
 const now=Math.floor(Date.now()/1000);
 const identity={uid:'firebase-uid',googleSubject:'google-subject',email:'',name:'Owner',provider:'google.com'};
 const token=(overrides:Record<string,unknown>={})=>new SignJWT({iss:'https://accounts.google.com',aud:googleClientId,sub:'google-subject',iat:now,exp:now+3600,email:'owner@example.test',email_verified:true,...overrides}).setProtectedHeader({alg:'RS256',kid:'google-test'}).sign(privateKey);
 const verified=await withGoogleProfile(identity,await token(),keys);assert.equal(verified.email,'owner@example.test');assert.equal(verified.emailVerified,true);assert.equal(verified.uid,identity.uid);
 for(const change of [{sub:'another-google-user'},{aud:'another-client'},{iss:'https://evil.test'},{iat:now-600},{iat:now+60},{exp:now-1},{email_verified:false},{email:undefined}])await assert.rejects(()=>token(change).then(t=>withGoogleProfile(identity,t,keys)));
 await assert.rejects(()=>withGoogleProfile({...identity,googleSubject:undefined},'token',keys));
 await assert.rejects(()=>withGoogleProfile({...identity,provider:'facebook.com'},'token',keys));
 const other=await generateKeyPair('RS256');const forged=await new SignJWT({sub:'google-subject'}).setProtectedHeader({alg:'RS256',kid:'google-test'}).sign(other.privateKey);
 await assert.rejects(()=>withGoogleProfile(identity,forged,keys));
});


test('provider profile lookup binds Firebase account and signed-in provider and ignores unrelated profile fields',async()=>{
 const identity={uid:'firebase-user',providerSubject:'facebook-user',email:'',name:'Community member',provider:'facebook.com'};
 const account={localId:identity.uid,displayName:'Editable Firebase name',email:'unverified@example.test',providerUserInfo:[{providerId:'google.com',rawId:'google-user',displayName:'Other provider'},{providerId:'facebook.com',rawId:'facebook-user',displayName:'  Alice Facebook  '}]};
 const lookup=(users:unknown[],status=200):typeof fetch=>async(input,init)=>{
  assert.equal(new URL(String(input)).origin,'https://identitytoolkit.googleapis.com');
  assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');
  assert.deepEqual(JSON.parse(String(init?.body)),{idToken:'synthetic-id-token'});
  return Response.json({users},{status});
 };
 const profile=await withFirebaseProviderProfile(identity,'synthetic-id-token',lookup([account]));
 assert.equal(profile.name,'Alice Facebook');assert.equal(profile.uid,identity.uid);assert.equal(profile.email,'','Profile lookup must not upgrade email admission');
 for(const users of [[],[account,account],[{...account,localId:'someone-else'}],[{...account,disabled:true}],[{...account,providerUserInfo:[{providerId:'facebook.com',rawId:'wrong-user',displayName:'Wrong'}]}]])await assert.rejects(()=>withFirebaseProviderProfile(identity,'synthetic-id-token',lookup(users)));
 await assert.rejects(()=>withFirebaseProviderProfile(identity,'synthetic-id-token',lookup([],401)));
 await assert.rejects(()=>withFirebaseProviderProfile({...identity,providerSubject:undefined},'synthetic-id-token',lookup([account])));
 const nameless=await withFirebaseProviderProfile(identity,'synthetic-id-token',lookup([{...account,providerUserInfo:[{providerId:'facebook.com',rawId:'facebook-user',displayName:'  '}]}]));assert.equal(nameless.name,'Community member');
 const google=await withFirebaseProviderProfile({...identity,provider:'google.com',providerSubject:'google-user'},'synthetic-id-token',lookup([account]));assert.equal(google.name,'Other provider');
});

test('SSO refreshes the legacy profile while preserving owner, posts, agents and linking boundaries',async()=>{
 const sqlite=new SQLiteDatabase(':memory:');sqlite.migrate('drizzle');const db=sqlite.asD1();
 try{
  const base='https://dealoop.example';
  const req=(token?:string,legacy=false)=>new Request(base+'/api/auth/session',{headers:{...(token?{Cookie:'thread_session='+token}:{}),...(legacy?{'oai-authenticated-user-id':'legacy-owner','oai-authenticated-user-email':'owner@example.test','oai-authenticated-user-full-name':'Winter','oai-authenticated-user-full-name-encoding':'percent-encoded-utf-8'}:{})}});
  await db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').bind('legacy-owner','Winter',1).run();
  const alice={uid:'google-owner',email:'owner@example.test',name:'Alice Google',provider:'google.com'};
  const first=await createSession(req(undefined,true),db,alice,true);assert.equal(first.ownerId,'legacy-owner');
  assert.equal((await humanFor(req(first.token).headers,db))?.displayName,'Alice Google');
  const payload={type:'wanted',title:'Used commuter bicycle',description:'Working brakes, pickup this weekend.',category:'Bicycles',price:150,condition:'Good',location:'Oakland, CA',delivery:'local_pickup',image:null};
  const posted=await handleApi(new Request(base+'/api/v1/posts',{method:'POST',headers:{Origin:base,Cookie:'thread_session='+first.token,'Content-Type':'application/json','Idempotency-Key':'profile-post'},body:JSON.stringify(payload)}),{DB:db});assert.equal(posted.status,201);
  await db.prepare('INSERT INTO connections(id,device_hash,user_code,name,owner_id,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)').bind('synthetic-agent','synthetic-device','SYNTHETIC','Muse',first.ownerId,'active',Date.now()+100000,Date.now()).run();
  const facebook=await createSession(req(first.token),db,{...alice,uid:'facebook-owner',name:'Alice Facebook',provider:'facebook.com'},true);
  assert.equal(facebook.ownerId,first.ownerId);assert.equal((await humanFor(req(facebook.token).headers,db))?.displayName,'Alice Facebook');
  const again=await createSession(req(),db,{...alice,name:'Alice Updated'},false);
  assert.equal(again.ownerId,first.ownerId);assert.equal((await humanFor(req(again.token).headers,db))?.displayName,'Alice Updated');
  assert.equal((await db.prepare('SELECT created_at FROM users WHERE id=?').bind(first.ownerId).first() as any).created_at,1);
  assert.equal((await db.prepare('SELECT owner_id FROM posts').first() as any).owner_id,first.ownerId);
  assert.equal((await db.prepare('SELECT owner_id,status FROM connections WHERE id=?').bind('synthetic-agent').first() as any).owner_id,first.ownerId);
  const bob=await createSession(req(),db,{...alice,uid:'bob',name:'Bob'},false);
  await assert.rejects(()=>createSession(req(bob.token),db,{...alice,name:'Bad rename'},true));
  assert.equal((await humanFor(req(bob.token).headers,db))?.displayName,'Bob');assert.equal((await humanFor(req(again.token).headers,db))?.displayName,'Alice Updated');
 }finally{sqlite.close();}
});
