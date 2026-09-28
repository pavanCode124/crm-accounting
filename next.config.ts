import type { NextConfig } from 'next';

/**
 * `pg` opens TCP sockets and must stay a real Node module: bundling it pulls in
 * optional native bits and breaks its connection handling. Everything under
 * `src/server/**` is server-only by convention and guarded by `server-only`,
 * so nothing here should ever reach a client bundle in the first place.
 */
const nextConfig: NextConfig = {
  // `pg` opens TCP sockets and `@electric-sql/pglite` loads a WASM build of
  // Postgres; bundling either breaks it. Both are server-only by construction.
  serverExternalPackages: ['pg', '@electric-sql/pglite'],
  typedRoutes: false,
  /**
   * `src/server/schema.sql` is read at runtime to bootstrap the accounting
   * schema. Next traces `import`s, not `readFileSync` paths, so without this
   * the file is left out of the deployment bundle and the first request fails
   * with ENOENT instead of creating the tables.
   */
  outputFileTracingIncludes: { '/**': ['./src/server/schema.sql'] },
};

export default nextConfig;
