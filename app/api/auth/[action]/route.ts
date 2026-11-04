import {env} from '@/runtime/bindings';
import {authEndpoint} from '@/backend/auth';
import {externalRequest} from '@/backend/deployment';
export const dynamic='force-dynamic';
export async function POST(req:Request,{params}:{params:Promise<{action:string}>}){return authEndpoint(externalRequest(req),env.DB!,(await params).action);}
