import 'server-only';
import { all, one, run, scalar, tx, id, nowIso, nextNumber } from '../db';
import { isPl, kindSign } from '@/lib/accounting';
import { audit } from './audit';

/**
 * THE POSTING ENGINE.
 *
 * Every balanced journal entry in this system is written by `postEntry` and by
 * nothing else. Invoices, bills, payments, expenses, depreciation, opening
 * balances and manual entries all funnel through it, which is what makes the
 * guarantees in plan section 56 checkable rather than aspirational:
 *
 *   - debits equal credits, always, enforced here and not by the caller
 *   - no line without an account that exists in THIS org
 *   - nothing posted into a locked or closed period
 *   - nothing posted twice: an entry already posted is refused
 *   - every entry carries its source document, both directions (Rule 3)
 *   - posted entries are never mutated or deleted, only reversed (section 44)
 *
 * Screens do not compute balances and do not touch journal_entry_lines. Plan
 * section 49, Rule 1: the UI must not implement accounting rules.
 */

export interface PostingLine {
  accountId: string;
  /** Minor units. Exactly one of debit/credit is non-zero; the other is 0. */
  debit?: number;
  credit?: number;
  partnerId?: string | null;
  label?: string | null;
  bookingId?: string | null;
  taxId?: string | null;
  /** On a tax line, the taxable amount it was computed from. */
  taxBase?: number;
  /** Foreign-currency face value of this line, for the audit trail. */
  currency?: string | null;
  amountCurrency?: number;
  rateE6?: number | null;
  /**
   * Analytic tagging. A bare id means 100%; the array form splits one GL line
   * across trips or departments in basis points that must total 10000.
   */
  analyticId?: string | null;
  analytic?: Array<{ analyticId: string; bps: number }>;
}

export interface PostingInput {
  orgId: string;
  journalId: string;
  date: string;
  reference?: string | null;
  narration?: string | null;
  sourceModel?: string | null;
  sourceId?: string | null;
  currency?: string;
  lines: PostingLine[];
}

export interface Actor {
  id?: string;
  name?: string;
  role?: string;
}

export class PostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostingError';
  }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Refuse to write into a period that has been locked or closed.
 *
 * A date with NO period defined is allowed: an agency that has not set up next
 * year's periods yet should still be able to raise an invoice. Locking is an
 * explicit act, so the absence of a period cannot mean "locked".
 */
export async function assertPeriodOpen(orgId: string, date: string) {
  const period = await one<{ name: string; state: string }>(
    `SELECT name, state FROM accounting_periods
      WHERE org_id = ? AND date_from <= ? AND date_to >= ?`,
    orgId, date, date,
  );
  if (period && period.state !== 'open') {
    throw new PostingError(
      `${period.name} is ${period.state}. Reopen the period, or post to a date in an open one.`,
    );
  }
}

function assertBalanced(lines: PostingLine[]) {
  if (lines.length < 2) throw new PostingError('A journal entry needs at least two lines.');
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    const d = Math.round(l.debit ?? 0);
    const c = Math.round(l.credit ?? 0);
    if (d < 0 || c < 0) throw new PostingError('Debit and credit must be positive; use the other column.');
    if (d > 0 && c > 0) throw new PostingError('A line carries a debit or a credit, never both.');
    debit += d;
    credit += c;
  }
  if (debit === 0 && credit === 0) throw new PostingError('An entry of zero cannot be posted.');
  if (debit !== credit) {
    // The difference is named in the message because that is the number the
    // person fixing it needs, and hunting for it by hand is how rounding bugs
    // get "fixed" with a plug line.
    throw new PostingError(
      `Entry does not balance. Debits ${(debit / 100).toFixed(2)}, credits ${(credit / 100).toFixed(2)}, difference ${((debit - credit) / 100).toFixed(2)}.`,
    );
  }
}

