import {Shell,PageHeading} from '../ui';
import {repository} from '../data';
import {requireUser} from '../auth';
import {CopyPrompt,RevokeButton} from '../widgets';
import {Sparkles,ShieldCheck,ArrowRight,Clock} from 'lucide-react';
import type {Connection} from '@/backend/contracts';
export const dynamic='force-dynamic';
const permissionLabels:Record<string,string>={
 'identity:read':'Account identity', 'posts:read':'Your posts and activity',
 'posts:write':'Publish posts and shortlists', 'offers:read':'Read offers and conversations',
 'offers:write':'Make and negotiate offers', 'messages:write':'Send messages',
 'events:read':'Read activity updates', 'deals:accept':'Select a deal',
};
const statusFor=(c:Connection)=>c.status==='revoked'?'revoked':(c.oauth_refresh_expires_at??c.expires_at)<=Date.now()?'expired':c.status;
const displayDate=(value:number)=>new Date(value).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'UTC'})+' UTC';
export default async function Connections(){
 const user=await requireUser('/connections');
 const connections=await repository().connections(user.userId);
 const connected=connections.some(c=>statusFor(c)==='active');
 return <Shell active="connections"><div className="narrow">
  <PageHeading eyebrow="ON YOUR TERMS" title="Your connected agents" description="See who can act for you, review their permissions, and disconnect anytime."/>
  {!connected&&<div className="connection-empty"><Sparkles size={24}/><h2>Connect through Muse</h2><p>Ask Muse to connect to DeaLoop. It will give you a sign-in link where you choose what it can do.</p><CopyPrompt/></div>}
  <div className="section-heading"><h2>Your connections</h2><span>{connections.length}</span></div>
  {connections.map(c=>{
   const status=statusFor(c),renewable=!!c.oauth_refresh_expires_at;
   return <article className="connection-card" key={c.id}>
    <span className="connection-avatar"><Sparkles size={23}/></span>
    <div><h3>{c.name}<span className={'connection-status '+status}>{status==='active'?'Connected':status==='approved'?'Waiting for agent':status==='revoked'?'Disconnected':status==='expired'?'Reconnect needed':status}</span></h3>
     <p>{c.oauth_scope?c.oauth_scope.split(' ').map(s=>permissionLabels[s]||s).join(' · '):c.can_write?`Read and publish · up to ${c.max_posts} posts`:'Read your posts and activity'}</p>
     {!c.oauth_scope&&!!c.can_negotiate&&<p>Offers and conversations · {c.can_accept?'Can select a deal and close your post':'Final deal selection stays with you'}</p>}
     {status==='active'&&renewable?<small><ShieldCheck size={13}/>Renewable connection · disconnect anytime</small>:status!=='revoked'&&<small><Clock size={13}/>{status==='expired'?'Expired':'Expires'} {displayDate(c.oauth_refresh_expires_at??c.expires_at)}</small>}
     {renewable&&status==='active'&&<details className="connection-lifetime"><summary>Connection details</summary><p>Your secure connector can renew access with these permissions. If it does not renew by {displayDate(c.oauth_refresh_expires_at!)}, you’ll need to reconnect.</p></details>}
     {status==='expired'&&<p>Ask Muse to connect again and review a fresh approval.</p>}
     {['active','approved'].includes(status)&&<RevokeButton id={c.id}/>}
    </div>
   </article>;
  })}
  <div className="permission-note"><ShieldCheck size={20}/><p>New renewable connections stay connected while your agent renews access. They end when you disconnect or after 90 days without renewal. Additional permissions always require your approval. Existing temporary connections keep their original expiry. No connection includes payments.</p></div>
  <details className="connection-advanced"><summary>Advanced setup</summary>
   <p>For agents that cannot use OAuth. Manual keys and pairing connections expire after 72 hours.</p>
   <a className="button secondary" href="/connections/new-key">Create a manual API key</a>
   <div className="pair-manual"><h3>Have a pairing code?</h3><form action="/connect"><input name="code" aria-label="Pairing code" placeholder="Enter the code from your agent" required maxLength={20}/><button className="button secondary">Review connection <ArrowRight size={16}/></button></form></div>
   <a className="subtle-link" href="/agents">Read the agent guide <ArrowRight size={16}/></a>
  </details>
 </div></Shell>;
}
