import 'server-only';
import { all, one, scalar } from '../db';
import {
  ACCOUNT_KINDS, kindSign, isPl, ageingBucket, daysBetween, fiscalYearOf, isoDate,
  type AccountKind,
} from '@/lib/accounting';
import { profitForPeriod } from './engine';
import { getSetting } from './settings';

/**
 * Every financial report in the product.
 *
 * ALL OF THEM READ journal_entry_lines AND NOTHING ELSE. There is no reporting
 * table, no nightly rollup and no cached balance: the P&L, the Balance Sheet
 * and the trip margin are three different questions asked of the same rows,
 * which is the only way they can be guaranteed to agree (plan section 56 —
 * "reports use the same accounting source of truth as operational screens").
 *
 * Drafts are excluded everywhere. A draft entry is a proposal, not a fact.
 */

export interface Period { from: string; to: string }

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------

export interface TrialRow {
  account_id: string; code: string; name: string; kind: string;
  opening: number; debit: number; credit: number; closing: number;
}

export async function trialBalance(orgId: string, p: Period): Promise<{ rows: TrialRow[]; debit: number; credit: number; balanced: boolean }> {
  const rows = (await all<TrialRow>(
    `SELECT a.id AS account_id, a.code, a.name, a.kind,
            COALESCE((SELECT SUM(l.debit - l.credit) FROM journal_entry_lines l
                       WHERE l.account_id = a.id AND l.state='posted' AND l.entry_date < ?), 0) AS opening,
            COALESCE(SUM(CASE WHEN l2.entry_date BETWEEN ? AND ? THEN l2.debit END), 0) AS debit,
            COALESCE(SUM(CASE WHEN l2.entry_date BETWEEN ? AND ? THEN l2.credit END), 0) AS credit
       FROM accounts a
       LEFT JOIN journal_entry_lines l2 ON l2.account_id = a.id AND l2.state='posted'
      WHERE a.org_id = ?
      GROUP BY a.id
      ORDER BY a.code`,
    p.from, p.from, p.to, p.from, p.to, orgId,
  )).map((r) => ({ ...r, closing: r.opening + r.debit - r.credit }))
    .filter((r) => r.opening !== 0 || r.debit !== 0 || r.credit !== 0);

  const debit = rows.reduce((s, r) => s + r.debit, 0);
  const credit = rows.reduce((s, r) => s + r.credit, 0);
  return { rows, debit, credit, balanced: debit === credit };
}

// ---------------------------------------------------------------------------
// General ledger
// ---------------------------------------------------------------------------

export interface GlFilter extends Period {
  accountId?: string;
  journalId?: string;
  partnerId?: string;
  bookingId?: string;
  analyticId?: string;
  limit?: number;
}

export interface GlLine {
  id: string; entry_id: string; entry_no: string; entry_date: string;
  journal_code: string; account_id: string; account_code: string; account_name: string;
  partner_name: string | null; label: string | null; reference: string | null;
  debit: number; credit: number; source_model: string | null; source_id: string | null;
  running?: number;
}

export async function generalLedger(orgId: string, f: GlFilter): Promise<{ lines: GlLine[]; opening: number }> {
  const clauses = ["l.org_id = ?", "l.state = 'posted'", 'l.entry_date BETWEEN ? AND ?'];
  const params: Array<string | number> = [orgId, f.from, f.to];
  if (f.accountId) { clauses.push('l.account_id = ?'); params.push(f.accountId); }
  if (f.journalId) { clauses.push('e.journal_id = ?'); params.push(f.journalId); }
  if (f.partnerId) { clauses.push('l.partner_id = ?'); params.push(f.partnerId); }
  if (f.bookingId) { clauses.push('l.booking_id = ?'); params.push(f.bookingId); }
  if (f.analyticId) {
    clauses.push('EXISTS (SELECT 1 FROM analytic_distributions ad WHERE ad.line_id = l.id AND ad.analytic_id = ?)');
    params.push(f.analyticId);
  }

  const lines = await all<GlLine>(
    `SELECT l.id, l.entry_id, e.entry_no, l.entry_date, j.code AS journal_code,
            l.account_id, a.code AS account_code, a.name AS account_name,
            p.name AS partner_name, l.label, e.reference, l.debit, l.credit,
            e.source_model, e.source_id
       FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN journals j ON j.id = e.journal_id
       JOIN accounts a ON a.id = l.account_id
       LEFT JOIN partners p ON p.id = l.partner_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY l.entry_date, e.entry_no, l.id
      LIMIT ${f.limit ?? 1000}`,
    ...params,
  );

  // The opening balance is what makes a ledger extract readable: without it the
  // running column starts from an arbitrary zero and ties to nothing.
  const opening = f.accountId
    ? await scalar(
      `SELECT COALESCE(SUM(debit - credit),0) FROM journal_entry_lines
        WHERE org_id = ? AND account_id = ? AND state='posted' AND entry_date < ?`,
      orgId, f.accountId, f.from,
    )
    : 0;

  let running = opening;
  for (const l of lines) { running += l.debit - l.credit; l.running = running; }
  return { lines, opening };
}

