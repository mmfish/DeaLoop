'use client';
import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {Pencil,ArrowLeftRight,ChevronDown} from 'lucide-react';
import {OfferForm} from './negotiation-ui';

type Props={id:string;revision:number;initial:{price:number;item:string;condition:string;delivery:string;terms:string};editable:boolean;ownProposal:boolean;agreed:boolean;status:string;summary:ReactNode;children:ReactNode;history:ReactNode;decision?:ReactNode};
export function OfferCard({id,revision,initial,editable,ownProposal,agreed,status,summary,children,history,decision}:Props){
 const [expanded,setExpanded]=useState(false),[editing,setEditing]=useState(false);
 const detailsId=useId();
 const editButton=useRef<HTMLButtonElement>(null),wasEditing=useRef(false);
 useEffect(()=>{if(wasEditing.current&&!editing)editButton.current?.focus();wasEditing.current=editing;},[editing]);
 const editLabel=ownProposal?'Edit offer':'Make counteroffer';
 return <aside className={'terms-panel offer-card'+(editing?' is-editing':'')} aria-label={agreed?'Agreed offer':'Current offer'}>
  <div className="offer-card-heading"><div><p className="offer-card-kicker">{agreed?'FINAL AGREEMENT':`OFFER #${revision}`}</p><h2>{agreed?'Agreed offer':'Current offer'}</h2></div><button className="button secondary small offer-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={()=>setExpanded(!expanded)}>{expanded?'Hide details':'Show details'}<ChevronDown size={16} aria-hidden="true"/></button></div>
  <div className="offer-compact-summary">{summary}</div>
  <p className={'offer-progress'+(agreed?' agreed':'')}><span aria-hidden="true"/>{status}</p>
  {decision}
  <div id={detailsId} hidden={!expanded} className="offer-expanded-details">
   {editing?<><h3>{ownProposal?'Edit offer':'Your counteroffer'}</h3><p className="offer-editor-intro">Adjust the details below, then send your proposal to the other person.</p><OfferForm offerId={id} revision={revision} initial={initial} compact onCancel={()=>setEditing(false)} submitLabel={ownProposal?'Send revised offer':'Send counteroffer'}/></>:<>{editable&&<div className="offer-details-toolbar"><button ref={editButton} className="button secondary small offer-edit-button" onClick={()=>setEditing(true)}>{ownProposal?<Pencil size={14}/>:<ArrowLeftRight size={14}/>} {editLabel}</button></div>}{children}{history}</>}
  </div>
 </aside>;
}
