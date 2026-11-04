import {offerItemCharacters,negotiationListLimit} from './policy.ts';
import {fail,hash,now,conditions} from './contracts.ts';
import type {Actor} from './contracts.ts';

export type Offer={id:string;post_id:string;post_owner_id:string;offerer_id:string;status:string;revision:number;price:number;item:string;condition:string;delivery:string;terms:string;expires_at:number;proposed_by:string;confirmed_revision:number|null;created_at:number;updated_at:number;post_title:string;post_type:string;post_status:string;has_deal:number;pending_decision:number;owner_name:string;offerer_name:string};
// Shared database predicate for the decision inbox and final selection guard.
const selectableSQL="o.status='open' AND p.status='active' AND o.expires_at>? AND (o.proposed_by=o.offerer_id OR o.confirmed_revision=o.revision) AND NOT EXISTS(SELECT 1 FROM deals d WHERE d.post_id=o.post_id)";
export const scopes=(a:Actor)=>a.oauthScope?a.oauthScope.split(' '):['posts:read',...(a.canWrite?['posts:write']:[]),...(a.canNegotiate?['offers:read','offers:write','messages:write','events:read']:[]),...(a.canAccept?['deals:accept']:[])];
export function negotiationAccess(a:Actor,accept=false){if(!a.canNegotiate||accept&&!a.canAccept)fail(403,'scope_required',accept?'Separate deals:accept permission is required.':'Negotiation permission is required.');}
export function publicOffer(o:Offer,owner:string){return {id:o.id,post_id:o.post_id,post_title:o.post_title,post_type:o.post_type,role:owner===o.post_owner_id?'post_owner':'responder',counterparty:owner===o.post_owner_id?o.offerer_name:o.owner_name,status:o.status,revision:o.revision,price:o.price/100,currency:'USD',item:o.item,condition:o.condition,delivery:o.delivery,terms:o.terms,expires_at:new Date(o.expires_at).toISOString(),expired:o.expires_at<=now(),proposed_by:owner===o.proposed_by?'you':'counterparty',counterparty_confirmed:o.confirmed_revision===o.revision,can_accept:owner===o.post_owner_id&&o.status==='open'&&o.post_status==='active'&&!o.has_deal&&o.expires_at>now()&&(o.proposed_by===o.offerer_id||o.confirmed_revision===o.revision),pending_decision:!!o.pending_decision&&o.expires_at>now(),created_at:new Date(o.created_at).toISOString(),updated_at:new Date(o.updated_at).toISOString()};}
export type AgreedTerms={price:number;currency:string;item:string;condition:string;delivery:string;terms:string;expires_at:string};
export type Agreement={id:string;post_id:string;offer_id:string;revision:number;buyer_id:string;seller_id:string;created_at:number;post_title:string;post_type:string;image:string|null;category:string;buyer_name:string;seller_name:string;terms:AgreedTerms};
export class Negotiations{
 constructor(readonly db:D1Database){}
 async list(owner:string,post?:string,view:'all'|'inbox'|'open'|'history'|'pending'='all'){
  const stamp=now();
  const filter=view==='inbox'?"AND o.status<>'accepted'":view==='open'?"AND o.status='open' AND o.expires_at>?":view==='history'?"AND o.status<>'accepted' AND (o.status<>'open' OR o.expires_at<=?)":view==='pending'?'AND o.post_owner_id=? AND '+selectableSQL:'';
  return (await this.db.prepare(`SELECT o.*,p.title post_title,p.type post_type,p.status post_status,EXISTS(SELECT 1 FROM deals d WHERE d.post_id=o.post_id) has_deal,CASE WHEN o.post_owner_id=? AND ${selectableSQL} THEN 1 ELSE 0 END pending_decision,u.name owner_name,v.name offerer_name FROM offers o JOIN posts p ON p.id=o.post_id JOIN users u ON u.id=o.post_owner_id JOIN users v ON v.id=o.offerer_id WHERE (o.post_owner_id=? OR o.offerer_id=?) ${post?'AND o.post_id=?':''} ${filter} ORDER BY pending_decision DESC,CASE WHEN o.post_owner_id=? AND ${selectableSQL} THEN o.expires_at END ASC,o.updated_at DESC,o.id LIMIT ${negotiationListLimit}`).bind(owner,stamp,owner,owner,...(post?[post]:[]),...(['open','history'].includes(view)?[stamp]:view==='pending'?[owner,stamp]:[]),owner,stamp).all<Offer>()).results;
 }
 async pendingDecisions(owner:string,post?:string){
  const stamp=now();
  const result=await this.db.prepare(`SELECT COUNT(*) total,MIN(o.expires_at) next_expiry FROM offers o JOIN posts p ON p.id=o.post_id WHERE o.post_owner_id=? AND ${selectableSQL} ${post?'AND o.post_id=?':''}`).bind(owner,stamp,...(post?[post]:[])).first<{total:number;next_expiry:number|null}>();
  return {count:result?.total??0,next_expiry:result?.next_expiry?new Date(result.next_expiry).toISOString():null};
 }
 async agreements(owner:string,role:'all'|'buying'|'selling'='all',post?:string){
  const roleFilter=role==='buying'?'AND d.buyer_id=?':role==='selling'?'AND d.seller_id=?':'';
  const rows=(await this.db.prepare(`SELECT d.id,d.post_id,d.offer_id,d.revision,d.buyer_id,d.seller_id,d.created_at,d.terms_json,p.title post_title,p.type post_type,p.image,p.category,b.name buyer_name,s.name seller_name FROM deals d JOIN posts p ON p.id=d.post_id JOIN users b ON b.id=d.buyer_id JOIN users s ON s.id=d.seller_id WHERE (d.buyer_id=? OR d.seller_id=?) ${roleFilter} ${post?'AND d.post_id=?':''} ORDER BY d.created_at DESC,d.id LIMIT ${negotiationListLimit}`).bind(owner,owner,...(role!=='all'?[owner]:[]),...(post?[post]:[])).all<Omit<Agreement,'terms'>&{terms_json:string}>()).results;
  return rows.map(({terms_json,...row})=>({...row,terms:JSON.parse(terms_json) as AgreedTerms}));
 }
 async offer(id:string,owner:string){return this.db.prepare(`SELECT o.*,p.title post_title,p.type post_type,p.status post_status,EXISTS(SELECT 1 FROM deals d WHERE d.post_id=o.post_id) has_deal,CASE WHEN o.post_owner_id=? AND ${selectableSQL} THEN 1 ELSE 0 END pending_decision,u.name owner_name,v.name offerer_name FROM offers o JOIN posts p ON p.id=o.post_id JOIN users u ON u.id=o.post_owner_id JOIN users v ON v.id=o.offerer_id WHERE o.id=? AND (o.post_owner_id=? OR o.offerer_id=?)`).bind(owner,now(),id,owner,owner).first<Offer>();}
 async detail(id:string,owner:string){const offer=await this.offer(id,owner);if(!offer)fail(404,'not_found','Offer not found.');const messages=(await this.db.prepare('SELECT id,author_id,actor_name,body,created_at FROM messages WHERE offer_id=? ORDER BY sequence LIMIT 40').bind(id).all<{id:string;author_id:string;actor_name:string;body:string;created_at:number}>()).results.map(m=>({id:m.id,by:m.author_id===owner?'you':'counterparty',actor:m.actor_name,body:m.body,created_at:new Date(m.created_at).toISOString()}));const deal=await this.db.prepare('SELECT id,revision,terms_json,created_at FROM deals WHERE offer_id=?').bind(id).first<{id:string;revision:number;terms_json:string;created_at:number}>();const history=(await this.db.prepare('SELECT revision,actor_name,terms_json,created_at FROM offer_revisions WHERE offer_id=? ORDER BY revision LIMIT 100').bind(id).all<{revision:number;actor_name:string;terms_json:string;created_at:number}>()).results.map(r=>({revision:r.revision,actor:r.actor_name,terms:JSON.parse(r.terms_json),created_at:new Date(r.created_at).toISOString()}));return {offer:publicOffer(offer!,owner),messages,history,deal:deal?{id:deal.id,revision:deal.revision,terms:JSON.parse(deal.terms_json),created_at:new Date(deal.created_at).toISOString(),status:'agreed',payment_status:'not_processed'}:null};}
 // actor_name is owner-scoped display data for MCP read_events and agent inbox
 // polling; the SSE stream intentionally carries metadata only (see event-stream.ts).
 async events(owner:string,after:number){const rows=(await this.db.prepare('SELECT sequence,kind,offer_id,post_id,revision,actor_name,created_at FROM negotiation_events WHERE owner_id=? AND sequence>? ORDER BY sequence LIMIT 51').bind(owner,after).all()).results;const events=rows.slice(0,50);return {events,next_cursor:events.length?events[events.length-1].sequence:after,has_more:rows.length>50};}
}
function exact(b:Record<string,unknown>,fields:string[]){if(Object.keys(b).some(k=>!fields.includes(k)))fail(400,'unknown_field','Only documented fields are accepted.');}
function revision(b:Record<string,unknown>){if(!Number.isSafeInteger(b.expected_revision)||Number(b.expected_revision)<1)fail(400,'revision_required','Read the offer and send its expected_revision.');return Number(b.expected_revision);}
const termFields=['price','item','condition','delivery','terms','expires_at'];
function validateTerms(b:Record<string,unknown>){
 if(typeof b.price!=='number'||!Number.isFinite(b.price)||b.price<0||b.price>100000||Math.abs(b.price*100-Math.round(b.price*100))>0.00001)fail(400,'invalid_price','Use a USD price with up to two decimals.');
 const price=Math.round((b.price as number)*100);
 for(const [k,max] of [['item',offerItemCharacters],['terms',2000]] as const)if(typeof b[k]!=='string'||!(b[k] as string).trim()||(b[k] as string).length>max)fail(400,'invalid_terms',`${k} is required (up to ${max} characters).`);
 if(!conditions.includes(b.condition as typeof conditions[number])||!['local_pickup','shipping'].includes(String(b.delivery)))fail(400,'invalid_terms','Specify a condition and either local_pickup or shipping.');
 const expires=typeof b.expires_at==='string'?Date.parse(b.expires_at):NaN;if(!Number.isFinite(expires)||expires<=now()||expires>now()+86400000)fail(400,'invalid_expiry','expires_at must be an ISO date in the next 24 hours.');
 return {price,item:(b.item as string).trim(),condition:String(b.condition),delivery:String(b.delivery),terms:(b.terms as string).trim(),expires_at:expires};
}
// Every write starts with one conditional ledger insert in the same D1 transaction as
// its effects. Replays, competing revisions and winner selection cannot partially apply.
export async function negotiate(req:Request,db:D1Database,a:Actor,path:string,b:Record<string,unknown>){
 negotiationAccess(a,path.endsWith('/accept'));
 const key=req.headers.get('idempotency-key');if(!key||!/^[\w.-]{1,120}$/.test(key))fail(400,'idempotency_required','Send an Idempotency-Key; retain it for identical retries.');
 const fingerprint=await hash(JSON.stringify({path,body:Object.fromEntries(Object.entries(b).sort(([x],[y])=>x.localeCompare(y)))}));
 const prior=await db.prepare('SELECT id,request_hash,offer_id FROM negotiation_actions WHERE owner_id=? AND actor_key=? AND idempotency_key=?').bind(a.ownerId,a.key,key).first<{id:string;request_hash:string;offer_id:string}>();
 const repo=new Negotiations(db);
 if(prior){if(prior.request_hash!==fingerprint)fail(409,'idempotency_conflict','This operation key was used with different content.');return {...await repo.detail(prior.offer_id,a.ownerId),replayed:true};}
 const action=crypto.randomUUID(),stamp=now(),actorName=a.name;
 const parts=path.split('/'),creating=parts[1]==='posts',kind=creating?'offer_created':parts[3],offerId=creating?crypto.randomUUID():parts[2];
 let guard='',args:(string|number)[]=[],effect:D1PreparedStatement[]=[];
 let offer:Offer|null=null;
 if(!creating){offer=await repo.offer(offerId,a.ownerId);if(!offer)fail(404,'not_found','Offer not found.');}
 const postId=creating?parts[2]:offer!.post_id;
 const access=a.agentId?`EXISTS(SELECT 1 FROM connections c WHERE c.id=? AND c.status='active' AND c.expires_at>? AND c.can_negotiate=1${kind==='accept'?' AND c.can_accept=1':''})`:'1=1';
 const accessArgs=a.agentId?[a.agentId,stamp]:[];
 const exists='EXISTS(SELECT 1 FROM negotiation_actions WHERE id=?)';
 let rev=1;
 if(creating){
  exact(b,termFields);const t=validateTerms(b);
  guard=`EXISTS(SELECT 1 FROM posts p WHERE p.id=? AND p.status='active' AND p.demo=0 AND p.owner_id<>?) AND ${access} AND (SELECT COUNT(*) FROM offers WHERE offerer_id=? AND created_at>?)<20`;
  args=[postId,a.ownerId,...accessArgs,a.ownerId,stamp-86400000];
  effect.push(db.prepare(`INSERT INTO offers(id,post_id,post_owner_id,offerer_id,status,revision,price,item,condition,delivery,terms,expires_at,proposed_by,created_at,updated_at) SELECT ?,p.id,p.owner_id,?,'open',1,?,?,?,?,?,?,?,?,? FROM posts p WHERE p.id=? AND ${exists}`).bind(offerId,a.ownerId,t.price,t.item,t.condition,t.delivery,t.terms,t.expires_at,a.ownerId,stamp,stamp,postId,action));
 }else{
  rev=revision(b);const owner=offer!.post_owner_id===a.ownerId;
  guard=`EXISTS(SELECT 1 FROM offers o JOIN posts p ON p.id=o.post_id WHERE o.id=? AND o.revision=? AND o.status='open' AND p.status='active'${['withdraw','decline'].includes(kind)?'':' AND o.expires_at>?'} ) AND ${access}`;
  args=[offerId,rev,...(['withdraw','decline'].includes(kind)?[]:[stamp]),...accessArgs];
  if(kind==='revise'){
   exact(b,[...termFields,'expected_revision']);const t=validateTerms(b);guard+=' AND (SELECT revision FROM offers WHERE id=?)<20';args.push(offerId);rev++;
   effect.push(db.prepare(`UPDATE offers SET revision=revision+1,price=?,item=?,condition=?,delivery=?,terms=?,expires_at=?,proposed_by=?,confirmed_revision=NULL,updated_at=? WHERE id=? AND ${exists}`).bind(t.price,t.item,t.condition,t.delivery,t.terms,t.expires_at,a.ownerId,stamp,offerId,action));
  }else if(kind==='messages'){
   exact(b,['body','expected_revision']);if(typeof b.body!=='string'||!b.body.trim()||b.body.length>2000)fail(400,'invalid_message','Message must contain 1–2000 characters.');
   guard+=' AND (SELECT COUNT(*) FROM messages WHERE offer_id=?)<40';args.push(offerId);
   effect.push(db.prepare(`INSERT INTO messages(id,offer_id,author_id,actor_name,body,created_at) SELECT ?,?,?,?,?,? WHERE ${exists}`).bind(action,offerId,a.ownerId,actorName,(b.body as string).trim(),stamp,action));
   effect.push(db.prepare(`UPDATE offers SET updated_at=? WHERE id=? AND ${exists}`).bind(stamp,offerId,action));
  }else if(kind==='confirm'){
   exact(b,['expected_revision']);if(owner||offer!.proposed_by!==offer!.post_owner_id)fail(409,'confirmation_not_needed','Only the responder can confirm a counterproposal made by the post owner.');
   guard+=' AND EXISTS(SELECT 1 FROM offers WHERE id=? AND proposed_by=? AND (confirmed_revision IS NULL OR confirmed_revision<>revision))';args.push(offerId,offer!.post_owner_id);
   effect.push(db.prepare(`UPDATE offers SET confirmed_revision=revision,updated_at=? WHERE id=? AND ${exists}`).bind(stamp,offerId,action));
  }else if(kind==='accept'){
   exact(b,['expected_revision']);if(!owner)fail(403,'owner_required','Only the post owner can select the winning offer.');
   guard+=` AND EXISTS(SELECT 1 FROM offers o JOIN posts p ON p.id=o.post_id WHERE o.id=? AND ${selectableSQL})`;args.push(offerId,stamp);
   const terms=JSON.stringify({price:offer!.price/100,currency:'USD',item:offer!.item,condition:offer!.condition,delivery:offer!.delivery,terms:offer!.terms,expires_at:new Date(offer!.expires_at).toISOString()});
   effect.push(db.prepare(`INSERT INTO deals(id,post_id,offer_id,revision,buyer_id,seller_id,terms_json,accepted_by,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${exists}`).bind(action,postId,offerId,rev,offer!.post_type==='wanted'?offer!.post_owner_id:offer!.offerer_id,offer!.post_type==='wanted'?offer!.offerer_id:offer!.post_owner_id,terms,a.key,stamp,action));
   effect.push(db.prepare(`UPDATE posts SET status='closed' WHERE id=? AND ${exists}`).bind(postId,action));
   effect.push(db.prepare(`UPDATE offers SET status=CASE WHEN id=? THEN 'accepted' ELSE 'closed' END,updated_at=? WHERE post_id=? AND status='open' AND ${exists}`).bind(offerId,stamp,postId,action));
  }else if(kind==='decline'||kind==='withdraw'){
   exact(b,['expected_revision']);if(kind==='decline'&&!owner||kind==='withdraw'&&owner)fail(403,'role_required','Post owners decline offers; responders withdraw their own offer.');
   effect.push(db.prepare(`UPDATE offers SET status=?,updated_at=? WHERE id=? AND ${exists}`).bind(kind==='decline'?'declined':'withdrawn',stamp,offerId,action));
  }else fail(404,'not_found','Offer operation not found.');
 }
 const batch=[db.prepare(`INSERT OR IGNORE INTO negotiation_actions(id,owner_id,actor_key,idempotency_key,request_hash,offer_id,kind,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`).bind(action,a.ownerId,a.key,key,fingerprint,offerId,kind,stamp,...args),...effect];
 if(creating||kind==='revise')batch.push(db.prepare(`INSERT INTO offer_revisions(offer_id,revision,author_id,actor_name,terms_json,created_at) SELECT id,revision,proposed_by,?,json_object('price',price/100.0,'currency','USD','item',item,'condition',condition,'delivery',delivery,'terms',terms,'expires_at',expires_at),? FROM offers WHERE id=? AND ${exists}`).bind(actorName,stamp,offerId,action));
 // A deal also closes all competing offers. Notify each affected participant privately.
 const recipients=kind==='accept'?"SELECT post_owner_id owner_id,id offer_id,revision FROM offers WHERE post_id=? AND status IN ('accepted','closed') UNION SELECT offerer_id owner_id,id offer_id,revision FROM offers WHERE post_id=? AND status IN ('accepted','closed')":"SELECT post_owner_id owner_id,id offer_id,revision FROM offers WHERE id=? UNION SELECT offerer_id owner_id,id offer_id,revision FROM offers WHERE id=?";
 const target=kind==='accept'?postId:offerId;
 batch.push(db.prepare(`INSERT INTO negotiation_events(owner_id,kind,offer_id,post_id,revision,actor_name,created_at) SELECT r.owner_id,CASE WHEN r.offer_id<>? THEN 'offer_closed' ELSE ? END,r.offer_id,?,r.revision,?,? FROM (${recipients}) r WHERE ${exists}`).bind(offerId,kind==='accept'?'deal_agreed':kind,postId,actorName,stamp,target,target,action));
 batch.push(db.prepare(`INSERT OR IGNORE INTO activities(id,owner_id,actor,kind,summary,post_id,created_at) SELECT ?||':'||r.owner_id,r.owner_id,?,'negotiation',?,?,? FROM (${recipients}) r WHERE ${exists}`).bind(action,actorName,kind==='accept'?'Deal agreed; post closed.':kind==='messages'?'New message in an offer conversation.':'Offer updated: '+kind.replaceAll('_',' '),postId,stamp,target,target,action));
 await db.batch(batch);
 const saved=await db.prepare('SELECT id,request_hash,offer_id FROM negotiation_actions WHERE owner_id=? AND actor_key=? AND idempotency_key=?').bind(a.ownerId,a.key,key).first<{id:string;request_hash:string;offer_id:string}>();
 if(!saved)fail(409,'state_conflict','No change made. Read the latest offer and post: revision, expiry, confirmation, message/offer limit or authorization changed.');
 if(saved.request_hash!==fingerprint)fail(409,'idempotency_conflict','This operation key was used with different content.');
 return {...await repo.detail(saved.offer_id,a.ownerId),replayed:saved.id!==action};
}
