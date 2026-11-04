import {env} from '@/runtime/bindings';
import {Repository} from '@/db/repository';
export const repository=()=>new Repository(env.DB!);
