import 'server-only';

/**
 * The door to TripzoCRM.
 *
 * This app used to invent its own Wander Travels: an agency name, four users,
 * a season of bookings and a stack of invoices, all written into seed.ts. That
 * is fine for a demo and wrong for a product — the agency already exists in the
 * CRM, and two systems each holding their own idea of who the customers are is
 * the oldest reconciliation problem there is.
 *
 * So the books are now DERIVED. This module is the transport; sync.ts is the
 * mapping that turns CRM records into ledger postings.
 *
 * -------------------------------------------------------------------------
 * WHY IT AUTHENTICATES THE WAY IT DOES
 * -------------------------------------------------------------------------
 * The CRM backend (api.tripzocrm.cloud) validates a Supabase access token and
 * resolves the caller's organization from it — exactly what the mobile app
 * does in src/lib/api.ts. There is no service account and no API key to hold,
 * which is a deliberate property of that backend rather than an oversight: the
 * data an agency can see is a function of WHO is asking.
 *
 * That leaves one honest option. The accountant signs in here with their own
 * CRM credentials, through the screen at /settings/crm-sync, and we hold the
 * resulting token. The password is used for the one sign-in call and never
 * stored — see `signIn` below.
 */

/*
 * -------------------------------------------------------------------------
 * TWO SUPABASES, AND THEY DO DIFFERENT JOBS
 * -------------------------------------------------------------------------
 * This product talks to two of them and confusing the pair is the single
 * easiest way to break it, so they are named apart rather than left to be
 * told by their values:
 *
 *   PRIMARY    TRIPZO_DATABASE_URL — the Postgres this LEDGER lives in. Owned
 *              by this app, written to constantly, never authenticated against.
 *
 *   SECONDARY  SUPABASE_MOBILE_* — the SELF-HOSTED Supabase at
 *              supa.tripzocrm.cloud that TripzoCRM's mobile app and web CRM
 *              authenticate against. USED ONLY FOR AUTH. This app never reads
 *              a table in it, never writes one, and holds no service key for
 *              it: it exchanges a password for a token and stops there.
 *              Everything else goes through the node backend, which is where
 *              organization scoping and row-level access are actually decided.
 *
 * "MOBILE" IS WHERE THE VALUES CAME FROM, not who may use them. They are the
 * same EXPO_PUBLIC_* values that get inlined into the mobile bundle, which is
 * why copying them here is safe: the anon key grants nothing on its own, and
 * every /api/* call is authorised by the signed-in person's own token.
 *
 * The older TRIPZO_SUPABASE_* names are still read, because a deployment that
 * was configured before the rename must not stop authenticating when this
 * ships. New names first, old names as the fallback, hard-coded host last.
 */
const SUPABASE_URL =
  process.env.SUPABASE_MOBILE_URL
  ?? process.env.TRIPZO_SUPABASE_URL
  ?? 'https://supa.tripzocrm.cloud';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_MOBILE_ANON_KEY
  ?? process.env.TRIPZO_SUPABASE_ANON_KEY
  ?? '';
const BACKEND_URL = (
  process.env.TRIPZO_BACKEND_URL
  ?? process.env.SUPABASE_MOBILE_BACKEND_URL
  ?? 'https://api.tripzocrm.cloud'
).replace(/\/+$/, '');

export class CrmError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'CrmError';
  }
}

export interface CrmSession {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
  email: string;
}

/**
 * Exchange an email and password for a Supabase session.
 *
 * THE PASSWORD IS NEVER PERSISTED. It exists as an argument to this function
 * and in the request body it builds, and nowhere else — not in org_settings,
 * not in the audit log, not in an error message. What is kept afterwards is the
 * access token and its refresh token, which are revocable from the CRM and
 * expire on their own.
 */
