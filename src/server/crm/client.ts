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

const SUPABASE_URL = process.env.TRIPZO_SUPABASE_URL ?? 'https://supa.tripzocrm.cloud';
const SUPABASE_ANON_KEY = process.env.TRIPZO_SUPABASE_ANON_KEY ?? '';
const BACKEND_URL = (process.env.TRIPZO_BACKEND_URL ?? 'https://api.tripzocrm.cloud').replace(/\/+$/, '');

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
      'TRIPZO_SUPABASE_ANON_KEY is not set. Copy it from tripzo-crm-mobile/.env into this app\'s .env.local.',
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
 * An authenticated GET against the CRM's /api/* routes.
 *
 * Deliberately read-only: there is no `method` parameter and no body. This
 * app's job is to keep books about what the CRM recorded, and a bug in a
 * mapping routine should never be able to alter the CRM's own data. Writes
 * back to the CRM, if they are ever wanted, should be a separate module with a
 * separate reason to exist.
 */
export async function crmGet<T>(session: CrmSession, path: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'X-Tripzo-Client': 'tripzo-finance',
      Accept: 'application/json',
    },
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

/**
 * Unwrap the two response shapes the CRM uses interchangeably.
 *
 * Some routes answer a bare array, others `{ invoices: [...] }` or
 * `{ leads: [...] }`. The mobile app handles this at every call site; doing it
 * once here is the same fix applied in one place.
 */
export function rows<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  const wrapped = (body as Record<string, unknown> | null)?.[key];
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

export const CRM_BACKEND_URL = BACKEND_URL;
export const CRM_CONFIGURED = Boolean(SUPABASE_ANON_KEY);
