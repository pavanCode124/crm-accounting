import 'server-only';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The database handle, and the only place that opens it.
 *
 * WHY node:sqlite AND NOT better-sqlite3. Node 24 ships SQLite in core, with
 * the same synchronous API shape. A native addon would have to be rebuilt for
 * every Node version on every machine the agency runs this on, which is a
 * support cost paid forever for an API we already have.
 *
 * WHY SYNCHRONOUS. A ledger post is a multi-statement transaction that must be
 * all-or-nothing: entry header, lines, analytic rows, sequence bump, audit row.
 * Synchronous statements inside one `BEGIN`/`COMMIT` cannot interleave with
 * another request's await, so the transaction is genuinely atomic rather than
 * atomic-looking. Every call here is local disk and sub-millisecond.
 *
 * In dev, Next re-evaluates modules on every edit. Caching the handle on
 * globalThis keeps one connection instead of leaking a file handle per reload.
 */

const DB_PATH = process.env.TRIPZO_DB ?? path.join(process.cwd(), 'data', 'tripzo-finance.db');

declare global {
  // eslint-disable-next-line no-var
  var __tripzoDb: DatabaseSync | undefined;
}

function open(): DatabaseSync {
  const database = new DatabaseSync(DB_PATH);
  // WAL lets reports read while a post is writing. NORMAL sync is the usual
  // WAL pairing: a crash can lose the last commit to an OS failure, not to a
  // process failure, which is the right trade for an app that is re-seedable.
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(readFileSync(path.join(process.cwd(), 'src', 'server', 'schema.sql'), 'utf8'));
  migrate(database);
  return database;
}

/**
 * Column additions for a database created by an earlier version of the schema.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * a new column has to be added explicitly. Each statement is attempted and its
 * "duplicate column" error swallowed, which is idempotent and needs no version
 * table — adequate while the schema only ever GAINS columns, and this list is
 * where a real migration runner would go if it ever stops being true.
 */
function migrate(database: DatabaseSync) {
  const additions = [
    "ALTER TABLE payments ADD COLUMN side TEXT NOT NULL DEFAULT 'customer'",
    /*
     * Un-archive every account.
     *
     * Archiving was removed from the product (see masters.ts), but a database
     * created before that has accounts sitting at active=0 — greyed out on the
     * chart, refused by the posting engine, and now with no button anywhere to
     * bring them back. This repairs them. It is idempotent and a no-op on a
     * fresh install, which is what lets it live in this list.
     */
    'UPDATE accounts SET active = 1 WHERE active = 0',
  ];
  for (const sql of additions) {
    try {
      database.exec(sql);
    } catch {
      // Already present. Any other failure would surface on the first query
      // that needs the column, which is a clearer error than one thrown here.
    }
  }
}

export const db: DatabaseSync = globalThis.__tripzoDb ?? (globalThis.__tripzoDb = open());

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------
// node:sqlite returns null-prototype objects. Spreading them into plain objects
// keeps React server components from choking when they cross the RSC boundary.

type Params = Array<string | number | bigint | null | Uint8Array>;

function normalise<T>(row: unknown): T {
  return { ...(row as object) } as T;
}

export function all<T = Record<string, unknown>>(sql: string, ...params: Params): T[] {
  return db.prepare(sql).all(...params).map((r) => normalise<T>(r));
}

export function one<T = Record<string, unknown>>(sql: string, ...params: Params): T | null {
  const row = db.prepare(sql).get(...params);
  return row === undefined ? null : normalise<T>(row);
}

/** A single scalar, for the many `SELECT SUM(...)` reads reports make. */
export function scalar(sql: string, ...params: Params): number {
  const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  if (!row) return 0;
  const v = Object.values(row)[0];
  return typeof v === 'number' ? v : Number(v ?? 0);
}

export function run(sql: string, ...params: Params) {
  return db.prepare(sql).run(...params);
}

/**
 * Run `fn` inside a transaction.
 *
 * Every posting path goes through here. Half a journal entry on disk is worse
 * than no journal entry: it is an unbalanced ledger that no report can explain.
 * Nested calls reuse the outer transaction (SQLite has no nested BEGIN), so a
 * service that posts a document and then allocates a payment against it is one
 * atomic unit rather than two.
 */
let depth = 0;
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  depth = 1;
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth = 0;
  }
}

/** Short, sortable, collision-resistant ids. Readable in a URL and in a log. */
export function id(prefix: string): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Take the next number from a sequence.
 *
 * Called inside the posting transaction, never before it: a number handed out
 * and then rolled back is a gap in an invoice series, and a gap in an invoice
 * series is a question from an auditor.
 */
export function nextNumber(orgId: string, code: string, fallbackPrefix = 'DOC'): string {
  const seq = one<{ prefix: string; padding: number; next_no: number }>(
    'SELECT prefix, padding, next_no FROM sequences WHERE org_id = ? AND code = ?',
    orgId,
    code,
  );
  if (!seq) {
    run('INSERT INTO sequences (org_id, code, prefix, padding, next_no) VALUES (?,?,?,?,?)',
      orgId, code, fallbackPrefix, 5, 2);
    return `${fallbackPrefix}-${String(1).padStart(5, '0')}`;
  }
  run('UPDATE sequences SET next_no = next_no + 1 WHERE org_id = ? AND code = ?', orgId, code);
  return `${seq.prefix}-${String(seq.next_no).padStart(seq.padding, '0')}`;
}
