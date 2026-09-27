import 'server-only';
import { all, scalar } from '../db';

/**
 * THE PRIMARY BOOKS OF ACCOUNT.
 *
 * Day Book, Ledger Account, Cash Book and Bank Book — the four books a
 * chartered accountant asks for by name, and the four a home-made ledger
 * usually cannot produce because it only ever built the summary reports.
 *
 * WHY THESE ARE NOT JUST THE GENERAL LEDGER WITH A FILTER. They differ in
 * SHAPE, not in data:
 *
 *   - The General Ledger is a flat list of lines. It answers "show me every
 *     posting that matches these filters".
 *   - The Day Book is grouped by ENTRY, so each transaction reads as one
 *     complete double entry — debit legs, credit legs, narration — the way it
 *     was written, not shredded into independent rows.
 *   - A Ledger Account is grouped by ACCOUNT and carries `particulars`: the
 *     CONTRA account on the other side of the same entry. That column is the
 *     whole value of a ledger folio — "Sales A/c", "To Bank A/c" — and it does
 *     not exist on a journal line, it has to be derived from its siblings.
 *   - The Cash and Bank Books are a ledger account with the two columns renamed
 *     to Receipts and Payments, which is what they are.
 *
 * As everywhere else in this app: `journal_entry_lines` is the only source, and
 * drafts are excluded. A draft is a proposal, not a fact.
 */

export interface Period { from: string; to: string }

// ---------------------------------------------------------------------------
// Day Book / Journal Register
// ---------------------------------------------------------------------------

export interface BookLine {
  id: string; account_id: string; account_code: string; account_name: string;
  partner_name: string | null; label: string | null; debit: number; credit: number;
}

export interface DayBookEntry {
  id: string; entry_no: string | null; entry_date: string; reference: string | null;
  narration: string | null; state: string; journal_code: string; journal_name: string;
  journal_type: string; source_model: string | null; source_id: string | null;
  lines: BookLine[]; debit: number; credit: number;
}

/**
 * Every entry in the window, in date order, each with its full set of lines.
 *
 * Two queries and a join in memory rather than one query with a JOIN: a single
 * flat result would repeat the entry header once per line and still need
 * grouping in JS, and the second query is an indexed lookup on `entry_id`.
 */
export function dayBook(
  orgId: string,
  p: Period,
  opts: { journalId?: string; state?: string; limit?: number } = {},
): DayBookEntry[] {
  const clauses = ['e.org_id = ?', 'e.entry_date BETWEEN ? AND ?'];
  const params: Array<string | number> = [orgId, p.from, p.to];
  if (opts.journalId) { clauses.push('e.journal_id = ?'); params.push(opts.journalId); }
  // Default to posted only. The Day Book is the bound record of what happened;
  // a draft belongs on the Journal Entries screen until someone posts it.
  clauses.push(opts.state ? 'e.state = ?' : "e.state <> 'draft'");
  if (opts.state) params.push(opts.state);

  const entries = all<Omit<DayBookEntry, 'lines' | 'debit' | 'credit'>>(
    `SELECT e.id, e.entry_no, e.entry_date, e.reference, e.narration, e.state,
            j.code AS journal_code, j.name AS journal_name, j.type AS journal_type,
            e.source_model, e.source_id
       FROM journal_entries e JOIN journals j ON j.id = e.journal_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.entry_date, e.entry_no, e.id
      LIMIT ${opts.limit ?? 400}`,
    ...params,
  );
  if (entries.length === 0) return [];

  const ids = entries.map((e) => e.id);
  const lines = all<BookLine & { entry_id: string }>(
    `SELECT l.id, l.entry_id, l.account_id, a.code AS account_code, a.name AS account_name,
            p.name AS partner_name, l.label, l.debit, l.credit
       FROM journal_entry_lines l
       JOIN accounts a ON a.id = l.account_id
       LEFT JOIN partners p ON p.id = l.partner_id
      WHERE l.entry_id IN (${ids.map(() => '?').join(',')})
      ORDER BY l.debit DESC, l.id`,
    ...ids,
  );

  const byEntry = new Map<string, BookLine[]>();
  for (const l of lines) {
    const list = byEntry.get(l.entry_id) ?? [];
    list.push(l);
    byEntry.set(l.entry_id, list);
  }

  return entries.map((e) => {
    const own = byEntry.get(e.id) ?? [];
    return {
      ...e,
      lines: own,
      debit: own.reduce((s, l) => s + l.debit, 0),
      credit: own.reduce((s, l) => s + l.credit, 0),
    };
  });
}

// ---------------------------------------------------------------------------
// Ledger Account
// ---------------------------------------------------------------------------

export interface LedgerRow {
  id: string; entry_id: string; entry_no: string | null; entry_date: string;
  journal_code: string; label: string | null; partner_name: string | null;
  reference: string | null; source_model: string | null; source_id: string | null;
  debit: number; credit: number;
  /** The contra account(s) on the other side of the same entry. */
  particulars: string;
  /** Signed running balance, debit-positive. */
  running: number;
}

export interface LedgerAccountReport {
  account: { id: string; code: string; name: string; kind: string } | null;
  opening: number; closing: number;
  debit: number; credit: number;
  rows: LedgerRow[];
  truncated: boolean;
}