async function assertAccounts(orgId: string, lines: PostingLine[]) {
  for (const l of lines) {
    const acc = await one<{ id: string; active: number }>(
      'SELECT id, active FROM accounts WHERE id = ? AND org_id = ?', l.accountId, orgId,
    );
    if (!acc) throw new PostingError(`Account ${l.accountId} does not exist in this organisation.`);
    if (!acc.active) throw new PostingError(`Account ${l.accountId} is archived and cannot be posted to.`);
  }
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/**
 * Write a balanced, posted journal entry. Returns its id.
 *
 * Everything happens in one transaction: header, lines, analytic rows, the
 * sequence bump and the audit row. A partially written entry would be an
 * unbalanced ledger, which no report could explain and no user could repair.
 */
export async function postEntry(input: PostingInput, actor: Actor = {}): Promise<string> {
  const lines = input.lines.filter((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0);
  assertBalanced(lines);

  return await tx(async () => {
    await assertPeriodOpen(input.orgId, input.date);
    await assertAccounts(input.orgId, lines);

    const journal = await one<{ id: string; sequence_code: string; code: string }>(
      'SELECT id, sequence_code, code FROM journals WHERE id = ? AND org_id = ?',
      input.journalId, input.orgId,
    );
    if (!journal) throw new PostingError('Unknown journal.');

    const entryId = id('je');
    const entryNo = await nextNumber(input.orgId, journal.sequence_code, journal.code);
    const now = nowIso();

    await run(
      `INSERT INTO journal_entries
         (id, org_id, journal_id, entry_no, entry_date, reference, narration, state,
          source_model, source_id, currency, created_by, created_at, posted_by, posted_at)
       VALUES (?,?,?,?,?,?,?,'posted',?,?,?,?,?,?,?)`,
      entryId, input.orgId, journal.id, entryNo, input.date,
      input.reference ?? null, input.narration ?? null,
      input.sourceModel ?? 'manual', input.sourceId ?? null,
      input.currency ?? 'INR',
      actor.id ?? null, now, actor.id ?? null, now,
    );

    for (const l of lines) await writeLine(input, entryId, l, 'posted');

    await audit(input.orgId, actor, 'posted', 'journal_entry', entryId,
      `${entryNo} · ${input.reference ?? input.narration ?? journal.code}`);
    return entryId;
  });
}

/** A draft entry: written but not part of any balance until it is posted. */
export async function draftEntry(input: PostingInput, actor: Actor = {}): Promise<string> {
  const lines = input.lines.filter((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0);
  return await tx(async () => {
    await assertAccounts(input.orgId, lines);
    const entryId = id('je');
    await run(
      `INSERT INTO journal_entries
         (id, org_id, journal_id, entry_no, entry_date, reference, narration, state,
          source_model, source_id, currency, created_by, created_at)
       VALUES (?,?,?,NULL,?,?,?,'draft',?,?,?,?,?)`,
      entryId, input.orgId, input.journalId, input.date,
      input.reference ?? null, input.narration ?? null,
      input.sourceModel ?? 'manual', input.sourceId ?? null,
      input.currency ?? 'INR', actor.id ?? null, nowIso(),
    );
    for (const l of lines) await writeLine(input, entryId, l, 'draft');
    await audit(input.orgId, actor, 'created', 'journal_entry', entryId, 'Draft entry');
    return entryId;
  });
}

/** Post an entry that already exists in draft. */
export async function postDraft(orgId: string, entryId: string, actor: Actor = {}): Promise<string> {
  return await tx(async () => {
    const entry = await one<{ id: string; state: string; entry_date: string; journal_id: string; reference: string }>(
      'SELECT id, state, entry_date, journal_id, reference FROM journal_entries WHERE id = ? AND org_id = ?',
      entryId, orgId,
    );
    if (!entry) throw new PostingError('Unknown entry.');
    if (entry.state === 'posted') throw new PostingError('This entry is already posted.');
    if (entry.state === 'reversed') throw new PostingError('A reversed entry cannot be posted again.');
    await assertPeriodOpen(orgId, entry.entry_date);

    const lines = await all<{ debit: number; credit: number; account_id: string }>(
      'SELECT debit, credit, account_id FROM journal_entry_lines WHERE entry_id = ?', entryId,
    );
    assertBalanced(lines.map((l) => ({ accountId: l.account_id, debit: l.debit, credit: l.credit })));

    const journal = (await one<{ sequence_code: string; code: string }>(
      'SELECT sequence_code, code FROM journals WHERE id = ?', entry.journal_id,
    ))!;
    const entryNo = await nextNumber(orgId, journal.sequence_code, journal.code);

    await run(
      `UPDATE journal_entries SET state='posted', entry_no=?, posted_by=?, posted_at=? WHERE id=?`,
      entryNo, actor.id ?? null, nowIso(), entryId,
    );
    await run(`UPDATE journal_entry_lines SET state='posted' WHERE entry_id=?`, entryId);
    await run(`UPDATE analytic_distributions SET state='posted' WHERE line_id IN
           (SELECT id FROM journal_entry_lines WHERE entry_id=?)`, entryId);
    await audit(orgId, actor, 'posted', 'journal_entry', entryId, entryNo);
    return entryId;
  });
}

async function writeLine(input: PostingInput, entryId: string, l: PostingLine, state: string) {
  const lineId = id('jel');
  await run(
    `INSERT INTO journal_entry_lines
       (id, org_id, entry_id, account_id, partner_id, label, debit, credit,
        currency, amount_currency, rate_e6, tax_id, tax_base, booking_id, entry_date, state)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    lineId, input.orgId, entryId, l.accountId, l.partnerId ?? null, l.label ?? null,
    Math.round(l.debit ?? 0), Math.round(l.credit ?? 0),
    l.currency ?? null, Math.round(l.amountCurrency ?? 0), l.rateE6 ?? null,
    l.taxId ?? null, Math.round(l.taxBase ?? 0), l.bookingId ?? null, input.date, state,
  );

  const kind = (await one<{ kind: string }>('SELECT kind FROM accounts WHERE id = ?', l.accountId))?.kind ?? '';
  // Only P&L lines carry analytic weight. Tagging the receivable side of an
  // invoice to a trip would double-count it: the revenue line already is the
  // trip's income, and the receivable is merely how it was financed.
  if (!isPl(kind)) return;

  const spread = [...(l.analytic ?? (l.analyticId ? [{ analyticId: l.analyticId, bps: 10000 }] : []))];

  /*
   * A LINE TAGGED TO A TRIP IS TAGGED TO THE TRIP'S ANALYTIC ACCOUNT, ALWAYS.
   *
   * The two fields look interchangeable on a form and are not: `booking_id`
   * is a label on the line, `analytic_id` is what Trip Profitability actually
   * sums. Every entry screen in the product offers both, and a hotel bill
   * where the accountant picked the trip but left the analytic box alone used
   * to post with no analytic row at all — the cost was in the ledger, correct
   * to the rupee, and simply absent from the trip's margin. Nobody notices
   * that until the season is closed.
   *
   * So the booking fills it in. This is the one place worth doing it, because
   * every posting in the system — invoice, bill, receipt, expense, commission,
   * depreciation, hand-typed journal — passes through here, and a fallback in
   * any one screen would have to be repeated in the other six.
   *
   * THE TRIP TAG IS ADDED ALONGSIDE, NOT INSTEAD OF. The analytic box on a
   * line is one flat list across every plan — trips, departments, branches,
   * agents — so picking AGENT-3 on a hotel bill used to be read as "this line
   * is not on a trip" and knocked the trip tag out, silently. The two are
   * different questions about the same rupee, and the schema has always
   * allowed one row per plan. Only an analytic FROM THE TRIP'S OWN PLAN is a
   * decision about which trip this is, and only that one wins — which is what
   * keeps a deliberate split across two trips working.
   */
  if (l.bookingId) {
    const trip = await one<{ analytic_id: string | null; plan_id: string | null }>(
      `SELECT b.analytic_id, an.plan_id
         FROM bookings b LEFT JOIN analytic_accounts an ON an.id = b.analytic_id
        WHERE b.id = ? AND b.org_id = ?`, l.bookingId, input.orgId,
    );
    if (trip?.analytic_id && trip.plan_id) {
      const tagged = spread.length
        ? await scalar(
          `SELECT COUNT(*) FROM analytic_accounts
            WHERE plan_id = ? AND id IN (${spread.map(() => '?').join(',')})`,
          trip.plan_id, ...spread.map((a) => a.analyticId),
        )
        : 0;
      if (!tagged) spread.push({ analyticId: trip.analytic_id, bps: 10000 });
    }
  }
  if (!spread.length) return;

  /*
   * 100% PER PLAN, not 100% across all of them. A line that is wholly on the
   * Goa trip AND wholly in the Leisure department is 10000 bps twice, and
   * summing the two to 20000 would reject a perfectly ordinary posting.
   */
  const planOf = new Map<string, string>();
  for (const r of await all<{ id: string; plan_id: string }>(
    `SELECT id, plan_id FROM analytic_accounts WHERE id IN (${spread.map(() => '?').join(',')})`,
    ...spread.map((a) => a.analyticId),
  )) planOf.set(r.id, r.plan_id);

  const byPlan = new Map<string, number>();
  for (const a of spread) {
    const plan = planOf.get(a.analyticId) ?? a.analyticId;
    byPlan.set(plan, (byPlan.get(plan) ?? 0) + a.bps);
  }
  for (const total of byPlan.values()) {
    if (total !== 10000) {
      throw new PostingError(`Analytic distribution must total 100% per plan (got ${(total / 100).toFixed(2)}%).`);
    }
  }

  // Signed so that trip profitability is a straight SUM: cost positive,
  // revenue negative, profit = -SUM.
  const signed = (Math.round(l.debit ?? 0) - Math.round(l.credit ?? 0));
  for (const a of spread) {
    await run(
      `INSERT INTO analytic_distributions
         (org_id, line_id, analytic_id, bps, amount, entry_date, account_id, state)
       VALUES (?,?,?,?,?,?,?,?)`,
      input.orgId, lineId, a.analyticId, a.bps,
      Math.round((signed * a.bps) / 10000), input.date, l.accountId, state,
    );
  }
}

/**
 * Reverse a posted entry.
 *
 * Posted accounting records are never deleted (plan section 44). A reversal is
 * a NEW entry with the sides swapped, dated when the reversal happened — which
 * keeps both the original mistake and its correction in the audit trail, and
 * keeps a closed period's totals untouched.
 */
export async function reverseEntry(orgId: string, entryId: string, date: string, actor: Actor = {}, reason?: string): Promise<string> {
  return await tx(async () => {
    const entry = await one<{ id: string; journal_id: string; entry_no: string; state: string; source_model: string; source_id: string; currency: string }>(
      `SELECT id, journal_id, entry_no, state, source_model, source_id, currency
         FROM journal_entries WHERE id = ? AND org_id = ?`, entryId, orgId,
    );
    if (!entry) throw new PostingError('Unknown entry.');
    if (entry.state !== 'posted') throw new PostingError('Only a posted entry can be reversed.');

    const lines = await all<{
      account_id: string; partner_id: string | null; label: string | null;
      debit: number; credit: number; booking_id: string | null; id: string;
      currency: string | null; amount_currency: number; rate_e6: number | null;
    }>(`SELECT id, account_id, partner_id, label, debit, credit, booking_id,
               currency, amount_currency, rate_e6
          FROM journal_entry_lines WHERE entry_id = ?`, entryId);

    // A loop rather than Promise.all over the map: each iteration reads the
    // line's analytic split on the transaction's single connection, and
    // issuing those concurrently would only queue them anyway.
    const reversed: PostingLine[] = [];
    for (const l of lines) {
      const analytic = (await all<{ analytic_id: string; bps: number }>(
        'SELECT analytic_id, bps FROM analytic_distributions WHERE line_id = ?', l.id,
      )).map((a) => ({ analyticId: a.analytic_id, bps: a.bps }));
      reversed.push({
        accountId: l.account_id,
        partnerId: l.partner_id,
        label: `Reversal — ${l.label ?? ''}`.trim(),
        debit: l.credit,
        credit: l.debit,
        bookingId: l.booking_id,
        currency: l.currency,
        amountCurrency: -l.amount_currency,
        rateE6: l.rate_e6,
        analytic: analytic.length ? analytic : undefined,
      });
    }

    const newId = await postEntry({
      orgId,
      journalId: entry.journal_id,
      date,
      reference: `Reversal of ${entry.entry_no}`,
      narration: reason ?? `Reversal of ${entry.entry_no}`,
      sourceModel: entry.source_model,
      sourceId: entry.source_id,
      currency: entry.currency,
      lines: reversed,
    }, actor);

    await run(`UPDATE journal_entries SET state='reversed' WHERE id=?`, entryId);
    await run(`UPDATE journal_entries SET reversal_of=? WHERE id=?`, entryId, newId);
    await audit(orgId, actor, 'reversed', 'journal_entry', entryId,
      `${entry.entry_no} reversed${reason ? ` — ${reason}` : ''}`);
    return newId;
  });
}

// ---------------------------------------------------------------------------
// Reading the ledger
// ---------------------------------------------------------------------------
// Everything below derives from posted lines. There is no cached balance column
// anywhere in the schema, on purpose (Rule 2).

export interface BalanceQuery {
  from?: string;
  to?: string;
  /** Posted only, by default. Drafts are not part of any balance. */
  includeDraft?: boolean;
}

export async function accountBalance(orgId: string, accountId: string, q: BalanceQuery = {}): Promise<number> {
  const state = q.includeDraft ? "('draft','posted')" : "('posted')";
  return await scalar(
    `SELECT COALESCE(SUM(debit - credit), 0) FROM journal_entry_lines
      WHERE org_id = ? AND account_id = ? AND state IN ${state}
        AND (?::text IS NULL OR entry_date >= ?) AND (?::text IS NULL OR entry_date <= ?)`,
    orgId, accountId, q.from ?? null, q.from ?? null, q.to ?? null, q.to ?? null,
  );
}

/** Signed by the account's natural side, which is what a report wants to print. */
export async function accountBalanceNatural(orgId: string, accountId: string, q: BalanceQuery = {}): Promise<number> {
  const kind = (await one<{ kind: string }>('SELECT kind FROM accounts WHERE id = ?', accountId))?.kind ?? 'asset_current';
  return await accountBalance(orgId, accountId, q) * kindSign(kind);
}

/** Total debits and credits over a window — the trial balance's proof line. */
export async function ledgerTotals(orgId: string, from?: string, to?: string) {
  const row = await one<{ d: number; c: number }>(
    `SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c
       FROM journal_entry_lines WHERE org_id = ? AND state = 'posted'
         AND (?::text IS NULL OR entry_date >= ?) AND (?::text IS NULL OR entry_date <= ?)`,
    orgId, from ?? null, from ?? null, to ?? null, to ?? null,
  );
  return { debit: row?.d ?? 0, credit: row?.c ?? 0, balanced: (row?.d ?? 0) === (row?.c ?? 0) };
}

/**
 * Sum of all P&L accounts over a window — current-year profit.
 *
 * Returned in natural sign: positive is a profit. The Balance Sheet adds this
 * to equity so it balances before the year has been closed.
 */
export async function profitForPeriod(orgId: string, from: string, to: string): Promise<number> {
  return -await scalar(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0)
       FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.org_id = ? AND l.state = 'posted'
        AND a.kind IN ('income','income_other','expense_direct','expense_operating','expense_depreciation')
        AND l.entry_date BETWEEN ? AND ?`,
    orgId, from, to,
  );
}
