import 'server-only';
import { all, one, run, tx, id, nowIso } from '../db';
import { addMonths, endOfMonth, isoDate } from '@/lib/accounting';
import { postEntry, PostingError, type Actor } from './engine';
import { requireSetting } from './settings';
import { audit } from './audit';

/**
 * Fixed assets and deferrals (plan sections 33, 34, 35).
 *
 * Both are the same idea: one amount recognised a slice at a time. The schedule
 * is GENERATED AND STORED rather than computed on the fly, because the point of
 * a depreciation schedule is that it is agreed once and then followed — if it
 * were recomputed on every read, changing the useful life would silently
 * rewrite entries that have already been posted and filed.
 *
 * The last slice carries the rounding remainder. Twelve slices of ₹8,333.33
 * come to ₹99,999.96, and an asset that never fully depreciates is a balance
 * nobody can clear.
 */

export interface AssetInput {
  orgId: string; name: string;
  assetAccountId: string; depreciationAccountId: string; expenseAccountId: string;
  journalId?: string | null;
  purchaseDate: string; purchaseValue: number; salvageValue?: number;
  method?: 'straight_line' | 'declining'; lifeMonths: number; decliningBps?: number;
  analyticId?: string | null;
}

export function createAsset(input: AssetInput, actor: Actor = {}): string {
  return tx(() => {
    const assetId = id('ast');
    run(
      `INSERT INTO assets
         (id, org_id, name, asset_account_id, depreciation_account_id, expense_account_id,
          journal_id, purchase_date, purchase_value, salvage_value, method, life_months,
          declining_bps, state, analytic_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,
      assetId, input.orgId, input.name, input.assetAccountId, input.depreciationAccountId,
      input.expenseAccountId, input.journalId ?? null, input.purchaseDate, input.purchaseValue,
      input.salvageValue ?? 0, input.method ?? 'straight_line', input.lifeMonths,
      input.decliningBps ?? 0, input.analyticId ?? null, nowIso(),
    );
    generateSchedule(input.orgId, assetId);
    audit(input.orgId, actor, 'created', 'asset', assetId, input.name);
    return assetId;
  });
}

export function generateSchedule(orgId: string, assetId: string) {
  const a = one<{
    purchase_date: string; purchase_value: number; salvage_value: number;
    method: string; life_months: number; declining_bps: number;
  }>('SELECT * FROM assets WHERE id=? AND org_id=?', assetId, orgId);
  if (!a) throw new PostingError('Unknown asset.');

  run("DELETE FROM asset_lines WHERE asset_id=? AND state='pending'", assetId);
  const depreciable = a.purchase_value - a.salvage_value;
  if (depreciable <= 0 || a.life_months <= 0) return;

  const slices: number[] = [];
  if (a.method === 'declining' && a.declining_bps > 0) {
    // Written-down value: a fixed percentage of what is left each year, taken
    // monthly. The final slice still takes the remainder, so the schedule ends
    // at the salvage value instead of approaching it forever.
    let remaining = depreciable;
    for (let i = 0; i < a.life_months; i += 1) {
      const slice = Math.round((remaining * a.declining_bps) / 10000 / 12);
      slices.push(slice);
      remaining -= slice;
    }
  } else {
    const per = Math.floor(depreciable / a.life_months);
    for (let i = 0; i < a.life_months; i += 1) slices.push(per);
  }
  const allocated = slices.reduce((s, x) => s + x, 0);
  slices[slices.length - 1] += depreciable - allocated;

  let cumulative = 0;
  slices.forEach((amount, i) => {
    cumulative += amount;
    run(
      `INSERT INTO asset_lines (id, org_id, asset_id, seq, due_date, amount, cumulative, remaining, state)
       VALUES (?,?,?,?,?,?,?,?,'pending')`,
      id('asl'), orgId, assetId, i + 1,
      endOfMonth(addMonths(a.purchase_date, i)),
      amount, cumulative, a.purchase_value - cumulative,
    );
  });
}

export function confirmAsset(orgId: string, assetId: string, actor: Actor = {}) {
  run("UPDATE assets SET state='running' WHERE id=? AND org_id=?", assetId, orgId);
  audit(orgId, actor, 'confirmed', 'asset', assetId, 'Depreciation schedule confirmed');
}

/**
 * Post every due depreciation slice up to `upTo`.
 *
 *   Depreciation expense       Dr
 *        Accumulated depreciation   Cr
 *
 * Accumulated depreciation is a contra-asset, so the asset's own cost stays on
 * the books at what was paid — which is what an auditor asks to see.
 */
export function runDepreciation(orgId: string, upTo = isoDate(), actor: Actor = {}): number {
  return tx(() => {
    const due = all<{
      id: string; asset_id: string; due_date: string; amount: number; seq: number;
      name: string; expense_account_id: string; depreciation_account_id: string;
      journal_id: string | null; analytic_id: string | null;
    }>(
      `SELECT l.id, l.asset_id, l.due_date, l.amount, l.seq, a.name,
              a.expense_account_id, a.depreciation_account_id, a.journal_id, a.analytic_id
         FROM asset_lines l JOIN assets a ON a.id = l.asset_id
        WHERE l.org_id = ? AND l.state='pending' AND l.due_date <= ? AND a.state='running'
        ORDER BY l.due_date`, orgId, upTo,
    );

    let posted = 0;
    for (const l of due) {
      if (l.amount === 0) { run("UPDATE asset_lines SET state='posted' WHERE id=?", l.id); continue; }
      const label = `Depreciation ${l.seq} — ${l.name}`;
      const entryId = postEntry({
        orgId,
        journalId: l.journal_id ?? requireSetting(orgId, 'journal.general'),
        date: l.due_date,
        reference: l.name,
        narration: label,
        sourceModel: 'asset',
        sourceId: l.asset_id,
        lines: [
          { accountId: l.expense_account_id, debit: l.amount, label, analyticId: l.analytic_id },
          { accountId: l.depreciation_account_id, credit: l.amount, label },
        ],
      }, actor);
      run("UPDATE asset_lines SET state='posted', entry_id=? WHERE id=?", entryId, l.id);
      posted += 1;
    }
    if (posted) audit(orgId, actor, 'posted', 'depreciation', 'batch', `${posted} slice(s) up to ${upTo}`);
    return posted;
  });
}

export function listAssets(orgId: string) {
  return all<{
    id: string; name: string; purchase_date: string; purchase_value: number;
    salvage_value: number; method: string; life_months: number; state: string;
    depreciated: number; book_value: number;
  }>(
    `SELECT a.*, COALESCE((SELECT SUM(l.amount) FROM asset_lines l
                            WHERE l.asset_id = a.id AND l.state='posted'),0) AS depreciated
       FROM assets a WHERE a.org_id = ? ORDER BY a.purchase_date DESC`, orgId,
  ).map((a) => ({ ...a, book_value: a.purchase_value - a.depreciated }));
}

export function assetSchedule(assetId: string) {
  return all<{ id: string; seq: number; due_date: string; amount: number; cumulative: number; remaining: number; state: string; entry_id: string | null }>(
    'SELECT * FROM asset_lines WHERE asset_id=? ORDER BY seq', assetId,
  );
}

export function getAsset(orgId: string, assetId: string) {
  return one<{
    id: string; name: string; purchase_date: string; purchase_value: number;
    salvage_value: number; method: string; life_months: number; state: string;
    asset_account_id: string; depreciation_account_id: string; expense_account_id: string;
  }>('SELECT * FROM assets WHERE id=? AND org_id=?', assetId, orgId);
}

// ---------------------------------------------------------------------------
// Deferrals — prepaid expenses and deferred revenue
// ---------------------------------------------------------------------------

export function createDeferral(input: {
  orgId: string; name: string; kind: 'expense' | 'revenue';
  balanceAccountId: string; recognitionAccountId: string; journalId?: string | null;
  amount: number; dateFrom: string; months: number; analyticId?: string | null;
}, actor: Actor = {}): string {
  return tx(() => {
    const defId = id('def');
    run(
      `INSERT INTO deferrals
         (id, org_id, name, kind, balance_account_id, recognition_account_id, journal_id,
          amount, date_from, months, analytic_id, state, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'running',?)`,
      defId, input.orgId, input.name, input.kind, input.balanceAccountId,
      input.recognitionAccountId, input.journalId ?? null, input.amount,
      input.dateFrom, input.months, input.analyticId ?? null, nowIso(),
    );
    const per = Math.floor(input.amount / input.months);
    let allocated = 0;
    for (let i = 0; i < input.months; i += 1) {
      const amount = i === input.months - 1 ? input.amount - allocated : per;
      allocated += per;
      run(
        `INSERT INTO deferral_lines (id, org_id, deferral_id, seq, due_date, amount, state)
         VALUES (?,?,?,?,?,?,'pending')`,
        id('dfl'), input.orgId, defId, i + 1, endOfMonth(addMonths(input.dateFrom, i)), amount,
      );
    }
    audit(input.orgId, actor, 'created', 'deferral', defId, input.name);
    return defId;
  });
}

/**
 * Recognise every due slice.
 *
 *   expense kind:  Expense Dr / Prepaid Cr        (the cost lands in the month it belongs to)
 *   revenue kind:  Deferred revenue Dr / Revenue Cr
 */
export function runDeferrals(orgId: string, upTo = isoDate(), actor: Actor = {}): number {
  return tx(() => {
    const due = all<{
      id: string; deferral_id: string; due_date: string; amount: number; seq: number;
      name: string; kind: string; balance_account_id: string; recognition_account_id: string;
      journal_id: string | null; analytic_id: string | null;
    }>(
      `SELECT l.*, d.name, d.kind, d.balance_account_id, d.recognition_account_id,
              d.journal_id, d.analytic_id
         FROM deferral_lines l JOIN deferrals d ON d.id = l.deferral_id
        WHERE l.org_id=? AND l.state='pending' AND l.due_date <= ? AND d.state='running'
        ORDER BY l.due_date`, orgId, upTo,
    );

    let posted = 0;
    for (const l of due) {
      const label = `${l.name} — ${l.seq}`;
      const entryId = postEntry({
        orgId,
        journalId: l.journal_id ?? requireSetting(orgId, 'journal.general'),
        date: l.due_date,
        reference: l.name,
        narration: label,
        sourceModel: 'deferral',
        sourceId: l.deferral_id,
        lines: [
          { accountId: l.recognition_account_id, label, analyticId: l.analytic_id,
            ...(l.kind === 'expense' ? { debit: l.amount } : { credit: l.amount }) },
          { accountId: l.balance_account_id, label,
            ...(l.kind === 'expense' ? { credit: l.amount } : { debit: l.amount }) },
        ],
      }, actor);
      run("UPDATE deferral_lines SET state='posted', entry_id=? WHERE id=?", entryId, l.id);
      posted += 1;
    }
    return posted;
  });
}

export function listDeferrals(orgId: string) {
  return all<{
    id: string; name: string; kind: string; amount: number; date_from: string;
    months: number; state: string; recognised: number;
  }>(
    `SELECT d.*, COALESCE((SELECT SUM(l.amount) FROM deferral_lines l
                            WHERE l.deferral_id=d.id AND l.state='posted'),0) AS recognised
       FROM deferrals d WHERE d.org_id=? ORDER BY d.date_from DESC`, orgId,
  );
}
