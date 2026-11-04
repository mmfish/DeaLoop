// Dependency-free reference consumer for runtimes with fetch/ReadableStream (Node22+).
// Credential storage, OAuth renewal, event processing and cursor persistence belong
// to the integrating agent runtime. This module never logs or writes credentials.
export async function* parseSse(body) {
 const reader=body.getReader(),decoder=new TextDecoder();
 let pending='',data=[],event='',id, retry,frameSize=0;
 try {
  for (;;) {
   const {value,done}=await reader.read();
   if(done)break; // An incomplete final frame is not acknowledged/dispatched.
   pending+=decoder.decode(value,{stream:true});
   if(pending.length>131072)throw Error('SSE input exceeds buffer limit');
   for (;;) {
    const match=/\r\n|\r|\n/.exec(pending);if(!match)break;
    if(match[0]==='\r'&&match.index===pending.length-1)break;
    const line=pending.slice(0,match.index);pending=pending.slice(match.index+match[0].length);
    frameSize+=line.length;if(frameSize>65536)throw Error('SSE frame exceeds limit');
    if(!line){
     if(data.length||retry!==undefined)yield {event:event||'message',id,data:data.join('\n'),retry};
     data=[];event='';id=undefined;retry=undefined;frameSize=0;continue;
    }
    if(line.startsWith(':'))continue;
    const colon=line.indexOf(':'),field=colon<0?line:line.slice(0,colon);
    let text=colon<0?'':line.slice(colon+1);if(text.startsWith(' '))text=text.slice(1);
    if(field==='data')data.push(text);else if(field==='event')event=text;
    else if(field==='id'&&!text.includes('\0'))id=text;
    else if(field==='retry'&&/^\d+$/.test(text))retry=Number(text);
   }
  }
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
const validCursor=value=>/^(0|[1-9][0-9]*)$/.test(String(value))&&Number.isSafeInteger(Number(value));
function sleep(ms,signal){return new Promise((resolve,reject)=>{
 if(signal?.aborted){reject(signal.reason);return;}
 const abort=()=>{clearTimeout(timer);reject(signal.reason);};
 const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
 signal?.addEventListener('abort',abort,{once:true});
});}
/**
 * @param {{url:string, getAccessToken:()=>Promise<string>, loadCursor:()=>Promise<string|number|null|undefined>, saveCursor:(id:string)=>Promise<void>, onEvent:(event:any)=>Promise<void>, onUnauthorized?:()=>Promise<void>, signal?:AbortSignal, fetcher?:typeof fetch}} options
 */
export async function consumeEvents({url,getAccessToken,loadCursor,saveCursor,onEvent,onUnauthorized,signal,fetcher=fetch}) {
 const endpoint=new URL(url);
 if(endpoint.username||endpoint.password||endpoint.hash||endpoint.search||endpoint.pathname!=='/api/v1/events/stream'||(endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&['localhost','127.0.0.1'].includes(endpoint.hostname))))throw Error('Use the exact HTTPS DeaLoop stream URL without credentials or query parameters');
 let cursor=String(await loadCursor()??'0');if(!validCursor(cursor))throw Error('Invalid saved cursor');
 let delay=3000,failures=0,renewed=false;
 async function backoff(ms=delay){await sleep(Math.max(ms,Math.min(30000,delay*2**Math.min(failures++,3)))*(1+Math.random()*0.2),signal);}
 while(!signal?.aborted){
  const token=await getAccessToken();if(!token)throw Error('No secure access token available');
  let response;
  try{response=await fetcher(endpoint,{headers:{Authorization:'Bearer '+token,Accept:'text/event-stream','Last-Event-ID':cursor},redirect:'error',credentials:'omit',cache:'no-store',signal});}
  catch(error){if(signal?.aborted)return;await backoff();continue;}
  if(response.status===401){await response.body?.cancel();if(renewed||!onUnauthorized)throw Error('Authorization failed; renew securely or ask the owner to reconnect');await onUnauthorized();renewed=true;continue;}
  if(response.status===429||response.status>=500){const retry=Number(response.headers.get('retry-after'));await response.body?.cancel();await backoff(Number.isFinite(retry)&&retry>0?retry*1000:delay);continue;}
  if(!response.ok){await response.body?.cancel();throw Error('Stream refused (HTTP '+response.status+'); review permissions/cursor before retrying');}
  if(!response.headers.get('content-type')?.startsWith('text/event-stream')||!response.body){await response.body?.cancel();throw Error('Expected an SSE response');}
  renewed=false;
  const iterator=parseSse(response.body)[Symbol.asyncIterator]();
  try{
   for(;;){
    let next;try{next=await iterator.next();}catch(error){if(signal?.aborted)return;break;}
    if(next.done)break;
    const frame=next.value;if(frame.retry!==undefined)delay=Math.max(1000,Math.min(30000,frame.retry));
    if(frame.event==='stream_end')break;
    if(frame.event!=='marketplace_event')continue;
    if(!validCursor(frame.id))throw Error('Invalid event ID');
    if(Number(frame.id)<=Number(cursor))continue;
    const event=JSON.parse(frame.data);
    if(event.schema_version!==1||event.id!==frame.id)throw Error('Unsupported event schema');
    // Await processing (including idempotent effects) BEFORE advancing durable cursor.
    await onEvent(event);await saveCursor(frame.id);cursor=frame.id;failures=0;renewed=false;
   }
  }finally{await iterator.return?.();}
  if(signal?.aborted)return;
  await backoff();
 }
}
