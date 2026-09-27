import 'server-only';
import { one } from './db';
import { can, type FinanceCap } from '@/lib/accounting';

/**
 * Who is asking, and what they are allowed to do.
 *
 * This app is the finance BRANCH of TripzoCRM, not a separate product: in
 * production the session comes from the CRM (Supabase auth, org membership
 * from the Node backend) and this module is the seam where that arrives. Until
 * it is wired, it resolves the seeded org and a user picked by an env var, so
 * every downstream caller is already written against the real shape and none
 * of them has to change when the seam is connected.
 *
 * THE POINT OF THIS FILE IS `requireCap`. Hiding a button is a courtesy;
 * refusing the request is the control. Every mutating route handler and server
 * action calls it, because anyone can POST to a route (plan section 46: the
 * backend must enforce these permissions).
 */

export interface Session {
  orgId: string;
  orgName: string;
  currency: string;
  fyStartMonth: number;
  userId: string;
  userName: string;
  role: string;
}

export class ForbiddenError extends Error {
  constructor(public cap: FinanceCap) {
    super(`You do not have permission to ${cap.replace('.', ' ')}.`);
    this.name = 'ForbiddenError';
  }
}

export function getSession(): Session {
  const org = one<{ id: string; name: string; currency: string; fy_start_month: number }>(
    'SELECT id, name, currency, fy_start_month FROM organizations ORDER BY created_at LIMIT 1',
  );
  if (!org) {
    throw new Error('No organisation found. Run `npm run seed` to create the books.');
  }
  const wanted = process.env.TRIPZO_USER;
  const user =
    (wanted ? one<{ id: string; name: string; role: string }>(
      'SELECT id, name, role FROM users WHERE org_id = ? AND (id = ? OR email = ?)',
      org.id, wanted, wanted,
    ) : null)
    ?? one<{ id: string; name: string; role: string }>(
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

export function actorOf(s: Session) {
  return { id: s.userId, name: s.userName, role: s.role };
}

/** Throws unless the current session holds `cap`. Server-side only, by design. */
export function requireCap(cap: FinanceCap): Session {
  const s = getSession();
  if (!can(s.role, cap)) throw new ForbiddenError(cap);
  return s;
}