// ---------------------------------------------------------------------------
// Profit & Loss
// ---------------------------------------------------------------------------

export interface PlSection {
  key: string; label: string; total: number;
  rows: Array<{ account_id: string; code: string; name: string; amount: number }>;
}

export interface PlReport {
  revenue: PlSection; costOfSales: PlSection; grossProfit: number;
  operating: PlSection; depreciation: PlSection; netProfit: number;
  comparison?: { grossProfit: number; netProfit: number; revenue: number };
}

async function plSection(orgId: string, p: Period, kinds: AccountKind[], key: string, label: string): Promise<PlSection> {
  const rows = (await all<{ account_id: string; code: string; name: string; kind: string; net: number }>(
    `SELECT a.id AS account_id, a.code, a.name, a.kind,
            COALESCE(SUM(l.debit - l.credit),0) AS net
       FROM accounts a
       JOIN journal_entry_lines l ON l.account_id = a.id AND l.state='posted'
            AND l.entry_date BETWEEN ? AND ?
      WHERE a.org_id = ? AND a.kind IN (${kinds.map(() => '?').join(',')})
      GROUP BY a.id HAVING COALESCE(SUM(l.debit - l.credit),0) <> 0 ORDER BY a.code`,
    p.from, p.to, orgId, ...kinds,
  )).map((r) => ({
    account_id: r.account_id, code: r.code, name: r.name,
    // Natural sign: revenue reads positive, expenses read positive.
    amount: r.net * kindSign(r.kind),
  }));
  return { key, label, rows, total: rows.reduce((s, r) => s + r.amount, 0) };
}

export async function profitAndLoss(orgId: string, p: Period, compare?: Period): Promise<PlReport> {
  const revenue = await plSection(orgId, p, ['income', 'income_other'], 'revenue', 'Revenue');
  const costOfSales = await plSection(orgId, p, ['expense_direct'], 'cos', 'Cost of Sales');
  const operating = await plSection(orgId, p, ['expense_operating'], 'opex', 'Operating Expenses');
  const depreciation = await plSection(orgId, p, ['expense_depreciation'], 'dep', 'Depreciation');
  const grossProfit = revenue.total - costOfSales.total;
  const netProfit = grossProfit - operating.total - depreciation.total;

  const comparison = compare ? {
    revenue: (await plSection(orgId, compare, ['income', 'income_other'], 'r', 'r')).total,
    grossProfit: (await plSection(orgId, compare, ['income', 'income_other'], 'r', 'r')).total
      - (await plSection(orgId, compare, ['expense_direct'], 'c', 'c')).total,
    netProfit: await profitForPeriod(orgId, compare.from, compare.to),
  } : undefined;

  return { revenue, costOfSales, grossProfit, operating, depreciation, netProfit, comparison };
}

// ---------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------

export interface BsSection {
  label: string; total: number;
  groups: Array<{ kind: string; label: string; total: number;
    rows: Array<{ account_id: string; code: string; name: string; amount: number }> }>;
}

export interface BsReport {
  assets: BsSection; liabilities: BsSection; equity: BsSection;
  currentYearProfit: number; balanced: boolean; difference: number; asOf: string;
}