export async function signIn(email: string, password: string): Promise<CrmSession> {
  if (!SUPABASE_ANON_KEY) {
    throw new CrmError(
      0,
      'SUPABASE_MOBILE_ANON_KEY is not set, so there is nothing to authenticate against. ' +
      'Copy EXPO_PUBLIC_SUPABASE_ANON_KEY out of tripzo-crm-mobile/.env into this app\'s .env.local.',
    );
  }

  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  }).catch((e: unknown) => {
    throw new CrmError(0, `Cannot reach ${SUPABASE_URL}: ${e instanceof Error ? e.message : 'network error'}`);
  });

  const body = (await res.json().catch(() => null)) as
    | { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string; msg?: string }
    | null;

  if (!res.ok || !body?.access_token) {
    throw new CrmError(res.status, body?.error_description ?? body?.msg ?? 'Sign-in failed.');
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    email,
  };
}

/** Trade a refresh token for a fresh access token, so a sync days later still works. */
export async function refresh(refreshToken: string, email: string): Promise<CrmSession> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const body = (await res.json().catch(() => null)) as
    | { access_token?: string; refresh_token?: string; expires_in?: number }
    | null;
  if (!res.ok || !body?.access_token) {
    throw new CrmError(res.status, 'The saved CRM session has expired. Sign in again.');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? refreshToken,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    email,
  };
}

/**
 * An authenticated READ against the CRM's /api/* routes.
 *
 * -------------------------------------------------------------------------
 * THIS IS A ONE-WAY DOOR, AND THE GUARD BELOW IS WHY
 * -------------------------------------------------------------------------
 * TripzoCRM is the system of record for packages, leads and the invoices agents
 * raise. This app keeps the BOOKS about them, in its own database, and it has
 * no business altering a single row of the CRM's — not an invoice total, not a
 * payment, not a status. An agency's operational data must not move because a
 * mapping routine in an accounting app took a wrong turn.
 *
 * That rule was previously a convention: `crmFetch` accepted a method and a
 * body, and three call sites used them to POST, PATCH and DELETE invoices.
 * A convention is not a control — the next caller does not read the comment.
 * So the method is now FIXED AT GET, there is no parameter to pass a body
 * through, and anything that wants to write has nowhere to put the payload.
 * Writing to the CRM is not forbidden here; it is unexpressible.
 *
 * The belt-and-braces check on `path` catches the other way in: a caller that
 * smuggles a mutating route (`/api/invoices/x/delete`) through a GET still
 * reaches the backend, which may honour it. Paths are read-only by shape.
 *
 * Every call carries the SIGNED-IN PERSON's token, so this app sees exactly
 * what that person sees on their phone — organization scoping, row-level
 * access and admin impersonation are all decided by the backend, and a SELECT
 * against the CRM's Postgres would have to re-implement all three correctly,
 * for ever, as they change.
 *
 * Ported from tripzo-crm-mobile/src/lib/api.ts, minus the writes.
 *
 * -------------------------------------------------------------------------
 * THE TWO POSTS LEFT IN THIS FILE ARE NOT DATA WRITES
 * -------------------------------------------------------------------------
 * `signIn` and `refresh` above POST to GoTrue — `/auth/v1/token` on the
 * self-hosted Supabase — because trading a password for a token is a POST and
 * there is no other way to spell it. They create no row, change no record and
 * touch nothing the CRM owns: the response is a token and the request is the
 * only way to get one.
 *
 * Every call that reaches the CRM's DATA goes through this function, and this
 * function is a GET. If you are auditing whether this app can alter TripzoCRM,
 * those two are the whole exception list and neither of them can.
 */

/**
 * Route segments that mean "this request changes something over there".
 *
 * Checked because a GET is not automatically harmless: a backend route named
 * for an action can perform it on any method. This is a cheap second lock on
 * the same door, and it fails LOUDLY — a developer who adds a write path finds
 * out at the call, not from an agency's data.
 */
const MUTATING_SEGMENT = /\/(create|update|delete|remove|cancel|void|send|pay|approve|reject|import|sync)(\/|$)/i;

