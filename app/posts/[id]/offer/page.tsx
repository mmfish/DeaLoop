import {ShortlistPanel} from '../../../shortlist';
import {Shortlists} from '@/backend/shortlist';
import {notFound,redirect} from 'next/navigation';
import {Shell,PageHeading} from '../../../ui';
import {requireUser} from '../../../auth';
import {repository} from '../../../data';
import {OfferForm} from '../../../negotiation-ui';
export const dynamic='force-dynamic';
export default async function NewOffer({params}:{params:Promise<{id:string}>}){const {id}=await params;const user=await requireUser('/posts/'+id+'/offer'),p=await repository().post(id);if(!p)notFound();if(p.owner_id===user.userId)redirect('/offers?post_id='+id);return <Shell active="offers"><div className="narrow"><a className="back-link" href={'/posts/'+id}>← Back to post</a><PageHeading eyebrow={p.type==='wanted'?'HAVE WHAT THEY’RE LOOKING FOR?':'MAKE IT YOUR NEXT FIND'} title="Start with an offer." description={p.title}/><ShortlistPanel shortlist={await new Shortlists(repository().db).public(id)}/>{p.status!=='active'||p.demo?<div className="quiet-note">Offers are unavailable for closed, archived, or example posts.</div>:<OfferForm postId={id} wanted={p.type==='wanted'} initial={{price:p.price/100,item:p.type==='for_sale'?p.title:'',condition:p.condition,delivery:p.delivery==='shipping'?'shipping':'local_pickup',terms:''}}/>}</div></Shell>;}
