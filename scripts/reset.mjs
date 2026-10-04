/**
 * Drop the accounting schema so the app rebuilds it on its next request.
 *
 * WHAT COMES BACK DEPENDS ON WHETHER A CRM IS CONFIGURED, and this used to say
 * "re-seeds" unconditionally, which is no longer true and was the misleading
 * half. On a deployment with no Supabase anon key there is no CRM to
 * authenticate against, so the demo books are seeded as before. On a CONNECTED
 * deployment nothing is seeded at all: `ensureDemoBooks` is a no-op there, and
 * each agency gets its own empty, fully configured set of books provisioned on
 * its next sign-in. Running this against a connected deployment therefore
 * erases the books and hands back a clean ledger, not the demo.
 *
 * Deliberately NOT a re-implementation of the seed: the seed lives in
 * src/server/seed.ts and runs through the same posting engine the screens use,
 * which is what makes the demo data trustworthy. Running it from plain Node
 * would need the bundler's path aliases, so the app seeds itself on first
 * request instead and this only clears the way.
 *
 * SCOPE, because this now points at a shared database. It drops exactly one
 * schema — the accounting one — and cannot touch a CRM table, which all live in
 * `public`. That containment is the reason the ledger was given its own schema.
 *
 * The Settings screen has the same button, with a typed confirmation.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// next loads .env.local for the app; a plain node script has to do it itself.
for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(path.join(process.cwd(), file), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // Absent is fine — the variables may come from the environment instead.
  }
}

const url = process.env.TRIPZO_DATABASE_URL ?? process.env.DATABASE_URL;
const schema = process.env.TRIPZO_DB_SCHEMA ?? 'accounting';

if (!url) {
  console.error('TRIPZO_DATABASE_URL is not set. Nothing to reset.');
  process.exit(1);
}

// The same refusal db.ts makes, repeated because this script is the one that
// actually runs DROP SCHEMA ... CASCADE. Against `public` that is the CRM's
// entire database, deleted by a command called "reset".
if (['public', 'auth', 'storage'].includes(schema)) {
  console.error(
    `Refusing to drop schema "${schema}" — it belongs to TripzoCRM or Supabase, not to the ledger.`,
  );
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: url.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
});

await client.connect();
try {
  await client.query(`DROP SCHEMA IF EXISTS "${schema.replace(/"/g, '""')}" CASCADE`);
  console.log(
    `Dropped schema "${schema}". The next request rebuilds it; a CRM-connected `
    + 'deployment then provisions fresh books per agency on sign-in, and only an '
    + 'unconnected one re-seeds the demo.',
  );
} finally {
  await client.end();
}
