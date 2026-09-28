import 'server-only';
import { ensureSeeded } from './seed';
import { getSession, type Session } from './auth';

/**
 * First call of a request wins.
 *
 * Every page calls `await ctx()` instead of `getSession()` so that a fresh
 * deployment — an empty accounting schema, no migration step — opens on a
 * working set of books rather than on a stack trace. The check is one COUNT;
 * the schema is created on the first connection (see db.ts) and the seed runs
 * once, inside its own transaction.
 */
export async function ctx(): Promise<Session> {
  await ensureSeeded();
  return await getSession();
}