/**
 * One account's folio: opening balance, every movement with its contra account,
 * and the closing balance.
 *
 * THE `particulars` COLUMN. For each of this account's lines, the contra is
 * every line in the SAME entry that sits on the OPPOSITE side. On a simple two-
 * line entry that is one name. On a sales invoice with three tax lines it is
 * several, so they are joined — a ledger that silently showed only the first
 * would be quietly wrong on exactly the entries worth reading closely.
 */
export function ledgerAccount(
  orgId: string, accountId: string, p: Period, limit = 1000,
): LedgerAccountReport {
  const account = all<{ id: string; code: string; name: string; kind: string }>(
    'SELECT id, code, name, kind FROM accounts WHERE id = ? AND org_id = ?', accountId, orgId,
  )[0] ?? null;
  if (!account) {
    return { account: null, opening: 0, closing: 0, debit: 0, credit: 0, rows: [], truncated: false };
  }

  const opening = scalar(
    `SELECT COALESCE(SUM(debit - credit),0) FROM journal_entry_lines
      WHERE org_id = ? AND account_id = ? AND state='posted' AND entry_date < ?`,
    orgId, accountId, p.from,
  );

  const own = all<Omit<LedgerRow, 'particulars' | 'running'>>(
    `SELECT l.id, l.entry_id, e.entry_no, l.entry_date, j.code AS journal_code,
            l.label, pt.name AS partner_name, e.reference,
            e.source_model, e.source_id, l.debit, l.credit
       FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN journals j ON j.id = e.journal_id
       LEFT JOIN partners pt ON pt.id = l.partner_id
      WHERE l.org_id = ? AND l.account_id = ? AND l.state='posted'
        AND l.entry_date BETWEEN ? AND ?
      ORDER BY l.entry_date, e.entry_no, l.id
      LIMIT ${limit + 1}`,
    orgId, accountId, p.from, p.to,
  );
  const truncated = own.length > limit;
  const rows0 = truncated ? own.slice(0, limit) : own;

  // Every OTHER line of the entries we just pulled — the contra side.
  const contra = new Map<string, Array<{ account_name: string; debit: number; credit: number }>>();
  if (rows0.length) {
    const entryIds = [...new Set(rows0.map((r) => r.entry_id))];
    const siblings = all<{ entry_id: string; account_id: string; account_name: string; debit: number; credit: number }>(
      `SELECT l.entry_id, l.account_id, a.name AS account_name, l.debit, l.credit
         FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
        WHERE l.entry_id IN (${entryIds.map(() => '?').join(',')}) AND l.account_id <> ?`,
      ...entryIds, accountId,
    );
    for (const sib of siblings) {
      const list = contra.get(sib.entry_id) ?? [];
      list.push(sib);
      contra.set(sib.entry_id, list);
    }
  }

  let running = opening;
  const rows: LedgerRow[] = rows0.map((r) => {
    running += r.debit - r.credit;
    // Our line is a debit, so the contra worth naming is the credit side.
    const wantCredit = r.debit > 0;
    const sibs = contra.get(r.entry_id) ?? [];
    const picked = sibs.filter((sx) => (wantCredit ? sx.credit > 0 : sx.debit > 0));
    const names = [...new Set((picked.length ? picked : sibs).map((sx) => sx.account_name))];
    return {
      ...r,
      particulars: names.length ? names.join(', ') : '(no contra)',
      running,
    };
  });

  return {
    account,
    opening,
    closing: running,
    debit: rows.reduce((s, r) => s + r.debit, 0),
    credit: rows.reduce((s, r) => s + r.credit, 0),
    rows,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Cash Book and Bank Book
// ---------------------------------------------------------------------------

export interface CashBookAccount {
  bank_account_id: string; account_id: string; label: string;
  bank_name: string | null; account_no: string | null;
  opening: number; receipts: number; payments: number; closing: number;
}

/**
 * The cash/bank accounts this book covers, with their period figures.
 *
 * `is_cash` on `bank_accounts` is what separates the two books — the ledger
 * accounts behind them are both `asset_cash`, and an agency's petty cash tin
 * and its current account want separate books even though they are the same
 * kind of thing to the trial balance.
 */
export function cashBookAccounts(orgId: string, p: Period, isCash: boolean): CashBookAccount[] {
  return all<CashBookAccount>(
    `SELECT b.id AS bank_account_id, b.account_id,
            b.name AS label, b.bank_name, b.account_no,
            COALESCE((SELECT SUM(l.debit - l.credit) FROM journal_entry_lines l
                       WHERE l.account_id = b.account_id AND l.state='posted'
                         AND l.entry_date < ?), 0) AS opening,
            COALESCE((SELECT SUM(l.debit) FROM journal_entry_lines l
                       WHERE l.account_id = b.account_id AND l.state='posted'
                         AND l.entry_date BETWEEN ? AND ?), 0) AS receipts,
            COALESCE((SELECT SUM(l.credit) FROM journal_entry_lines l
                       WHERE l.account_id = b.account_id AND l.state='posted'
                         AND l.entry_date BETWEEN ? AND ?), 0) AS payments
       FROM bank_accounts b
      WHERE b.org_id = ? AND b.is_cash = ? AND b.active = 1
      ORDER BY b.name`,
    p.from, p.from, p.to, p.from, p.to, orgId, isCash ? 1 : 0,
  ).map((a) => ({ ...a, closing: a.opening + a.receipts - a.payments }));
}
