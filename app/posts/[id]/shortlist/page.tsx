import {notFound} from 'next/navigation';
import {Shell,PageHeading} from '../../../ui';
import {requireUser} from '../../../auth';
import {repository} from '../../../data';
import {Shortlists} from '@/backend/shortlist';
import {ShortlistEditor} from '../../../shortlist-editor';
export const dynamic='force-dynamic';
export default async function ManageShortlist({params}:{params:Promise<{id:string}>}){
 const {id}=await params,user=await requireUser('/posts/'+id+'/shortlist'),repo=repository(),post=await repo.post(id);
 if(!post||post.owner_id!==user.userId)notFound();
 const initial=await new Shortlists(repo.db).manage(id,{ownerId:user.userId,name:user.displayName,key:'human:'+user.userId,agentId:null,canWrite:true,canNegotiate:true,canAccept:true});
 return <Shell active="posts"><div className="narrow"><a className="back-link" href={'/posts/'+id}>← Back to post</a><PageHeading eyebrow="YOUR PREFERENCES, YOUR ORDER" title="Manage shortlist" description={post.title}/>{initial.editable?<ShortlistEditor initial={initial}/>:<p>This post is closed to shortlist changes.</p>}</div></Shell>;
}
