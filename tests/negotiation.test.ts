import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {handleApi} from '../backend/service.ts';
import {negotiate} from '../backend/negotiation.ts';
import {actorFor} from '../backend/service.ts';
const origin='https://thread.example';
const post={type:'wanted',title:'Demo: used espresso machine',description:'Working pump, no leaks, compact counter footprint.',category:'Home & garden',price:200,condition:'Good',location:'Oakland',delivery:'local_pickup'};
const terms=()=>({price:150,item:'Used compact espresso machine, portafilter included',condition:'Good',delivery:'local_pickup',terms:'Demonstrate a working brew and no leaks. Pickup Saturday at a public meeting place. Total price includes accessories.',expires_at:new Date(Date.now()+3600000).toISOString()});
test('two-owner negotiation: private Q&A, explicit counterterms, safe retries and atomic single winner',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'thread-negotiation-'));const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'neg'},d1Persist:dir,cf:false});
 try{
 const DB=await mf.getD1Database('DB'),db=DB as unknown as D1Database;
 for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())for(const sql of readFileSync('drizzle/'+f,'utf8').split('--> statement-breakpoint'))if(sql.trim())await DB.prepare(sql).run();
 const req=(p:string,method:string,value:unknown,user?:string,token?:string,key?:string)=>new Request(origin+'/api/v1'+p,{method,headers:{'Content-Type':'application/json',Origin:origin,...(user?{'oai-authenticated-user-id':user,'oai-authenticated-user-email':user+'@example.test'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(key?{'Idempotency-Key':key}:{})},...(value===undefined?{}:{body:JSON.stringify(value)})});
 async function call(p:string,method='GET',v?:unknown,user?:string,token?:string,key?:string){const r=await handleApi(req(p,method,v,user,token,key),{DB:db});return {status:r.status,...await r.json() as any};}
 async function grant(user:string,negotiate=true,accept=false){const p=await call('/agent-connections','POST',{name:user+' Muse'});assert.equal((await call('/connections/approve','POST',{user_code:p.user_code,can_write:true,can_negotiate:negotiate,can_accept:accept},user)).status,200);return (await call('/agent-token','POST',{device_code:p.device_code}));}
 const buyer=await grant('buyer',true,true),seller=await grant('seller',true,false),other=await grant('other'),readonly=await grant('reader',false);
 assert((await call('/me','GET',undefined,undefined,buyer.access_token)).scopes.includes('deals:accept'));
 assert.equal((await call('/offers','GET',undefined,undefined,readonly.access_token)).status,403);
 const p=(await call('/posts','POST',post,undefined,buyer.access_token,'wanted')).post.id;
 const t=terms();assert.equal((await call('/posts/'+p+'/offers','POST',{...t,price:1.005},undefined,seller.access_token,'invalid-money')).status,400);
 assert.equal((await call('/posts/'+p+'/offers','POST',{...t,owner_id:'buyer'},undefined,seller.access_token,'spoof')).status,400);
 assert.equal((await call('/posts/'+p+'/offers','POST',t,undefined,buyer.access_token,'self')).status,409);
 const pair=await Promise.all([call('/posts/'+p+'/offers','POST',t,undefined,seller.access_token,'offer'),call('/posts/'+p+'/offers','POST',t,undefined,seller.access_token,'offer')]);assert(pair.every(x=>x.status===200),JSON.stringify(pair));assert.equal(pair[0].offer.id,pair[1].offer.id);const id=pair[0].offer.id;
 assert.equal((await call('/posts/'+p+'/offers','POST',{...t,price:160},undefined,seller.access_token,'offer')).status,409);
 assert.equal((await call('/offers/'+id,'GET',undefined,'stranger')).status,404);
 assert.equal((await call('/offers/'+id+'/messages','POST',{body:'peek',expected_revision:1},'stranger',undefined,'peek')).status,404);
 const msg={body:'Does it leak, and are all accessories included?',expected_revision:1};
 await Promise.all([call('/offers/'+id+'/messages','POST',msg,undefined,buyer.access_token,'q1'),call('/offers/'+id+'/messages','POST',msg,undefined,buyer.access_token,'q1')]);
 assert.equal((await call('/offers/'+id,'GET',undefined,undefined,seller.access_token)).messages.length,1);
 assert.equal((await call('/offers/'+id+'/messages','POST',{body:'No leaks; portafilter and basket included.',expected_revision:1},undefined,seller.access_token,'a1')).status,200);
 const counter=await call('/offers/'+id+'/revise','POST',{...t,price:140,expected_revision:1},undefined,buyer.access_token,'counter');assert.equal(counter.status,200);assert.equal(counter.offer.revision,2);
 assert.equal((await call('/offers/'+id+'/accept','POST',{expected_revision:1},undefined,buyer.access_token,'stale')).status,409);
 assert.equal((await call('/offers/'+id+'/accept','POST',{expected_revision:2},undefined,buyer.access_token,'unconfirmed')).status,409);
 assert.equal((await call('/offers/'+id+'/confirm','POST',{expected_revision:2},undefined,seller.access_token,'confirm')).status,200);
 assert.equal((await call('/offers/'+id+'/accept','POST',{expected_revision:2},undefined,seller.access_token,'seller-accept')).status,403);
 const another=(await call('/posts/'+p+'/offers','POST',t,undefined,other.access_token,'other-offer')).offer.id;
 const winner=await Promise.all([call('/offers/'+id+'/accept','POST',{expected_revision:2},undefined,buyer.access_token,'win1'),call('/offers/'+another+'/accept','POST',{expected_revision:1},undefined,buyer.access_token,'win2')]);
 assert.deepEqual(winner.map(x=>x.status).sort(),[200,409]);assert.equal((await DB.prepare('SELECT COUNT(*) n FROM deals').first() as any).n,1);
 assert.equal((await call('/posts/'+p)).post.status,'closed');assert.equal((await call('/posts')).posts.length,0);
 const won=winner[0].status===200?id:another;const lost=won===id?another:id;
 assert.equal((await call('/offers/'+lost,'GET',undefined,'buyer')).offer.status,'closed');
 assert.equal((await call('/offers/'+won+'/messages','POST',{expected_revision:won===id?2:1,body:'too late'},'buyer',undefined,'late')).status,409);
 const repeat=await call('/offers/'+won+'/accept','POST',{expected_revision:won===id?2:1},undefined,buyer.access_token,won===id?'win1':'win2');assert.equal(repeat.status,200);assert.equal(repeat.deal.id,winner.find(x=>x.status===200).deal.id);assert.equal(repeat.deal.payment_status,'not_processed');
 const events=await call('/events?after=0','GET',undefined,undefined,seller.access_token);assert(events.events.some((e:any)=>['deal_agreed','offer_closed'].includes(e.kind)));assert.equal((await call('/events?after='+events.next_cursor,'GET',undefined,undefined,seller.access_token)).events.length,0);assert.equal((await call('/events','GET',undefined,'stranger')).events.length,0);assert.equal((await call('/events?after=-1','GET',undefined,'buyer')).status,400);
 // For Sale reverses buyer/seller roles without changing who selects the winner.
 const sale=(await call('/posts','POST',{...post,type:'for_sale'},'seller',undefined,'sale')).post.id;
 const saleOffer=(await call('/posts/'+sale+'/offers','POST',t,'buyer',undefined,'buy')).offer.id;
 assert.equal((await call('/offers/'+saleOffer+'/accept','POST',{expected_revision:1},undefined,seller.access_token,'no-accept-grant')).status,403);
 assert.equal((await call('/offers/'+saleOffer+'/accept','POST',{expected_revision:1},'seller',undefined,'accept-human')).status,200);
 const deal=await DB.prepare('SELECT buyer_id,seller_id FROM deals WHERE post_id=?').bind(sale).first() as any;assert.equal(deal.buyer_id,'buyer');assert.equal(deal.seller_id,'seller');
 // Revocation between authorization and transaction must prevent all effects.
 const live=(await call('/posts','POST',post,'buyer',undefined,'more')).post.id;
 const request=req('/posts/'+live+'/offers','POST',t,undefined,seller.access_token,'revoked-race');const actor=await actorFor(request,db);
 await call('/connections/'+seller.connection.id+'/revoke','POST',{},'seller');
 await assert.rejects(()=>negotiate(request,db,actor,'/posts/'+live+'/offers',t),(e:any)=>e.status===409);
 assert.equal((await call('/offers','GET',undefined,undefined,seller.access_token)).status,401);
 // Near-limit concurrent sends and revisions must be serialized, not exceed caps.
 const cap=(await call('/posts/'+live+'/offers','POST',t,'other',undefined,'cap')).offer.id;
 assert.equal((await call('/posts/'+live+'/archive','POST',{},'buyer')).status,409);
 const forged=req('/offers/'+cap+'/messages','POST',{body:'csrf',expected_revision:1},'buyer',undefined,'csrf');forged.headers.set('Origin','https://evil.test');assert.equal((await handleApi(forged,{DB:db})).status,403);
 for(let i=0;i<39;i++)await DB.prepare('INSERT INTO messages(id,offer_id,author_id,actor_name,body,created_at) VALUES(?,?,?,?,?,?)').bind('limit-'+i,cap,'other','Other','Fixture question',Date.now()).run();
 const sends=await Promise.all([call('/offers/'+cap+'/messages','POST',{body:'Final permitted question',expected_revision:1},'buyer',undefined,'limit-a'),call('/offers/'+cap+'/messages','POST',{body:'Another question',expected_revision:1},'buyer',undefined,'limit-b')]);assert.deepEqual(sends.map(x=>x.status).sort(),[200,409]);
 assert.equal((await call('/offers/'+cap,'GET',undefined,'buyer')).messages.length,40);
 const edits=await Promise.all([call('/offers/'+cap+'/revise','POST',{...t,price:130,expected_revision:1},'other',undefined,'edit-a'),call('/offers/'+cap+'/revise','POST',{...t,price:135,expected_revision:1},'other',undefined,'edit-b')]);assert.deepEqual(edits.map(x=>x.status).sort(),[200,409]);assert.equal((await call('/offers/'+cap,'GET',undefined,'buyer')).history.length,2);
 await call('/offers/'+cap+'/withdraw','POST',{expected_revision:2},'other',undefined,'cap-withdraw');
 const highPost=(await call('/posts','POST',post,'buyer',undefined,'high-post')).post.id;
 const high=(await call('/posts/'+highPost+'/offers','POST',{...t,price:201},'other',undefined,'high')).offer.id;
 assert.equal((await call('/offers/'+high+'/accept','POST',{expected_revision:1},undefined,buyer.access_token,'over-wanted-budget')).status,200);
 // Large inboxes page without leaks or skipped sequences.
 for(let i=0;i<51;i++)await DB.prepare('INSERT INTO negotiation_events(owner_id,kind,offer_id,post_id,revision,actor_name,created_at) VALUES(?,?,?,?,?,?,?)').bind('buyer','fixture',cap,live,2,'Fixture',Date.now()).run();
 const firstPage=await call('/events?after=0','GET',undefined,'buyer');assert.equal(firstPage.events.length,50);assert.equal(firstPage.has_more,true);
 const nextPage=await call('/events?after='+firstPage.next_cursor,'GET',undefined,'buyer');assert(nextPage.events.every((e:any)=>e.sequence>firstPage.next_cursor));assert.equal(new Set([...firstPage.events,...nextPage.events].map((e:any)=>e.sequence)).size,firstPage.events.length+nextPage.events.length);
 // Expired proposals cannot be accepted, but can be withdrawn. No new event on rejected writes.
 const ex=(await call('/posts/'+live+'/offers','POST',t,'other',undefined,'exp')).offer.id;
 await DB.prepare('UPDATE offers SET expires_at=0 WHERE id=?').bind(ex).run();
 assert.equal((await call('/offers/'+ex+'/accept','POST',{expected_revision:1},'buyer',undefined,'expired')).status,409);
 assert.equal((await call('/offers/'+ex+'/withdraw','POST',{expected_revision:1},'other',undefined,'withdraw')).status,200);
 assert.equal((await call('/posts/'+live+'/archive','POST',{},'buyer')).status,200);
 }finally{await mf.dispose();rmSync(dir,{recursive:true,force:true});}
});