async function bsSection(orgId: string, asOf: string, group: 'asset' | 'liability' | 'equity', label: string): Promise<BsSection> {
  const kinds = (Object.keys(ACCOUNT_KINDS) as AccountKind[]).filter((k) => ACCOUNT_KINDS[k].group === group);
  const rows = await all<{ account_id: string; code: string; name: string; kind: string; net: number }>(
    `SELECT a.id AS account_id, a.code, a.name, a.kind,
            COALESCE(SUM(l.debit - l.credit),0) AS net
       FROM accounts a
       JOIN journal_entry_lines l ON l.account_id = a.id AND l.state='posted' AND l.entry_date <= ?
      WHERE a.org_id = ? AND a.kind IN (${kinds.map(() => '?').join(',')})
      GROUP BY a.id HAVING COALESCE(SUM(l.debit - l.credit),0) <> 0 ORDER BY a.code`,
    asOf, orgId, ...kinds,
  );

  const groups = kinds.map((kind) => {
    const kr = rows.filter((r) => r.kind === kind)
      .map((r) => ({ account_id: r.account_id, code: r.code, name: r.name, amount: r.net * kindSign(kind) }));
    return { kind, label: ACCOUNT_KINDS[kind].label, rows: kr, total: kr.reduce((s, r) => s + r.amount, 0) };
  }).filter((g) => g.rows.length);

  return { label, groups, total: groups.reduce((s, g) => s + g.total, 0) };
}

/**
 * The Balance Sheet, with the bit home-made ledgers forget.
 *
 * Profit for the current, UNCLOSED year lives on income and expense accounts,
 * not on equity — so a balance sheet that only adds up the balance-sheet
 * accounts is out by exactly the year's profit, every time. It is added here as
 * an explicit equity line, which is both correct and legible: the reader can
 * see where it came from.
 */
export async function balanceSheet(orgId: string, asOf: string, fyStartMonth = 4): Promise<BsReport> {
  const assets = await bsSection(orgId, asOf, 'asset', 'Assets');
  const liabilities = await bsSection(orgId, asOf, 'liability', 'Liabilities');
  const equity = await bsSection(orgId, asOf, 'equity', 'Equity');
  const fy = fiscalYearOf(asOf, fyStartMonth);
  const currentYearProfit = await profitForPeriod(orgId, fy.from, asOf);

  const totalEquity = equity.total + currentYearProfit;
  const difference = assets.total - (liabilities.total + totalEquity);
  return {
    assets, liabilities,
    equity: { ...equity, total: totalEquity },
    currentYearProfit,
    balanced: difference === 0,
    difference,
    asOf,
  };
}

// ---------------------------------------------------------------------------
// Cash flow (direct method)
// ---------------------------------------------------------------------------

/**
 * Where the cash actually moved, classified by what sat on the OTHER side of
 * the entry.
 *
 * Direct method rather than indirect: an agency owner wants "₹6L came in from
 * customers, ₹4L went to hotels", not a reconciliation starting from net
 * profit. The classification is by the counterpart account's kind, which is why
 * `kind` had to be a closed set.
 */
export interface CashFlowReport {
  opening: number; closing: number; net: number;
  sections: Array<{ key: string; label: string; total: number;
    rows: Array<{ code: string; name: string; amount: number }> }>;
}

