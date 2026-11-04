import {externalRequest} from '@/backend/deployment';
import {protectedResourceMetadata} from '@/backend/oauth-scopes';
export function GET(request:Request){return Response.json(protectedResourceMetadata(new URL(externalRequest(request).url).origin),{headers:{'Cache-Control':'public, max-age=300'}});}
