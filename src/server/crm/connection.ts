import 'server-only';
import { one, run, nowIso } from '../db';
import { signIn, refresh, crmGet, type CrmSession } from './client';

/**
 * The stored CRM connection, and keeping its token alive.
 *
 * One row per organisation. The access token is short-lived by design, so
 * `await session()` refreshes it on the way past rather than making the accountant
 * sign in again every hour — which is the difference between a sync they can
 * schedule and one they have to babysit.
 */

export interface ConnectionRow {
  org_id: string;
  email: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  crm_org_id: string | null;
  crm_org_name: string | null;
  last_sync_at: string | null;
  last_result: string | null;
}

export async function getConnection(orgId: string): Promise<ConnectionRow | null> {
  return await one<ConnectionRow>('SELECT * FROM crm_connection WHERE org_id = ?', orgId);
}

export async function isConnected(orgId: string): Promise<boolean> {
  return await getConnection(orgId) !== null;
}

/**
 * Sign in and remember the session. Replaces any previous connection.
 *
 * -------------------------------------------------------------------------
 * THE AGENCY IS CHECKED BEFORE THE TOKEN IS STORED
 * -------------------------------------------------------------------------
 * A correct password proves who somebody is, not which agency's books they are
 * entitled to import into. An administrator with accounts at two agencies, or
 * one who pasted the wrong credentials, connects successfully — and from then
 * on this ledger's unattended 3am sync pulls the OTHER agency's customers,
 * suppliers, invoices and receipts, each one correctly scoped to this `orgId`
 * and belonging to someone else.
 *
 * `syncFromCrm` also refuses a mismatched connection, and that is the control
 * that actually matters because it guards the writes. This check exists so the
 * accountant finds out WHILE TYPING THE PASSWORD rather than from a failed
 * sync a week later: the wrong credentials are never stored, so there is no
 * broken connection sitting in the database looking configured.
 *
 * It is only a check, never a correction. A connection that resolves to no
 * organisation at all, or to books that have not been claimed by a CRM agency
 * yet, is allowed through — `resolveBooks` owns that question, and refusing
 * here would block the legitimate first connection on a freshly adopted
 * ledger.
 */
export async function connect(orgId: string, email: string, password: string): Promise<CrmSession> {
  const s = await signIn(email, password);

  const books = await one<{ crm_org_id: string | null; name: string }>(
    'SELECT crm_org_id, name FROM organizations WHERE id = ?', orgId,
  );
  if (books?.crm_org_id) {
    const who = await crmGet<CrmUserLike | { user?: CrmUserLike }>(s, '/api/users/current');
    const user = (who as { user?: CrmUserLike })?.user ?? (who as CrmUserLike);
    if (user?.organization_id && user.organization_id !== books.crm_org_id) {
      throw new Error(
        `That account belongs to ${user.organization_name || 'another agency'}, and these books `
        + `belong to ${books.name}. The connection has NOT been saved — syncing on it would import `
        + 'another agency’s records into this ledger. Use an account in this agency.',
      );
    }
  }

  await run(
    `INSERT INTO crm_connection (org_id, email, access_token, refresh_token, expires_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(org_id) DO UPDATE SET
       email = excluded.email, access_token = excluded.access_token,
       refresh_token = excluded.refresh_token, expires_at = excluded.expires_at`,
    orgId, email, s.accessToken, s.refreshToken, s.expiresAt,
  );
  return s;
}

/** The two fields of `GET /api/users/current` this module needs. */
interface CrmUserLike {
  organization_id?: string | null;
  organization_name?: string | null;
}

export async function disconnect(orgId: string) {
  await run('DELETE FROM crm_connection WHERE org_id = ?', orgId);
}

/**
 * The current session, refreshed if it is close to expiring.
 *
 * The margin is generous because a sync is a long sequence of calls: a token
 * with forty seconds left would pass a check here and expire halfway through
 * importing invoices, leaving the books partly updated, which is the one
 * outcome worth going out of the way to avoid.
 */
const MARGIN_MS = 120_000;

export async function session(orgId: string): Promise<CrmSession> {
  const row = await getConnection(orgId);
  if (!row) throw new Error('Not connected to TripzoCRM. Connect under Settings → CRM Sync.');

  if (row.expires_at - Date.now() > MARGIN_MS) {
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
      email: row.email,
    };
  }

  if (!row.refresh_token) {
    throw new Error('The saved CRM session has expired and cannot be renewed. Sign in again.');
  }
  const fresh = await refresh(row.refresh_token, row.email);
  await run(
    'UPDATE crm_connection SET access_token=?, refresh_token=?, expires_at=? WHERE org_id=?',
    fresh.accessToken, fresh.refreshToken, fresh.expiresAt, orgId,
  );
  return fresh;
}

export async function recordSync(orgId: string, result: string, crmOrg?: { id: string; name: string }) {
  await run(
    `UPDATE crm_connection
        SET last_sync_at = ?, last_result = ?,
            crm_org_id = COALESCE(?, crm_org_id), crm_org_name = COALESCE(?, crm_org_name)
      WHERE org_id = ?`,
    nowIso(), result, crmOrg?.id ?? null, crmOrg?.name ?? null, orgId,
  );
}

// ---------------------------------------------------------------------------
// The identity map
// ---------------------------------------------------------------------------

export type LinkKind = 'partner' | 'booking' | 'document' | 'payment';

export async function linkedLocalId(orgId: string, kind: LinkKind, crmId: string): Promise<string | null> {
  return (await one<{ local_id: string }>(
    'SELECT local_id FROM crm_links WHERE org_id=? AND kind=? AND crm_id=?',
    orgId, kind, crmId,
  ))?.local_id ?? null;
}

export async function link(orgId: string, kind: LinkKind, crmId: string, localId: string) {
  await run(
    `INSERT INTO crm_links (org_id, kind, crm_id, local_id, synced_at) VALUES (?,?,?,?,?)
     ON CONFLICT(org_id, kind, crm_id) DO UPDATE SET local_id = excluded.local_id, synced_at = excluded.synced_at`,
    orgId, kind, crmId, localId, nowIso(),
  );
}
