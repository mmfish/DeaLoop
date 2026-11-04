export const categories = ['Furniture','Electronics','Bicycles','Home & garden','Music','Books','Sports','Other'] as const;
export const conditions = ['Like new','Good','Fair','Needs repair'] as const;
export type Post = {id:string;owner_id:string;owner_name:string;actor:string;agent_id:string|null;type:'for_sale'|'wanted';title:string;description:string;category:string;price:number;condition:string;location:string;delivery:string;image:string|null;status:string;demo:number;created_at:number;idempotency_key:string;request_hash:string};
export type PostInput = Pick<Post,'type'|'title'|'description'|'category'|'price'|'condition'|'location'|'delivery'|'image'>;
export type Actor = {ownerId:string;name:string;key:string;agentId:string|null;oauthScope?:string;canWrite:boolean;canNegotiate:boolean;canAccept:boolean};
export type Connection = {oauth_refresh_expires_at?:number|null;id:string;name:string;owner_id:string|null;status:string;can_write:number;can_negotiate:number;can_accept:number;min_deal_price:number;max_deal_price:number;max_posts:number;max_price:number;expires_at:number;created_at:number;user_code:string;device_hash:string;token_hash:string|null;oauth_scope?:string|null;oauth_resource?:string|null};
export type Activity = {id:string;actor:string;kind:string;summary:string;post_id:string|null;created_at:number};
export class ApiError extends Error { status:number;code:string; constructor(status:number,code:string,message:string){super(message);this.status=status;this.code=code;} }
export function fail(status:number,code:string,message:string):never{throw new ApiError(status,code,message);}
export const now=()=>Date.now();
export async function hash(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(b=>b.toString(16).padStart(2,'0')).join('');}
export const secret=()=>Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b=>b.toString(16).padStart(2,'0')).join('');
// Pixel-bomb guard: a small compressed file can still decode to gigapixels of flat color.
// Reject uploads whose declared dimensions exceed a generous viewer-safe box.
// Pure header parsing (no image library) so it runs in Workers and Node alike.
export {maxImageSide,maxImagePixels} from './policy.ts';
export function imageDimensions(type:string,bytes:Uint8Array):{width:number;height:number}|null{
 if(type==='image/png'){
  if(bytes.length<24||bytes[12]!==0x49||bytes[13]!==0x48||bytes[14]!==0x44||bytes[15]!==0x52)return null;
  return {width:(bytes[16]<<24|bytes[17]<<16|bytes[18]<<8|bytes[19])>>>0,height:(bytes[20]<<24|bytes[21]<<16|bytes[22]<<8|bytes[23])>>>0};
 }
 if(type==='image/jpeg'){
  if(bytes[0]!==255||bytes[1]!==216)return null;
  let pos=2,guard=0;
  while(pos+9<bytes.length&&guard++<200){
   if(bytes[pos]!==255){pos++;continue;}
   const marker=bytes[pos+1];
   if(marker===0xFF||marker===0xD8||marker===0xD9||marker===0x01||marker>=0xD0&&marker<=0xD7){pos+=marker===0xFF?1:2;continue;}
   if(marker===0xDA)return null; // scan data: no SOF appeared before pixels
   const len=(bytes[pos+2]<<8)|bytes[pos+3];
   if(len<2||pos+2+len>bytes.length)return null;
   if(marker>=0xC0&&marker<=0xCF&&marker!==0xC4&&marker!==0xC8&&marker!==0xCC){
    if(len<7)return null;
    return {width:(bytes[pos+7]<<8)|bytes[pos+8],height:(bytes[pos+5]<<8)|bytes[pos+6]};
   }
   pos+=2+len;
  }
  return null;
 }
 if(type==='image/webp'){
  const tag=(o:number)=>String.fromCharCode(bytes[o],bytes[o+1],bytes[o+2],bytes[o+3]);
  if(bytes.length<12||tag(0)!=='RIFF'||tag(8)!=='WEBP')return null;
  // Canvas-first enforcement: an extended file decodes to its VP8X canvas, so
  // the canvas and every frame are bounded and every frame must fit the canvas.
  // VP8 width/height are separate 14-bit fields; VP8X canvas is LE24 at +4/+7;
  // ANMF bounds are x/y/w-1/h-1 triples. Layouts verified against libwebp
  // output (tests/fixtures, cross-checked with sharp).
  const le24=(o:number)=>bytes[o]|bytes[o+1]<<8|bytes[o+2]<<16;
  let pos=12,canvas:{width:number;height:number}|null=null;
  const frames:{x:number;y:number;width:number;height:number}[]=[];
  while(pos+8<=bytes.length){
   const size=(bytes[pos+4]|bytes[pos+5]<<8|bytes[pos+6]<<16|bytes[pos+7]<<24)>>>0,data=pos+8,name=tag(pos);
   if(name==='VP8X'){
    if(size<10||data+10>bytes.length)return null;
    canvas={width:le24(data+4)+1,height:le24(data+7)+1};
   }else if(name==='VP8 '&&data+10<=bytes.length){
    if(bytes[data+3]!==0x9D||bytes[data+4]!==0x01||bytes[data+5]!==0x2A)return null;
    frames.push({x:0,y:0,width:bytes[data+6]|(bytes[data+7]&0x3F)<<8,height:bytes[data+8]|(bytes[data+9]&0x3F)<<8});
   }else if(name==='VP8L'&&data+5<=bytes.length){
    if(bytes[data]!==0x2F)return null;
    const b0=bytes[data+1],b1=bytes[data+2],b2=bytes[data+3],b3=bytes[data+4];
    frames.push({x:0,y:0,width:((b0|(b1<<8))&0x3FFF)+1,height:(((b1>>6)|(b2<<2)|(b3<<10))&0x3FFF)+1});
   }else if(name==='ANMF'&&data+12<=bytes.length){
    frames.push({x:le24(data),y:le24(data+3),width:le24(data+6)+1,height:le24(data+9)+1});
   }else if(name==='VP8 '||name==='VP8L'||name==='ANMF'){
    return null; // truncated bitstream or frame header
   }
   const next=data+size+(size%2);if(next<=data||next>bytes.length)return null;pos=next;
  }
  if(canvas)for(const f of frames)if(f.x+f.width>canvas.width||f.y+f.height>canvas.height)return null;
  const all=canvas?[canvas as {width:number;height:number},...frames]:frames;
  if(!all.length)return null;
  return {width:Math.max(...all.map(f=>f.width)),height:Math.max(...all.map(f=>f.height))};
 }
 return null;
}
export const publicPost=(p:Post)=>({id:p.id,type:p.type,title:p.title,description:p.description,category:p.category,price:p.price/100,currency:'USD',condition:p.condition,location:p.location,delivery:p.delivery,image_url:p.image,status:p.status,demo:!!p.demo,owner_name:p.owner_name,created_by:p.agent_id?'agent':'human',created_at:new Date(p.created_at).toISOString()});
export function validatePost(value:unknown):PostInput {
 const p=value as Record<string,unknown>;
 if(!p||typeof p!=='object'||Array.isArray(p))fail(400,'invalid_body','Expected a JSON object.');
 const allowed=['type','title','description','category','price','condition','location','delivery','image'];
 if(Object.keys(p).some(k=>!allowed.includes(k)))fail(400,'unknown_field','Only documented post fields are accepted. Ownership is assigned by the server.');
 for(const [key,max] of [['title',120],['description',3000],['location',100]] as const){if(typeof p[key]!=='string'||!(p[key] as string).trim()||(p[key] as string).length>max)fail(400,'invalid_field',`${key} must contain 1–${max} characters.`);}
 if(!['for_sale','wanted'].includes(String(p.type)))fail(400,'invalid_type','Choose For Sale or Wanted.');
 if(!categories.includes(p.category as typeof categories[number]))fail(400,'invalid_category','Choose a supported category.');
 if(!conditions.includes(p.condition as typeof conditions[number]))fail(400,'invalid_condition','Choose a supported condition.');
 if(!['local_pickup','shipping','either'].includes(String(p.delivery)))fail(400,'invalid_delivery','Choose local_pickup, shipping or either.');
 if(typeof p.price!=='number'||!Number.isFinite(p.price)||p.price<0||p.price>100000||Math.abs(p.price*100-Math.round(p.price*100))>0.00001)fail(400,'invalid_price','Price must be between $0 and $100,000, with up to two decimals.');
 if(p.image!=null&&(typeof p.image!=='string'||!/^\/media\/[a-f0-9-]{36}$/.test(p.image)))fail(400,'invalid_image','Upload a photo first, then use its returned path.');
 return {type:p.type as PostInput['type'],title:(p.title as string).trim(),description:(p.description as string).trim(),category:p.category as string,price:Math.round((p.price as number)*100),condition:p.condition as string,location:(p.location as string).trim(),delivery:p.delivery as string,image:p.image as string||null};
}
