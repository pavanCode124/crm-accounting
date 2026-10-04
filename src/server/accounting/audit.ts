import 'server-only';
import { all, run, nowIso } from '../db';
import type { Actor } from './engine';

/**
 * The audit trail (plan section 45).
 *
 * Append-only and never updated. It is written inside the same transaction as
 * the thing it describes, so a rolled-back post leaves no ghost line claiming
 * it happened — and a committed post can never be missing from the trail.
 */
export async function audit(
  orgId: string,
  actor: Actor,
  action: string,
  model: string,
  recordId: string,
  summary?: string,
  detail?: unknown,
) {
  await run(
    `INSERT INTO audit_log (org_id, at, user_id, user_name, action, model, record_id, summary, detail)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    orgId, nowIso(), actor.id ?? null, actor.name ?? 'System',
    action, model, recordId, summary ?? null,
    detail === undefined ? null : JSON.stringify(detail),
  );
}

export interface AuditRow {
  id: number; at: string; user_name: string; action: string;
  model: string; record_id: string; summary: string | null; detail: string | null;
}

/**
 * Everything that has happened to one record.
 *
 * -------------------------------------------------------------------------
 * WHY `orgId` IS A PARAMETER WHEN THE RECORD ID IS ALREADY UNIQUE
 * -------------------------------------------------------------------------
 * It is not needed to find the rows. It is there so that asking for a record
 * belonging to another agency returns nothing instead of returning its history
 * — and a history is the worst of the child readers to leak, because the trail
 * is not a list of ids. It names the people who acted, and `detail` carries the
 * before-and-after of every amendment: the figures, the dates and the partner
 * on each one. A document's lines leak one invoice; its audit trail leaks how
 * that invoice came to say what it says, and who changed it.
 *
 * Every caller today proves ownership first — the entry screen calls
 * `journalEntry(orgId, id)`, the settlement screen `getSettlement(orgId, id)`
 * and `DocumentDetail` `getDocument(orgId, docId)`, and all three give up when
 * the answer is null. That makes the call sites safe and left this FUNCTION
 * unsafe, which is the distinction that matters now that one database holds
 * several agencies' books and every one of those ids arrives from a URL. The
 * filter costs nothing (`audit_log.org_id` is on every row) and turns the
 * convention into an invariant, as it already is for `documentLines`,
 * `allocationsFor`, `paymentTaxes`, `taxChildren` and `settlementCharges`.
 */
export async function auditFor(orgId: string, model: string, recordId: string): Promise<AuditRow[]> {
  return await all<AuditRow>(
    `SELECT id, at, user_name, action, model, record_id, summary, detail
       FROM audit_log WHERE org_id = ? AND model = ? AND record_id = ? ORDER BY id`,
    orgId, model, recordId,
  );
}

export async function auditRecent(orgId: string, limit = 50): Promise<AuditRow[]> {
  return await all<AuditRow>(
    `SELECT id, at, user_name, action, model, record_id, summary, detail
       FROM audit_log WHERE org_id = ? ORDER BY id DESC LIMIT ?`,
    orgId, limit,
  );
}
