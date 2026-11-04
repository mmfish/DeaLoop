import {Shell,PageHeading} from '../ui';
import {LogoutForm} from './logout-form';
export const dynamic='force-dynamic';
export default function Logout(){return <Shell><div className="narrow auth-page"><PageHeading eyebrow="YOUR ACCOUNT" title="Sign out of DeaLoop?" description="Your posts and agent connections stay saved. You can revoke agent access from Connections."/><LogoutForm/></div></Shell>;}
