import {env} from '@/runtime/bindings';
import {externalRequest} from '@/backend/deployment';
import {handleOAuth} from '@/backend/oauth';
export const dynamic='force-dynamic';
export const GET=(request:Request)=>handleOAuth(externalRequest(request),env.DB!);
export const POST=GET;
