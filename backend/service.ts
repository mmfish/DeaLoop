import {maxImageBytes,manualTokenSeconds,pendingConnectionSeconds,agentPostAllowance,marketplaceJsonBytes} from './policy.ts';
import {openEventStream,eventStreamInfo,requireEvents,streamPath} from './event-stream.ts';
import {mcpResource} from './oauth-scopes.ts';
import {Shortlists,updateShortlist} from './shortlist.ts';
import {requiredApiScope} from './oauth-scopes.ts';
import {validateGrant} from './grants.ts';
import {isAws,agentOrigin} from './deployment.ts';
import {Negotiations,negotiate,negotiationAccess,publicOffer,scopes} from './negotiation.ts';
import {humanFor} from './auth.ts';
import {Repository} from '../db/repository.ts';
import {ApiError,fail,hash,secret,now,publicPost,validatePost,imageDimensions,maxImageSide,maxImagePixels} from './contracts.ts';
import type {Actor,Connection,Post} from './contracts.ts';
import {seedDemo} from '../db/seed.ts';
export type Bindings={DB:D1Database;BUCKET?:R2Bucket};
export async function actorFor(req:Request,db:D1Database,humanOnly=false,resource?:string,checkScope=true):Promise<Actor>{
 const repo=new Repository(db);const bearer=req.headers.get('authorization');
 if(bearer){
  if(humanOnly)fail(403,'human_required','Sign in as the account owner to manage access.');
  if(!/^Bearer th_[a-f0-9]{64}$/.test(bearer))fail(401,'invalid_token','The agent credential is invalid.');
  const c=await db.prepare("SELECT * FROM connections WHERE token_hash=? AND status='active' AND expires_at>?").bind(await hash(bearer.slice(7)),now()).first<Connection>();
  if(!c?.owner_id)fail(401,'expired_or_revoked','Renew your OAuth access token if available. If renewal is unavailable or rejected, reconnect with your owner’s approval.');
  if(c!.oauth_scope){
   if((c!.oauth_resource||undefined)!==resource)fail(401,'invalid_token','This OAuth token is not valid for this resource.');
   const required=requiredApiScope(req.method,new URL(req.url).pathname);
   if(checkScope&&(!required||!c!.oauth_scope.split(' ').includes(required)))fail(403,'scope_required','This action requires '+(required||'a human session')+'.');
  }
  return {oauthScope:c!.oauth_scope||undefined,ownerId:c!.owner_id!,name:c!.name,key:'agent:'+c!.id,agentId:c!.id,canWrite:!!c!.can_write,canNegotiate:!!c!.can_negotiate,canAccept:!!c!.can_accept};
 }
 const user=await humanFor(req.headers,db);if(!user)fail(401,'sign_in_required','Sign in or connect an agent first.');
 if(!['GET','HEAD'].includes(req.method)&&req.headers.get('origin')!==new URL(req.url).origin)fail(403,'origin_required','Use a same-origin page to make this change.');
 await repo.user(user!.userId,user!.displayName);
 return {ownerId:user!.userId,name:user!.displayName,key:'human:'+user!.userId,agentId:null,canWrite:true,canNegotiate:true,canAccept:true};
}
async function input(req:Request){
 if(!req.headers.get('content-type')?.startsWith('application/json'))fail(415,'json_required','Send Content-Type: application/json.');
 if(Number(req.headers.get('content-length')||0)>marketplaceJsonBytes)fail(413,'too_large','JSON body is too large.');
 const reader=req.body?.getReader();let size=0;const parts:Uint8Array[]=[];
 if(reader){while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>marketplaceJsonBytes){await reader.cancel();fail(413,'too_large','JSON body is too large.');}parts.push(value);}}
 const merged=new Uint8Array(size);let offset=0;for(const p of parts){merged.set(p,offset);offset+=p.length;}
 try {const result=JSON.parse(new TextDecoder().decode(merged));if(!result||typeof result!=='object'||Array.isArray(result))throw Error();return result as Record<string,unknown>;}catch{fail(400,'invalid_json','Send a valid JSON object.');}
}
// 15-minute hashed-bucket limiter shared by REST and MCP. IP-keyed buckets read
// cf-connecting-ip, which Caddy overwrites from remote_host on AWS
// (scripts/aws/Caddyfile) and Cloudflare sets on Sites; callers cannot spoof it
// past the edge. A missing header collapses to one shared 'null' bucket, which
// is stricter, not a bypass.
export async function rateLimit(db:D1Database,key:string,limit:number){
 const bucket=Math.floor(now()/900000);const k=await hash(key+':'+bucket);
 const out=await db.batch([db.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now()),db.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').bind(k,(bucket+1)*900000),db.prepare('SELECT count FROM rate_limits WHERE key=?').bind(k)]);
 if(Number((out[2].results[0] as {count:number}).count)>limit)fail(429,'rate_limited','Too many requests. Try again in 15 minutes.');
}
function publicConnection(c:Connection){return {id:c.id,name:c.name,status:(c.oauth_refresh_expires_at??c.expires_at)<=now()&&c.status!=='revoked'?'expired':c.status,scopes:c.oauth_scope?c.oauth_scope.split(' '):['posts:read',...(c.can_write?['posts:write']:[]),...(c.can_negotiate?['offers:read','offers:write','messages:write','events:read']:[]),...(c.can_accept?['deals:accept']:[])],max_posts:c.max_posts,expires_at:new Date(c.oauth_refresh_expires_at??c.expires_at).toISOString(),renewable:!!c.oauth_refresh_expires_at,access_token_expires_at:new Date(c.expires_at).toISOString()};}
const actorForResource=actorFor;
export async function handleApi(req:Request,env:Bindings,resource?:string):Promise<Response>{
 const actorFor=(request:Request,db:D1Database,humanOnly=false)=>actorForResource(request,db,humanOnly,resource);
 const requestId=crypto.randomUUID();const url=new URL(req.url),path=url.pathname.replace(/^\/api\/v1/,'')||'/';const db=env.DB,repo=new Repository(db);
 const json=(data:Record<string,unknown>,status=200)=>Response.json({...data,request_id:requestId},{status,headers:{'Cache-Control':'no-store','X-Request-ID':requestId,'X-Content-Type-Options':'nosniff'}});
 try {
 if(path==='/events/stream'||path==='/events/stream-info'){
  if(req.method!=='GET')return new Response(null,{status:405,headers:{Allow:'GET'}});
  // Explicit SSE companion to the MCP protected resource; other REST resource rules stay unchanged.
  const authorize=()=>actorForResource(req,db,false,mcpResource(url.origin));
  if(path==='/events/stream')return await openEventStream(req,db,authorize);
  const actor=await authorize();requireEvents(actor);return json({stream:eventStreamInfo(url.origin)});
 }
 if(req.method==='GET'&&path==='/capabilities'){await rateLimit(db,'public:'+req.headers.get('cf-connecting-ip'),600);return json({service:'DeaLoop',version:'1',operations:['search_posts','read_post','publish_post','upload_photo','read_own_activity','pair_agent','create_offer','revise_offer','send_message','confirm_terms','accept_offer','read_events','get_event_stream','read_shortlist','manage_shortlist','update_shortlist'],auth:'Browsing published posts is public. Account activity and writes require human sign-in or an owner-approved scoped bearer credential.',not_available:['payments','shipping_fulfillment','webhooks','scheduling'],agent_guide:'/agents',schema:'/openapi.json',event_stream:eventStreamInfo(url.origin),...(isAws()?{mcp:{endpoint:'/mcp',transport:'streamable-http',resource_metadata:'/.well-known/oauth-protected-resource/mcp'}}:{})});}
 if(/^\/posts\/[^/]+\/shortlist(?:\/manage)?$/.test(path)){
  const post=path.split('/')[2],shortlists=new Shortlists(db);
  if(req.method==='GET'&&path.endsWith('/manage')){const a=await actorFor(req,db);const offset=Number(url.searchParams.get('offset')||0);if(!Number.isSafeInteger(offset)||offset<0||offset>10000)fail(400,'invalid_offset','Invalid offset.');return json(await shortlists.manage(post,a,offset));}
  if(req.method==='GET'){await rateLimit(db,'public:'+req.headers.get('cf-connecting-ip'),600);if(req.headers.has('authorization'))await actorFor(req,db);return json({shortlist:await shortlists.public(post)});}
  if(req.method==='POST'&&!path.endsWith('/manage')){const a=await actorFor(req,db);await rateLimit(db,'shortlist:'+a.ownerId,120);return json(await updateShortlist(req,db,a,post,await input(req)));}
 }
 if(req.method==='GET'&&path==='/posts'){
  await rateLimit(db,'public:'+req.headers.get('cf-connecting-ip'),600);
  if(isAws()&&req.headers.has('authorization'))await actorFor(req,db);
  const filters=Object.fromEntries(['q','type','category','location','max_price','delivery','sort','limit','offset'].map(k=>[k,url.searchParams.get(k)||undefined]));
  if(filters.type&&!['for_sale','wanted'].includes(filters.type))fail(400,'invalid_type','Use for_sale or wanted.');
  const rows=await repo.browse(filters);const limit=Math.min(60,Math.max(1,Math.floor(Number(filters.limit))||24));const offset=Math.max(0,Math.min(10000,Math.floor(Number(filters.offset))||0));
  return json({posts:rows.map(publicPost),next_offset:rows.length===limit?offset+limit:null});
 }
 if(req.method==='GET'&&/^\/posts\/[^/]+$/.test(path)){await rateLimit(db,'public:'+req.headers.get('cf-connecting-ip'),600);if(isAws()&&req.headers.has('authorization'))await actorFor(req,db);const p=await repo.post(path.split('/')[2]);if(!p)fail(404,'not_found','Post not found.');return json({post:publicPost(p!),shortlist:await new Shortlists(db).public(p!.id)});}
 if(req.method==='POST'&&path==='/agent-connections'){
  await rateLimit(db,'pair:'+req.headers.get('cf-connecting-ip'),10);const b=await input(req);
  if(typeof b?.name!=='string'||!b.name.trim()||b.name.length>80)fail(400,'invalid_name','Give your agent a name (1–80 characters).');
  const device=secret(),code=secret().slice(0,10).toUpperCase(),id=crypto.randomUUID();
  await db.prepare("INSERT INTO connections(id,device_hash,user_code,name,status,expires_at,created_at,max_posts) VALUES(?,?,?,?,'pending',?,?,?)").bind(id,await hash(device),code,(b!.name as string).trim(),now()+pendingConnectionSeconds*1000,now(),agentPostAllowance).run();
  return json({device_code:device,user_code:code,verification_uri:url.origin+'/connect',verification_uri_complete:url.origin+'/connect?code='+code,expires_in:pendingConnectionSeconds,interval:5,instructions:'Keep device_code private. Show the verification link and user_code to your owner; wait for their approval. Then poll /api/v1/agent-token. Never approve your own request.'},201);
 }
 if(req.method==='POST'&&path==='/agent-token'){
  await rateLimit(db,'poll:'+req.headers.get('cf-connecting-ip'),240);const b=await input(req);if(typeof b?.device_code!=='string'||! /^[a-f0-9]{64}$/.test(b.device_code))fail(400,'invalid_device_code','Invalid device code.');
  const c=await db.prepare('SELECT * FROM connections WHERE device_hash=?').bind(await hash(b!.device_code as string)).first<Connection>();
  if(!c||c.expires_at<now())fail(400,'expired_request','Pairing request expired. Start a new connection.');
  if(c!.status==='pending')fail(428,'authorization_pending','Waiting for your owner. Poll no more frequently than every 5 seconds.');
  if(c!.status!=='approved')fail(400,'request_used_or_denied','This request was already exchanged, denied or revoked. Reconnect if the token response was lost.');
  const token='th_'+secret();const changed=await db.prepare("UPDATE connections SET status='active',token_hash=? WHERE id=? AND status='approved' AND token_hash IS NULL RETURNING id").bind(await hash(token),c!.id).first();
  if(!changed)fail(409,'already_exchanged','This pairing request has already been exchanged.');
  return json({access_token:token,token_type:'Bearer',expires_in:Math.max(0,Math.floor((c!.expires_at-now())/1000)),connection:publicConnection({...c!,status:'active'}),instructions:'Store the token in your secure credential facility. Never show it in chat. Send Authorization: Bearer <token> only to this origin.'});
 }
 if(req.method==='GET'&&path==='/me'){const a=await actorFor(req,db);if(a.oauthScope)console.info('OAuth identity read',requestId,a.agentId);return json({account_id:a.ownerId,actor:a.agentId?'agent':'human',agent_name:a.agentId?a.name:null,scopes:scopes(a)});}
 if(req.method==='GET'&&path==='/my-posts'){const a=await actorFor(req,db);return json({posts:(await repo.mine(a.ownerId)).map(publicPost)});}
 if(req.method==='GET'&&path==='/activity'){const a=await actorFor(req,db);return json({events:await repo.activity(a.ownerId)});}
 if(req.method==='GET'&&(path==='/offers'||path==='/events'||/^\/offers\/[^/]+$/.test(path))){
  const a=await actorFor(req,db);negotiationAccess(a);const n=new Negotiations(db);
  if(path==='/offers'){
   const post=url.searchParams.get('post_id')||undefined,view=url.searchParams.get('view');
   if(view&&view!=='pending')fail(400,'invalid_view','Use view=pending or omit view.');
   return json({offers:(await n.list(a.ownerId,post,view==='pending'?'pending':'all')).map(o=>publicOffer(o,a.ownerId)),pending_decisions:await n.pendingDecisions(a.ownerId,post)});
  }
  if(path==='/events'){const after=Number(url.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)fail(400,'invalid_cursor','after must be a nonnegative integer.');return json(await n.events(a.ownerId,after));}
  return json(await n.detail(path.split('/')[2],a.ownerId));
 }
 if(req.method==='POST'&&(/^\/posts\/[^/]+\/offers$/.test(path)||/^\/offers\/[^/]+\/(revise|messages|confirm|accept|decline|withdraw)$/.test(path))){const a=await actorFor(req,db);await rateLimit(db,'negotiate:'+a.ownerId,120);return json(await negotiate(req,db,a,path,await input(req)));}
 if(req.method==='GET'&&path==='/connections'){const a=await actorFor(req,db,true);return json({connections:(await repo.connections(a.ownerId)).map(publicConnection)});}
 if(req.method==='POST'&&path==='/connections/api-key'){
  const a=await actorFor(req,db,true),b=await input(req);await rateLimit(db,'manual-key:'+a.ownerId,10);
  if(typeof b.name!=='string'||!b.name.trim()||b.name.length>80)fail(400,'invalid_name','Give this connection a name.');
  const g=validateGrant(b),id=crypto.randomUUID(),token='th_'+secret(),stamp=now();
  await db.batch([
   db.prepare("INSERT INTO connections(id,device_hash,user_code,name,owner_id,status,token_hash,can_write,can_negotiate,can_accept,expires_at,created_at,max_posts) VALUES(?,?,?,?,?,'active',?,?,?,?,?,?,?)").bind(id,await hash(secret()),secret().slice(0,10).toUpperCase(),b.name.trim(),a.ownerId,await hash(token),g.canWrite,g.canNegotiate,g.canAccept,stamp+manualTokenSeconds*1000,stamp,g.canWrite?agentPostAllowance:0),
   db.prepare('INSERT INTO activities(id,owner_id,actor,kind,summary,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),a.ownerId,'You','connection_approved','Created a 72-hour API key for '+b.name.trim(),stamp)
  ]);
  return json({access_token:token,token_type:'Bearer',connection_id:id,expires_at:new Date(stamp+manualTokenSeconds*1000).toISOString(),api_origin:agentOrigin(),instructions:'Shown once. Enter only in the secure API-key form for this origin. Never paste in agent chat. Revoke and replace if lost.'},201);
 }
 if(req.method==='POST'&&path==='/connections/approve'){
  const a=await actorFor(req,db,true),b=await input(req);await rateLimit(db,'approve:'+a.ownerId,30);
  if(typeof b.user_code!=='string')fail(400,'invalid_approval','Provide a pairing code.');const g=validateGrant(b);
  const c=await repo.pairing((b!.user_code as string).replace(/\s|-/g,'').toUpperCase());if(!c)fail(404,'pairing_not_found','This pairing request is missing, used or expired.');
  const event=crypto.randomUUID();const result=await db.batch([
   db.prepare("UPDATE connections SET owner_id=?,status='approved',can_write=?,can_negotiate=?,can_accept=?,max_posts=?,expires_at=? WHERE id=? AND status='pending' AND expires_at>? RETURNING id").bind(a.ownerId,g.canWrite,g.canNegotiate,g.canAccept,g.canWrite?agentPostAllowance:0,now()+manualTokenSeconds*1000,c!.id,now()),
   db.prepare("INSERT INTO activities(id,owner_id,actor,kind,summary,created_at) SELECT ?,?,?,'connection_approved',?,? WHERE EXISTS(SELECT 1 FROM connections WHERE id=? AND owner_id=? AND status='approved')").bind(event,a.ownerId,'You',`Approved ${c!.name} for ${b!.can_write?'reading and up to 200 posts':'reading only'}. Access expires in 72 hours.`,now(),c!.id,a.ownerId)
  ]);if(!result[0].results.length)fail(409,'already_decided','This connection was already approved or expired.');
  return json({approved:true,name:c!.name});
 }
 if(req.method==='POST'&&/^\/connections\/[^/]+\/revoke$/.test(path)){
  const a=await actorFor(req,db,true),id=path.split('/')[2];await rateLimit(db,'revoke:'+a.ownerId,60);
  const changed=await db.prepare("UPDATE connections SET status='revoked',token_hash=NULL WHERE id=? AND owner_id=? AND status IN ('active','approved') RETURNING name").bind(id,a.ownerId).first<{name:string}>();
  if(!changed)fail(404,'not_found','Active connection not found.');
  await db.prepare('INSERT INTO activities(id,owner_id,actor,kind,summary,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),a.ownerId,'You','connection_revoked',`Revoked access for ${changed!.name}.`,now()).run();return json({revoked:true});
 }
 if(req.method==='POST'&&path==='/posts'){
  const a=await actorFor(req,db);if(!a.canWrite)fail(403,'scope_required','This connection does not have posts:write permission.');
  const b=await input(req),p=validatePost(b);
  const key=req.headers.get('idempotency-key');if(!key||key.length>120||!/^[\w.-]+$/.test(key))fail(400,'idempotency_required','Send an Idempotency-Key of 1–120 letters, digits, dots, underscores or hyphens. Reuse it for identical retries.');
  const requestHash=await hash(JSON.stringify(p));const prior=await db.prepare('SELECT id,request_hash FROM posts WHERE owner_id=? AND actor=? AND idempotency_key=?').bind(a.ownerId,a.key,key).first<{id:string;request_hash:string}>();
  if(prior){if(prior.request_hash!==requestHash)fail(409,'idempotency_conflict','This key was used with different post content.');return json({post:publicPost((await repo.post(prior.id))!),replayed:true});}
  await rateLimit(db,'publish:'+a.ownerId,30);
  if(p.image&&!await db.prepare('SELECT id FROM photos WHERE id=? AND owner_id=?').bind(p.image.split('/').pop(),a.ownerId).first())fail(403,'photo_not_owned','Use a photo uploaded by this account.');
  const id=crypto.randomUUID(),time=now(),photoId=p.image?p.image.split('/').pop()!:null;
  // The photo guard is the atomic backstop to the ownership pre-check above:
  // a GC pass that collects the photo between the check and this insert makes
  // the insert a clean no-op instead of a dangling reference.
  const guard=(a.agentId?"EXISTS(SELECT 1 FROM connections c WHERE c.id=? AND c.status='active' AND c.expires_at>? AND c.can_write=1 AND (SELECT COUNT(*) FROM posts WHERE agent_id=c.id)<c.max_posts)":'1=1')+" AND (? IS NULL OR EXISTS(SELECT 1 FROM photos WHERE id=? AND owner_id=?))";
  const args=[id,a.ownerId,a.key,a.agentId,p.type,p.title,p.description,p.category,p.price,p.condition,p.location,p.delivery,p.image,time,key,requestHash,...(a.agentId?[a.agentId,time]:[]),photoId,photoId,a.ownerId];
  await db.batch([
   db.prepare(`INSERT OR IGNORE INTO posts(id,owner_id,actor,agent_id,type,title,description,category,price,condition,location,delivery,image,created_at,idempotency_key,request_hash) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}`).bind(...args),
   db.prepare("INSERT OR IGNORE INTO activities(id,owner_id,actor,kind,summary,post_id,created_at) SELECT ?,?,?,'post_published',?,?,? WHERE EXISTS(SELECT 1 FROM posts WHERE id=?)").bind('post:'+id,a.ownerId,a.agentId?a.name:'You',`Published ${p.type==='wanted'?'a Wanted':'a For Sale'} post: ${p.title}`,id,time,id)
  ]);
  const saved=await db.prepare('SELECT id,request_hash FROM posts WHERE owner_id=? AND actor=? AND idempotency_key=?').bind(a.ownerId,a.key,key).first<{id:string;request_hash:string}>();
  if(!saved){
   if(p.image&&!await db.prepare('SELECT id FROM photos WHERE id=? AND owner_id=?').bind(photoId,a.ownerId).first())fail(403,'photo_not_owned','Use a photo uploaded by this account.');
   fail(403,'posting_limit','This connection reached its posting limit, expired or was revoked.');
  }
  if(saved!.request_hash!==requestHash)fail(409,'idempotency_conflict','This key was used with different post content.');
  return json({post:publicPost((await repo.post(saved!.id))!),replayed:saved!.id!==id},saved!.id===id?201:200);
 }
 if(req.method==='POST'&&/^\/posts\/[^/]+\/archive$/.test(path)){
  const a=await actorFor(req,db,true),id=path.split('/')[2];await rateLimit(db,'archive:'+a.ownerId,60);
  if(await db.prepare("SELECT id FROM offers WHERE post_id=? AND post_owner_id=? AND status='open'").bind(id,a.ownerId).first())fail(409,'open_offers','Decline open offers before archiving this post.');
  const p=await db.prepare("UPDATE posts SET status='archived' WHERE id=? AND owner_id=? AND status='active' AND NOT EXISTS(SELECT 1 FROM offers WHERE offers.post_id=posts.id AND offers.status='open') RETURNING title").bind(id,a.ownerId).first<{title:string}>();
  if(!p)fail(404,'not_found','Active post not found.');await db.prepare('INSERT INTO activities(id,owner_id,actor,kind,summary,post_id,created_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),a.ownerId,'You','post_archived',`Archived: ${p!.title}`,id,now()).run();return json({archived:true});
 }
 if(req.method==='POST'&&path==='/photos'){
  const a=await actorFor(req,db);if(!a.canWrite)fail(403,'scope_required','Posting permission is required.');await rateLimit(db,'photos:'+a.ownerId,20);
  // Opportunistic GC: drop this owner's uploads never attached to a post within 7 days.
  // Rows first, objects second: the guarded delete and the post-insert photo
  // guard below are each atomic, so a concurrent publish either wins the race
  // (row survives, object kept) or fails cleanly (row gone, 403) — a post can
  // never reference a deleted photo. The candidate select filters to expired
  // unattached rows BEFORE the limit so old attached photos cannot starve
  // collection; the outer guard rechecks at delete time. Best-effort only; a
  // storage failure here must not fail the new upload.
  try{
   const stale=(await db.prepare("DELETE FROM photos WHERE id IN (SELECT id FROM photos WHERE owner_id=? AND created_at<? AND NOT EXISTS(SELECT 1 FROM posts WHERE posts.image='/media/'||photos.id) LIMIT 100) AND NOT EXISTS(SELECT 1 FROM posts WHERE posts.image='/media/'||photos.id) RETURNING id").bind(a.ownerId,now()-7*86400000).all<{id:string}>()).results;
   if(typeof env.BUCKET?.delete==='function')for(const p of stale)await env.BUCKET.delete(p.id);
  }catch{console.warn('Photo GC skipped',requestId);}
  // The cap covers unattached drafts only: attached photos are product data, and
  // drafts always have a recovery path (delete below, or 7-day expiry), so the
  // cap can never lock an account permanently. Enforced again atomically at insert.
  const owned=await db.prepare("SELECT COUNT(*) n FROM photos WHERE owner_id=? AND NOT EXISTS(SELECT 1 FROM posts WHERE posts.image='/media/'||photos.id)").bind(a.ownerId).first<{n:number}>();
  if(Number(owned?.n??0)>=100)fail(403,'photo_quota','This account reached 100 unattached photos. Delete unused uploads or wait for them to expire.');
  const type=req.headers.get('content-type')||'';if(!['image/jpeg','image/png','image/webp'].includes(type))fail(415,'invalid_photo','Upload JPEG, PNG or WebP.');
  if(!req.headers.get('content-length')||Number(req.headers.get('content-length'))>maxImageBytes)fail(413,'photo_too_large','Photo must be 10 MB or smaller.');
  const bytes=await req.arrayBuffer();if(bytes.byteLength>maxImageBytes)fail(413,'photo_too_large','Photo must be 10 MB or smaller.');const head=new Uint8Array(bytes);
  const valid=type==='image/jpeg'?head[0]===255&&head[1]===216&&head[2]===255:type==='image/png'?head[0]===137&&head[1]===80&&head[2]===78&&head[3]===71:new TextDecoder().decode(head.slice(0,4))==='RIFF'&&new TextDecoder().decode(head.slice(8,12))==='WEBP';
  if(!valid)fail(400,'invalid_photo','The file contents do not match the image type.');
  const size=imageDimensions(type,head);
  if(!size||size.width<1||size.height<1||size.width>maxImageSide||size.height>maxImageSide||size.width*size.height>maxImagePixels)fail(400,'invalid_photo','The photo dimensions are unreadable or exceed 12000 pixels per side / 64 megapixels.');
  if(!env.BUCKET)fail(503,'storage_unavailable','Photo storage is unavailable.');
  const id=crypto.randomUUID();await env.BUCKET!.put(id,bytes,{httpMetadata:{contentType:type}});
  const stored=await db.prepare("INSERT INTO photos SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM photos WHERE owner_id=? AND NOT EXISTS(SELECT 1 FROM posts WHERE posts.image='/media/'||photos.id))<100 RETURNING id").bind(id,a.ownerId,type,now(),a.ownerId).first<{id:string}>();
  if(!stored){try{if(typeof env.BUCKET?.delete==='function')await env.BUCKET.delete(id);}catch{/* best-effort cleanup of the orphaned object */}fail(403,'photo_quota','This account reached 100 unattached photos. Delete unused uploads or wait for them to expire.');}
  return json({image:'/media/'+id},201);
 }
 if(req.method==='POST'&&/^\/photos\/[^/]+\/delete$/.test(path)){
  const a=await actorFor(req,db);if(!a.canWrite)fail(403,'scope_required','Posting permission is required.');await rateLimit(db,'photos:'+a.ownerId,20);
  const id=path.split('/')[2];
  const gone=await db.prepare("DELETE FROM photos WHERE id=? AND owner_id=? AND NOT EXISTS(SELECT 1 FROM posts WHERE posts.image='/media/'||photos.id) RETURNING id").bind(id,a.ownerId).first<{id:string}>();
  if(!gone){
   if(await db.prepare('SELECT id FROM photos WHERE id=? AND owner_id=?').bind(id,a.ownerId).first())fail(409,'photo_attached','This photo is attached to a post and cannot be deleted.');
   fail(404,'not_found','Photo not found.');
  }
  try{if(typeof env.BUCKET?.delete==='function')await env.BUCKET.delete(id);}catch{console.warn('Photo object cleanup skipped',requestId);}
  return json({deleted:true});
 }
 if(req.method==='POST'&&path==='/demo'){const a=await actorFor(req,db,true);await rateLimit(db,'demo:'+a.ownerId,10);await seedDemo(db);return json({loaded:true});}
 return json({error:{code:'not_found',message:'Endpoint not found. Read /agents or /openapi.json.'}},404);
 }catch(e){if(e instanceof ApiError){const response=json({error:{code:e.code,message:e.message}},e.status);
  if(url.pathname===streamPath||path==='/events/stream-info'){
   if(e.status===401||e.status===403)response.headers.set('WWW-Authenticate',`Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp", scope="events:read"`);
   if(e.status===429)response.headers.set('Retry-After','10');
  }return response;}console.error('API error',requestId,e instanceof Error?e.constructor.name:'unknown');return json({error:{code:'internal_error',message:'Something went wrong. Please retry with the same idempotency key.'}},500);}
}
