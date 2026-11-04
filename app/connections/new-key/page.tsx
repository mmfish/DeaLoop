import {Shell,PageHeading} from '../../ui';
import {requireUser} from '../../auth';
import {KeyForm} from './key-form';
import {agentOrigin} from '@/backend/deployment';
export const dynamic='force-dynamic';
export default async function CreateKey(){const user=await requireUser('/connections/new-key');return <Shell active="connections"><div className="narrow"><PageHeading eyebrow="A SECURE CONNECTION FOR YOUR AGENT" title="Connect Muse to your marketplace." description={'Create a short-lived key for '+user.displayName+'’s account. You choose what the agent can do.'}/><KeyForm apiOrigin={agentOrigin()}/></div></Shell>;}
