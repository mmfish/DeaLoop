import {Shell,PageHeading,Empty,money} from '../ui';
import {requireUser} from '../auth';
import {repository} from '../data';
import {Negotiations} from '@/backend/negotiation';
import {Handshake,ArrowUpRight,Package,MapPin,Truck} from 'lucide-react';
import {WantedArt} from '../wanted-art';
export const dynamic='force-dynamic';
export default async function AgreedDeals({searchParams}:{searchParams:Promise<{view?:string;post_id?:string}>}){
 const {view,post_id}=await searchParams;
 const currentView=view==='buying'||view==='selling'?view:'all';
 const query=(value:string)=>'/deals?view='+value+(post_id?'&post_id='+encodeURIComponent(post_id):'');
 const user=await requireUser(query(currentView));
 const deals=await new Negotiations(repository().db).agreements(user.userId,currentView,post_id);
 return <Shell active="deals">
  <PageHeading eyebrow="THE MATCH IS MADE" title="Agreed Deals" description="Your closed agreements, with the final price and handoff details in one place."/>
  <div className="offer-tabs">{[['all','All deals'],['buying','Buying'],['selling','Selling']].map(([key,label])=><a key={key} className={currentView===key?'selected':''} aria-current={currentView===key?'page':undefined} href={query(key)}>{label}</a>)}<a className="offer-refresh" href={query(currentView)}>Refresh</a></div>
  {deals.length?<div className="deal-list">{deals.map(d=>{
   const buying=d.buyer_id===user.userId,t=d.terms;
   const counterparty=buying?d.seller_name:d.buyer_name;
   return <a className="agreed-deal" href={'/offers/'+d.offer_id} key={d.id}>
    <div className={'deal-thumbnail '+(d.post_type==='wanted'?'wanted-deal':'')}>{d.image?<img src={d.image} alt="" loading="lazy"/>:d.post_type==='wanted'?<WantedArt category={d.category}/>:<Package size={34} strokeWidth={1.4}/>}</div>
    <div className="deal-copy"><div className="offer-row-meta"><span>{buying?'YOU’RE BUYING':'YOU’RE SELLING'}</span><span className="offer-status accepted"><Handshake size={12}/> Agreed</span></div><h2>{t.item}</h2><p>{buying?'Seller':'Buyer'}: {counterparty}</p><p className="deal-handoff">{t.delivery==='shipping'?<Truck size={14}/>:<MapPin size={14}/>} {t.delivery==='shipping'?'Shipping':'Local pickup'} · {t.condition}</p><p className="deal-terms-preview">{t.terms}</p><small>Agreed {new Date(d.created_at).toLocaleString('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})} UTC · Terms #{d.revision}</small></div>
    <div className="deal-price"><span>Final price</span><strong>{money(Math.round(t.price*100))}</strong><span className="deal-open">View agreement <ArrowUpRight size={16}/></span></div>
   </a>;
  })}</div>:<Empty title={currentView==='buying'?'No buying agreements yet.':currentView==='selling'?'No selling agreements yet.':'Your next good deal belongs here.'} href="/offers" label="View offers & conversations">When a post owner selects an offer, the final agreement appears here for both buyer and seller.</Empty>}
  <p className="quiet-note deal-note">An agreed deal records the final terms and closes the post. Review the pickup or shipping arrangements in your agreement. Payment and delivery are handled outside DeaLoop.</p>
 </Shell>;
}
