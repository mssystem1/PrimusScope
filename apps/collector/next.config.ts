import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const config: NextConfig = {
  transpilePackages: ['@primusscope/worker', '@primusscope/storage', '@primusscope/api-schema'],
  outputFileTracingRoot: root, turbopack: { root }, experimental: { cpus: 2 },
  outputFileTracingExcludes: { '/*': ['../../.local/**', '../../.env*', '../../docs/**', '../../tests/**'] },
};
export default config;
