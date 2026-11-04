import {fail,hash,now} from './contracts.ts';
import type {Actor} from './contracts.ts';
import {scopes} from './negotiation.ts';

type Entry={rank:number;offer_id:string;offer_revision:number;summary:string;reason:string;price:number;condition:string;delivery:string;expires_at:number;current_revision:number;offer_status:string;current_expiry:number};
type Selection={offer_id:string;expected_revision:number;summary:string;reason:string};
export function shortlistAccess(actor:Actor,write=false){
 const granted=scopes(actor);
 if(!granted.includes('offers:read')||(write&&!actor.canWrite))fail(403,'scope_required',write?'Ranking requires posts:write and offers:read.':'Reading shortlist management requires offers:read.');
 if(write&&actor.oauthScope&&!granted.includes('posts:write'))fail(403,'scope_required','Ranking requires posts:write and offers:read.');
}
export class Shortlists{
 constructor(readonly db:D1Database){}
 async post(id:string){const p=await this.db.prepare('SELECT id,owner_id,type,status,demo FROM posts WHERE id=?').bind(id).first<{id:string;owner_id:string;type:string;status:string;demo:number}>();if(!p)fail(404,'not_found','Post not found.');return p;}
 async rows(post:string){return (await this.db.prepare('SELECT e.*,o.revision current_revision,o.status offer_status,o.expires_at current_expiry FROM shortlist_entries e JOIN offers o ON o.id=e.offer_id WHERE e.post_id=? ORDER BY e.rank').bind(post).all<Entry>()).results;}
 async state(post:string){return await this.db.prepare('SELECT version,updated_at FROM shortlist_state WHERE post_id=?').bind(post).first<{version:number;updated_at:number}>()??{version:0,updated_at:null};}
 status(e:Entry,postStatus:string,stamp:number){return postStatus!=='active'?'post_closed':e.offer_status!=='open'?'unavailable':e.current_expiry<=stamp?'expired':e.current_revision!==e.offer_revision?'needs_review':e.expires_at<=stamp?'expired':'active';}
 async defaults(p:Awaited<ReturnType<Shortlists['post']>>,stamp:number){
  if(p.status!=='active'||p.demo)return [];
  // Prices are USD cents. Only constant sort directions enter SQL; ties are stable.
  const direction=p.type==='wanted'?'ASC':'DESC';
  const offers=(await this.db.prepare(`SELECT id,revision,price,condition,delivery,expires_at FROM offers WHERE post_id=? AND post_owner_id=? AND status='open' AND expires_at>? ORDER BY price ${direction},created_at ASC,id ASC LIMIT 3`).bind(p.id,p.owner_id,stamp).all<{id:string;revision:number;price:number;condition:string;delivery:string;expires_at:number}>()).results;
  return offers.map((o,i)=>({rank:i+1,offer_id:o.id,offer_revision:o.revision,summary:o.delivery==='shipping'?'Offer with shipping':'Local pickup offer',reason:'',price:o.price,condition:o.condition,delivery:o.delivery,expires_at:o.expires_at,current_revision:o.revision,offer_status:'open',current_expiry:o.expires_at}));
 }
 async public(post:string){
  const p=await this.post(post),state=await this.state(post),stamp=now();
  const rows=state.version===0?await this.defaults(p,stamp):await this.rows(post);
  // Explicit allowlist: never expose participant IDs, private item/terms or messages.
  return {post_id:post,version:state.version,updated_at:state.updated_at?new Date(state.updated_at).toISOString():null,post_status:p.status,ranked_by:state.version===0?'price':'post_owner',price_order:state.version===0?(p.type==='wanted'?'lowest_first':'highest_first'):null,entries:rows.filter(e=>this.status(e,p.status,stamp)==='active').map(e=>({rank:e.rank,summary:e.summary,reason:e.reason||null,price:e.price/100,currency:'USD',condition:e.condition,delivery:e.delivery,expires_at:new Date(e.expires_at).toISOString()}))};
 }
 async manage(post:string,actor:Actor,offset=0){
  shortlistAccess(actor);const p=await this.post(post);if(p.owner_id!==actor.ownerId)fail(404,'not_found','Post not found.');
  const state=await this.state(post),stamp=now();
  const default_entries=state.version===0?(await this.defaults(p,stamp)).map(e=>({...e,status:'active',price:e.price/100})):[];
  const entries=(await this.rows(post)).map(e=>({...e,status:this.status(e,p.status,stamp),price:e.price/100}));
  const candidates=(await this.db.prepare("SELECT o.id,o.revision,o.price,o.item,o.condition,o.delivery,o.expires_at,u.name counterparty FROM offers o JOIN users u ON u.id=o.offerer_id WHERE o.post_id=? AND o.post_owner_id=? AND o.status='open' AND o.expires_at>? ORDER BY o.created_at DESC,o.id LIMIT 31 OFFSET ?").bind(post,actor.ownerId,stamp,offset).all<{id:string;revision:number;price:number;item:string;condition:string;delivery:string;expires_at:number;counterparty:string}>()).results;
  return {post_id:post,version:state.version,editable:p.status==='active'&&!p.demo,ranked_by:state.version===0?'price':'post_owner',price_order:state.version===0?(p.type==='wanted'?'lowest_first':'highest_first'):null,ranking_guidance:'Review top offers against your owner’s requirements (quality, price, delivery and other preferences). Rerank with update_shortlist when appropriate; price order is only a default, not the owner’s endorsement. Read current offer revisions before publishing.',default_entries,entries,candidates:candidates.slice(0,30).map(o=>({...o,price:o.price/100})),next_offset:candidates.length>30?offset+30:null};
 }
}
function parse(body:Record<string,unknown>){
 if(Object.keys(body).some(k=>!['expected_version','entries'].includes(k)))fail(400,'unknown_field','Use expected_version and entries only.');
 if(!Number.isSafeInteger(body.expected_version)||Number(body.expected_version)<0)fail(400,'version_required','Read shortlist management and supply expected_version.');
 if(!Array.isArray(body.entries)||body.entries.length>3)fail(400,'invalid_entries','Provide zero to three entries, in the owner’s chosen order.');
 const entries:Selection[]=body.entries.map(value=>{
  if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'invalid_entries','Each entry must be an object.');
  const e=value as Record<string,unknown>;
  if(Object.keys(e).some(k=>!['offer_id','expected_revision','summary','reason'].includes(k)))fail(400,'unknown_field','Unexpected shortlist entry field.');
  if(typeof e.offer_id!=='string'||!/^[a-f0-9-]{36}$/i.test(e.offer_id)||!Number.isSafeInteger(e.expected_revision)||Number(e.expected_revision)<1)fail(400,'invalid_entries','Each entry needs an offer ID and exact expected_revision.');
  if(typeof e.summary!=='string'||!e.summary.trim()||e.summary.length>160||e.reason!==undefined&&(typeof e.reason!=='string'||e.reason.length>200))fail(400,'invalid_summary','Provide a public summary (1–160 characters) and optional reason (up to200). Keep private details out.');
  return {offer_id:e.offer_id,expected_revision:Number(e.expected_revision),summary:e.summary.trim(),reason:typeof e.reason==='string'?e.reason.trim():''};
 });
 if(new Set(entries.map(e=>e.offer_id)).size!==entries.length)fail(400,'duplicate_offer','An offer may appear only once.');
 return {expected_version:Number(body.expected_version),entries};
}
export async function updateShortlist(req:Request,db:D1Database,actor:Actor,post:string,body:Record<string,unknown>){
 shortlistAccess(actor,true);const parsed=parse(body),repo=new Shortlists(db),p=await repo.post(post);
 if(p.owner_id!==actor.ownerId)fail(404,'not_found','Post not found.');
 const key=req.headers.get('idempotency-key');if(!key||!/^[\w.-]{1,120}$/.test(key))fail(400,'idempotency_required','Send a stable Idempotency-Key for identical retries.');
 const fingerprint=await hash(JSON.stringify({post,...parsed}));
 const prior=await db.prepare('SELECT request_hash,version FROM shortlist_actions WHERE owner_id=? AND actor_key=? AND idempotency_key=?').bind(actor.ownerId,actor.key,key).first<{request_hash:string;version:number}>();
 if(prior){if(prior.request_hash!==fingerprint)fail(409,'idempotency_conflict','This key was used for a different shortlist update.');return {...await repo.manage(post,actor),saved_version:prior.version,replayed:true};}
 const action=crypto.randomUUID(),stamp=now(),version=parsed.expected_version+1;
 let guard="EXISTS(SELECT 1 FROM posts WHERE id=? AND owner_id=? AND status='active' AND demo=0) AND COALESCE((SELECT version FROM shortlist_state WHERE post_id=?),0)=? AND NOT EXISTS(SELECT 1 FROM deals WHERE post_id=?)";
 const args:(string|number)[]=[post,actor.ownerId,post,parsed.expected_version,post];
 if(actor.agentId){guard+=" AND EXISTS(SELECT 1 FROM connections WHERE id=? AND owner_id=? AND status='active' AND expires_at>? AND can_write=1 AND can_negotiate=1 AND (oauth_scope IS NULL OR (instr(' '||oauth_scope||' ',' posts:write ')>0 AND instr(' '||oauth_scope||' ',' offers:read ')>0)))";args.push(actor.agentId,actor.ownerId,stamp);}
 for(const e of parsed.entries){guard+=" AND EXISTS(SELECT 1 FROM offers WHERE id=? AND post_id=? AND post_owner_id=? AND revision=? AND status='open' AND expires_at>?)";args.push(e.offer_id,post,actor.ownerId,e.expected_revision,stamp);}
 const exists='EXISTS(SELECT 1 FROM shortlist_actions WHERE id=?)';
 const batch=[
  db.prepare(`INSERT OR IGNORE INTO shortlist_actions(id,post_id,owner_id,actor_key,idempotency_key,request_hash,version,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`).bind(action,post,actor.ownerId,actor.key,key,fingerprint,version,stamp,...args),
  db.prepare(`INSERT INTO shortlist_state(post_id,version,updated_at,actor) SELECT ?,?,?,? WHERE ${exists} ON CONFLICT(post_id) DO UPDATE SET version=excluded.version,updated_at=excluded.updated_at,actor=excluded.actor`).bind(post,version,stamp,actor.name,action),
  db.prepare(`DELETE FROM shortlist_entries WHERE post_id=? AND ${exists}`).bind(post,action),
 ];
 parsed.entries.forEach((e,i)=>batch.push(db.prepare(`INSERT INTO shortlist_entries(post_id,rank,offer_id,offer_revision,summary,reason,price,condition,delivery,expires_at) SELECT ?,?,id,revision,?,?,price,condition,delivery,expires_at FROM offers WHERE id=? AND ${exists}`).bind(post,i+1,e.summary,e.reason,e.offer_id,action)));
 batch.push(db.prepare(`INSERT INTO activities(id,owner_id,actor,kind,summary,post_id,created_at) SELECT ?,?,?,'shortlist_updated',?,?,? WHERE ${exists}`).bind(action,actor.ownerId,actor.name,'Updated owner-ranked top offers.',post,stamp,action));
 await db.batch(batch);
 const saved=await db.prepare('SELECT id,request_hash,version FROM shortlist_actions WHERE owner_id=? AND actor_key=? AND idempotency_key=?').bind(actor.ownerId,actor.key,key).first<{id:string;request_hash:string;version:number}>();
 if(!saved)fail(409,'state_conflict','Nothing changed. Refresh the shortlist and offers: ranking version, offer revision, expiry, post or permissions changed.');
 if(saved.request_hash!==fingerprint)fail(409,'idempotency_conflict','This key was used for a different update.');
 return {...await repo.manage(post,actor),saved_version:saved.version,replayed:saved.id!==action};
}
