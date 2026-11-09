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
    ]}];
  }
};

export default config;
