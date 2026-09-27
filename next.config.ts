import type { NextConfig } from 'next';

/**
 * `node:sqlite` is a Node builtin (24.x), but the ledger module that opens it
 * must never be traced into a client bundle. Everything under
 * `src/server/**` is server-only by convention and guarded by `server-only`.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ['node:sqlite'],
  experimental: { typedRoutes: false },
};

export default nextConfig;