export async function cashFlow(orgId: string, p: Period): Promise<CashFlowReport> {
  const cashAccounts = (await all<{ id: string }>(
    "SELECT id FROM accounts WHERE org_id = ? AND kind = 'asset_cash'", orgId,
  )).map((r) => r.id);
  if (!cashAccounts.length) {
    return { opening: 0, closing: 0, net: 0, sections: [] };
  }
  const placeholders = cashAccounts.map(() => '?').join(',');

  const opening = await scalar(
    `SELECT COALESCE(SUM(debit - credit),0) FROM journal_entry_lines
      WHERE org_id = ? AND state='posted' AND entry_date < ? AND account_id IN (${placeholders})`,
    orgId, p.from, ...cashAccounts,
  );
  const net = await scalar(
    `SELECT COALESCE(SUM(debit - credit),0) FROM journal_entry_lines
      WHERE org_id = ? AND state='posted' AND entry_date BETWEEN ? AND ? AND account_id IN (${placeholders})`,
    orgId, p.from, p.to, ...cashAccounts,
  );

  // Counterpart lines: every non-cash line in an entry that touched cash.
  const rows = await all<{ code: string; name: string; kind: string; net: number }>(
    `SELECT a.code, a.name, a.kind, COALESCE(SUM(l.credit - l.debit),0) AS net
       FROM journal_entry_lines l
       JOIN accounts a ON a.id = l.account_id
      WHERE l.org_id = ? AND l.state='posted' AND l.entry_date BETWEEN ? AND ?
        AND a.id NOT IN (${placeholders})
        AND l.entry_id IN (
          SELECT DISTINCT entry_id FROM journal_entry_lines
           WHERE state='posted' AND entry_date BETWEEN ? AND ? AND account_id IN (${placeholders}))
      GROUP BY a.id HAVING COALESCE(SUM(l.credit - l.debit),0) <> 0 ORDER BY a.code`,
    orgId, p.from, p.to, ...cashAccounts, p.from, p.to, ...cashAccounts,
  );

  const bucket = (kind: string) => {
    if (kind === 'asset_fixed') return 'investing';
    if (kind === 'equity' || kind === 'equity_unaffected' || kind === 'liability_noncurrent') return 'financing';
    return 'operating';
  };
  const labels: Record<string, string> = {
    operating: 'Operating activities',
    investing: 'Investing activities',
    financing: 'Financing activities',
  };

  const sections = ['operating', 'investing', 'financing'].map((key) => {
    const rs = rows.filter((r) => bucket(r.kind) === key)
      .map((r) => ({ code: r.code, name: r.name, amount: r.net }));
    return { key, label: labels[key], rows: rs, total: rs.reduce((s, r) => s + r.amount, 0) };
  }).filter((s) => s.rows.length);

  return { opening, closing: opening + net, net, sections };
}

// ---------------------------------------------------------------------------
// Ageing
// ---------------------------------------------------------------------------

export interface AgeingRow {
  partner_id: string; partner_name: string; total: number;
  current: number; b1: number; b2: number; b3: number; b4: number;
}

export async function ageing(orgId: string, side: 'customer' | 'supplier', asOf = isoDate()): Promise<{ rows: AgeingRow[]; totals: AgeingRow }> {
  const types = side === 'customer' ? ['out_invoice', 'out_refund'] : ['in_invoice', 'in_refund'];
  const docs = await all<{ partner_id: string; partner_name: string; due_date: string; residual: number; doc_type: string }>(
    `SELECT d.partner_id, p.name AS partner_name, COALESCE(d.due_date, d.doc_date) AS due_date,
            d.residual, d.doc_type
       FROM documents d JOIN partners p ON p.id = d.partner_id
      WHERE d.org_id = ? AND d.state = 'posted' AND d.residual > 0
        AND d.doc_type IN (${types.map(() => '?').join(',')})`,
    orgId, ...types,
  );

  const map = new Map<string, AgeingRow>();
  for (const d of docs) {
    const row = map.get(d.partner_id) ?? {
      partner_id: d.partner_id, partner_name: d.partner_name,
      total: 0, current: 0, b1: 0, b2: 0, b3: 0, b4: 0,
    };
    // A credit note reduces what is owed, so it lands in the same bucket with
    // the opposite sign rather than as a separate "credits" column nobody nets.
    const sign = d.doc_type.endsWith('_refund') ? -1 : 1;
    const amount = d.residual * sign;
    const bucket = ageingBucket(daysBetween(d.due_date, asOf)) as keyof AgeingRow;
    (row[bucket] as number) += amount;
    row.total += amount;
    map.set(d.partner_id, row);
  }

  const rows = [...map.values()].filter((r) => r.total !== 0).sort((a, b) => b.total - a.total);
  const totals = rows.reduce<AgeingRow>((t, r) => ({
    partner_id: '', partner_name: 'Total',
    total: t.total + r.total, current: t.current + r.current,
    b1: t.b1 + r.b1, b2: t.b2 + r.b2, b3: t.b3 + r.b3, b4: t.b4 + r.b4,
  }), { partner_id: '', partner_name: 'Total', total: 0, current: 0, b1: 0, b2: 0, b3: 0, b4: 0 });

  return { rows, totals };
}

// ---------------------------------------------------------------------------
// Partner ledger & statement
// ---------------------------------------------------------------------------

export async function partnerLedger(orgId: string, partnerId: string, p: Period) {
  return await generalLedger(orgId, { ...p, partnerId });
}

