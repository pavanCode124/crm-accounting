import 'server-only';
import { ensureSeeded } from './seed';
import { getSession, type Session } from './auth';

/**
 * First call of a request wins.
 *
 * Every page calls `ctx()` instead of `getSession()` so that a fresh clone of
 * this repo — no database file, no migration step — opens on a working set of
 * books rather than on a stack trace. The check is one COUNT against an open
 * handle; the seed itself runs once, inside its own transaction.
 */
export function ctx(): Session {
  ensureSeeded();
  return getSession();
}
