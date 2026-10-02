import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool, types as pgTypes, type PoolClient } from 'pg';
import { formatDocNumber } from '@/lib/accounting';

/**
 * The database handle, and the only place that opens it.
 *
 * WHY POSTGRES AND NOT SQLITE. These books belong to TripzoCRM, not beside it.
 * The agency, its leads, its suppliers and its invoices already live in the
 * self-hosted Supabase the CRM authenticates against; keeping the ledger in a
 * file on one web server meant a second copy of the truth, no concurrency, and
 * nothing to deploy to — a serverless host mounts its filesystem read-only, so
 * the file either could not be written or vanished on the next cold start.
 * The ledger now lives in that same Postgres, in its own schema, so a backup of
 * the CRM is a backup of the books.
 *
 * WHY A SCHEMA AND NOT A PREFIX. Every table here — `accounts`, `payments`,
 * `documents`, `users` — is a name the CRM plausibly wants for itself. A
 * dedicated `accounting` schema means the two can never collide, `search_path`
 * keeps the SQL unqualified and readable, and a single `DROP SCHEMA` resets the
 * books without touching a row the CRM owns.
 *
 * WHY RAW SQL AND NOT supabase-js. A ledger post is a multi-statement
 * transaction that must be all-or-nothing: entry header, lines, analytic rows,
 * sequence bump, audit row. PostgREST — which is what supabase-js speaks — has
 * no BEGIN, so a half-written journal entry would be reachable. A direct
 * Postgres connection has real transactions, which is the whole argument.
 *
 * ---------------------------------------------------------------------------
 * TWO DRIVERS, ONE DIALECT
 * ---------------------------------------------------------------------------
 * With no `TRIPZO_DATABASE_URL` the app runs in DEMO MODE against an embedded
 * Postgres (PGlite, compiled to WASM, in this process) instead of refusing to
 * start. That is what lets the product be shown to a client on a laptop with no
 * Supabase, no connection string and no network — see `demo()` below.
 *
 * It is the same Postgres, not an emulation: identical SQL, identical schema
 * file, real transactions. So the demo exercises the code the server runs
 * rather than a second implementation that could quietly disagree with it.
 */

/**
 * The schema the ledger owns, and the guard that keeps it from being the CRM's.
 *
 * `public` is refused outright. Two operations here are destructive WITHIN this
 * schema by design — `resetAndSeed` truncates every table in it, and
 * `npm run reset` drops it — and both are correct only because the schema is
 * ours alone. Pointed at `public` they would erase the agency's leads, invoices
 * and conversations, from a button labelled "Reset the books". The only safe
 * place to stop that is before anything connects.
 */
const SCHEMA = process.env.TRIPZO_DB_SCHEMA ?? 'accounting';

if (SCHEMA === 'public' || SCHEMA === 'auth' || SCHEMA === 'storage') {
  throw new Error(
    `TRIPZO_DB_SCHEMA must not be "${SCHEMA}" — that schema belongs to TripzoCRM or Supabase. ` +
      'The ledger needs a schema of its own; leave it unset to use "accounting".',
  );
}

function connectionString(): string | null {
  // Trimmed and emptiness-checked, not just nullish-checked. `VAR=` in a shell
  // or a blank field in a hosting dashboard sets an EMPTY STRING, which is not
  // null — and an empty connection string does not fail, it makes libpq quietly
  // default to a Postgres on localhost. That reads as "demo mode is broken"
  // when what happened is that demo mode was never entered.
  const url = (process.env.TRIPZO_DATABASE_URL ?? process.env.DATABASE_URL ?? '').trim();
  return url === '' ? null : url;
}

/**
 * Demo mode is the ABSENCE of a connection string, not a flag someone has to
 * remember to set. A deployment that was meant to reach Supabase and lost its
 * variable therefore shows demo books rather than an error page — so the banner
 * in the UI is not decoration: it is the only thing distinguishing the two.
 */
export function isDemoMode(): boolean {
  return connectionString() === null;
}

/**
 * Read BIGINT and NUMERIC as numbers, not strings.
 *
 * Both drivers return int8 as a string by default, because 64 bits do not fit a
 * double — and `SUM()` over a BIGINT column comes back as NUMERIC, which is the
 * one that bites. A string would not throw: it would make `a + b` CONCATENATE
 * two rupee totals, in a report, silently. The range that actually matters here
 * is paise, and staying inside Number.MAX_SAFE_INTEGER leaves room for ninety
 * trillion rupees, comfortably more than a travel agency will bill.
 */
const NUMERIC_PARSERS = { 20: (v: string) => Number(v), 1700: (v: string) => Number(v) };
pgTypes.setTypeParser(pgTypes.builtins.INT8, Number);
pgTypes.setTypeParser(pgTypes.builtins.NUMERIC, Number);