export interface PartnerBalance {
  receivable: number; payable: number; overdue: number;
  invoiced: number; paid: number; advances: number; openDocs: number;
}

export async function partnerBalance(orgId: string, partnerId: string, asOf = isoDate()): Promise<PartnerBalance> {
  const receivable = await scalar(
    `SELECT COALESCE(SUM(CASE WHEN doc_type='out_invoice' THEN residual ELSE -residual END),0)
       FROM documents WHERE org_id=? AND partner_id=? AND state='posted'
         AND doc_type IN ('out_invoice','out_refund')`, orgId, partnerId,
  );
  const payable = await scalar(
    `SELECT COALESCE(SUM(CASE WHEN doc_type='in_invoice' THEN residual ELSE -residual END),0)
       FROM documents WHERE org_id=? AND partner_id=? AND state='posted'
         AND doc_type IN ('in_invoice','in_refund')`, orgId, partnerId,
  );
  const overdue = await scalar(
    `SELECT COALESCE(SUM(residual),0) FROM documents
      WHERE org_id=? AND partner_id=? AND state='posted' AND residual>0
        AND COALESCE(due_date, doc_date) < ?`, orgId, partnerId, asOf,
  );
  const invoiced = await scalar(
    `SELECT COALESCE(SUM(total),0) FROM documents WHERE org_id=? AND partner_id=?
       AND state='posted' AND doc_type IN ('out_invoice','in_invoice')`, orgId, partnerId,
  );
  const paid = await scalar(
    `SELECT COALESCE(SUM(amount),0) FROM payments WHERE org_id=? AND partner_id=? AND state<>'cancelled'`,
    orgId, partnerId,
  );
  const advances = await scalar(
    `SELECT COALESCE(SUM(unallocated),0) FROM payments
      WHERE org_id=? AND partner_id=? AND is_advance=1 AND state<>'cancelled'`, orgId, partnerId,
  );
  const openDocs = await scalar(
    `SELECT COUNT(*) FROM documents WHERE org_id=? AND partner_id=? AND state='posted' AND residual>0`,
    orgId, partnerId,
  );
  return { receivable, payable, overdue, invoiced, paid, advances, openDocs };
}

// ---------------------------------------------------------------------------
// Tax report
// ---------------------------------------------------------------------------

/**
 * Output tax, input tax, tax withheld and what is payable.
 *
 * Taken from the tax lines themselves, so it ties to the ledger rather than
 * being recomputed from invoice totals and quietly disagreeing with it.
 *
 * THREE sections, not two, because GST and TDS are two different liabilities
 * to two different departments on two different due dates, and netting one
 * against the other is simply wrong:
 *
 *   - GST: output tax less input credit, filed in GSTR-3B by the 20th.
 *   - TDS/TCS: deducted from a supplier and deposited by the 7th on a separate
 *     challan, with no offset against GST whatsoever.
 *
 * A withholding tax row carries `scope='purchase'` (it is chosen on a bill), so
 * it HAS to be split off by `tax_group` BEFORE the scope filter runs, or it
 * lands in input credit and silently reduces the GST cheque.
 */
export interface TaxLine {
  tax_id: string; name: string; tax_group: string; scope: string; rate_bps: number;
  /** Taxable value, signed the same way `amount` is. */
  base: number;
  amount: number;
  /** The part of the two figures above that came from a credit or debit note. */
  note_base: number;
  note_amount: number;
}

