import 'server-only';
import { cache } from 'react';
import { all, one, run, tx, id as newId } from './db';
import { can, type FinanceCap } from '@/lib/accounting';
import { currentCrmUser, type CrmUser } from './crm/identity';
import { CRM_CONFIGURED } from './crm/client';
import { provisionOrg, booksOfCrmOrg } from './provision';
import { audit } from './accounting/audit';

/**
 * Who is asking, and what they are allowed to do.
 *
 * This app is the finance BRANCH of TripzoCRM, not a separate product, and this
 * module is the seam where that identity arrives. It used to be a stub — resolve
 * the seeded org, pick a user out of it — with a comment promising the real
 * thing later. This is the real thing: the visitor signs in with their own CRM
 * credentials against the same self-hosted Supabase the mobile app and the web
 * CRM use, the node backend says who they are and which agency they belong to,
 * and those answers become the session.
 *
 * THE POINT OF THIS FILE IS STILL `requireCap`. Hiding a button is a courtesy;
 * refusing the request is the control. Every mutating route handler and server
 * action calls it, because anyone can POST to a route (plan section 46).
 *
 * -------------------------------------------------------------------------
 * AND IT IS WHERE TENANCY IS DECIDED — SEE `resolveBooks`
 * -------------------------------------------------------------------------
 * One deployment holds ONE SET OF BOOKS PER CRM AGENCY. `session.orgId` is the
 * id this module resolves the signing-in person's agency to, and it is the
 * value every query in the product is filtered by — so the correctness of
 * "Wander Travels only ever sees Wander Travels' books" is decided here and
 * enforced everywhere. There is no second place that gets a vote, which is
 * deliberate: a tenancy rule with two implementations has one bug.
 *
 * -------------------------------------------------------------------------
 * THE DEMO PATH IS STILL HERE, AND HAS TO BE
 * -------------------------------------------------------------------------
 * With no Supabase anon key configured there is no CRM to authenticate against,
 * and the product runs on its embedded database with seeded books. That mode is
 * what makes the app openable by someone evaluating it, and what every test and
 * screenshot runs on. So `getSession` resolves the seeded org in that case
 * exactly as it always did — and ONLY in that case. Once the CRM is configured,
 * an unauthenticated request gets no session at all rather than quietly falling
 * back to "the first admin in the database", which would be an authentication
 * bypass wearing a convenience's clothes.
 */

export interface Session {
  orgId: string;
  orgName: string;
  currency: string;
  fyStartMonth: number;
  userId: string;
  userName: string;
  role: string;
  /** The CRM account behind this session, absent in demo mode. */
  crm?: {
    userId: string;
    email: string | null;
    orgId: string | null;
    orgName: string | null;
  };
}

export class ForbiddenError extends Error {
  constructor(public cap: FinanceCap) {
    super(`You do not have permission to ${cap.replace('.', ' ')}.`);
    this.name = 'ForbiddenError';
  }
}

/** Thrown when the CRM is configured and nobody is signed in. Caught by `ctx`, which redirects. */
export class NotSignedInError extends Error {
  constructor(message = 'Sign in with your TripzoCRM account to open the books.') {
    super(message);
    this.name = 'NotSignedInError';
  }
}

/**
 * A valid CRM account that belongs to no agency.
 *
 * ITS OWN ERROR because the remedy is different from every other failure here.
 * It is not a bug, not a permission problem and not something reloading fixes:
 * the password was right, the CRM answered, and the answer was that this person
 * is attached to no organisation. TripzoCRM allows that state deliberately —
 * `signup.tsx` there creates a Supabase auth user and nothing else, because
 * neither an organisation nor a role is something somebody should be able to
 * give themselves, so a brand-new account signs in with no agency behind it
 * until an administrator provisions one.
 *
 * There is nothing this app can do with such a session. It cannot invent an
 * agency — a set of books with no agency is a set of books nobody answers for —
 * so `ctx` sends them back to the sign-in screen with the session cleared and
 * this sentence on it, rather than a 500 that says nothing and leaves a cookie
 * behind that will produce the same 500 again.
 *
 * IT USED TO MEAN SOMETHING ELSE, and the change is the point of this release.
 * It was `WrongAgencyError`: "these books belong to another agency, go away",
 * thrown whenever a second agency signed into a deployment whose single ledger
 * the first had already claimed. That is no longer a failure, because a second
 * agency now gets a second set of books. See `resolveBooks`.
 */
