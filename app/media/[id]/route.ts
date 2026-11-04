import {env} from '@/runtime/bindings';
import {externalRequest} from '@/backend/deployment';
import {readMedia} from '@/backend/media';
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){
 return readMedia(externalRequest(req),(await params).id,{DB:env.DB!,BUCKET:env.BUCKET});
}
