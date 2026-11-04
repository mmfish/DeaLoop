import type { NextConfig } from "next";
import path from 'node:path';

const securityHeaders=[
  {key:'X-Content-Type-Options',value:'nosniff'},
  {key:'X-Frame-Options',value:'DENY'},
  {key:'Referrer-Policy',value:'strict-origin-when-cross-origin'},
  {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=(), payment=()'},
  {key:'Strict-Transport-Security',value:'max-age=31536000; includeSubDomains'},
  // Framing-only policy: other directives stay unset so app scripts, styles and
  // provider calls keep working. Route-level CSPs (OAuth consent) add their own
  // restrictions; multiple CSP headers intersect, so framing stays denied.
  {key:'Content-Security-Policy',value:"frame-ancestors 'none'"},
];
const headers=async()=>[
  {source:'/',headers:[{key:'Link',value:'</llms.txt>; rel="describedby"; type="text/plain", </mcp>; rel="service"; type="application/json"'}]},
  {source:'/:path*',headers:securityHeaders},
];

const nextConfig: NextConfig = process.env.DEALOOP_BUILD_TARGET === 'aws' ? {
  output: 'standalone',
  compress: false, // Caddy handles compression; keep event-stream chunks unbuffered.
  headers,
  env: {DEALOOP_RUNTIME:'aws'},
  experimental: {cpus:1},
  webpack(config, {webpack}) {
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/(^@\/runtime\/bindings$|^cloudflare:workers$)/,path.resolve('runtime/aws-bindings.ts')));
    return config;
  },
} : {headers};

export default nextConfig;
