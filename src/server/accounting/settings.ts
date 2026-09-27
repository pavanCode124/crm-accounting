import 'server-only';
import { all, one, run } from '../db';

/**
 * Account and journal RESOLUTION.
 *
 * The engine never names an account. When a payment needs "the customer
 * advance account", it asks here, and here looks at org_settings — so an
 * agency that renumbers its chart, or keeps two advance accounts, changes a
 * configuration row instead of a constant in a posting routine.
 *
 * The keys are the contract. Anything the engine can need has one, and the
 * seed writes every one of them; a missing key is a loud error at posting time
 * rather than a silent posting to the wrong account, which is far harder to
 * find three months later.
 */

export type SettingKey =
  | 'account.receivable'
  | 'account.payable'
  | 'account.customer_advance'
  | 'account.supplier_advance'
  | 'account.customer_refund_payable'
  | 'account.input_tax'
  | 'account.output_tax'
  | 'account.tds_payable'
  | 'account.retained_earnings'
  | 'account.current_year'
  | 'account.fx_gain'
  | 'account.fx_loss'
  | 'account.bank_charges'
  | 'account.commission_expense'
  | 'account.commission_payable'
  | 'account.employee_advance'
  | 'account.rounding'
  | 'account.opening_balance'
  | 'journal.sale'
  | 'journal.sale_refund'
  | 'journal.purchase'
  | 'journal.purchase_refund'
  | 'journal.bank'
  | 'journal.cash'
  | 'journal.customer_payment'
  | 'journal.vendor_payment'
  | 'journal.general'
  | 'journal.expense'
  | 'journal.asset'
  | 'plan.trips'
  | 'plan.departments'
  | 'plan.branches'
  | 'plan.agents';

export function setSetting(orgId: string, key: SettingKey, value: string) {
  run(
    `INSERT INTO org_settings (org_id, key, value) VALUES (?,?,?)
       ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`,
    orgId, key, value,
  );
}

export function getSetting(orgId: string, key: SettingKey): string | null {
  return one<{ value: string }>(
    'SELECT value FROM org_settings WHERE org_id = ? AND key = ?', orgId, key,
  )?.value ?? null;
}

export function requireSetting(orgId: string, key: SettingKey): string {
  const v = getSetting(orgId, key);
  if (!v) {
    throw new Error(
      `Accounting setting "${key}" is not configured for this organisation. ` +
      'Set it under Configuration → Accounting Settings.',
    );
  }
  return v;
}

export function allSettings(orgId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of all<{ key: string; value: string }>(
    'SELECT key, value FROM org_settings WHERE org_id = ?', orgId,
  )) out[r.key] = r.value;
  return out;
}

/**
 * The receivable account for a partner: their own override, else the org
 * default. Agencies that keep B2B receivables separate from retail set the
 * override on the partner and nothing else changes.
 */
export function receivableAccount(orgId: string, partnerId: string): string {
  return one<{ receivable_account_id: string | null }>(
    'SELECT receivable_account_id FROM partners WHERE id = ? AND org_id = ?', partnerId, orgId,
  )?.receivable_account_id ?? requireSetting(orgId, 'account.receivable');
}

export function payableAccount(orgId: string, partnerId: string): string {
  return one<{ payable_account_id: string | null }>(
    'SELECT payable_account_id FROM partners WHERE id = ? AND org_id = ?', partnerId, orgId,
  )?.payable_account_id ?? requireSetting(orgId, 'account.payable');
}

export function accountByCode(orgId: string, code: string): string | null {
  return one<{ id: string }>(
    'SELECT id FROM accounts WHERE org_id = ? AND code = ?', orgId, code,
  )?.id ?? null;
}
