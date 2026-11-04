import type {Post,Activity,Connection} from '../backend/contracts.ts';
export class Repository {
 constructor(readonly db:D1Database){}
 async user(id:string,name:string){await this.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').bind(id,name,Date.now()).run();}
 async browse(filters:Record<string,string|undefined>={}){
  const clauses=['p.status = ?'],values:(string|number)[]=['active'];
  for(const k of ['type','category','owner_id','delivery'] as const)if(filters[k]){clauses.push(`p.${k} = ?`);values.push(filters[k]!);}
  if(filters.q){clauses.push('(instr(lower(p.title),lower(?)) > 0 OR instr(lower(p.description),lower(?)) > 0)');values.push(filters.q,filters.q);}
  if(filters.location){clauses.push('instr(lower(p.location),lower(?)) > 0');values.push(filters.location);}
  if(filters.max_price&&Number.isFinite(Number(filters.max_price))){clauses.push('p.price <= ?');values.push(Math.round(Number(filters.max_price)*100));}
  const order=filters.sort==='price_low'?'p.price ASC':filters.sort==='price_high'?'p.price DESC':'p.created_at DESC';
  const limit=Math.min(60,Math.max(1,Math.floor(Number(filters.limit))||24));const offset=Math.max(0,Math.min(10000,Math.floor(Number(filters.offset))||0));
  return (await this.db.prepare(`SELECT p.*,u.name owner_name FROM posts p JOIN users u ON p.owner_id=u.id WHERE ${clauses.join(' AND ')} ORDER BY ${order},p.id LIMIT ? OFFSET ?`).bind(...values,limit,offset).all<Post>()).results;
 }
 async post(id:string){return this.db.prepare('SELECT p.*,u.name owner_name FROM posts p JOIN users u ON p.owner_id=u.id WHERE p.id=?').bind(id).first<Post>();}
 async mine(owner:string){return (await this.db.prepare('SELECT p.*,u.name owner_name FROM posts p JOIN users u ON p.owner_id=u.id WHERE p.owner_id=? ORDER BY p.created_at DESC LIMIT 100').bind(owner).all<Post>()).results;}
 async activity(owner:string){return (await this.db.prepare('SELECT id,actor,kind,summary,post_id,created_at FROM activities WHERE owner_id=? ORDER BY created_at DESC LIMIT 100').bind(owner).all<Activity>()).results;}
 async connections(owner:string){return (await this.db.prepare('SELECT * FROM connections WHERE owner_id=? ORDER BY created_at DESC LIMIT 100').bind(owner).all<Connection>()).results;}
 async pairing(code:string){return this.db.prepare("SELECT * FROM connections WHERE user_code=? AND status='pending' AND expires_at>?").bind(code,Date.now()).first<Connection>();}
}