/** The one shape both drivers are used through. */
interface Conn {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  /** Multi-statement SQL, which only the schema bootstrap and the reset need. */
  exec(sql: string): Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __tripzoPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __tripzoDemo: Promise<Conn> | undefined;
  // eslint-disable-next-line no-var
  var __tripzoReady: Promise<void> | undefined;
  // eslint-disable-next-line no-var
  var __tripzoTxQueue: Promise<unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Driver: Postgres over the network (the real one)
// ---------------------------------------------------------------------------

/**
 * In dev, Next re-evaluates modules on every edit. Caching the pool on
 * globalThis keeps one pool instead of leaking a poolful of sockets per reload.
 *
 * Supabase hands out two addresses. The POOLER (port 6543) is the one a
 * serverless deployment wants, because each instance holds its own connection
 * and a direct Postgres would run out of them. The DIRECT address (5432) is
 * what the schema bootstrap needs, as a pooler in transaction mode cannot hold
 * an advisory lock across statements.
 */
function pool(): Pool {
  if (globalThis.__tripzoPool) return globalThis.__tripzoPool;
  /*
   * Resolved on first use, never at import. `next build` evaluates every server
   * module to collect page data, on a machine that has no database and no
   * business having one — a connection opened at module scope fails the build
   * rather than the request.
   */
  const url = connectionString()!;
  return (globalThis.__tripzoPool = new Pool({
    connectionString: url,
    // Supabase terminates TLS with its own certificate. Verifying it would need
    // the CA bundle shipped alongside the app; the connection is still
    // encrypted without that check.
    ssl: url.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
    // A serverless instance serves a handful of concurrent requests and is
    // recycled often. A large pool per instance is how a Postgres runs out of
    // backends while every individual app looks idle.
    max: Number(process.env.TRIPZO_DB_POOL_MAX ?? 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    /*
     * Our schema ALONE on the path, deliberately — `public` is not on it.
     *
     * With `public` as a fallback, an unqualified name that is missing from the
     * accounting schema silently resolves to the CRM's table of the same name,
     * and the ledger has a `payments`, a `users` and an `organizations` just as
     * the CRM does. The failure would not look like a failure: an UPDATE would
     * succeed, against the agency's real records. Leaving `public` off turns
     * that whole class of accident into "relation does not exist" on the first
     * query, which is a bug report rather than data loss.
     *
     * Nothing here needs `public`: CRM records arrive over the REST API
     * (src/server/crm/), never over this connection, and `information_schema`
     * and `pg_catalog` resolve regardless of the search path.
     */
    options: `-c search_path=${SCHEMA}`,
  }));
}

// ---------------------------------------------------------------------------
// Driver: embedded Postgres (the demo)
// ---------------------------------------------------------------------------

/**
 * Postgres compiled to WASM, running inside this process.
 *
 * IN MEMORY, deliberately. Every restart re-seeds, so a demo always opens on
 * the same clean set of books however badly the last one was mangled — and
 * there is no stray database file to be mistaken later for real bookkeeping.
 *
 * Imported dynamically so a production deployment, which never takes this
 * branch, does not pay to load several megabytes of WASM at startup.
 */
async function demo(): Promise<Conn> {
  return (globalThis.__tripzoDemo ??= (async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = await PGlite.create({ parsers: NUMERIC_PARSERS });
    return {
      async query(sql: string, params?: unknown[]) {
        const r = await db.query(sql, params as unknown[]);
        return { rows: r.rows as unknown[] };
      },
      async exec(sql: string) {
        await db.exec(sql);
      },
    };
  })());
}

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

/** Quote an identifier that came from configuration rather than from us. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function schemaSql(): string {
  return readFileSync(path.join(process.cwd(), 'src', 'server', 'schema.sql'), 'utf8');
}

/**
 * Create the schema if it is not there yet, once per process.
 *
 * Under an advisory lock on the real driver, because several instances can
 * cold-start at the same moment and `CREATE TABLE IF NOT EXISTS` racing itself
 * in Postgres raises a duplicate-key error on the catalog rather than quietly
 * doing nothing. The demo is one process with one connection and needs none.
 */
async function ready(): Promise<void> {
  return (globalThis.__tripzoReady ??= (async () => {
    if (isDemoMode()) {
      const db = await demo();
      await db.exec(`CREATE SCHEMA IF NOT EXISTS ${ident(SCHEMA)}`);
      await db.exec(`SET search_path = ${ident(SCHEMA)}`);
      await db.exec(schemaSql());
      return;
    }

    const client = await pool().connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', ['tripzo_finance_schema']);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${ident(SCHEMA)}`);
      await client.query(`SET search_path = ${ident(SCHEMA)}`);
      await client.query(schemaSql());
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['tripzo_finance_schema']);
      client.release();
    }
  })().catch((err) => {
    // A failed bootstrap must not be cached as done, or every later request in
    // this instance reports a missing table instead of the real cause.
    globalThis.__tripzoReady = undefined;
    throw err;
  }));
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

type Params = Array<string | number | bigint | boolean | null | Uint8Array>;

/**
 * `?` → `$1, $2, …`.
 *
 * Every query in this app was written with SQLite's positional marker and
 * there are close to three hundred of them. Translating here keeps them all
 * readable and identical to the SQL you would paste into psql, minus the
 * numbering. Safe because no query carries a literal `?` inside a string
 * literal — a `'?'` in the SQL text would break this, so do not add one.
 */
