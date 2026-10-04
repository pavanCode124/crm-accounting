import 'server-only';
import { all, one, run, tx, id, nowIso } from '../db';
import { postEntry, PostingError, type Actor } from './engine';
import { requireSetting } from './settings';
import { audit } from './audit';
import { pct } from '@/lib/money';
import { formatDocNumber } from '@/lib/accounting';

/**
 * Employee expenses, employee advances and agent commissions
 * (plan sections 28, 31, 32).
 *
 * The expense workflow is a real state machine — draft → submitted → approved
 * → posted → paid — and the POSTING happens at approval, not at submission. An
 * agent typing a claim must not be able to move the general ledger; that is
 * what "approved by" means, and it is enforced here rather than by hiding the
 * button.
 *
 * WHO IS OWED depends on who paid:
 *   paid_by employee  →  Expense Dr / Employee Advance Cr   (reimbursable)
 *   paid_by company   →  Expense Dr / Bank or Cash Cr       (already settled)
 */

export interface ExpenseInput {
  orgId: string; employeeId?: string | null; employeeName: string;
  description: string; expenseDate: string; amount: number;
  taxId?: string | null; accountId: string; analyticId?: string | null;
  bookingId?: string | null; paidBy: 'employee' | 'company'; journalId?: string | null;
  receipt?: string | null;
  /**
   * THE CUSTOMER INVOICE THIS CLAIM WAS INCURRED FOR.
   *
   * The guide an employee paid in cash on day three is a cost of the package
   * that was sold, and it has to reach that package's margin or the margin is
   * overstated by exactly the amount nobody could tag. The claim form used to
   * offer only a TRIP, which is a `bookings` row, which exists only for a CRM
   * lead carrying a package number — so for an agency without those the field
   * could not be filled and the cost reached nothing.
   *
   * Naming the invoice also fills in the trip, where there is one:
   * `tripOfInvoice` copies the invoice's booking and analytic account onto the
   * claim, so the analytic-backed reports keep working unchanged and the
   * invoice-backed ones start working at all.
   */
  linkedInvoiceId?: string | null;
}

/**
 * The trip behind a sale, for a cost record that names the sale.
 *
 * ===========================================================================
 * ONE HELPER, THREE COST RECORDS, BECAUSE THE RULE MUST NOT DIVERGE
 * ===========================================================================
 * A vendor bill, an expense claim and an agent commission are all costs of a
 * sale, and all three now name the invoice rather than the trip. Each of them
 * still has to carry the trip tag where one exists — that is what keeps Trip
 * Profitability, the trip dossier and every analytic report working for the
 * agencies that do have bookings. Written once here so the three cannot drift
 * into three slightly different answers about which trip a cost is on.
 *
 * WHAT THE RECORD SAYS ITSELF WINS. This only ever fills a blank: somebody who
 * named an invoice AND a different trip has said something deliberate, and
 * overriding it would be the system disagreeing with the person typing.
 *
 * AN UNKNOWN INVOICE IS A NULL, NOT A THROW. Unlike a vendor bill — where the
 * link is the point of the document and a bad one must be refused — a claim or
 * a commission is a real cost that must reach the ledger whatever happens to
 * its tagging. Losing the attribution is recoverable; losing the cost is not.
 */
export async function tripOfInvoice(
  orgId: string,
  invoiceId: string | null | undefined,
  given: { bookingId?: string | null; analyticId?: string | null } = {},
): Promise<{ bookingId: string | null; analyticId: string | null; linkedInvoiceId: string | null }> {
  const bookingId = given.bookingId ?? null;
  const analyticId = given.analyticId ?? null;
  const linkedInvoiceId = (invoiceId ?? '').trim() || null;
  if (!linkedInvoiceId) return { bookingId, analyticId, linkedInvoiceId: null };

  const inv = await one<{ booking_id: string | null; analytic_id: string | null }>(
    `SELECT booking_id, analytic_id FROM documents
      WHERE id = ? AND org_id = ? AND doc_type IN ('out_invoice','out_refund')`,
    linkedInvoiceId, orgId,
  );
  return {
    bookingId: bookingId ?? inv?.booking_id ?? null,
    analyticId: analyticId ?? inv?.analytic_id ?? null,
    linkedInvoiceId,
  };
}

