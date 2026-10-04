import 'server-only';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { signIn, refresh, crmGet, CrmError, CRM_CONFIGURED, type CrmSession } from './client';

/**
 * THE SIGNED-IN PERSON, as TripzoCRM knows them.
 *
 * -------------------------------------------------------------------------
 * HOW THIS DIFFERS FROM connection.ts, WHICH ALSO HOLDS A CRM TOKEN
 * -------------------------------------------------------------------------
 * They look alike and they are not interchangeable, so the distinction is
 * worth stating once rather than re-deriving every time someone touches one of
 * them:
 *
 *   connection.ts  ONE token per set of books, stored in `crm_connection`, put
 *                  there deliberately by an accountant on the CRM Sync screen.
 *                  It is a SERVICE identity: the importer runs on a schedule
 *                  with nobody watching, and it must keep working at 3am when
 *                  the person who configured it is asleep.
 *
 *   identity.ts    THE CURRENT VISITOR's own token, in an httpOnly cookie,
 *                  living exactly as long as their browser session. Every live
 *                  read made on their behalf uses it, which is the whole point:
 *                  the backend resolves the organization FROM the token, so an
 *                  agent only ever sees their own agency's packages and
 *                  invoices, and this app never has to re-implement that rule.
 *
 * Using the stored connection for on-screen reads would quietly grant every
 * visitor the access of whoever last configured the sync. Using a visitor's
 * token for the importer would break the sync the moment they logged out.
 *
 * -------------------------------------------------------------------------
 * WHY A COOKIE AND NOT supabase-js
 * -------------------------------------------------------------------------
 * The mobile app uses supabase-js because it needs a long-lived client holding
 * a session across app restarts, a realtime socket and an auth listener. This
 * app is server-rendered: every page is a fresh request, there is no client to
 * keep alive, and the only two calls it ever makes against Supabase are "trade
 * a password for a session" and "trade a refresh token for a fresh one" —
 * both of which `client.ts` already implements as plain fetch against GoTrue.
 *
 * So the session lives in an httpOnly cookie, where no script on the page can
 * read it, and the token never reaches the browser's JavaScript at all.
 */

/** The subset of GET /api/users/current this app reads. Matches the mobile `CurrentUser`. */
export interface CrmUser {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string | null;
  /** The EFFECTIVE organization — it already follows impersonation on the backend. */
  organization_id: string | null;
  organization_name?: string | null;
}

const COOKIE = 'tripzo_session';

/**
 * How close to expiry the stored token stops being trusted.
 *
 * Comfortably longer than any request this app makes, so a token cannot expire
 * in flight — and generous enough that a page which fans out to several CRM
 * reads cannot have the first succeed and the last fail.
 */
const MARGIN_MS = 120_000;

interface StoredSession {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  email: string;
}

function encode(s: StoredSession): string {
  return Buffer.from(JSON.stringify(s), 'utf8').toString('base64url');
}

function decode(raw: string | undefined): StoredSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as StoredSession;
    return parsed?.accessToken ? parsed : null;
  } catch {
    // A cookie this app did not write, or one left over from an older shape.
    // Treating it as "not signed in" sends the visitor to /login, which is the
    // only useful outcome; throwing here would 500 every page instead.
    return null;
  }
}

async function writeCookie(s: StoredSession) {
  (await cookies()).set(COOKIE, encode(s), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    // The refresh token outlives the access token by a long way, so the cookie
    // is given a week rather than the access token's hour. Anything shorter
    // logs the accountant out mid-afternoon for no reason; anything longer is
    // a credential sitting in a browser for a month.
    maxAge: 7 * 24 * 60 * 60,
  });
}

/**
 * Sign in with CRM credentials and remember the session.
 *
 * THE PASSWORD IS NEVER PERSISTED — it is an argument to `signIn` and part of
 * the request body it builds, and nowhere else. What is kept is the pair of
 * tokens, which the CRM can revoke and which expire on their own.
 */
export async function signInToCrm(email: string, password: string): Promise<CrmUser> {
  const session = await signIn(email, password);
  const user = await crmGet<CrmUser | { user?: CrmUser }>(session, '/api/users/current');
  const resolved = (user as { user?: CrmUser }).user ?? (user as CrmUser);
  if (!resolved?.id) {
    throw new CrmError(502, 'TripzoCRM accepted the password but returned no profile.');
  }
  await writeCookie({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
    email: resolved.email ?? email,
  });
  return resolved;
}

export async function signOutOfCrm() {
  (await cookies()).delete(COOKIE);
}

/**
 * The visitor's CRM session, refreshed on the way past if it is nearly out.
 *
 * Returns null rather than throwing when nobody is signed in: "not signed in"
 * is an ordinary state on the way to /login, not a failure, and every caller
 * here has something sensible to do with a null.
 */
export const crmSession = cache(async (): Promise<CrmSession | null> => {
  const stored = decode((await cookies()).get(COOKIE)?.value);
  if (!stored) return null;

  if (stored.expiresAt - Date.now() > MARGIN_MS) {
    return {
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken,
      expiresAt: stored.expiresAt,
      email: stored.email,
    };
  }
  if (!stored.refreshToken) return null;

  try {
    const fresh = await refresh(stored.refreshToken, stored.email);
    /*
     * THE REFRESHED TOKEN IS NOT WRITTEN BACK FROM EVERY RENDER.
     *
     * A Server Component cannot set a cookie — Next refuses it outside an
     * action or a route handler — so attempting it here throws on exactly the
     * page the visitor was trying to read. The refreshed token is therefore
     * used for THIS request and the cookie is left alone; the next action or
     * route handler that runs renews it properly through `renewCookie`.
     *
     * The cost is one extra refresh call per render in the few minutes after a
     * token ages out, against a request that was going to call the CRM anyway.
     */
    return fresh;
  } catch {
    return null;
  }
});

/**
 * Write a refreshed token back, from somewhere that is allowed to set cookies.
 *
 * Called by the sign-in action and by the route handlers that proxy live CRM
 * reads. Silent on failure for the reason above: being unable to persist a
 * renewal must never break the request that triggered it.
 */
export async function renewCookie(session: CrmSession) {
  try {
    await writeCookie({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      email: session.email,
    });
  } catch {
    /* Not in a cookie-writable context. The session still works for this request. */
  }
}

/**
 * The signed-in CRM user, or null.
 *
 * `cache`d for the duration of one request: `getSession` is called by every
 * page, every layout and every server action, and without this a single render
 * would make a dozen identical round trips to api.tripzocrm.cloud before the
 * first byte reached the browser.
 */
export const currentCrmUser = cache(async (): Promise<CrmUser | null> => {
  if (!CRM_CONFIGURED) return null;
  const session = await crmSession();
  if (!session) return null;
  try {
    const body = await crmGet<CrmUser | { user?: CrmUser }>(session, '/api/users/current');
    const user = (body as { user?: CrmUser }).user ?? (body as CrmUser);
    return user?.id ? user : null;
  } catch (e) {
    /*
     * A 401 means the token is genuinely dead and the visitor has to sign in
     * again. ANY OTHER failure — the backend cold-starting, DNS blinking, a
     * deploy in progress — must NOT log them out: treating a 502 as "signed
     * out" would drop an accountant mid-entry every time the CRM restarted.
     * Those are rethrown so the screen can say what actually happened.
     */
    if (e instanceof CrmError && (e.status === 401 || e.status === 403)) return null;
    throw e;
  }
});
