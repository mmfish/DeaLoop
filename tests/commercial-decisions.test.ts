import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SQLiteDatabase} from '../runtime/sqlite.ts';
import {createSession} from '../backend/auth.ts';
import {handleApi} from '../backend/service.ts';

test('agents own commercial decisions while scoped, revision-bound agreements remain enforced',async()=>{
 const sqlite=new SQLiteDatabase(':memory:');sqlite.migrate('drizzle');const db=sqlite.asD1(),origin='https://dealoop.example';
 const call=async(path:string,method='GET',body?:unknown,auth?:{cookie?:string;token?:string},key?:string)=>{
  const r=await handleApi(new Request(origin+'/api/v1'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(auth?.cookie?{Cookie:'thread_session='+auth.cookie}:{}),...(auth?.token?{Authorization:'Bearer '+auth.token}:{}),...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),{DB:db});
  return {status:r.status,...await r.json() as any};
 };
 const identity=(uid:string)=>({uid,email:uid+'@example.test',emailVerified:true,name:uid,provider:'google.com'});
 try{
  const buyer=await createSession(new Request(origin),db,identity('buyer'),false),seller=await createSession(new Request(origin),db,identity('seller'),false);
  const buyerHuman={cookie:buyer.token},sellerHuman={cookie:seller.token};
  const permissions={can_write:true,can_negotiate:true,can_accept:true};
  // Reject retired fields on both enrollment paths, instead of pretending to enforce them.
  const pending=await call('/agent-connections','POST',{name:'Pending Muse'});
  for(const field of ['max_price','min_deal_price','max_deal_price']){
   const invalid={[field]:100,...permissions};
   for(const [path,body] of [['/connections/api-key',{...invalid,name:'Old client'}],['/connections/approve',{...invalid,user_code:pending.user_code}]] as const){
    const r=await call(path,'POST',body,buyerHuman);assert.equal(r.status,400);assert.equal(r.error.code,'commercial_limits_not_supported');
   }
  }
  assert.equal((await call('/connections/approve','POST',{...permissions,user_code:pending.user_code},buyerHuman)).status,200);
  const buyerKey=await call('/agent-token','POST',{device_code:pending.device_code});assert.equal(buyerKey.status,200);
  const sellerKey=await call('/connections/api-key','POST',{...permissions,name:'Seller Muse',can_write:false,can_accept:false},sellerHuman);assert.equal(sellerKey.status,201);
  const a={token:buyerKey.access_token},b={token:sellerKey.access_token};
  // Simulate older stored grants, including ranges that exclude every price below.
  await db.prepare('UPDATE connections SET max_price=100,min_deal_price=12000,max_deal_price=18000').run();
  for(const r of [await call('/me','GET',undefined,a),...(await call('/connections','GET',undefined,buyerHuman)).connections,buyerKey.connection]){
   for(const field of ['max_price','min_deal_price','max_deal_price'])assert.equal(Object.hasOwn(r,field),false);
  }
  const post={type:'wanted',title:'A used espresso machine',description:'Working pump preferred; discuss condition and delivery.',category:'Home & garden',price:200,condition:'Good',location:'Oakland',delivery:'local_pickup'};
  const published=await call('/posts','POST',post,a,'wanted');assert.equal(published.status,201);
  const id=published.post.id;
  const terms={price:250,item:'Used espresso machine',condition:'Fair',delivery:'shipping',terms:'Cosmetic wear; shipping included. Owner and agent decide suitability.',expires_at:new Date(Date.now()+3600000).toISOString()};
  const offered=await call('/posts/'+id+'/offers','POST',terms,b,'offer');assert.equal(offered.status,200);
  const offer=offered.offer.id;
  // Above both stored range and stated budget, and a different condition/delivery preference.
  assert.equal((await call('/offers/'+offer+'/revise','POST',{...terms,price:240,expected_revision:1},b,'seller-revision')).status,200);
  // Below the stored seller minimum: neither revision nor confirmation is commercially judged.
  assert.equal((await call('/offers/'+offer+'/revise','POST',{...terms,price:90,expected_revision:2},a,'low-counter')).status,200);
  assert.equal((await call('/offers/'+offer+'/confirm','POST',{expected_revision:3},b,'low-confirm')).status,200);
  assert.equal((await call('/offers/'+offer+'/revise','POST',{...terms,price:230,expected_revision:3},a,'high-counter')).status,200);
  assert.equal((await call('/offers/'+offer+'/accept','POST',{expected_revision:3},a,'stale')).status,409);
  assert.equal((await call('/offers/'+offer+'/accept','POST',{expected_revision:4},a,'unconfirmed')).status,409);
  assert.equal((await call('/offers/'+offer+'/confirm','POST',{expected_revision:4},b,'high-confirm')).status,200);
  assert.equal((await call('/offers/'+offer+'/accept','POST',{expected_revision:4},b,'wrong-scope')).status,403);
  const accepted=await call('/offers/'+offer+'/accept','POST',{expected_revision:4},a,'accept');assert.equal(accepted.status,200);
  assert.equal(accepted.deal.terms.price,230);assert.equal(accepted.deal.revision,4);assert.equal(accepted.deal.payment_status,'not_processed');
  assert.equal((await call('/posts/'+id)).post.status,'closed');
  const replay=await call('/offers/'+offer+'/accept','POST',{expected_revision:4},a,'accept');assert.equal(replay.deal.id,accepted.deal.id);
  assert.equal((await call('/offers/'+offer+'/revise','POST',{...terms,expected_revision:4},a,'closed')).status,409);
 }finally{sqlite.close();}
});