export async function createExpense(input: ExpenseInput, actor: Actor = {}): Promise<string> {
  return await tx(async () => {
    const expenseId = id('exp');
    const taxAmount = input.taxId
      ? pct(input.amount, (await one<{ rate_bps: number }>('SELECT rate_bps FROM taxes WHERE id=?', input.taxId))?.rate_bps ?? 0)
      : 0;
    // The sale this was spent on, and the trip behind that sale. One helper,
    // shared with bills and commissions, so the three agree. See `tripOfInvoice`.
    const trip = await tripOfInvoice(input.orgId, input.linkedInvoiceId, input);
    await run(
      `INSERT INTO expenses
         (id, org_id, number, employee_id, employee_name, description, expense_date, amount,
          tax_id, tax_amount, account_id, analytic_id, booking_id, linked_invoice_id,
          paid_by, journal_id, state, receipt, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,
      expenseId, input.orgId, await nextExpenseNumber(input.orgId), input.employeeId ?? null,
      input.employeeName, input.description, input.expenseDate, input.amount,
      input.taxId ?? null, taxAmount, input.accountId, trip.analyticId,
      trip.bookingId, trip.linkedInvoiceId, input.paidBy, input.journalId ?? null,
      input.receipt ?? null, nowIso(),
    );
    await audit(input.orgId, actor, 'created', 'expense', expenseId, input.description);
    return expenseId;
  });
}

async function nextExpenseNumber(orgId: string): Promise<string> {
  // Prefix and padding off the row, so Settings → Numbering reaches this series
  // too. 'EXP' below only seeds one that does not exist yet.
  const seq = await one<{ prefix: string; padding: number; next_no: number }>(
    "SELECT prefix, padding, next_no FROM sequences WHERE org_id=? AND code='expense' FOR UPDATE", orgId);
  if (!seq) {
    await run("INSERT INTO sequences (org_id, code, prefix, padding, next_no) VALUES (?,'expense','EXP',4,2)", orgId);
    return formatDocNumber('EXP', 4, 1);
  }
  await run("UPDATE sequences SET next_no = next_no + 1 WHERE org_id=? AND code='expense'", orgId);
  return formatDocNumber(seq.prefix, seq.padding, seq.next_no);
}

export async function submitExpense(orgId: string, expenseId: string, actor: Actor = {}) {
  await run("UPDATE expenses SET state='submitted' WHERE id=? AND org_id=? AND state='draft'", expenseId, orgId);
  await audit(orgId, actor, 'submitted', 'expense', expenseId, 'Submitted for approval');
}

export async function refuseExpense(orgId: string, expenseId: string, reason: string, actor: Actor = {}) {
  await run("UPDATE expenses SET state='refused' WHERE id=? AND org_id=?", expenseId, orgId);
  await audit(orgId, actor, 'refused', 'expense', expenseId, reason);
}

/** Approve AND post. The approval is what makes it an accounting fact. */
export async function approveExpense(orgId: string, expenseId: string, actor: Actor = {}): Promise<string> {
  return await tx(async () => {
    const e = await one<{
      id: string; number: string; description: string; expense_date: string; amount: number;
      tax_amount: number; tax_id: string | null; account_id: string; analytic_id: string | null;
      booking_id: string | null; paid_by: string; journal_id: string | null; state: string;
      employee_name: string;
    }>('SELECT * FROM expenses WHERE id=? AND org_id=?', expenseId, orgId);
    if (!e) throw new PostingError('Unknown expense.');
    if (e.state === 'posted' || e.state === 'paid') throw new PostingError('This expense is already posted.');

    const credit = e.paid_by === 'employee'
      ? await requireSetting(orgId, 'account.employee_advance')
      : await requireSetting(orgId, 'account.opening_balance');
    const creditAccount = e.paid_by === 'employee'
      ? credit
      : (await one<{ default_account_id: string }>(
        'SELECT default_account_id FROM journals WHERE id=?',
        e.journal_id ?? await requireSetting(orgId, 'journal.cash'),
      ))?.default_account_id ?? credit;

    const label = `${e.number} · ${e.employee_name} · ${e.description}`;
    const lines = [
      { accountId: e.account_id, debit: e.amount, label, analyticId: e.analytic_id, bookingId: e.booking_id },
    ] as Parameters<typeof postEntry>[0]['lines'];

    if (e.tax_amount > 0 && e.tax_id) {
      const taxAccount = (await one<{ account_id: string }>('SELECT account_id FROM taxes WHERE id=?', e.tax_id))?.account_id;
      if (taxAccount) lines.push({ accountId: taxAccount, debit: e.tax_amount, label: 'Input tax', taxId: e.tax_id, taxBase: e.amount });
    }
    lines.push({ accountId: creditAccount, credit: e.amount + e.tax_amount, label });

    const entryId = await postEntry({
      orgId,
      journalId: e.journal_id ?? await requireSetting(orgId, 'journal.expense'),
      date: e.expense_date,
      reference: e.number,
      narration: label,
      sourceModel: 'expense',
      sourceId: expenseId,
      lines,
    }, actor);

    await run("UPDATE expenses SET state='posted', entry_id=?, approved_by=?, approved_at=? WHERE id=?",
      entryId, actor.id ?? null, nowIso(), expenseId);
    await audit(orgId, actor, 'approved', 'expense', expenseId, `${e.number} approved and posted`);
    return entryId;
  });
}

/**
 * Pay an employee back.
 *
 *   Employee Advance Dr / Bank Cr
 *
 * Which clears the liability the approval created. The advance account is a
 * running balance per employee, which is exactly what plan section 32 asks
 * for: advance ₹20,000, expenses ₹17,500, ₹2,500 still to return.
 */
export async function reimburseExpense(orgId: string, expenseId: string, opts: { date: string; journalId: string }, actor: Actor = {}) {
  return await tx(async () => {
    const e = await one<{ number: string; amount: number; tax_amount: number; employee_name: string; state: string }>(
      'SELECT number, amount, tax_amount, employee_name, state FROM expenses WHERE id=? AND org_id=?',
      expenseId, orgId,
    );
    if (!e) throw new PostingError('Unknown expense.');
    if (e.state !== 'posted') throw new PostingError('Approve the expense before reimbursing it.');

    const bank = (await one<{ default_account_id: string }>(
      'SELECT default_account_id FROM journals WHERE id=?', opts.journalId,
    ))?.default_account_id;
    if (!bank) throw new PostingError('That journal has no bank or cash account.');

    const total = e.amount + e.tax_amount;
    const label = `Reimbursement ${e.number} — ${e.employee_name}`;
    await postEntry({
      orgId, journalId: opts.journalId, date: opts.date, reference: e.number, narration: label,
      sourceModel: 'expense', sourceId: expenseId,
      lines: [
        { accountId: await requireSetting(orgId, 'account.employee_advance'), debit: total, label },
        { accountId: bank, credit: total, label },
      ],
    }, actor);
    await run("UPDATE expenses SET state='paid' WHERE id=?", expenseId);
    await audit(orgId, actor, 'paid', 'expense', expenseId, label);
  });
}

/** Cash handed to an employee before the trip: Employee Advance Dr / Bank Cr. */
export async function payEmployeeAdvance(orgId: string, opts: {
  employeeName: string; amount: number; date: string; journalId: string; note?: string;
}, actor: Actor = {}) {
  return await tx(async () => {
    const bank = (await one<{ default_account_id: string }>(
      'SELECT default_account_id FROM journals WHERE id=?', opts.journalId,
    ))?.default_account_id;
    if (!bank) throw new PostingError('That journal has no bank or cash account.');
    const label = `Advance to ${opts.employeeName}${opts.note ? ` — ${opts.note}` : ''}`;
    return await postEntry({
      orgId, journalId: opts.journalId, date: opts.date,
      reference: 'Employee advance', narration: label,
      sourceModel: 'employee_advance',
      lines: [
        { accountId: await requireSetting(orgId, 'account.employee_advance'), debit: opts.amount, label },
        { accountId: bank, credit: opts.amount, label },
      ],
    }, actor);
  });
}

export async function listExpenses(orgId: string, opts: { state?: string; limit?: number } = {}) {
  const clauses = ['e.org_id = ?'];
  const params: Array<string | number> = [orgId];
  if (opts.state) { clauses.push('e.state = ?'); params.push(opts.state); }
  return await all<{
    id: string; number: string; employee_name: string; description: string;
    expense_date: string; amount: number; tax_amount: number; state: string;
    paid_by: string; account_name: string; analytic_name: string | null;
    trip_booking_id: string | null; booking_ref: string | null;
  }>(
    // The trip is carried to the list as a BOOKING, not only as a name: the
    // Trip column links the same way the Commissions screen links its Booking
    // column, and a claim's trip is worth nothing to a reader who then has to
    // go and find which booking it belongs to. `e.booking_id` wins over the
    // analytic account's own booking because a claim filed against a booking
    // directly is the more specific statement of the two.
    `SELECT e.*, a.name AS account_name, an.name AS analytic_name,
            COALESCE(e.booking_id, an.booking_id) AS trip_booking_id,
            b.ref AS booking_ref
       FROM expenses e
       LEFT JOIN accounts a ON a.id = e.account_id
       LEFT JOIN analytic_accounts an ON an.id = e.analytic_id
       LEFT JOIN bookings b ON b.id = COALESCE(e.booking_id, an.booking_id)
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.expense_date DESC LIMIT ${opts.limit ?? 200}`,
    ...params,
  );
}

// ---------------------------------------------------------------------------
// Agent commissions (plan section 28)
// ---------------------------------------------------------------------------

/**
 * What a commission is a percentage OF.
 *
 * `'margin'` is the old name for `'profit'` and is kept so that commissions
 * calculated before the rename still read back as what they were.
 */
export type CommissionBasis = 'revenue' | 'profit' | 'margin';

export function commissionBasisLabel(basis: string): string {
  return basis === 'revenue' ? 'Revenue' : 'Profit';
}

/**
 * Compute and record a commission.
 *
 * `basis` matters and is not a detail. Commission on REVENUE rewards selling;
 * commission on PROFIT rewards selling profitably, and a travel agency that
 * pays on revenue will find its agents discounting the trip away. Both are
 * supported because both are used; the accounting is the same either way:
 *
 *   Commission expense Dr / Commission payable Cr
 *
 * PROFIT, not "gross margin", is the honest name for the second one. The base
 * subtracts every P&L cost tagged to the trip — the direct hotel and flight
 * cost, and equally the operating cost and the cab an employee paid for out of
 * pocket. That is the same number Trip Profitability prints in its PROFIT
 * column, and calling it a gross margin here while the report called it profit
 * invited the reader to assume one of the two excluded overheads. It does not.
 *
 * `'margin'` is still accepted on the way in and still read back from rows
 * written before the rename: it is the same basis under its old name, and a
 * posted commission must never change the number it was calculated on.
 */
export async function createCommission(orgId: string, input: {
  agentName: string; agentId?: string | null;
  /**
   * EITHER A SALE OR A TRIP, AND THE SALE IS THE ONE THE FORM ASKS FOR.
   *
   * `bookingId` was mandatory, which made a commission impossible to record at
   * all for an agency with no bookings — the same assumption that left Trip
   * Profitability permanently empty for them. An agent earns on the sale they
   * closed; the trip is optional context, filled in from the invoice when the
   * invoice has one.
   */
  linkedInvoiceId?: string | null;
  bookingId?: string | null;
  basis: CommissionBasis; rateBps?: number; fixedAmount?: number; dueDate?: string | null;
}, actor: Actor = {}): Promise<string> {
  return await tx(async () => {
    const trip = await tripOfInvoice(orgId, input.linkedInvoiceId, input);
    if (!trip.linkedInvoiceId && !trip.bookingId) {
      throw new PostingError(
        'A commission is earned on something. Choose the customer invoice it was earned on — '
        + 'or the trip, if this agency works in bookings.',
      );
    }
    const base = await commissionBase(orgId, trip, input.basis);
    const amount = input.fixedAmount && input.fixedAmount > 0
      ? input.fixedAmount
      : pct(base, input.rateBps ?? 0);
    const commissionId = id('com');
    await run(
      `INSERT INTO commissions
         (id, org_id, agent_id, agent_name, booking_id, linked_invoice_id, basis, rate_bps,
          fixed_amount, base_amount, amount, due_date, state, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
      commissionId, orgId, input.agentId ?? null, input.agentName, trip.bookingId,
      trip.linkedInvoiceId, input.basis, input.rateBps ?? 0, input.fixedAmount ?? 0, base, amount,
      input.dueDate ?? null, nowIso(),
    );
    await audit(orgId, actor, 'created', 'commission', commissionId,
      `${input.agentName} — ${(amount / 100).toFixed(2)}`);
    return commissionId;
  });
}

/**
 * What a commission is a percentage OF.
 *
 * TWO SOURCES, AND THE SALE IS TRIED FIRST. A commission against an invoice is
 * calculated from that sale — its revenue net of credit notes, and for the
 * profit basis less every cost recorded against it. A commission against a
 * trip keeps reading the analytic distributions, which is what it always did
 * and what still has to be true for the agencies that work in bookings.
 *
 * READ FROM THE LEDGER EITHER WAY, never typed, so a commission cannot be
 * calculated on a figure the books do not support. And NET OF TAX on both
 * sides: GST is collected for the government and input GST is reclaimed, so an
 * agent paid a percentage of the gross would be paid a percentage of the
 * government's money.
 *
 * A COMMISSION ALREADY RECORDED IS NEVER RECOMPUTED. `base_amount` is stored
 * at creation precisely so that a bill arriving next week — which legitimately
 * changes the profit — does not silently restate what an agent was told they
 * had earned.
 */
async function commissionBase(
  orgId: string,
  trip: { bookingId: string | null; linkedInvoiceId: string | null },
  basis: CommissionBasis,
): Promise<number> {
  if (trip.linkedInvoiceId) {
    const { saleMargin } = await import('./analytics');
    const m = await saleMargin(orgId, trip.linkedInvoiceId);
    if (!m) return 0;
    return basis === 'revenue' ? m.revenue : m.profit;
  }
  if (!trip.bookingId) return 0;
  const analytic = await one<{ id: string }>(
    'SELECT id FROM analytic_accounts WHERE org_id=? AND booking_id=?', orgId, trip.bookingId,
  );
  if (!analytic) return 0;
  const row = await one<{ revenue: number; cost: number }>(
    `SELECT COALESCE(SUM(CASE WHEN a.kind IN ('income','income_other') THEN -ad.amount END),0) AS revenue,
            COALESCE(SUM(CASE WHEN a.kind LIKE 'expense%' THEN ad.amount END),0) AS cost
       FROM analytic_distributions ad JOIN accounts a ON a.id = ad.account_id
      WHERE ad.org_id=? AND ad.analytic_id=? AND ad.state='posted'`,
    orgId, analytic.id,
  );
  const revenue = row?.revenue ?? 0;
  return basis === 'revenue' ? revenue : revenue - (row?.cost ?? 0);
}

export async function postCommission(orgId: string, commissionId: string, date: string, actor: Actor = {}): Promise<string> {
  return await tx(async () => {
    const c = await one<{
      id: string; agent_name: string; amount: number; state: string;
      booking_id: string | null; linked_invoice_id: string | null;
    }>('SELECT * FROM commissions WHERE id=? AND org_id=?', commissionId, orgId);
    if (!c) throw new PostingError('Unknown commission.');
    if (c.state !== 'draft') throw new PostingError('This commission is already posted.');
    if (c.amount <= 0) throw new PostingError('Nothing to post: the commission is zero.');

    /*
     * THE TRIP TAG, WHERE THERE IS A TRIP. A commission recorded against an
     * invoice takes the trip from that invoice, so it lands in the analytic
     * margin alongside the sale it was earned on; one recorded against a
     * booking directly keeps reading the booking, as it always did. Neither is
     * required — an agency with no bookings posts a commission with no
     * analytic row, and the sale-level report finds it by `linked_invoice_id`.
     */
    const trip = await tripOfInvoice(orgId, c.linked_invoice_id, { bookingId: c.booking_id });
    const analytic = trip.analyticId
      ? { id: trip.analyticId }
      : trip.bookingId
        ? await one<{ id: string }>(
          'SELECT id FROM analytic_accounts WHERE org_id=? AND booking_id=?', orgId, trip.bookingId,
        )
        : null;
    const label = `Commission — ${c.agent_name}`;
    const entryId = await postEntry({
      orgId,
      journalId: await requireSetting(orgId, 'journal.general'),
      date,
      reference: 'Commission',
      narration: label,
      sourceModel: 'commission',
      sourceId: commissionId,
      lines: [
        { accountId: await requireSetting(orgId, 'account.commission_expense'), debit: c.amount, label,
          analyticId: analytic?.id ?? null, bookingId: trip.bookingId },
        { accountId: await requireSetting(orgId, 'account.commission_payable'), credit: c.amount, label },
      ],
    }, actor);
    await run("UPDATE commissions SET state='posted', entry_id=? WHERE id=?", entryId, commissionId);
    await audit(orgId, actor, 'posted', 'commission', commissionId, label);
    return entryId;
  });
}

export async function listCommissions(orgId: string) {
  return await all<{
    id: string; agent_name: string; booking_id: string | null; booking_ref: string | null;
    linked_invoice_id: string | null; invoice_number: string | null; invoice_partner: string | null;
    basis: string; rate_bps: number; base_amount: number; amount: number;
    due_date: string | null; state: string;
  }>(
    `SELECT c.*, b.ref AS booking_ref,
            COALESCE(i.number, ci.invoice_number) AS invoice_number,
            p.name AS invoice_partner
       FROM commissions c
       LEFT JOIN bookings b ON b.id = c.booking_id
       LEFT JOIN documents i ON i.id = c.linked_invoice_id AND i.org_id = c.org_id
       LEFT JOIN partners p ON p.id = i.partner_id
       -- A draft invoice has no number of its own yet, and the one the agent
       -- recognises is the CRM's in any case. Shown rather than a blank cell.
       LEFT JOIN crm_invoices ci ON ci.document_id = i.id AND ci.org_id = c.org_id
      WHERE c.org_id = ? ORDER BY c.created_at DESC`, orgId,
  );
}
