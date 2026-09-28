import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { listExpenses } from '@/server/accounting/expenses';
import { journalOptions } from '@/server/options';
import { fmtDate, isoDate, titleise, can } from '@/lib/accounting';
import { expenseWorkflowAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, Money, Chip, StatTile, EmptyState, btn, LinkButton,
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
  const mayApprove = can(s.role, 'payment.approve');
  // Only what the REIMBURSE button on a row needs. The claim form's options
  // moved to /expenses/new with it.
  const today = isoDate();
  const cashJournals = journalOptions(s.orgId, ['bank', 'cash']);

  const pending = expenses.filter((e) => e.state === 'submitted');
  const owed = expenses.filter((e) => e.state === 'posted')
    .reduce((sum, e) => sum + e.amount + e.tax_amount, 0);

  return (
    <>
      <PageHeader
        title="Expenses"
        subtitle="What staff spent on the agency's behalf, and what is still owed back to them."
        accent="var(--color-sec-settings)"
        actions={
          <>
            <LinkButton href="/expenses/new?tab=advance">Pay advance</LinkButton>
            <LinkButton href="/expenses/new" variant="primary">+ New Claim</LinkButton>
          </>
        }
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile label="Awaiting approval" value={String(pending.length)}
          tone={pending.length ? 'warn' : 'positive'} />
        <StatTile label="Approved, not reimbursed" value={owed} compact={false} />
        <StatTile label="Claims this year" value={String(expenses.length)} />
      </div>

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
    </>
  );
}