export class NoAgencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoAgencyError';
  }
}

/** True when this deployment authenticates against TripzoCRM rather than running the demo. */
export const AUTH_REQUIRED = CRM_CONFIGURED;

interface Books { id: string; name: string; currency: string; fy_start_month: number }

const BOOKS_COLUMNS = 'id, name, currency, fy_start_month';

/**
 * THE BOOKS A CRM AGENCY'S FINANCE SCREENS OPEN ONTO.
 *
 * ===========================================================================
 * ONE SET OF BOOKS PER CRM AGENCY. THIS IS THE TENANCY RULE.
 * ===========================================================================
 * Everything downstream depends on it. `organizations.crm_org_id` is the join,
 * the unique index on it is the enforcement, and `session.orgId` — which every
 * query in this product is filtered by — is the id this function returns. When
 * Wander Travels signs in, every account, journal, invoice, receipt, journal
 * entry, GST figure and report they see is a row whose `org_id` is Wander
 * Travels' books, and there is no path through this app that reads a row
 * belonging to another one.
 *
 * ---------------------------------------------------------------------------
 * THE THREE CASES, IN THIS ORDER, AND THE ORDER MATTERS
 * ---------------------------------------------------------------------------
 *  1. MATCHED. The agency has books. Return them, and take the CRM's name for
 *     them on the way past — the CRM owns what an agency is called.
 *
 *  2. UNCLAIMED, REAL BOOKS — adoption. A ledger that was configured and traded
 *     on before this deployment was ever connected to a CRM has no agency
 *     against it. Refusing to open it until somebody ran a migration would mean
 *     the first sign-in after an upgrade loses the books, so the signing-in
 *     agency adopts them. NARROW ON PURPOSE: only when there is exactly ONE
 *     such ledger, and never one carrying `demo_data`.
 *
 *  3. NOTHING. Provision a fresh set — see `provisionOrg`. This is the case
 *     that used to throw `WrongAgencyError`, and turning it from a refusal into
 *     a provisioning step is what makes this product multi-tenant rather than
 *     single-tenant with a multi-tenant schema.
 *
 * ---------------------------------------------------------------------------
 * WHY ADOPTION IS SO CAREFUL
 * ---------------------------------------------------------------------------
 * Adoption hands an agency a ledger it did not create. Get it wrong in either
 * direction and the damage is in the books themselves:
 *
 *   ADOPTING THE DEMO would put Wander Travels' sample invoices, receipts and
 *   cancellations into a real agency's trial balance, receivables, P&L and GST
 *   summary. Every one of those figures would be wrong, and wrong in a way that
 *   looks like real data. `demo_data = 0` is the guard, and the demo seed sets
 *   that flag precisely so this check can exist.
 *
 *   ADOPTING WHEN THERE ARE SEVERAL unclaimed ledgers means guessing which
 *   agency's books these are, from a created_at timestamp. There is no honest
 *   answer, so the agency gets its own fresh books instead and nobody's
 *   history is handed to a stranger. The orphaned rows stay where they are,
 *   readable and recoverable, rather than being silently reassigned.
 */
async function resolveBooks(crmOrgId: string, crmOrgName: string | null): Promise<Books> {
  const name = crmOrgName?.trim() || null;

  // --- 1. Already provisioned -------------------------------------------
  const matched = await booksOfCrmOrg(crmOrgId);
  if (matched) {
    /*
     * THE CRM OWNS THE AGENCY'S NAME, so a rename there reaches the masthead,
     * every report header and every exported statement on the next page load
     * rather than on the next deployment. Written only when it has actually
     * changed: this runs on every single request, and an unconditional UPDATE
     * would be a write per page view for no reason.
     */
    if (name && name !== matched.name) {
      await run('UPDATE organizations SET name = ? WHERE id = ?', name, matched.id);
      matched.name = name;
    }
    return matched;
  }

  // --- 2. Adopt one pre-CRM ledger --------------------------------------
  const unclaimed = await all<Books>(
    `SELECT ${BOOKS_COLUMNS} FROM organizations
      WHERE crm_org_id IS NULL AND demo_data = 0 ORDER BY created_at LIMIT 2`,
  );
  if (unclaimed.length === 1) {
    const books = unclaimed[0];
    await run('UPDATE organizations SET crm_org_id = ?, name = COALESCE(?, name) WHERE id = ?',
      crmOrgId, name, books.id);
    await audit(books.id, {}, 'claimed', 'organisation', books.id,
      `Books adopted by TripzoCRM agency ${name ?? crmOrgId}`);
    return { ...books, name: name ?? books.name };
  }

  // --- 3. A new agency, a new set of books ------------------------------
  return await provisionBooksFor(crmOrgId, name);
}

