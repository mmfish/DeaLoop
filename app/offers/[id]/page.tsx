import {notFound} from 'next/navigation';
import {Shell,money} from '../../ui';
import {requireUser} from '../../auth';
import {repository} from '../../data';
import {Negotiations} from '@/backend/negotiation';
import {OfferAction,MessageForm,ReviewDeal} from '../../negotiation-ui';
import {OfferCard} from '../../offer-card';
export const dynamic='force-dynamic';
export default async function Conversation({params}:{params:Promise<{id:string}>}){
 const {id}=await params;
 const user=await requireUser('/offers/'+id),repo=new Negotiations(repository().db);
 if(!await repo.offer(id,user.userId))notFound();
 const {offer:o,messages,history,deal}=await repo.detail(id,user.userId);
 const open=!deal&&o.status==='open'&&!o.expired,owner=o.role==='post_owner',finalTerms=deal?.terms??o;
 const status=deal?'Deal agreed':o.status!=='open'?o.status.charAt(0).toUpperCase()+o.status.slice(1):o.expired?'Offer expired':owner?(o.can_accept?'Ready for your decision':'Awaiting their response'):o.proposed_by==='counterparty'&&!o.counterparty_confirmed?'Counteroffer received · Your response needed':o.counterparty_confirmed?'Confirmed · Waiting for the post owner’s decision':'Your offer · Awaiting response';
 const historyPanel=history.length>1?<details className="offer-card-history"><summary>Offer history <span>{history.length} versions</span></summary>{[...history].reverse().map(h=><article className="history-entry" key={h.revision}><h3>Offer #{h.revision} · {money(h.terms.price*100)}</h3><small>{h.actor} · {new Date(h.created_at).toLocaleString('en-US',{timeZone:'UTC',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})} UTC</small><p>{h.terms.item} · {h.terms.condition} · {h.terms.delivery==='shipping'?'Shipping':'Local pickup'}</p><p className="description">{h.terms.terms}</p></article>)}</details>:null;
 return <Shell active={deal?'deals':'offers'}><div className="offer-detail-layout">
  <a className="back-link" href={deal?'/deals':'/offers'}>← {deal?'Agreed Deals':'Offers & conversations'}</a>
  <div className="conversation-heading"><div><p className="eyebrow">{owner?'OFFER RECEIVED':'YOUR OFFER'} · {o.post_type==='wanted'?'WANTED':'FOR SALE'}</p><h1>{o.post_title}</h1><p>Conversation with <strong>{o.counterparty}</strong></p></div><a className="button secondary" href={'/offers/'+id}>Refresh conversation</a></div>
  {owner&&open&&<a className="subtle-link" href={'/posts/'+o.post_id+'/shortlist'}>Manage this post’s top offers →</a>}
  {deal&&<div className="deal-banner"><strong>Deal agreed</strong><p>Offer #{deal.revision} was agreed on {new Date(deal.created_at).toLocaleString('en-US',{timeZone:'UTC'})} UTC.</p><small>Payment and delivery are handled outside DeaLoop.</small></div>}
  <div className="conversation-grid consolidated-offer-grid">
   <OfferCard key={o.revision} id={id} revision={deal?.revision??o.revision} initial={o} editable={open} ownProposal={o.proposed_by==='you'} agreed={!!deal} status={status} history={historyPanel} decision={open&&owner&&o.can_accept?<ReviewDeal id={id} revision={o.revision} offer={o}/>:null} summary={<><p className="offer-card-price">{money(Math.round(finalTerms.price*100))}<span>Total price</span></p><p className="terms-item">{finalTerms.item}</p></>}>
    <dl><dt>Condition</dt><dd>{finalTerms.condition}</dd><dt>Handoff</dt><dd>{finalTerms.delivery==='shipping'?'Shipping':'Local pickup'}</dd>{!deal&&<><dt>Valid until</dt><dd>{new Date(o.expires_at).toLocaleString('en-US',{timeZone:'UTC'})} UTC</dd></>}</dl>
    <h3>{deal?'Agreed terms':'Additional terms'}</h3><p className="description">{finalTerms.terms}</p>
    <a className="subtle-link offer-post-link" href={'/posts/'+o.post_id}>View original post →</a>
    {open&&<div className="offer-decisions">{owner?(o.can_accept?null:<p className="offer-waiting">Your counteroffer has been sent. Waiting for their confirmation.</p>):o.proposed_by==='counterparty'&&!o.counterparty_confirmed?<OfferAction id={id} revision={o.revision} action="confirm" label="Agree to counteroffer"/>:<p className="offer-waiting">{o.counterparty_confirmed?'You’ve confirmed this proposal. Waiting for the post owner’s decision.':'Your proposal has been sent. You can edit it while you wait.'}</p>}<OfferAction id={id} revision={o.revision} action={owner?'decline':'withdraw'} label={owner?'Decline offer':'Withdraw offer'}/></div>}
    {o.status==='open'&&o.expired&&<div className="offer-decisions"><OfferAction id={id} revision={o.revision} action={owner?'decline':'withdraw'} label={owner?'Decline expired offer':'Withdraw expired offer'}/></div>}
   </OfferCard>
   <section className="conversation-panel"><div className="section-heading"><h2>Your conversation</h2><span>{messages.length} {messages.length===1?'message':'messages'}</span></div>
    <div className="message-list">{messages.length?messages.map(m=><article key={m.id} className={'message-bubble '+(m.by==='you'?'mine':'')}><div><strong>{m.by==='you'?'You':o.counterparty}</strong><small>{m.actor} · {new Date(m.created_at).toLocaleTimeString('en-US',{timeZone:'UTC',hour:'numeric',minute:'2-digit'})} UTC</small></div><p>{m.body}</p></article>):<div className="conversation-empty">Work out the details together.<br/>Ask about the item, pickup, or anything else that matters.</div>}</div>
    {open?<MessageForm id={id} revision={o.revision} count={messages.length}/>:<p className="quiet-note">{deal?'Your conversation is saved with this agreement.':`This conversation is read-only because the offer is ${o.expired&&o.status==='open'?'expired':o.status}.`}</p>}
   </section>
  </div>
 </div></Shell>;
}