function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/** The transaction's connection, when we are inside one. */
const txConn = new AsyncLocalStorage<Conn>();

/** Whichever driver is in play, bootstrapped and ready. */
async function conn(): Promise<Conn> {
  const inTx = txConn.getStore();
  if (inTx) return inTx;
  await ready();
  if (isDemoMode()) return demo();
  const p = pool();
  return {
    query: (sql, params) => p.query(sql, params as unknown[]).then((r) => ({ rows: r.rows })),
    exec: async (sql) => { await p.query(sql); },
  };
}

async function query<T>(sql: string, params: Params): Promise<T[]> {
  const c = await conn();
  const res = await c.query(numbered(sql), params as unknown[]);
  return res.rows as T[];
}

export async function all<T = Record<string, unknown>>(sql: string, ...params: Params): Promise<T[]> {
  return query<T>(sql, params);
}

export async function one<T = Record<string, unknown>>(sql: string, ...params: Params): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows.length ? rows[0] : null;
}

/** A single scalar, for the many `SELECT SUM(...)` reads reports make. */
export async function scalar(sql: string, ...params: Params): Promise<number> {
  const rows = await query<Record<string, unknown>>(sql, params);
  if (!rows.length) return 0;
  const v = Object.values(rows[0])[0];
  return typeof v === 'number' ? v : Number(v ?? 0);
}

export async function run(sql: string, ...params: Params): Promise<void> {
  await query(sql, params);
}

/** Raw statement execution, for the seed's bulk truncate. */
export async function exec(sql: string): Promise<void> {
  const c = await conn();
  await c.exec(sql);
}

/**
 * Run `fn` inside a transaction.
 *
 * Every posting path goes through here. Half a journal entry on disk is worse
 * than no journal entry: it is an unbalanced ledger that no report can explain.
 *
 * WHY AsyncLocalStorage. A transaction belongs to ONE connection, and the real
 * driver is a pool — so `all()` called inside `fn` has to reach the same client
 * or its read would run outside the transaction and miss everything written so
 * far. Passing a client through every one of the three hundred call sites would
 * say the same thing three hundred times; the async context says it once, and a
 * helper called anywhere inside the callback picks it up automatically.
 *
 * Nested calls reuse the outer transaction (Postgres has no nested BEGIN), so a
 * service that posts a document and then allocates a payment against it is one
 * atomic unit rather than two.
 */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  const existing = txConn.getStore();
  if (existing) return fn();

  await ready();
  return isDemoMode() ? demoTx(fn) : poolTx(fn);
}

async function poolTx<T>(fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await pool().connect();
  const c: Conn = {
    query: (sql, params) => client.query(sql, params as unknown[]).then((r) => ({ rows: r.rows })),
    exec: async (sql) => { await client.query(sql); },
  };
  try {
    await client.query('BEGIN');
    const out = await txConn.run(c, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    // A rollback can itself fail if the connection died mid-transaction. The
    // original error is the one worth reporting, so this one is swallowed.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The demo has ONE connection, so its transactions are queued rather than
 * pooled. Two overlapping posts would otherwise interleave their statements
 * inside a single BEGIN — one entry's COMMIT making the other's half-written
 * lines permanent. Serialising them costs nothing at demo traffic and keeps the
 * atomicity guarantee the same as in production.
 */
async function demoTx<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const c = await demo();
    await c.exec('BEGIN');
    try {
      const out = await txConn.run(c, fn);
      await c.exec('COMMIT');
      return out;
    } catch (err) {
      await c.exec('ROLLBACK').catch(() => {});
      throw err;
    }
  };
  const queued = (globalThis.__tripzoTxQueue ?? Promise.resolve()).then(run, run);
  // The queue must not reject, or every later transaction inherits the failure.
  globalThis.__tripzoTxQueue = queued.catch(() => {});
  return queued;
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
 *
 * `FOR UPDATE` is new with Postgres and load-bearing. SQLite serialised the
 * whole database, so two posts could not read the same `next_no`; here they
 * can, and two invoices numbered INV-00042 is a worse outcome than one of them
 * waiting a millisecond.
 */
export async function nextNumber(orgId: string, code: string, fallbackPrefix = 'DOC'): Promise<string> {
  const seq = await one<{ prefix: string; padding: number; next_no: number }>(
    'SELECT prefix, padding, next_no FROM sequences WHERE org_id = ? AND code = ? FOR UPDATE',
    orgId,
    code,
  );
  if (!seq) {
    await run('INSERT INTO sequences (org_id, code, prefix, padding, next_no) VALUES (?,?,?,?,?)',
      orgId, code, fallbackPrefix, 5, 2);
    return formatDocNumber(fallbackPrefix, 5, 1);
  }
  await run('UPDATE sequences SET next_no = next_no + 1 WHERE org_id = ? AND code = ?', orgId, code);
  return formatDocNumber(seq.prefix, seq.padding, seq.next_no);
}
