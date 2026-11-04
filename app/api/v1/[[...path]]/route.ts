import { env } from '@/runtime/bindings';
import {handleApi} from '@/backend/service';
import {externalRequest} from '@/backend/deployment';
export const dynamic='force-dynamic';
export const GET=(request:Request)=>handleApi(externalRequest(request),{DB:env.DB!,BUCKET:env.BUCKET});
export const POST=GET;
