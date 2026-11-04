import {env} from '@/runtime/bindings';
import {externalRequest} from '@/backend/deployment';
import {handleMcp} from '@/backend/mcp';
export const dynamic='force-dynamic';
export const POST=(request:Request)=>handleMcp(externalRequest(request),{DB:env.DB!,BUCKET:env.BUCKET});
export const GET=POST;
export const DELETE=POST;
export const OPTIONS=POST;
