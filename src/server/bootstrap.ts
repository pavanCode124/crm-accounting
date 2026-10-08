import 'server-only';
import { redirect } from 'next/navigation';
import { ensureDemoBooks } from './seed';
import { ensureGstComponents, ensureCoaNames } from './provision';
import { getSession, NotSignedInError, NoAgencyError, type Session } from './auth';

/**
 * First call of a request wins.
 *
 * Every page calls `await ctx()` instead of `getSession()` so that a fresh
 * deployment — an empty accounting schema, no migration step — opens on a
 * working set of books rather than on a stack trace. The schema is created on
 * the first connection (see db.ts); what happens next depends entirely on
 * whether this deployment is connected to a CRM.
 *
 * IT IS ALSO THE AUTHENTICATION GATE, and that is why it is one function rather
 * than two. Every screen in the product already calls this on its first line —
 * it has to, to get the org id — so making the redirect happen here means there
 * is no page that can be reached without a session by forgetting to add a
 * check. A screen that does not call `ctx()` has no org to query with and
 * cannot show anything anyway.
 *
 * `redirect` rather than an error: being signed out is an ordinary state, not a
 * fault, and a 500 page that says "NotSignedInError" is a worse answer to it
 * than the sign-in form.
 */
export async function ctx(): Promise<Session> {
  /*
   * -----------------------------------------------------------------------
   * THE DEMO IS SEEDED HERE; A REAL AGENCY'S BOOKS ARE NOT
   * -----------------------------------------------------------------------
   * This line used to be `ensureSeeded()`, unconditionally, and that was a
   * real bug once a second agency could sign in. On a CRM-connected
   * deployment it wrote Wander Travels — a fictional agency with a season of
   * sample invoices, receipts and a cancellation — into the production
   * database before anybody had even reached the sign-in form. The first real
   * agency then adopted those books, and the demo's figures turned up in its
   * trial balance, its receivables and its GST summary.
   *
   * So the seed is now explicitly the DEMO's, it runs only when there is no
   * CRM to authenticate against, and it says so in its name. A connected
   * deployment starts with an empty schema and gets one set of books per
   * agency, provisioned on that agency's first sign-in — see `resolveBooks`.
   */
  await ensureDemoBooks();
  try {
    const session = await getSession();
    /*
     * CONFIGURATION THIS BUILD NEEDS AND OLDER BOOKS DO NOT HAVE.
     *
     * Provisioning runs once, on an agency's first sign-in, so an agency
     * onboarded before UTGST existed has no union-territory tax rows and no
     * account to post them to — and nothing in the ordinary course of work
     * would ever give it one. This is the top-up, and it only ever ADDS: it
     * returns at the first read on books that already have the rows, and it is
     * remembered per process, so the cost after a cold start is nothing.
     */
    await ensureGstComponents(session.orgId);
    /*
     * THE AGENCY'S OWN NAMES for accounts this ledger already carries under a
     * generic one, plus the handful it was missing (Drawings, Bad Debts,
     * Computer Laptops...). Same top-up shape as the GST call above — additive,
     * idempotent, remembered per process. See `ensureCoaNames`.
     */
    await ensureCoaNames(session.orgId);
    return session;
  } catch (e) {
    if (e instanceof NotSignedInError) redirect('/login');
    /*
     * A VALID CRM ACCOUNT WITH NO AGENCY BEHIND IT is not a fault to show a
     * stack trace for, and it is not fixed by reloading — the cookie that
     * caused it would still be there. It goes through the route handler that
     * CLEARS the session (a Server Component may not write a cookie) and lands
     * on the sign-in screen with the reason on it, which is the only place the
     * person can actually do something about it.
     */
    if (e instanceof NoAgencyError) {
      redirect(`/api/auth/switch?reason=${encodeURIComponent(e.message)}`);
    }
    throw e;
  }
}
