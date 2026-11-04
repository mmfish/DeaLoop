import {headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {env} from '@/runtime/bindings';
import {humanFor} from '@/backend/auth';
export const getUser=async()=>humanFor(new Headers(await headers()),env.DB!);
export async function requireUser(returnTo:string){const user=await getUser();if(user)return user;redirect(signInPath(returnTo));}
export function safeReturn(value:string){try{const url=new URL(value,'https://thread.local');if(!value.startsWith('/')||value.startsWith('//')||url.origin!=='https://thread.local'||/^\/(login|logout|api\/auth)(\/|$)/.test(url.pathname))return '/';return url.pathname+url.search+url.hash;}catch{return '/';}}
export const signInPath=(returnTo='/')=>'/login?return_to='+encodeURIComponent(safeReturn(returnTo));
export const signOutPath=()=>'/logout';