/**
 * Open a brand-new ledger for an agency that has never had one.
 *
 * ---------------------------------------------------------------------------
 * THE RACE IS REAL AND IT IS HANDLED BY THE DATABASE, NOT BY A LOCK
 * ---------------------------------------------------------------------------
 * One page load resolves the session twice — the root layout reads it to draw
 * the masthead and the page reads it for its own data, and React renders them
 * concurrently. On an agency's very first visit both reach this function before
 * either has written anything, so both would provision. Two sets of books for
 * one agency is the worst possible outcome: nothing downstream could say which
 * was the books, and half the agency's work would land in each.
 *
 * `ux_org_crm`, the unique index on `crm_org_id`, is what actually prevents it.
 * The loser's INSERT fails, and the correct response to that failure is not to
 * report it but to READ THE WINNER'S BOOKS — which is what the catch does. A
 * mutex in this process would not help anyway, since two server instances can
 * cold-start against the same database.
 *
 * The whole provisioning runs in ONE TRANSACTION, so a failure part-way through
 * leaves nothing behind. A half-provisioned ledger — a chart of accounts but no
 * journals, or journals but no default accounts — would open, look fine, and
 * fail on the first attempt to post anything.
 */
async function provisionBooksFor(crmOrgId: string, name: string | null): Promise<Books> {
  try {
    const { orgId } = await tx(async () => await provisionOrg({
      // Named by the CRM. The fallback is deliberately not a blank string:
      // "TripzoCRM agency" on the masthead is at least a sentence, and it is
      // corrected by `resolveBooks` the moment the CRM answers with a name.
      name: name ?? 'TripzoCRM agency',
      crmOrgId,
    }));
    const books = await one<Books>(
      `SELECT ${BOOKS_COLUMNS} FROM organizations WHERE id = ?`, orgId,
    );
    if (!books) throw new Error('The new books were created but could not be read back.');
    await audit(orgId, {}, 'created', 'organisation', orgId,
      `Books opened for TripzoCRM agency ${name ?? crmOrgId}`);
    return books;
  } catch (e) {
    const concurrent = await booksOfCrmOrg(crmOrgId);
    if (concurrent) return concurrent;
    throw e;
  }
}

/**
 * The local row that signs this person's work.
 *
 * MIRRORED, NOT REPLACED. Every audit entry, every posted journal entry and
 * every document names a `users.id`, and those references have to resolve for
 * ever — including when the CRM is unreachable, and including after somebody is
 * removed from the CRM. So a CRM user gets a local row on first sign-in and
 * keeps it; what is refreshed on each visit is only the mutable part, the name
 * and the role, because a promotion in the CRM has to reach the books on the
 * next page load rather than the next deployment.
 *
 * MATCHED ON THE CRM ID FIRST, then on the email. The email path is what adopts
 * the users the seed created, so an existing ledger's audit history stays
 * attached to the same person rather than restarting under a second row for the
 * same human being.
 */
async function mirrorUser(orgId: string, user: CrmUser) {
  const role = (user.role ?? 'member').trim() || 'member';
  const name = (user.full_name ?? '').trim() || user.email || 'TripzoCRM user';

  const existing =
    await one<{ id: string }>('SELECT id FROM users WHERE org_id = ? AND crm_user_id = ?', orgId, user.id)
    ?? (user.email
      ? await one<{ id: string }>(
        'SELECT id FROM users WHERE org_id = ? AND LOWER(email) = LOWER(?)', orgId, user.email,
      )
      : null);

  if (existing) {
    await run(
      'UPDATE users SET crm_user_id = ?, name = ?, email = COALESCE(?, email), role = ?, active = 1 WHERE id = ?',
      user.id, name, user.email, role, existing.id,
    );
    return { id: existing.id, name, role };
  }

  const localId = newId('usr');
  await run(
    'INSERT INTO users (id, org_id, name, email, role, active, crm_user_id) VALUES (?,?,?,?,?,1,?)',
    localId, orgId, name, user.email, role, user.id,
  );
  return { id: localId, name, role };
}

