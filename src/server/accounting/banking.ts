import 'server-only';
import { all, one, run, scalar, tx, id, nowIso } from '../db';
import { postEntry, PostingError, type Actor } from './engine';
import { createPayment } from './payments';
import { requireSetting } from './settings';
import { audit } from './audit';
import { daysBetween } from '@/lib/accounting';

/**
 * Banking — accounts, statement import, reconciliation and transfers
 * (plan sections 17–19).
 *
 * A bank transaction is a line off the STATEMENT. It is not a journal entry and
 * must not be one until somebody says what it was: importing a statement
 * changes no balance at all. Reconciling is what posts, and it posts through
 * the payment service, so a matched receipt behaves exactly like one keyed by
 * hand — same entry shape, same allocation, same audit trail.
 */

export interface BankAccountRow {
  id: string; name: string; bank_name: string | null; account_no: string | null;
  ifsc: string | null; currency: string; is_cash: number; account_id: string;
  journal_id: string | null; active: number; balance?: number; unreconciled?: number;
}

export function listBankAccounts(orgId: string): BankAccountRow[] {
  return all<BankAccountRow>(
    `SELECT ba.*,
            COALESCE((SELECT SUM(l.debit - l.credit) FROM journal_entry_lines l
                       WHERE l.account_id = ba.account_id AND l.state='posted'),0) AS balance,
            COALESCE((SELECT COUNT(*) FROM bank_transactions bt
                       WHERE bt.bank_account_id = ba.id AND bt.state='unreconciled'),0) AS unreconciled
       FROM bank_accounts ba WHERE ba.org_id = ? AND ba.active = 1
      ORDER BY ba.is_cash, ba.name`, orgId,
  );
}

export function getBankAccount(orgId: string, bankAccountId: string): BankAccountRow | null {
  return one<BankAccountRow>(
    `SELECT ba.*, COALESCE((SELECT SUM(l.debit - l.credit) FROM journal_entry_lines l
                             WHERE l.account_id = ba.account_id AND l.state='posted'),0) AS balance
       FROM bank_accounts ba WHERE ba.id = ? AND ba.org_id = ?`, bankAccountId, orgId,
  );
}

export function listBankTransactions(orgId: string, opts: {
  bankAccountId?: string; state?: string; limit?: number;
} = {}) {
  const clauses = ['bt.org_id = ?'];
  const params: Array<string | number> = [orgId];
  if (opts.bankAccountId) { clauses.push('bt.bank_account_id = ?'); params.push(opts.bankAccountId); }
  if (opts.state) { clauses.push('bt.state = ?'); params.push(opts.state); }
  return all<{
    id: string; txn_date: string; description: string | null; reference: string | null;
    amount: number; balance: number | null; state: string; bank_account_id: string;
    bank_name: string; matched_payment_id: string | null; partner_id: string | null;
  }>(
    `SELECT bt.*, ba.name AS bank_name FROM bank_transactions bt
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY bt.txn_date DESC, bt.id DESC LIMIT ${opts.limit ?? 300}`,
    ...params,
  );
}

// ---------------------------------------------------------------------------
// Statement import
// ---------------------------------------------------------------------------

export interface ImportRow {
  date: string;
  description: string;
  reference?: string;
  /** Signed minor units: credit on the statement positive, debit negative. */
  amount: number;
  balance?: number;
}

/**
 * Import statement lines.
 *
 * Duplicate-safe: a line with the same account, date, amount and reference as
 * one already imported is skipped. People re-upload overlapping statements all
 * the time — a bank exports "last 30 days" twice — and a duplicated receipt
 * that gets reconciled twice is a real, hard-to-unpick error.
 */
export function importStatement(
  orgId: string,
  bankAccountId: string,
  rows: ImportRow[],
  actor: Actor = {},
): { imported: number; skipped: number; batch: string } {
  return tx(() => {
    const batch = id('imp');
    let imported = 0;
    let skipped = 0;
    for (const r of rows) {
      const dupe = scalar(
        `SELECT COUNT(*) FROM bank_transactions
          WHERE org_id=? AND bank_account_id=? AND txn_date=? AND amount=?
            AND COALESCE(reference,'') = COALESCE(?,'')`,
        orgId, bankAccountId, r.date, r.amount, r.reference ?? null,
      );
      if (dupe > 0) { skipped += 1; continue; }
      run(
        `INSERT INTO bank_transactions
           (id, org_id, bank_account_id, txn_date, description, reference, amount, balance,
            state, import_batch, created_at)
         VALUES (?,?,?,?,?,?,?,?,'unreconciled',?,?)`,
        id('bt'), orgId, bankAccountId, r.date, r.description, r.reference ?? null,
        r.amount, r.balance ?? null, batch, nowIso(),
      );
      imported += 1;
    }
    audit(orgId, actor, 'imported', 'bank_statement', bankAccountId,
      `${imported} line(s) imported, ${skipped} duplicate(s) skipped`);
    return { imported, skipped, batch };
  });
}

