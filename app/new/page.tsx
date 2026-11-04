import {Shell,PageHeading,Back} from '../ui';
import {PostForm} from '../widgets';
import {requireUser} from '../auth';
export const dynamic='force-dynamic';
export default async function New({searchParams}:{searchParams:Promise<{type?:string}>}){const {type}=await searchParams;await requireUser('/new'+(type==='wanted'?'?type=wanted':''));return <Shell><div className="narrow"><Back/><PageHeading eyebrow="MAKE A CONNECTION" title="A new home. Or a new find." description="Tell the community what you have—or what you’re hoping to find."/><PostForm initialType={type}/></div></Shell>;}
