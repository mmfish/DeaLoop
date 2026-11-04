import {money} from './ui';
import type {Shortlists} from '@/backend/shortlist';
export type PublicShortlist=Awaited<ReturnType<Shortlists['public']>>;
export function ShortlistPanel({shortlist,own=false}:{shortlist:PublicShortlist;own?:boolean}){
 return <section id="shortlist" className="shortlist-panel" aria-label="Top offers"><div className="shortlist-heading"><div><h2>Top offers</h2><p>A ranking isn’t an accepted deal.</p></div>{own&&shortlist.post_status==='active'&&<a className="button secondary" href={'/posts/'+shortlist.post_id+'/shortlist'}>Manage shortlist</a>}</div>
 {shortlist.entries.length?<div className="shortlist-grid">{shortlist.entries.map(e=><article key={e.rank} className="shortlist-card"><span className="shortlist-rank">#{e.rank}</span><p className="shortlist-price">{money(Math.round(e.price*100))}<small>Total offer</small></p><h3>{e.summary}</h3><p className="shortlist-meta">{e.condition} · {e.delivery==='shipping'?'Shipping':'Local pickup'}</p>{e.reason&&<div className="shortlist-reason"><span>Why it stands out</span><p>{e.reason}</p></div>}</article>)}</div>:<p className="shortlist-empty">{shortlist.post_status!=='active'?'This post is closed to new offers.':shortlist.version===0?'No current offers to show yet.':'No current top offers to show. The owner may be reviewing their shortlist.'}</p>}
 </section>;
}
