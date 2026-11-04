import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {SQLiteDatabase} from '../runtime/sqlite.ts';
import {handleMcp,mcpTools} from '../backend/mcp.ts';
import {handleApi} from '../backend/service.ts';
import {handleOAuth,museRedirect,pkceChallenge} from '../backend/oauth.ts';
import {supportedScopes,protectedResourceMetadata} from '../backend/oauth-scopes.ts';
import {createSession} from '../backend/auth.ts';

const origin='https://dealoop.example',resource=origin+'/mcp';
test('native MCP SDK discovery and calls preserve OAuth scope/resource binding and marketplace agreement rules',async()=>{
 const sqlite=new SQLiteDatabase(':memory:');sqlite.migrate('drizzle');const db=sqlite.asD1(),env={DB:db};const clients:Client[]=[];
 const oauth=(path:string,method='GET',body?:string,headers:Record<string,string>={})=>handleOAuth(new Request(origin+path,{method,headers,...(body===undefined?{}:{body})}),db);
 const form=(path:string,fields:Record<string,string>,headers:Record<string,string>={})=>oauth(path,'POST',new URLSearchParams(fields).toString(),{'Content-Type':'application/x-www-form-urlencoded',...headers});
 const rpc=(method:string,params:unknown,auth?:string,extra:Record<string,string>={})=>handleMcp(new Request(resource,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(auth?{Authorization:'Bearer '+auth}:{}),...extra},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),env);
 const tool=(name:string,args:unknown={},auth?:string,extra:Record<string,string>={})=>rpc('tools/call',{name,arguments:args},auth,extra);
 const identity=(uid:string)=>({uid,email:uid+'@example.test',emailVerified:true,name:uid,provider:'google.com'});
 try{
  const buyer=await createSession(new Request(origin),db,identity('buyer'),false),seller=await createSession(new Request(origin),db,identity('seller'),false);
  const registration=await oauth('/oauth/register','POST',JSON.stringify({redirect_uris:[museRedirect],token_endpoint_auth_method:'none',scope:supportedScopes.join(' ')}),{'Content-Type':'application/json'});assert.equal(registration.status,201);const registered=await registration.json() as any;
  const verifier='v'.repeat(64),challenge=await pkceChallenge(verifier);
  async function authorize(owner:typeof buyer,requested:string[],selected=requested,changes:Record<string,string>={}){
   const query={client_id:registered.client_id,redirect_uri:museRedirect,response_type:'code',scope:requested.join(' '),resource,state:'sdk-test',code_challenge:challenge,code_challenge_method:'S256',...changes};
   const r=await oauth('/oauth/authorize?'+new URLSearchParams(query),'GET',undefined,{Cookie:'thread_session='+owner.token});
   if(r.status!==200)return {response:r};
   const html=await r.text();assert(!html.includes('sidebar'));for(const scope of requested.filter(s=>!s.endsWith(':read')))assert(!html.includes('name="allow_'+scope+'" value="yes" checked'));
   const id=html.match(/name="request_id" value="([^"]+)"/)![1],csrf=html.match(/name="csrf" value="([^"]+)"/)![1];
   const fields={request_id:id,csrf,decision:'approve',...Object.fromEntries(selected.map(s=>['allow_'+s,'yes']))};
   const approved=await form('/oauth/authorize',fields,{Origin:origin,Cookie:'thread_session='+owner.token+'; '+r.headers.get('set-cookie')!.split(';')[0]});
   if(approved.status!==303)return {response:approved};
   return {response:approved,code:new URL(approved.headers.get('location')!).searchParams.get('code')!,id};
  }
  const exchange=(code:string,changes:Record<string,string>={})=>form('/oauth/token',{client_id:registered.client_id,redirect_uri:museRedirect,grant_type:'authorization_code',resource,code,code_verifier:verifier,...changes});
  assert.equal((await authorize(buyer,[...supportedScopes],undefined,{resource:'https://evil.test/mcp'})).response.status,400);
  assert.equal((await authorize(buyer,[...supportedScopes],undefined,{resource:''})).response.status,400);
  assert.equal((await authorize(buyer,[...supportedScopes],[])).response.status,400);
  assert.equal((await authorize(buyer,[...supportedScopes],['identity:read','deals:accept'])).response.status,400);
  const reduced=await authorize(buyer,[...supportedScopes],['identity:read','posts:read']);assert.equal(reduced.response.status,303);
  assert.equal((await exchange(reduced.code!,{resource:'https://evil.test/mcp'})).status,400);
  assert.equal((await exchange(reduced.code!,{scope:supportedScopes.join(' ')})).status,400);
  const readResponse=await exchange(reduced.code!);assert.equal(readResponse.status,200);const readToken=await readResponse.json() as any;assert.equal(readToken.scope,'identity:read posts:read');assert.equal(readToken.refresh_token,undefined);
  const escalation=await authorize(buyer,['identity:read'],['identity:read','posts:write']);const narrow=await (await exchange(escalation.code!)).json() as any;assert.equal(narrow.scope,'identity:read');
  const buyerGrant=await authorize(buyer,[...supportedScopes]);const a=await (await exchange(buyerGrant.code!)).json() as any;
  const sellerScopes=['identity:read','posts:read','offers:read','offers:write','messages:write','events:read'];
  const sellerGrant=await authorize(seller,sellerScopes);const b=await (await exchange(sellerGrant.code!)).json() as any;
  async function client(token?:string){const client=new Client({name:'dealoop-test',version:'1.0'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(resource),{fetch:async(input,init)=>handleMcp(new Request(input,init),env),requestInit:token?{headers:{Authorization:'Bearer '+token}}:undefined}));return client;}
  const anon=await client();const listed=await anon.listTools();assert.equal(listed.tools.length,mcpTools.length);assert(listed.tools.some(t=>t.name==='publish_post'&&t.inputSchema.required?.includes('idempotency_key')));
  const call=async(c:Client,name:string,args:Record<string,unknown>={})=>{const result=await c.callTool({name,arguments:args});return {error:result.isError,data:result.structuredContent as any};};
  assert.equal((await call(anon,'search_posts')).error,false);
  assert.equal((await tool('get_my_identity')).status,401);
  const denied=await tool('publish_post',{},readToken.access_token);assert.equal(denied.status,403);assert.match(denied.headers.get('www-authenticate')!,/resource_metadata=.*oauth-protected-resource\/mcp/);assert.match(denied.headers.get('www-authenticate')!,/posts:write/);
  assert.equal((await tool('get_my_identity',{},undefined,{Cookie:'thread_session='+buyer.token})).status,401);
  assert.equal((await tool('get_my_identity',{},undefined,{'oai-authenticated-user-id':buyer.ownerId})).status,401);
  assert.equal((await rpc('initialize',{},undefined,{Origin:'https://evil.test'})).status,403);
  assert.equal((await rpc('tools/list',{},'th_'+'0'.repeat(64))).status,401);
  assert.equal((await handleMcp(new Request(resource),env)).status,405);
  assert.equal((await handleMcp(new Request(resource,{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(64001)}),env)).status,413);
  assert.equal(protectedResourceMetadata(origin).resource,resource);
  const readClient=await client(readToken.access_token);assert.equal((await call(readClient,'get_my_identity')).data.account_id,buyer.ownerId);
  const ac=await client(a.access_token),bc=await client(b.access_token);
  const post={idempotency_key:'wanted',type:'wanted',title:'Demo espresso machine wanted',description:'Working pump, discuss pickup.',category:'Home & garden',price:200,condition:'Good',location:'Oakland',delivery:'local_pickup'};
  const forged=await call(ac,'publish_post',{...post,owner_id:seller.ownerId});assert.equal(forged.error,true);
  const publish=await call(ac,'publish_post',post);assert.equal(publish.error,false);const postId=publish.data.post.id;assert.equal((await call(ac,'publish_post',post)).data.post.id,postId);
  const invalidId=await call(anon,'read_post',{post_id:'../connections'});assert.equal(invalidId.error,true);
  const terms={price:230,item:'Used espresso machine',condition:'Good',delivery:'local_pickup',terms:'Inspect pump at pickup. No payment processed.',expires_at:new Date(Date.now()+3600000).toISOString()};
  const offer=await call(bc,'create_offer',{...terms,post_id:postId,idempotency_key:'offer'});assert.equal(offer.error,false);const offerId=offer.data.offer.id;
  assert.equal((await call(ac,'send_offer_message',{offer_id:offerId,expected_revision:1,idempotency_key:'question',body:'Can I inspect the pump?'})).error,false);
  assert.equal((await call(ac,'revise_offer',{...terms,price:220,offer_id:offerId,expected_revision:1,idempotency_key:'counter'})).error,false);
  assert.equal((await call(ac,'accept_offer',{offer_id:offerId,expected_revision:2,idempotency_key:'unconfirmed'})).error,true);
  assert.equal((await call(bc,'confirm_offer',{offer_id:offerId,expected_revision:2,idempotency_key:'confirm'})).error,false);
  assert.equal((await tool('accept_offer',{},b.access_token)).status,403);
  const accepted=await call(ac,'accept_offer',{offer_id:offerId,expected_revision:2,idempotency_key:'accept'});assert.equal(accepted.error,false);assert.equal(accepted.data.deal.terms.price,220);assert.equal(accepted.data.deal.payment_status,'not_processed');
  assert((await call(bc,'read_events')).data.events.some((e:any)=>e.kind==='deal_agreed'));
  // MCP credentials cannot be replayed on REST, even with a signed-in browser cookie.
  assert.equal((await handleApi(new Request(origin+'/api/v1/me',{headers:{Authorization:'Bearer '+a.access_token,Cookie:'thread_session='+buyer.token}}),env)).status,401);
  await db.prepare("UPDATE connections SET oauth_resource='https://evil.test/mcp' WHERE id=(SELECT connection_id FROM oauth_requests WHERE id=?)").bind(sellerGrant.id!).run();assert.equal((await tool('get_my_identity',{},b.access_token)).status,401);
  await db.prepare('UPDATE connections SET expires_at=0 WHERE id=(SELECT connection_id FROM oauth_requests WHERE id=?)').bind(reduced.id!).run();assert.equal((await tool('get_my_identity',{},readToken.access_token)).status,401);
  await form('/oauth/revoke',{client_id:registered.client_id,token:a.access_token});assert.equal((await tool('get_my_identity',{},a.access_token)).status,401);
 }finally{for(const c of clients)await c.close();sqlite.close();}
});
