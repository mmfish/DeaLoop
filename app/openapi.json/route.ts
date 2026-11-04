import {openapi} from '@/backend/discovery';
import {isAws} from '@/backend/deployment';
import {awsOpenapi} from '@/backend/aws-discovery';
export function GET(){return Response.json(isAws()?awsOpenapi():openapi,{headers:{'Cache-Control':'public, max-age=300'}});}
