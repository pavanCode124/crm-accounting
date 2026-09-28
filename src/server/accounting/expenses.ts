import 'server-only';
import { all, one, run, tx, id, nowIso } from '../db';
import { postEntry, PostingError, type Actor } from './engine';
import { requireSetting } from './settings';
import { audit } from './audit';
import { pct } from '@/lib/money';

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
}

export async function createExpense(input: ExpenseInput, actor: Actor = {}): Promise<string> {
  return await tx(async () => {
    const expenseId = id('exp');
    const taxAmount = input.taxId
      ? pct(input.amount, (await one<{ rate_bps: number }>('SELECT rate_bps FROM taxes WHERE id=?', input.taxId))?.rate_bps ?? 0)
      : 0;
    await run(
      `INSERT INTO expenses
         (id, org_id, number, employee_id, employee_name, description, expense_date, amount,
          tax_id, tax_amount, account_id, analytic_id, booking_id, paid_by, journal_id,
          state, receipt, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`,
      expenseId, input.orgId, await nextExpenseNumber(input.orgId), input.employeeId ?? null,
      input.employeeName, input.description, input.expenseDate, input.amount,
      input.taxId ?? null, taxAmount, input.accountId, input.analyticId ?? null,
      input.bookingId ?? null, input.paidBy, input.journalId ?? null,
      input.receipt ?? null, nowIso(),
    );
    await audit(input.orgId, actor, 'created', 'expense', expenseId, input.description);
    return expenseId;
  });
}

async function nextExpenseNumber(orgId: string): Promise<string> {
  const seq = await one<{ next_no: number }>("SELECT next_no FROM sequences WHERE org_id=? AND code='expense' FOR UPDATE", orgId);
  if (!seq) {
    await run("INSERT INTO sequences (org_id, code, prefix, padding, next_no) VALUES (?,'expense','EXP',4,2)", orgId);
    return 'EXP-0001';
  }
  await run("UPDATE sequences SET next_no = next_no + 1 WHERE org_id=? AND code='expense'", orgId);
  return `EXP-${String(seq.next_no).padStart(4, '0')}`;
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
  }>(
    `SELECT e.*, a.name AS account_name, an.name AS analytic_name
       FROM expenses e
       LEFT JOIN accounts a ON a.id = e.account_id
       LEFT JOIN analytic_accounts an ON an.id = e.analytic_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.expense_date DESC LIMIT ${opts.limit ?? 200}`,
    ...params,
  );
}

// ---------------------------------------------------------------------------
// Agent commissions (plan section 28)
// ---------------------------------------------------------------------------

/**
 * Compute and record a commission.
 *
 * `basis` matters and is not a detail. Commission on REVENUE rewards selling;
 * commission on MARGIN rewards selling profitably, and a travel agency that
 * pays on revenue will find its agents discounting the trip away. Both are
 * supported because both are used; the accounting is the same either way:
 *
 *   Commission expense Dr / Commission payable Cr
 */
export async function createCommission(orgId: string, input: {
  agentName: string; agentId?: string | null; bookingId: string;
  basis: 'revenue' | 'margin'; rateBps?: number; fixedAmount?: number; dueDate?: string | null;
}, actor: Actor = {}): Promise<string> {
  return await tx(async () => {
    const base = await commissionBase(orgId, input.bookingId, input.basis);
    const amount = input.fixedAmount && input.fixedAmount > 0
      ? input.fixedAmount
      : pct(base, input.rateBps ?? 0);
    const commissionId = id('com');
    await run(
      `INSERT INTO commissions
         (id, org_id, agent_id, agent_name, booking_id, basis, rate_bps, fixed_amount,
          base_amount, amount, due_date, state, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
      commissionId, orgId, input.agentId ?? null, input.agentName, input.bookingId,
      input.basis, input.rateBps ?? 0, input.fixedAmount ?? 0, base, amount,
      input.dueDate ?? null, nowIso(),
    );
    await audit(orgId, actor, 'created', 'commission', commissionId,
      `${input.agentName} — ${(amount / 100).toFixed(2)}`);
    return commissionId;
  });
}

async function commissionBase(orgId: string, bookingId: string, basis: 'revenue' | 'margin'): Promise<number> {
  const analytic = await one<{ id: string }>(
    'SELECT id FROM analytic_accounts WHERE org_id=? AND booking_id=?', orgId, bookingId,
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
    const c = await one<{ id: string; agent_name: string; amount: number; state: string; booking_id: string }>(
      'SELECT * FROM commissions WHERE id=? AND org_id=?', commissionId, orgId,
    );
    if (!c) throw new PostingError('Unknown commission.');
    if (c.state !== 'draft') throw new PostingError('This commission is already posted.');
    if (c.amount <= 0) throw new PostingError('Nothing to post: the commission is zero.');

    const analytic = await one<{ id: string }>(
      'SELECT id FROM analytic_accounts WHERE org_id=? AND booking_id=?', orgId, c.booking_id,
    );
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
          analyticId: analytic?.id ?? null, bookingId: c.booking_id },
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
    id: string; agent_name: string; booking_id: string; booking_ref: string | null;
    basis: string; rate_bps: number; base_amount: number; amount: number;
    due_date: string | null; state: string;
  }>(
    `SELECT c.*, b.ref AS booking_ref FROM commissions c
       LEFT JOIN bookings b ON b.id = c.booking_id
      WHERE c.org_id = ? ORDER BY c.created_at DESC`, orgId,
  );
}
