import {fail,hash,secret,now} from './contracts.ts';

export const accessTokenSeconds=24*60*60;
export const refreshIdleSeconds=90*24*60*60;

type RefreshRow={token_hash:string;connection_id:string;client_id:string;resource:string;expires_at:number;used_at:number|null;status:string;oauth_scope:string;oauth_refresh_expires_at:number};

// Refresh credentials never authenticate marketplace calls. A connection is the
// revocable token family; retaining consumed hashes lets us detect replay.
export async function renewOAuth(db:D1Database,p:URLSearchParams){
 const token=p.get('refresh_token')||'';
 if(!/^dlr_[a-f0-9]{64}$/.test(token))fail(400,'invalid_grant','Invalid refresh credential. Reconnect with your owner.');
 const tokenHash=await hash(token),stamp=now();
 const row=await db.prepare('SELECT r.*,c.status,c.oauth_scope,c.oauth_refresh_expires_at FROM oauth_refresh_tokens r JOIN connections c ON c.id=r.connection_id WHERE r.token_hash=?').bind(tokenHash).first<RefreshRow>();
 if(!row||row.client_id!==p.get('client_id'))fail(400,'invalid_grant','Invalid refresh credential or client.');
 // An omitted resource inherits the original binding; a supplied target cannot change it.
 if(p.has('resource')&&p.get('resource')!==row.resource)fail(400,'invalid_target','Refresh resource must match the approved connection.');
 if(p.has('scope')&&p.get('scope')!==row.oauth_scope)fail(400,'invalid_scope','Renew the approved scopes unchanged. Changed permissions require new consent.');
 if(row.used_at!==null){await revokeFamily(db,row.connection_id);fail(400,'invalid_grant','Refresh credential was already used. Reconnect with your owner.');}
 if(row.status!=='active'||row.expires_at<=stamp||!row.oauth_refresh_expires_at||row.oauth_refresh_expires_at<=stamp)fail(400,'invalid_grant','Connection expired or was disconnected. Reconnect with your owner.');
 const access='th_'+secret(),accessHash=await hash(access),refresh='dlr_'+secret(),refreshHash=await hash(refresh),deadline=stamp+refreshIdleSeconds*1000;
 // Every write is conditional on this attempt winning the single-use token.
 // D1 batch and the AWS SQLite adapter both commit these statements atomically.
 const results=await db.batch([
  db.prepare("UPDATE oauth_refresh_tokens SET used_at=?,replacement_hash=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM connections WHERE id=? AND status='active' AND oauth_refresh_expires_at>?) RETURNING token_hash").bind(stamp,refreshHash,tokenHash,stamp,row.connection_id,stamp),
  db.prepare("UPDATE connections SET token_hash=?,expires_at=?,oauth_refresh_expires_at=? WHERE id=? AND status='active' AND EXISTS(SELECT 1 FROM oauth_refresh_tokens WHERE token_hash=? AND replacement_hash=?)").bind(accessHash,stamp+accessTokenSeconds*1000,deadline,row.connection_id,tokenHash,refreshHash),
  db.prepare('INSERT INTO oauth_refresh_tokens(token_hash,connection_id,client_id,resource,expires_at,created_at) SELECT ?,connection_id,client_id,resource,?,? FROM oauth_refresh_tokens WHERE token_hash=? AND replacement_hash=?').bind(refreshHash,deadline,stamp,tokenHash,refreshHash),
 ]);
 if(!results[0].results.length){await revokeFamily(db,row.connection_id);fail(400,'invalid_grant','Refresh credential was already used or disconnected. Reconnect with your owner.');}
 // Safe operational evidence: no credential, owner, body, or query data.
 console.info('OAuth refreshed',JSON.stringify({connection_id:row.connection_id}));
 return {access_token:access,token_type:'Bearer',expires_in:accessTokenSeconds,refresh_token:refresh,scope:row.oauth_scope};
}
async function revokeFamily(db:D1Database,id:string){await db.prepare("UPDATE connections SET status='revoked',token_hash=NULL WHERE id=?").bind(id).run();}
