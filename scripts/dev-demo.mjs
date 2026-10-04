/**
 * Run the ledger in DEMO MODE, whatever `.env.local` says.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCRIPT EXISTS
 * ---------------------------------------------------------------------------
 * Demo mode is the ABSENCE of configuration — no `TRIPZO_DATABASE_URL`, no
 * Supabase anon key — which makes it the one mode you cannot reach by adding a
 * variable. On a developer's machine `.env.local` points at a real agency's
 * Supabase, and Next loads that file on every `next dev`, so the only ways to
 * see the demo were to comment the file out and remember to put it back, or to
 * keep two copies of it. Both are a working tree away from pushing a commit
 * that has the connection string deleted.
 *
 * A real process environment variable BEATS a `.env` file in Next, so emptying
 * the two that matter here is enough — and emptying rather than deleting is
 * deliberate: `connectionString()` in server/db.ts trims and treats an empty
 * string as absent precisely because a blank field in a hosting dashboard sets
 * one, and `CRM_CONFIGURED` reads the anon key for truthiness.
 *
 * WHAT YOU GET: the embedded Postgres (PGlite, in-process), the demo books
 * seeded through `provisionOrg` and a season of Wander Travels' trading posted
 * through the same services the screens use, and no sign-in. Nothing can reach
 * a live agency, which is the point — this is also how the seed's own
 * guarantees get exercised, since a demo that starts at all is a demo whose
 * debits equal its credits.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const PORT = process.env.PORT ?? '3101';

/*
 * NEXT'S OWN ENTRY SCRIPT, RUN BY THIS NODE, rather than `npm exec next`.
 *
 * Windows refuses to spawn `npm.cmd` without a shell (EINVAL), and spawning
 * through a shell means quoting a path that contains a space — which this
 * project's does. Resolving the binary and handing it to `process.execPath`
 * sidesteps both, and has the incidental virtue of being one process fewer
 * between the terminal and the server's output.
 */
const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');

const child = spawn(
  process.execPath,
  [nextBin, 'dev', '-p', PORT],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      // The ledger's own database: absent means the embedded one.
      TRIPZO_DATABASE_URL: '',
      DATABASE_URL: '',
      // No key to authenticate against means no CRM, which means no sign-in
      // and — far more importantly — no path from this process to a real
      // agency's records.
      SUPABASE_MOBILE_ANON_KEY: '',
      TRIPZO_SUPABASE_ANON_KEY: '',
      // The sample trading, which is the whole reason to run this.
      TRIPZO_SEED_DEMO: '1',
    },
  },
);

child.on('exit', (code) => process.exit(code ?? 0));
