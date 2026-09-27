import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { listExpenses } from '@/server/accounting/expenses';
import { accountOptions, journalOptions, analyticOptions, bookingOptions } from '@/server/options';
import { listTaxes } from '@/server/accounting/tax';
import { fmtDate, isoDate, titleise, can } from '@/lib/accounting';
import { saveExpenseAction, expenseWorkflowAction, employeeAdvanceAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, Money, Chip, StatTile, EmptyState, Field, inputClass, btn,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Employee expenses and advances — plan sections 31 and 32.
 *
 * The workflow is real: draft → submitted → approved → posted → paid, and the
 * ledger moves at APPROVAL, not at submission. An agent typing a claim must
 * not be able to move the general ledger; that is what approval means, and it
 * is enforced by the capability check on the action rather than by hiding the
 * button below.
 */
export default async function ExpensesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const m = msg(await searchParams);
  const expenses = listExpenses(s.orgId);
  const today = isoDate();
  const mayApprove = can(s.role, 'payment.approve');

  const accounts = accountOptions(s.orgId, ['expense_direct', 'expense_operating']);
  const journals = journalOptions(s.orgId);
  const cashJournals = journalOptions(s.orgId, ['bank', 'cash']);
  const analytics = analyticOptions(s.orgId);
  const bookings = bookingOptions(s.orgId);
  const taxes = listTaxes(s.orgId, 'purchase');

  const pending = expenses.filter((e) => e.state === 'submitted');
  const owed = expenses.filter((e) => e.state === 'posted')
    .reduce((sum, e) => sum + e.amount + e.tax_amount, 0);

  return (
    <>
      <PageHeader
        title="Expenses"
        subtitle="What staff spent on the agency's behalf, and what is still owed back to them."
        accent="var(--color-sec-settings)"
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile label="Awaiting approval" value={String(pending.length)}
          tone={pending.length ? 'warn' : 'positive'} />
        <StatTile label="Approved, not reimbursed" value={owed} compact={false} />
        <StatTile label="Claims this year" value={String(expenses.length)} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Card padded={false}>
          {expenses.length === 0 ? (
            <EmptyState title="No expense claims yet." />
          ) : (
            <Table>
              <thead>
                <tr><Th>Number</Th><Th>Who</Th><Th>What</Th><Th>Account</Th><Th>Trip</Th>
                  <Th>Date</Th><Th align="right">Amount</Th><Th>State</Th><Th width="170px" /></tr>
              </thead>
              <tbody>
                {expenses.map((e) => (
                  <tr key={e.id} className="hover:bg-canvas">
                    <Td><span className="font-bold">{e.number}</span></Td>
                    <Td>{e.employee_name}</Td>
                    <Td><span className="font-semibold">{e.description}</span></Td>
                    <Td><span className="text-ink-muted">{e.account_name}</span></Td>
                    <Td><span className="text-ink-muted">{e.analytic_name ?? '—'}</span></Td>
                    <Td>{fmtDate(e.expense_date)}</Td>
                    <Td align="right"><Money value={e.amount + e.tax_amount} bold dash={false} /></Td>
                    <Td>
                      <Chip state={e.state} />
                      <div className="mt-1 text-[11px] text-ink-faint">
                        {e.paid_by === 'employee' ? 'Reimbursable' : 'Company paid'}
                      </div>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-2 no-print">
                        {e.state === 'submitted' && mayApprove && (
                          <>
                            <form action={expenseWorkflowAction}>
                              <input type="hidden" name="id" value={e.id} />
                              <input type="hidden" name="action" value="approve" />
                              <button className="text-[12px] font-bold text-positive hover:underline">Approve</button>
                            </form>
                            <form action={expenseWorkflowAction}>
                              <input type="hidden" name="id" value={e.id} />
                              <input type="hidden" name="action" value="refuse" />
                              <input type="hidden" name="reason" value="Refused" />
                              <button className="text-[12px] font-bold text-negative hover:underline">Refuse</button>
                            </form>
                          </>
                        )}
                        {e.state === 'posted' && e.paid_by === 'employee' && (
                          <form action={expenseWorkflowAction} className="flex items-center gap-1.5">
                            <input type="hidden" name="id" value={e.id} />
                            <input type="hidden" name="action" value="reimburse" />
                            <input type="hidden" name="date" value={today} />
                            <input type="hidden" name="journal_id" value={cashJournals[0]?.id ?? ''} />
                            <button className="text-[12px] font-bold text-brand hover:underline">Reimburse</button>
                          </form>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <div className="space-y-5">
          <Card title="New claim">
            <form action={saveExpenseAction} className="space-y-3">
              <Field label="Employee">
                <input name="employee_name" defaultValue={s.userName} className={inputClass} />
              </Field>
              <Field label="Description">
                <input name="description" required className={inputClass} placeholder="Local guide — Bali day 3" />
              </Field>
              <Field label="Amount">
                <input name="amount" required inputMode="decimal" className={`${inputClass} text-right`} />
              </Field>
              <Field label="Date">
                <input type="date" name="expense_date" defaultValue={today} className={inputClass} />
              </Field>
              <Field label="Account">
                <select name="account_id" required className={inputClass}>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </Field>
              <Field label="Input tax">
                <select name="tax_id" className={inputClass} defaultValue="">
                  <option value="">None</option>
                  {taxes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
              <Field label="Trip" hint="Tagging it here is what puts the cost into the trip's margin.">
                <select name="booking_id" className={inputClass} defaultValue="">
                  <option value="">—</option>
                  {bookings.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                </select>
              </Field>
              <Field label="Analytic">
                <select name="analytic_id" className={inputClass} defaultValue="">
                  <option value="">—</option>
                  {analytics.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </Field>
              <Field label="Paid by">
                <select name="paid_by" className={inputClass} defaultValue="employee">
                  <option value="employee">Employee (reimbursable)</option>
                  <option value="company">Company card / cash</option>
                </select>
              </Field>
              <input type="hidden" name="journal_id" value={journals.find((j) => j.type === 'general')?.id ?? ''} />
              <button className={`${btn.primary} w-full`}>Submit claim</button>
            </form>
          </Card>

          <Card title="Employee advance"
            subtitle="Cash handed over before the trip. It sits as an asset until the claims come in.">
            <form action={employeeAdvanceAction} className="space-y-3">
              <Field label="Employee"><input name="employee_name" required className={inputClass} /></Field>
              <Field label="Amount">
                <input name="amount" required inputMode="decimal" className={`${inputClass} text-right`} />
              </Field>
              <Field label="Date">
                <input type="date" name="date" defaultValue={today} className={inputClass} />
              </Field>
              <Field label="Paid from">
                <select name="journal_id" className={inputClass}>
                  {cashJournals.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}
                </select>
              </Field>
              <Field label="Note"><input name="note" className={inputClass} /></Field>
              <button className={`${btn.ghost} w-full`}>Pay advance</button>
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}
