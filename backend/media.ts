import {isAws} from './deployment.ts';
import {actorFor,type Bindings} from './service.ts';

export async function readMedia(req:Request,id:string,env:Bindings):Promise<Response>{
 const missing=()=>new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
 if(!/^[a-f0-9-]{36}$/.test(id))return missing();
 let published=true;
 if(isAws()){
  published=!!await env.DB.prepare('SELECT id FROM posts WHERE image=? LIMIT 1').bind('/media/'+id).first();
  if(!published){
   // An upload is not public until its owner attaches it to a published post.
   let owner:string;try{owner=(await actorFor(req,env.DB)).ownerId;}catch{return missing();}
   const photo=await env.DB.prepare('SELECT owner_id FROM photos WHERE id=?').bind(id).first<{owner_id:string}>();
   if(photo?.owner_id!==owner)return missing();
  }
 }
 const photo=await env.BUCKET?.get(id);if(!photo)return missing();
 // Serve only the upload-time allowlist; anything else degrades to octet-stream.
 const stored=photo.httpMetadata?.contentType,type=stored==='image/jpeg'||stored==='image/png'||stored==='image/webp'?stored:'application/octet-stream';
 return new Response(photo.body,{headers:{'Content-Type':type,'Cache-Control':published?'public, max-age=300':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
