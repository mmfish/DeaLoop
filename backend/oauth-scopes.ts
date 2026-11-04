import {fail} from './contracts.ts';
export const supportedScopes=['identity:read','posts:read','posts:write','offers:read','offers:write','messages:write','events:read','deals:accept'] as const;
export const negotiationScopes=['offers:read','offers:write','messages:write','events:read'];
export const mcpResource=(origin:string)=>origin+'/mcp';
export function parseScopes(value:unknown):string[]{
 if(typeof value!=='string'||!value.trim())fail(400,'invalid_scope','Request at least one documented scope.');
 const scopes=[...new Set(value.trim().split(/\s+/))];
 if(scopes.some(s=>!(supportedScopes as readonly string[]).includes(s)))fail(400,'invalid_scope','Unsupported DeaLoop scope.');
 if(scopes.includes('deals:accept')&&negotiationScopes.some(s=>!scopes.includes(s)))fail(400,'invalid_scope','Deal selection requires the negotiation scopes too.');
 return supportedScopes.filter(s=>scopes.includes(s));
}
export function requiredApiScope(method:string,path:string):string|null{
 if(method==='GET'){
  if(/^\/api\/v1\/posts\/[^/]+\/shortlist\/manage$/.test(path))return 'offers:read';
  if(/^\/api\/v1\/posts\/[^/]+\/shortlist$/.test(path))return 'posts:read';
  if(path==='/api/v1/me')return 'identity:read';
  if(['/api/v1/my-posts','/api/v1/activity','/api/v1/posts'].includes(path)||/^\/api\/v1\/posts\/[^/]+$/.test(path))return 'posts:read';
  if(path==='/api/v1/offers'||/^\/api\/v1\/offers\/[^/]+$/.test(path))return 'offers:read';
  if(['/api/v1/events','/api/v1/events/stream','/api/v1/events/stream-info'].includes(path))return 'events:read';
 }
 if(method==='POST'){
  if(/^\/api\/v1\/posts\/[^/]+\/shortlist$/.test(path))return 'posts:write';
  if(['/api/v1/posts','/api/v1/photos'].includes(path)||/^\/api\/v1\/photos\/[^/]+\/delete$/.test(path))return 'posts:write';
  if(/^\/api\/v1\/posts\/[^/]+\/offers$/.test(path)||/^\/api\/v1\/offers\/[^/]+\/(revise|confirm|decline|withdraw)$/.test(path))return 'offers:write';
  if(/^\/api\/v1\/offers\/[^/]+\/messages$/.test(path))return 'messages:write';
  if(/^\/api\/v1\/offers\/[^/]+\/accept$/.test(path))return 'deals:accept';
 }
 return null;
}
export function protectedResourceMetadata(origin:string){return {resource:mcpResource(origin),authorization_servers:[origin],scopes_supported:[...supportedScopes],bearer_methods_supported:['header'],resource_name:'DeaLoop marketplace',resource_documentation:origin+'/llms.txt'};}
