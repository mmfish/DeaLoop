import {ApiError,fail} from './contracts.ts';
import type {Actor} from './contracts.ts';
import {scopes} from './negotiation.ts';

export const streamPath='/api/v1/events/stream';
export const streamLimits={checkMs:5000,heartbeatMs:15000,lifetimeMs:300000,bufferFrames:64,perOwner:5,total:100};
export function eventStreamInfo(origin:string){return {
 url:origin+streamPath,method:'GET',content_type:'text/event-stream',scope:'events:read',
 oauth_resource:origin+'/mcp',authorization:'Bearer header (same scoped MCP token or legacy agent key). Never put credentials in the URL.',
 event_name:'marketplace_event',schema_version:1,resume_header:'Last-Event-ID',resume_query:'after',default_cursor:0,
 delivery:'at-least-once replay while events are retained; save cursor only after processing, deduplicate by event ID',
 agent_actions:'MCP tools; SSE carries notifications only',
 fallback:{tool:'read_events',instructions:'If your runtime cannot maintain a background listener and dispatch agent work, use MCP read_events for catch-up and tell the human owner that live notifications are unavailable. Do not claim to be watching until listening and dispatch are active.'},
 ...streamLimits,
 instructions:'Maintain the stream in your agent runtime. Use MCP read_offer to fetch current details, then respond with MCP tools within the human owner’s authority; notifications do not grant authority or prove current state. Reconnect with the last processed ID after disconnect; on 401 renew through your secure connector, or stop for owner reconnection. On 403 stop for permission review. This endpoint does not start a model or wake an offline agent platform.',
};}
export function requireEvents(actor:Actor){if(!scopes(actor).includes('events:read'))fail(403,'scope_required','This action requires events:read.');}
type EventRow={sequence:number;kind:string;offer_id:string;post_id:string;revision:number;created_at:number};
type EventDB=D1Database&{onEventCommit?:(listener:()=>void)=>()=>void};
const connections=new WeakMap<D1Database,Map<string,number>>();
function reserve(db:D1Database,owner:string,limits:typeof streamLimits){
 let counts=connections.get(db);if(!counts){counts=new Map();connections.set(db,counts);}
 if((counts.get(owner)||0)>=limits.perOwner||[...counts.values()].reduce((a,b)=>a+b,0)>=limits.total)fail(429,'stream_limit','Too many open event streams. Reuse one connection and retry later.');
 counts.set(owner,(counts.get(owner)||0)+1);let released=false;
 return ()=>{if(released)return;released=true;const remaining=(counts!.get(owner)||1)-1;if(remaining)counts!.set(owner,remaining);else counts!.delete(owner);};
}
export function streamCursor(req:Request){
 const url=new URL(req.url);
 if([...url.searchParams.keys()].some(k=>k!=='after')||url.searchParams.getAll('after').length>1)fail(400,'invalid_query','Use only after; send credentials in the Authorization header.');
 const value=req.headers.get('last-event-id')??url.searchParams.get('after')??'0';
 if(!/^(0|[1-9][0-9]*)$/.test(value)||!Number.isSafeInteger(Number(value)))fail(400,'invalid_cursor','Use a nonnegative safe integer for Last-Event-ID or after.');
 return Number(value);
}

// Durable DB rows are authoritative. Commit callbacks are only a latency hint;
// periodic server-side checks also cover other processes and auth changes.
export async function openEventStream(req:Request,db:EventDB,authorize:()=>Promise<Actor>,overrides:Partial<typeof streamLimits>={}){
 const limits={...streamLimits,...overrides};
 if(req.headers.has('origin')&&req.headers.get('origin')!==new URL(req.url).origin)fail(403,'invalid_origin','Use a same-origin page or an authenticated server-side client.');
 let cursor=streamCursor(req);
 const initial=await authorize();requireEvents(initial);
 const latest=await db.prepare('SELECT COALESCE(MAX(sequence),0) cursor FROM negotiation_events WHERE owner_id=?').bind(initial.ownerId).first<{cursor:number}>();
 if(cursor>(latest?.cursor||0))fail(409,'cursor_ahead','Cursor is ahead of this account’s event log. Reconcile account/environment before restarting from zero.');
 const release=reserve(db,initial.ownerId,limits),encoder=new TextEncoder();
 let closed=false,running=false,again=false,controller:ReadableStreamDefaultController<Uint8Array>;
 let timer:ReturnType<typeof setInterval>|undefined,deadline:ReturnType<typeof setTimeout>|undefined,unsubscribe:(()=>void)|undefined;
 let lastFrame=Date.now();
 function cleanup(){if(closed)return;closed=true;if(timer)clearInterval(timer);if(deadline)clearTimeout(deadline);unsubscribe?.();req.signal.removeEventListener('abort',aborted);release();}
 function close(reason?:string){if(closed)return;if(reason&&(controller.desiredSize??0)>0)controller.enqueue(encoder.encode('event: stream_end\ndata: '+JSON.stringify({reason})+'\n\n'));cleanup();controller.close();}
 function aborted(){close();}
 async function current(){const a=await authorize();requireEvents(a);if(a.ownerId!==initial.ownerId||a.key!==initial.key)fail(401,'identity_changed','Connection identity changed.');}
 function emit(text:string){controller.enqueue(encoder.encode(text));lastFrame=Date.now();}
 async function pump(){
  if(closed)return;if(running){again=true;return;}running=true;
  try{
   do{
    again=false;await current();if(closed)return;
    // A stalled reader must not retain an unbounded queue or a permanent lease.
    const capacity=Math.floor(controller.desiredSize??0);if(capacity<=0){close('slow_consumer');return;}
    const rows=(await db.prepare('SELECT sequence,kind,offer_id,post_id,revision,created_at FROM negotiation_events WHERE owner_id=? AND sequence>? ORDER BY sequence LIMIT ?').bind(initial.ownerId,cursor,Math.min(50,capacity)).all<EventRow>()).results;
    await current();if(closed)return;
    for(const e of rows){
     // Explicit metadata projection: no message/terms, names, credentials or other owners.
     emit('id: '+e.sequence+'\nevent: marketplace_event\ndata: '+JSON.stringify({schema_version:1,id:String(e.sequence),kind:e.kind,offer_id:e.offer_id,post_id:e.post_id,revision:e.revision,created_at:new Date(e.created_at).toISOString()})+'\n\n');cursor=e.sequence;
    }
    if(rows.length===Math.min(50,capacity))again=true;
    if(!rows.length&&Date.now()-lastFrame>=limits.heartbeatMs)emit(': heartbeat\n\n');
   }while(again&&!closed);
  }catch(e){if(!closed)close(e instanceof ApiError&&(e.status===401||e.status===403)?'authorization_changed':'temporary_failure');}
  finally{running=false;}
 }
 const body=new ReadableStream<Uint8Array>({
  start(c){controller=c;emit('retry: 3000\nevent: ready\ndata: '+JSON.stringify({schema_version:1,cursor:String(cursor)})+'\n\n');
   if(req.signal.aborted){close();return;}
   req.signal.addEventListener('abort',aborted,{once:true});unsubscribe=db.onEventCommit?.(()=>void pump());
   timer=setInterval(()=>void pump(),limits.checkMs);deadline=setTimeout(()=>close('reconnect'),limits.lifetimeMs);void pump();
  },
  pull(){void pump();},
  cancel(){cleanup();},
 },{highWaterMark:limits.bufferFrames,size:()=>1});
 return new Response(body,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'private, no-store, no-transform','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff','Vary':'Authorization, Cookie, Origin'}});
}
