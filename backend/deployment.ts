// The AWS build fixes this value in next.config.ts; Sites retains its own gate.
export const isAws = () => process.env.DEALOOP_RUNTIME === 'aws';
export function allowedEmail(email: string): boolean {
  if (!isAws()) return true;
  return (process.env.DEALOOP_ALLOWED_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean).includes(email.toLowerCase());
}
// Impact of the AWS default: externalRequest rewrites loopback requests to this
// origin before CSRF checks, so a wrong default fails closed (same-origin POSTs
// denied, never allowed). Secure cookies and pairing links target this host, so
// set DEALOOP_ORIGIN explicitly whenever the deployment host differs.
let warnedOrigin=false;
export const agentOrigin = () => {
  if(isAws()){
    if(process.env.DEALOOP_ORIGIN)return process.env.DEALOOP_ORIGIN;
    if(!warnedOrigin){warnedOrigin=true;console.warn('DEALOOP_ORIGIN is unset; using the built-in default origin.');}
    return 'https://dealoop.miracleraven.com';
  }
  return 'https://thread-agent-api.yiyxu.chatgpt.site';
};
// Next's Node listener sees the loopback HTTP origin behind Caddy. Use the
// configured public origin for CSRF checks, secure cookies and pairing links.
// Never derive this trusted origin from caller-supplied forwarding headers.
export function externalRequest(request: Request): Request {
  if (!isAws()) return request;
  const url = new URL(request.url);
  return new Request(new URL(url.pathname + url.search, agentOrigin()), request);
}