/**
 * Parse a bank CSV.
 *
 * Indian bank exports are not consistent, so the column names are matched
 * loosely and both shapes are handled: one signed Amount column, or the
 * separate Debit/Credit pair most Indian banks produce. Dates arrive as
 * dd/mm/yyyy far more often than ISO, and dd/mm is assumed because a bank
 * statement in this market is not American.
 */
export function parseStatementCsv(text: string): { rows: ImportRow[]; errors: string[] } {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], errors: ['The file has no data rows.'] };

  const split = (line: string) => {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (c === '"') { quoted = !quoted; continue; }
      if (c === ',' && !quoted) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };

  const header = split(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const find = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const iDate = find('date', 'txndate', 'valuedate');
  const iDesc = find('description', 'narration', 'particulars', 'remarks', 'details');
  const iRef = find('reference', 'chequeno', 'utr', 'refno');
  const iAmount = find('amount');
  const iDebit = find('withdrawal', 'debit');
  const iCredit = find('deposit', 'credit');
  const iBalance = find('balance');

  if (iDate < 0) return { rows: [], errors: ['No date column found. Expected a column named Date.'] };
  if (iAmount < 0 && iDebit < 0 && iCredit < 0) {
    return { rows: [], errors: ['No amount column found. Expected Amount, or Debit and Credit.'] };
  }

  const num = (s: string | undefined) => {
    if (!s) return 0;
    const cleaned = s.replace(/[₹,\s]/g, '');
    const n = parseFloat(cleaned);
    return isFinite(n) ? Math.round(n * 100) : 0;
  };

  const toIso = (s: string): string | null => {
    const t = s.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
    const m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
    if (m) {
      const [, d, mo, y] = m;
      const year = y.length === 2 ? `20${y}` : y;
      return `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    const m2 = t.match(/^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{2,4})/);
    if (m2) {
      const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      const mi = months.indexOf(m2[2].toLowerCase());
      if (mi >= 0) {
        const year = m2[3].length === 2 ? `20${m2[3]}` : m2[3];
        return `${year}-${String(mi + 1).padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
      }
    }
    return null;
  };

  const rows: ImportRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = split(lines[i]);
    const date = toIso(cells[iDate] ?? '');
    if (!date) { errors.push(`Row ${i + 1}: could not read the date "${cells[iDate] ?? ''}".`); continue; }
    const amount = iAmount >= 0 && cells[iAmount]
      ? num(cells[iAmount])
      : num(cells[iCredit]) - num(cells[iDebit]);
    if (amount === 0) { errors.push(`Row ${i + 1}: amount is zero, skipped.`); continue; }
    rows.push({
      date,
      description: (iDesc >= 0 ? cells[iDesc] : '') || 'Bank transaction',
      reference: iRef >= 0 ? cells[iRef] : undefined,
      amount,
      balance: iBalance >= 0 ? num(cells[iBalance]) : undefined,
    });
  }
  return { rows, errors };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface MatchSuggestion {
  kind: 'payment' | 'document';
  id: string;
  label: string;
  partnerId: string | null;
  partnerName: string | null;
  date: string;
  amount: number;
  /** 0–100. Amount agreement dominates; date proximity and name break ties. */
  score: number;
  reason: string;
}

/**
 * Suggest what a statement line is.
 *
 * Deliberately conservative. Every suggestion is CONFIRMED by a person before
 * anything posts (plan section 18), so the job here is to put the right answer
 * at the top of a short list, not to auto-post. An exact amount within a few
 * days, with the partner's name in the narration, is the case worth ranking
 * first — and it is most of the volume in a travel agency, where customers pay
 * round numbers by UPI with their name attached.
 */
