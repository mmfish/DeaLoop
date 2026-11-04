import {agentGuide} from '@/backend/discovery';
import {isAws} from '@/backend/deployment';
import {awsGuide} from '@/backend/aws-discovery';
export function GET(){return new Response(isAws()?awsGuide():agentGuide,{headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'public, max-age=300',...(isAws()?{'Link':'</mcp>; rel="service"; type="application/json", </.well-known/oauth-protected-resource/mcp>; rel="oauth-protected-resource"'}:{})}});}