/**
 * The seeded session, for the demo.
 *
 * Unchanged from what this file did before the CRM seam existed, and reachable
 * ONLY when no CRM is configured — see `getSession`.
 */
async function demoSession(): Promise<Session> {
  const org = await one<{ id: string; name: string; currency: string; fy_start_month: number }>(
    'SELECT id, name, currency, fy_start_month FROM organizations ORDER BY created_at LIMIT 1',
  );
  if (!org) {
    throw new Error('No organisation found. Run `npm run seed` to create the books.');
  }
  const wanted = process.env.TRIPZO_USER;
  const user =
    (wanted ? await one<{ id: string; name: string; role: string }>(
      'SELECT id, name, role FROM users WHERE org_id = ? AND (id = ? OR email = ?)',
      org.id, wanted, wanted,
    ) : null)
    ?? await one<{ id: string; name: string; role: string }>(
      `SELECT id, name, role FROM users WHERE org_id = ? AND active = 1
        ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'accountant' THEN 1 ELSE 2 END LIMIT 1`,
      org.id,
    );

  return {
    orgId: org.id,
    orgName: org.name,
    currency: org.currency,
    fyStartMonth: org.fy_start_month,
    userId: user?.id ?? 'system',
    userName: user?.name ?? 'System',
    role: user?.role ?? 'admin',
  };
}

/**
 * `cache`d for the request, because every page, every layout and every server
 * action asks for it. Without this one render would mirror the user a dozen
 * times and make a dozen identical calls to the CRM before the first byte went
 * out.
 */
export const getSession = cache(async (): Promise<Session> => {
  if (!AUTH_REQUIRED) return await demoSession();

  const user = await currentCrmUser();
  if (!user) throw new NotSignedInError();

  /*
   * NO AGENCY, NO BOOKS, AND THE CHECK IS HERE RATHER THAN INSIDE
   * `resolveBooks` so that function has one job: given an agency, find or make
   * its ledger. A session with no `organization_id` is not a tenancy question
   * at all — it is an unprovisioned CRM account, which the CRM creates on
   * sign-up by design (see `NoAgencyError`).
   */
  if (!user.organization_id) {
    throw new NoAgencyError(
      'Your TripzoCRM account is not attached to an agency yet, so there are no books to open. '
      + 'Ask an administrator at your agency to add you to its organisation, then sign in again.',
    );
  }

  const org = await resolveBooks(user.organization_id, user.organization_name ?? null);
  const local = await mirrorUser(org.id, user);

  return {
    orgId: org.id,
    orgName: org.name,
    currency: org.currency,
    fyStartMonth: org.fy_start_month,
    userId: local.id,
    userName: local.name,
    // THE CRM'S ROLE, NOT A LOCAL ONE. `ROLE_CAPS` in lib/accounting.ts is
    // already keyed by the CRM's own role names (member, admin, developer,
    // tester, service_role) precisely so this needs no translation table —
    // and a translation table is exactly where a privilege bug would hide.
    role: local.role,
    crm: {
      userId: user.id,
      email: user.email,
      orgId: user.organization_id,
      orgName: user.organization_name ?? null,
    },
  };
});

/** The session, or null when nobody is signed in. For the layout and the login screen. */
export async function optionalSession(): Promise<Session | null> {
  try {
    return await getSession();
  } catch (e) {
    // Both mean "there is no shell to draw". The DIFFERENCE between them — go
    // and sign in, against sign in as somebody else — is acted on by `ctx`,
    // which is what the actual page calls; this one only has to decide whether
    // to wrap the children in a masthead.
    if (e instanceof NotSignedInError || e instanceof NoAgencyError) return null;
    throw e;
  }
}

export function actorOf(s: Session) {
  return { id: s.userId, name: s.userName, role: s.role };
}

/** Throws unless the current session holds `cap`. Server-side only, by design. */
export async function requireCap(cap: FinanceCap): Promise<Session> {
  const s = await getSession();
  if (!can(s.role, cap)) throw new ForbiddenError(cap);
  return s;
}