export async function taxReport(orgId: string, p: Period) {
  /*
   * THE TAXABLE VALUE IS SIGNED, BECAUSE THE TAX IS.
   *
   * `tax_base` is stored positive on every line; the direction lives in the
   * debit and credit columns, exactly as it does for the tax itself. Summing
   * the column raw therefore ADDED a credit note's taxable value to outward
   * turnover while its tax was correctly subtracted, and the two columns of
   * this report stopped supporting each other: a cancelled ₹1,36,500 trip read
   * as ₹3,56,000 of supplies carrying ₹4,350 of CGST, which is 1.2%, a rate
   * that does not exist. Nothing reconciles GSTR-1 against GSTR-3B from that.
   *
   * The CASE mirrors `credit - debit` so base and amount always move together.
   *
   * The note columns are the same two figures restricted to credit and debit
   * notes, so the report can show outward supplies gross, the notes that
   * reduced them, and the net — which is how GSTR-1 reports them (Table 9B)
   * and the only form in which a cancellation is VISIBLE rather than merely
   * netted away.
   */
  const signedBase = `CASE WHEN l.credit > 0 THEN l.tax_base ELSE -l.tax_base END`;
  const isNote = `d.doc_type IN ('out_refund','in_refund')`;
  const rows = await all<TaxLine>(
    `SELECT l.tax_id, t.name, t.tax_group, t.scope, t.rate_bps,
            COALESCE(SUM(${signedBase}),0) AS base,
            COALESCE(SUM(l.credit - l.debit),0) AS amount,
            COALESCE(SUM(CASE WHEN ${isNote} THEN ${signedBase} ELSE 0 END),0) AS note_base,
            COALESCE(SUM(CASE WHEN ${isNote} THEN l.credit - l.debit ELSE 0 END),0) AS note_amount
       FROM journal_entry_lines l
       JOIN taxes t ON t.id = l.tax_id
       LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.source_model = 'document'
       LEFT JOIN documents d ON d.id = e.source_id
      WHERE l.org_id = ? AND l.state='posted' AND l.entry_date BETWEEN ? AND ? AND l.tax_id IS NOT NULL
      GROUP BY l.tax_id, t.name, t.tax_group, t.scope, t.rate_bps ORDER BY t.scope, t.name`,
    orgId, p.from, p.to,
  );

  const isWithholding = (r: { tax_group: string }) => r.tax_group === 'tds' || r.tax_group === 'tcs';
  const gst = rows.filter((r) => !isWithholding(r));

  // Output tax is a credit (positive above); input tax is a debit (negative).
  const output = gst.filter((r) => r.scope === 'sale');
  // Flipping the whole row, not just the amount: base, tax and the note split
  // have to stay in the same frame or the purchase table contradicts itself.
  const input = gst.filter((r) => r.scope === 'purchase').map((r) => ({
    ...r,
    base: -r.base, amount: -r.amount, note_base: -r.note_base, note_amount: -r.note_amount,
  }));
  // Withheld tax is credited to TDS Payable, so it is already positive.
  const withheld = rows.filter(isWithholding);

  const sum = (rs: TaxLine[], f: (r: TaxLine) => number) => rs.reduce((s, r) => s + f(r), 0);
  const outputTotal = sum(output, (r) => r.amount);
  const inputTotal = sum(input, (r) => r.amount);
  const withheldTotal = sum(withheld, (r) => r.amount);

  /*
   * ONE TAXABLE VALUE PER SUPPLY, NOT ONE PER TAX COMPONENT.
   *
   * CGST and SGST are two postings of ONE supply and each line carries the
   * whole taxable value, so adding the two rows reports a ₹1,74,000 trip as
   * ₹3,48,000 of turnover — the figure GSTR-3B Table 3.1 asks for once, beside
   * separate CGST and SGST columns. Tax totals DO add across the pair (both are
   * payable); taxable value does not.
   *
   * `tax_children` is what says the two are halves of the same thing, so the
   * base is taken once per family. An IGST row is its own family and is
   * unaffected. The larger magnitude wins rather than the first seen, so a
   * family whose components somehow disagree reports the supply rather than
   * half of it — and credit notes, whose bases are negative, compare correctly.
   */
  const pairs = await all<{ parent_id: string; child_id: string }>(
    'SELECT parent_id, child_id FROM tax_children',
  );
  const parentOf = new Map(pairs.map((p) => [p.child_id, p.parent_id]));
  const familyTotal = (rs: TaxLine[], f: (r: TaxLine) => number) => {
    const byFamily = new Map<string, number>();
    for (const r of rs) {
      const family = parentOf.get(r.tax_id) ?? r.tax_id;
      const v = f(r);
      const prev = byFamily.get(family);
      if (prev === undefined || Math.abs(v) > Math.abs(prev)) byFamily.set(family, v);
    }
    return [...byFamily.values()].reduce((s, v) => s + v, 0);
  };

  // What is deducted in a period and what is still sitting undeposited are two
  // different numbers: a challan paid in April clears March's deduction. The
  // closing balance of TDS Payable is the one that answers "what do we owe?".
  const tdsAccount = await getSetting(orgId, 'account.tds_payable');
  const withheldUnpaid = tdsAccount
    ? await scalar(
      `SELECT COALESCE(SUM(credit - debit),0) FROM journal_entry_lines
        WHERE org_id=? AND state='posted' AND account_id=? AND entry_date<=?`,
      orgId, tdsAccount, p.to,
    )
    : 0;

  return {
    output, input, withheld,
    outputTotal, inputTotal, withheldTotal, withheldUnpaid,
    // Taxable value alongside the tax, and the credit/debit note split out of
    // each, so the screen can show gross → notes → net on both sides.
    outputBase: familyTotal(output, (r) => r.base),
    inputBase: familyTotal(input, (r) => r.base),
    outputNotes: sum(output, (r) => r.note_amount),
    outputNotesBase: familyTotal(output, (r) => r.note_base),
    inputNotes: sum(input, (r) => r.note_amount),
    inputNotesBase: familyTotal(input, (r) => r.note_base),
    // GST only. TDS is deposited separately and never nets against it.
    netPayable: outputTotal - inputTotal,
  };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardKpis {
  revenue: number; expenses: number; profit: number; margin: number;
  cash: number; receivable: number; payable: number;
  overdueReceivable: number; overduePayable: number;
  invoicesOpen: number; billsOpen: number;
  taxPayable: number;
}

export async function dashboard(orgId: string, p: Period, asOf = isoDate()): Promise<DashboardKpis> {
  const revenue = -await scalar(
    `SELECT COALESCE(SUM(l.debit - l.credit),0) FROM journal_entry_lines l
       JOIN accounts a ON a.id=l.account_id
      WHERE l.org_id=? AND l.state='posted' AND l.entry_date BETWEEN ? AND ?
        AND a.kind IN ('income','income_other')`, orgId, p.from, p.to,
  );
  const expenses = await scalar(
    `SELECT COALESCE(SUM(l.debit - l.credit),0) FROM journal_entry_lines l
       JOIN accounts a ON a.id=l.account_id
      WHERE l.org_id=? AND l.state='posted' AND l.entry_date BETWEEN ? AND ?
        AND a.kind IN ('expense_direct','expense_operating','expense_depreciation')`,
    orgId, p.from, p.to,
  );
  const cash = await scalar(
    `SELECT COALESCE(SUM(l.debit - l.credit),0) FROM journal_entry_lines l
       JOIN accounts a ON a.id=l.account_id
      WHERE l.org_id=? AND l.state='posted' AND l.entry_date <= ? AND a.kind='asset_cash'`,
    orgId, asOf,
  );
  const receivable = await scalar(
    `SELECT COALESCE(SUM(CASE WHEN doc_type='out_invoice' THEN residual ELSE -residual END),0)
       FROM documents WHERE org_id=? AND state='posted' AND doc_type IN ('out_invoice','out_refund')`, orgId,
  );
  const payable = await scalar(
    `SELECT COALESCE(SUM(CASE WHEN doc_type='in_invoice' THEN residual ELSE -residual END),0)
       FROM documents WHERE org_id=? AND state='posted' AND doc_type IN ('in_invoice','in_refund')`, orgId,
  );
  const overdueReceivable = await scalar(
    `SELECT COALESCE(SUM(residual),0) FROM documents WHERE org_id=? AND state='posted'
       AND doc_type='out_invoice' AND residual>0 AND COALESCE(due_date,doc_date) < ?`, orgId, asOf,
  );
  const overduePayable = await scalar(
    `SELECT COALESCE(SUM(residual),0) FROM documents WHERE org_id=? AND state='posted'
       AND doc_type='in_invoice' AND residual>0 AND COALESCE(due_date,doc_date) < ?`, orgId, asOf,
  );
  const invoicesOpen = await scalar(
    `SELECT COUNT(*) FROM documents WHERE org_id=? AND state='posted' AND doc_type='out_invoice' AND residual>0`, orgId,
  );
  const billsOpen = await scalar(
    `SELECT COUNT(*) FROM documents WHERE org_id=? AND state='posted' AND doc_type='in_invoice' AND residual>0`, orgId,
  );
  const taxPayable = -await scalar(
    `SELECT COALESCE(SUM(l.debit - l.credit),0) FROM journal_entry_lines l
       JOIN accounts a ON a.id=l.account_id
      WHERE l.org_id=? AND l.state='posted' AND l.entry_date<=? AND a.kind='liability_tax'`,
    orgId, asOf,
  );

  const profit = revenue - expenses;
  return {
    revenue, expenses, profit,
    margin: revenue === 0 ? 0 : (profit / revenue) * 100,
    cash, receivable, payable, overdueReceivable, overduePayable,
    invoicesOpen, billsOpen, taxPayable,
  };
}

/** Monthly revenue / expense / profit series for the dashboard chart. */
export async function monthlySeries(orgId: string, p: Period) {
  return (await all<{ month: string; revenue: number; expense: number }>(
    `SELECT substr(l.entry_date,1,7) AS month,
            COALESCE(SUM(CASE WHEN a.kind IN ('income','income_other') THEN l.credit - l.debit END),0) AS revenue,
            COALESCE(SUM(CASE WHEN a.kind IN ('expense_direct','expense_operating','expense_depreciation')
                              THEN l.debit - l.credit END),0) AS expense
       FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.org_id=? AND l.state='posted' AND l.entry_date BETWEEN ? AND ?
      GROUP BY month ORDER BY month`,
    orgId, p.from, p.to,
  )).map((r) => ({ ...r, profit: r.revenue - r.expense }));
}

/** "Where the money went" — the expense split the CRM's Finances tab shows. */
export async function expenseBreakdown(orgId: string, p: Period) {
  return await all<{ code: string; name: string; amount: number }>(
    `SELECT a.code, a.name, COALESCE(SUM(l.debit - l.credit),0) AS amount
       FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.org_id=? AND l.state='posted' AND l.entry_date BETWEEN ? AND ?
        AND a.kind IN ('expense_direct','expense_operating','expense_depreciation')
      GROUP BY a.id HAVING COALESCE(SUM(l.debit - l.credit),0) <> 0 ORDER BY amount DESC`,
    orgId, p.from, p.to,
  );
}

export async function accountsWithBalances(orgId: string, asOf = isoDate()) {
  return (await all<{
    id: string; code: string; name: string; kind: string; reconcilable: number;
    active: number; default_hsn_code: string | null; balance: number;
  }>(
    `SELECT a.id, a.code, a.name, a.kind, a.reconcilable, a.active, a.default_hsn_code,
            COALESCE((SELECT SUM(l.debit - l.credit) FROM journal_entry_lines l
                       WHERE l.account_id = a.id AND l.state='posted' AND l.entry_date <= ?), 0) AS balance
       FROM accounts a WHERE a.org_id = ? ORDER BY a.code`,
    asOf, orgId,
  )).map((a) => ({ ...a, natural: a.balance * kindSign(a.kind), isPl: isPl(a.kind) }));
}

export async function journalEntry(orgId: string, entryId: string) {
  const entry = await one<{
    id: string; entry_no: string; entry_date: string; reference: string | null;
    narration: string | null; state: string; journal_id: string; journal_name: string;
    journal_code: string; source_model: string | null; source_id: string | null;
    created_at: string; posted_at: string | null; reversal_of: string | null;
  }>(
    `SELECT e.*, j.name AS journal_name, j.code AS journal_code
       FROM journal_entries e JOIN journals j ON j.id = e.journal_id
      WHERE e.id = ? AND e.org_id = ?`, entryId, orgId,
  );
  if (!entry) return null;
  const lines = await all<{
    id: string; account_code: string; account_name: string; account_id: string;
    partner_name: string | null; label: string | null; debit: number; credit: number;
    analytic_names: string | null;
  }>(
    `SELECT l.id, l.account_id, a.code AS account_code, a.name AS account_name,
            p.name AS partner_name, l.label, l.debit, l.credit,
            (SELECT string_agg(an.name, ', ') FROM analytic_distributions ad
               JOIN analytic_accounts an ON an.id = ad.analytic_id WHERE ad.line_id = l.id) AS analytic_names
       FROM journal_entry_lines l
       JOIN accounts a ON a.id = l.account_id
       LEFT JOIN partners p ON p.id = l.partner_id
      WHERE l.entry_id = ? ORDER BY l.debit DESC, l.id`, entryId,
  );
  return { entry, lines };
}
