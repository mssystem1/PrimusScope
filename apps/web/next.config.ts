import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

const config: NextConfig = {
  transpilePackages: ["@primusscope/api-schema", "@primusscope/data", "@primusscope/storage"],
  outputFileTracingRoot: root,
  outputFileTracingIncludes: {"/*": ["../../data/observations/current.json"]},
  outputFileTracingExcludes: {"/*": [
    "../../.local/**", "../../.env*", "../../docs/**", "../../scripts/**",
    "../../tests/**", "../../apps/worker/**",
  ]},
  turbopack: {root},
  experimental: {cpus: 2},
  async headers() {
    return [{source: "/(.*)", headers: [
      {key: "X-Content-Type-Options", value: "nosniff"},
      {key: "X-Frame-Options", value: "DENY"},
      {key: "Referrer-Policy", value: "no-referrer"},
      {key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()"},
      {key: "Content-Security-Policy", value: "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"}
    ]}, {source:"/sdk/:path*",headers:[
      {key:"Content-Security-Policy",value:"default-src 'none'; script-src 'self'; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'"},
      {key:"Cache-Control",value:"public, max-age=31536000, immutable"}
    ]}, {source:"/developers/verify",headers:[
      {key:"Content-Security-Policy",value:"base-uri 'self'; object-src 'none'; frame-ancestors 'none'; frame-src 'none'; connect-src 'self'; worker-src 'self'; form-action 'none'"}
    ]}];
  }
};

export default config;
