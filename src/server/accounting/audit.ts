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
export function audit(
  orgId: string,
  actor: Actor,
  action: string,
  model: string,
  recordId: string,
  summary?: string,
  detail?: unknown,
) {
  run(
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

export function auditFor(model: string, recordId: string): AuditRow[] {
  return all<AuditRow>(
    `SELECT id, at, user_name, action, model, record_id, summary, detail
       FROM audit_log WHERE model = ? AND record_id = ? ORDER BY id`,
    model, recordId,
  );
}

export function auditRecent(orgId: string, limit = 50): AuditRow[] {
  return all<AuditRow>(
    `SELECT id, at, user_name, action, model, record_id, summary, detail
       FROM audit_log WHERE org_id = ? ORDER BY id DESC LIMIT ?`,
    orgId, limit,
  );
}
