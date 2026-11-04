import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: dependency-free JavaScript integration example
import {parseSse,consumeEvents} from '../examples/sse/client.mjs';
const encode=new TextEncoder();
const stream=(text:string)=>new ReadableStream<Uint8Array>({start(c){for(const byte of encode.encode(text))c.enqueue(Uint8Array.of(byte));c.close();}});
const frame=(id:string)=>'id: '+id+'\nevent: marketplace_event\ndata: '+JSON.stringify({schema_version:1,id,kind:'messages',offer_id:'test',post_id:'test',revision:1,created_at:'2026-11-03T00:00:00Z'})+'\n\n';
test('reference client parses split UTF-8/CRLF, ignores comments, combines data and drops incomplete frames',async()=>{
 const result=[];for await(const f of parseSse(stream(': heartbeat\r\n\r\nretry: 3000\r\nid: 7\r\nevent: marketplace_event\r\ndata: first\r\ndata: café\r\n\r\nid: 8\ndata: incomplete')))result.push(f);
 assert.deepEqual(result,[{event:'marketplace_event',id:'7',data:'first\ncafé',retry:3000}]);
});
test('reference client renews through callback, deduplicates and persists only after successful work',async()=>{
 const abort=new AbortController(),order:string[]=[],requests:Headers[]=[];let calls=0;
 await consumeEvents({url:'https://dealoop.example/api/v1/events/stream',loadCursor:async()=>'5',getAccessToken:async()=>'test-token',onUnauthorized:async()=>{order.push('renew');},onEvent:async(e:any)=>{order.push('process:'+e.id);},saveCursor:async(id:string)=>{order.push('save:'+id);abort.abort();},signal:abort.signal,
  fetcher:async(_url:unknown,options?:RequestInit)=>{requests.push(new Headers(options?.headers));assert.equal(options?.redirect,'error');return ++calls===1?new Response(null,{status:401}):new Response(stream(frame('5')+frame('6')),{headers:{'Content-Type':'text/event-stream'}});}});
 assert.deepEqual(order,['renew','process:6','save:6']);assert.equal(calls,2);assert.equal(requests[1].get('Last-Event-ID'),'5');
 let saved=false;
 await assert.rejects(()=>consumeEvents({url:'https://dealoop.example/api/v1/events/stream',loadCursor:async()=>0,getAccessToken:async()=>'test-token',onEvent:async()=>{throw Error('durable queue unavailable');},saveCursor:async()=>{saved=true;},fetcher:async()=>new Response(stream(frame('1')),{headers:{'Content-Type':'text/event-stream'}})}),/durable queue unavailable/);
 assert.equal(saved,false);
});
test('reference client stops on rejected renewal, permission errors and unsafe URL configuration',async()=>{
 let refreshes=0;
 const options={url:'https://dealoop.example/api/v1/events/stream',loadCursor:async()=>0,getAccessToken:async()=>'test-token',onEvent:async()=>{},saveCursor:async()=>{},onUnauthorized:async()=>{refreshes++;},fetcher:async()=>new Response(null,{status:401})};
 await assert.rejects(()=>consumeEvents(options),/Authorization failed/);assert.equal(refreshes,1);
 await assert.rejects(()=>consumeEvents({...options,fetcher:async()=>new Response(null,{status:403})}),/HTTP 403/);
 await assert.rejects(()=>consumeEvents({...options,url:options.url+'?token=secret'}),/exact HTTPS/);
});
