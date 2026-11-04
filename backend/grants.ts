import {fail} from './contracts.ts';
export function validateGrant(b:Record<string,unknown>){
 if(['max_price','min_deal_price','max_deal_price'].some(key=>Object.hasOwn(b,key)))fail(400,'commercial_limits_not_supported','Price and budget decisions belong to your agent. Remove max_price, min_deal_price and max_deal_price; give these instructions directly to your agent.');
 if(typeof b.can_write!=='boolean')fail(400,'invalid_approval','Provide posting permission.');
 if(b.can_negotiate!==undefined&&typeof b.can_negotiate!=='boolean'||b.can_accept!==undefined&&typeof b.can_accept!=='boolean'||b.can_accept&&!b.can_negotiate)fail(400,'invalid_approval','Deal acceptance requires negotiation permission.');
 return {canWrite:b.can_write?1:0,canNegotiate:b.can_negotiate?1:0,canAccept:b.can_accept?1:0};
}