export async function crmFetch<T>(session: CrmSession, path: string): Promise<T> {
  if (!path.startsWith('/')) {
    throw new CrmError(0, `CRM path must be absolute, got "${path}".`);
  }
  if (MUTATING_SEGMENT.test(path.split('?')[0])) {
    throw new CrmError(
      0,
      `Refusing to call ${path}: this app is READ-ONLY against TripzoCRM. Nothing in the `
      + 'accounting software may alter the CRM’s data — invoices, receipts and packages are '
      + 'fetched and mirrored into this ledger’s own database, and every edit happens there.',
    );
  }

  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      // Names this app to the backend's request telemetry. Without it every
      // server-side number is web, mobile and finance added together.
      'X-Tripzo-Client': 'tripzo-finance',
      Accept: 'application/json',
    },
    // A ledger screen must never render a cached invoice: the figure on it is
    // the one somebody is about to act on.
    cache: 'no-store',
  }).catch((e: unknown) => {
    throw new CrmError(0, `Cannot reach ${BACKEND_URL}: ${e instanceof Error ? e.message : 'network error'}`);
  });

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // A proxy or a cold start can answer HTML. Falling through with null gives
    // the caller the status, which is the useful half.
    body = null;
  }

  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error ?? `${path} failed with ${res.status}`;
    throw new CrmError(res.status, message);
  }
  return body as T;
}

/** An alias kept because most call sites read better as `crmGet`. Same function. */
export function crmGet<T>(session: CrmSession, path: string): Promise<T> {
  return crmFetch<T>(session, path);
}

/**
 * Unwrap whichever shape a CRM route answered with.
 *
 * The backend is not consistent about this and does not need to be: some routes
 * answer a bare array, some `{ invoices: [...] }`, some wrap a page as
 * `{ data: [...], total }`. The mobile app handles it at each call site; doing
 * it once here is the same fix in one place.
 *
 * THE NAMED KEY IS TRIED FIRST AND THE GENERIC ONES AFTER, never the other way
 * round. A response that carries both `invoices` and `data` means the first,
 * and a guess that preferred `data` would quietly return a different list.
 *
 * FALLING BACK TO "THE ONLY ARRAY IN THE OBJECT" is the last resort and is
 * deliberately narrow — exactly one array-valued property, or nothing. It is
 * what stops a route that was renamed from `{ invoices }` to `{ records }`
 * presenting as "this agency has no invoices", which is indistinguishable from
 * the truth and is the worst way for this to fail.
 */
export function rows<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  const obj = body as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') return [];

  for (const k of [key, 'data', 'rows', 'items', 'results', 'records']) {
    if (Array.isArray(obj[k])) return obj[k] as T[];
  }

  const arrays = Object.values(obj).filter(Array.isArray) as T[][];
  return arrays.length === 1 ? arrays[0] : [];
}

/**
 * What a response LOOKED like, for a screen that got nothing back.
 *
 * An empty list has two completely different causes — the agency genuinely has
 * no invoices, or this code read the wrong key out of a shape it did not
 * expect — and they are indistinguishable on screen. That ambiguity is what
 * makes "it doesn't show anything" so slow to chase, so the shape travels back
 * with the result and the screen prints it when, and only when, the list is
 * empty.
 *
 * Keys and types only. NEVER VALUES: this string reaches a browser and a
 * server log, and an invoice payload carries customer names, phone numbers and
 * amounts that have no business in either.
 */
export function describeShape(body: unknown): string {
  if (body === null || body === undefined) return 'an empty body';
  if (Array.isArray(body)) return `an array of ${body.length}`;
  if (typeof body !== 'object') return typeof body;
  const entries = Object.entries(body as Record<string, unknown>).map(([k, v]) =>
    `${k}: ${Array.isArray(v) ? `array(${v.length})` : v === null ? 'null' : typeof v}`,
  );
  return entries.length ? `{ ${entries.join(', ')} }` : 'an empty object';
}

export const CRM_BACKEND_URL = BACKEND_URL;
export const CRM_CONFIGURED = Boolean(SUPABASE_ANON_KEY);