export function suggestMatches(orgId: string, txnId: string, limit = 6): MatchSuggestion[] {
  const txn = one<{ id: string; amount: number; txn_date: string; description: string | null; reference: string | null }>(
    'SELECT id, amount, txn_date, description, reference FROM bank_transactions WHERE id = ? AND org_id = ?',
    txnId, orgId,
  );
  if (!txn) return [];
  const inbound = txn.amount > 0;
  const magnitude = Math.abs(txn.amount);
  const haystack = `${txn.description ?? ''} ${txn.reference ?? ''}`.toLowerCase();

  const out: MatchSuggestion[] = [];

  // 1. A payment already keyed in but not yet tied to the statement.
  for (const p of all<{ id: string; number: string; amount: number; pay_date: string; partner_id: string; partner_name: string; reference: string | null }>(
    `SELECT p.id, p.number, p.amount, p.pay_date, p.partner_id, pt.name AS partner_name, p.reference
       FROM payments p LEFT JOIN partners pt ON pt.id = p.partner_id
      WHERE p.org_id = ? AND p.direction = ? AND p.state IN ('posted','reconciled')
        AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.matched_payment_id = p.id)`,
    orgId, inbound ? 'inbound' : 'outbound',
  )) {
    if (p.amount !== magnitude) continue;
    const days = Math.abs(daysBetween(p.pay_date, txn.txn_date));
    if (days > 20) continue;
    out.push({
      kind: 'payment', id: p.id, label: p.number,
      partnerId: p.partner_id, partnerName: p.partner_name,
      date: p.pay_date, amount: p.amount,
      score: 90 - Math.min(days * 2, 20)
        + (p.reference && haystack.includes(p.reference.toLowerCase()) ? 10 : 0),
      reason: `Recorded payment, same amount${days ? `, ${days} day(s) apart` : ', same day'}`,
    });
  }

  // 2. An open invoice or bill the money most likely settles.
  const types = inbound ? ['out_invoice'] : ['in_invoice'];
  for (const d of all<{ id: string; number: string; residual: number; doc_date: string; partner_id: string; partner_name: string }>(
    `SELECT d.id, d.number, d.residual, d.doc_date, d.partner_id, p.name AS partner_name
       FROM documents d JOIN partners p ON p.id = d.partner_id
      WHERE d.org_id = ? AND d.state='posted' AND d.residual > 0
        AND d.doc_type IN (${types.map(() => '?').join(',')})`,
    orgId, ...types,
  )) {
    const exact = d.residual === magnitude;
    const partial = magnitude < d.residual;
    if (!exact && !partial) continue;
    const named = d.partner_name && haystack.includes(d.partner_name.split(' ')[0].toLowerCase());
    const numbered = d.number && haystack.includes(d.number.toLowerCase());
    let score = exact ? 70 : 35;
    if (named) score += 15;
    if (numbered) score += 20;
    if (score < 45) continue;
    out.push({
      kind: 'document', id: d.id, label: d.number,
      partnerId: d.partner_id, partnerName: d.partner_name,
      date: d.doc_date, amount: d.residual,
      score: Math.min(score, 99),
      reason: [
        exact ? 'Balance matches exactly' : 'Part payment of an open balance',
        numbered ? 'invoice number in the narration' : named ? 'name in the narration' : '',
      ].filter(Boolean).join(' · '),
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Tie a statement line to a payment that was already recorded. */
export function matchToPayment(orgId: string, txnId: string, paymentId: string, actor: Actor = {}) {
  return tx(() => {
    const txn = one<{ amount: number }>('SELECT amount FROM bank_transactions WHERE id=? AND org_id=?', txnId, orgId);
    const pay = one<{ amount: number; number: string }>('SELECT amount, number FROM payments WHERE id=? AND org_id=?', paymentId, orgId);
    if (!txn || !pay) throw new PostingError('Unknown transaction or payment.');
    if (Math.abs(txn.amount) !== pay.amount) {
      throw new PostingError('The statement line and the payment are different amounts.');
    }
    run(`UPDATE bank_transactions SET state='reconciled', matched_payment_id=? WHERE id=?`, paymentId, txnId);
    audit(orgId, actor, 'reconciled', 'bank_transaction', txnId, `Matched to ${pay.number}`);
  });
}

/**
 * Create the payment a statement line represents, and reconcile in one step.
 * This is the common path: the money arrived and nobody had keyed it yet.
 */
export function reconcileAsPayment(orgId: string, txnId: string, opts: {
  partnerId: string; documentId?: string | null; isAdvance?: boolean; bookingId?: string | null;
}, actor: Actor = {}) {
  return tx(() => {
    const txn = one<{ id: string; amount: number; txn_date: string; description: string | null; reference: string | null; bank_account_id: string }>(
      'SELECT * FROM bank_transactions WHERE id=? AND org_id=?', txnId, orgId,
    );
    if (!txn) throw new PostingError('Unknown transaction.');
    const bank = one<{ journal_id: string | null }>(
      'SELECT journal_id FROM bank_accounts WHERE id=?', txn.bank_account_id,
    );
    if (!bank?.journal_id) throw new PostingError('This bank account has no journal configured.');

    const inbound = txn.amount > 0;
    const paymentId = createPayment({
      orgId,
      direction: inbound ? 'inbound' : 'outbound',
      side: inbound ? 'customer' : 'supplier',
      partnerId: opts.partnerId,
      journalId: bank.journal_id,
      bankAccountId: txn.bank_account_id,
      bookingId: opts.bookingId ?? null,
      payDate: txn.txn_date,
      amount: Math.abs(txn.amount),
      method: 'bank',
      reference: txn.reference ?? txn.description,
      isAdvance: opts.isAdvance ?? false,
      allocations: opts.documentId
        ? [{ documentId: opts.documentId, amount: Math.abs(txn.amount) }]
        : [],
    }, actor);

    run(`UPDATE bank_transactions SET state='reconciled', matched_payment_id=?, partner_id=? WHERE id=?`,
      paymentId, opts.partnerId, txnId);
    audit(orgId, actor, 'reconciled', 'bank_transaction', txnId, 'Payment created from statement line');
    return paymentId;
  });
}

/**
 * Post a statement line straight to an account — bank charges, interest, a
 * transfer. No partner, no document, just the two sides of the entry.
 */
export function reconcileToAccount(orgId: string, txnId: string, accountId: string, label: string, actor: Actor = {}) {
  return tx(() => {
    const txn = one<{ amount: number; txn_date: string; description: string | null; bank_account_id: string }>(
      'SELECT * FROM bank_transactions WHERE id=? AND org_id=?', txnId, orgId,
    );
    if (!txn) throw new PostingError('Unknown transaction.');
    const bank = one<{ account_id: string; journal_id: string | null }>(
      'SELECT account_id, journal_id FROM bank_accounts WHERE id=?', txn.bank_account_id,
    );
    if (!bank?.journal_id) throw new PostingError('This bank account has no journal configured.');

    const amount = Math.abs(txn.amount);
    const inbound = txn.amount > 0;
    const entryId = postEntry({
      orgId,
      journalId: bank.journal_id,
      date: txn.txn_date,
      reference: txn.description,
      narration: label,
      sourceModel: 'bank_transaction',
      sourceId: txnId,
      lines: inbound
        ? [
          { accountId: bank.account_id, debit: amount, label },
          { accountId, credit: amount, label },
        ]
        : [
          { accountId, debit: amount, label },
          { accountId: bank.account_id, credit: amount, label },
        ],
    }, actor);

    run(`UPDATE bank_transactions SET state='reconciled', entry_id=? WHERE id=?`, entryId, txnId);
    audit(orgId, actor, 'reconciled', 'bank_transaction', txnId, label);
    return entryId;
  });
}

/** Money between the agency's own accounts — bank to cash, bank to bank. */
export function transfer(orgId: string, opts: {
  fromBankAccountId: string; toBankAccountId: string; date: string; amount: number; note?: string;
}, actor: Actor = {}) {
  return tx(() => {
    if (opts.fromBankAccountId === opts.toBankAccountId) {
      throw new PostingError('Choose two different accounts.');
    }
    const from = getBankAccount(orgId, opts.fromBankAccountId);
    const to = getBankAccount(orgId, opts.toBankAccountId);
    if (!from || !to) throw new PostingError('Unknown bank account.');
    const label = opts.note ?? `Transfer ${from.name} → ${to.name}`;
    return postEntry({
      orgId,
      journalId: from.journal_id ?? requireSetting(orgId, 'journal.bank'),
      date: opts.date,
      reference: 'Internal transfer',
      narration: label,
      sourceModel: 'transfer',
      lines: [
        { accountId: to.account_id, debit: opts.amount, label },
        { accountId: from.account_id, credit: opts.amount, label },
      ],
    }, actor);
  });
}
