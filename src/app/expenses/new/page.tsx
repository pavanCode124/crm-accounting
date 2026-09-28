import { ctx } from '@/server/bootstrap';
import { msg, one, type SearchParams } from '@/lib/range';
import { accountOptions, journalOptions, analyticOptions, bookingOptions } from '@/server/options';
import { listTaxes } from '@/server/accounting/tax';
import { isoDate } from '@/lib/accounting';
import { saveExpenseAction, employeeAdvanceAction } from '@/app/actions';
import { PageHeader, Card, Banner, Tabs, Field, inputClass, btn, LinkButton } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The two ways money reaches an employee, on one page with two tabs.
 *
 * They are genuinely different transactions — a CLAIM is a cost the agency has
 * already incurred and owes back, an ADVANCE is cash handed over before the
 * trip that sits as an asset until claims are filed against it — so they get
 * separate forms rather than one form with a mode switch. They share a page
 * because whoever is doing one is, often as not, about to do the other.
 */
export default async function NewExpensePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const params = await searchParams;
  const m = msg(params);
  const tab = one(params, 'tab') === 'advance' ? 'advance' : 'claim';

  const accounts = accountOptions(s.orgId, ['expense_direct', 'expense_operating']);
  const journals = journalOptions(s.orgId);
  const cashJournals = journalOptions(s.orgId, ['bank', 'cash']);
  const analytics = analyticOptions(s.orgId);
  const bookings = bookingOptions(s.orgId);
  const taxes = listTaxes(s.orgId, 'purchase');
  const today = isoDate();

  return (
    <>
      <PageHeader
        title={tab === 'advance' ? 'New Employee Advance' : 'New Expense Claim'}
        subtitle={tab === 'advance'
          ? 'Cash handed over before the trip. It sits as an asset until the claims come in.'
          : 'The ledger moves at approval, not at submission — filing this claim commits nothing.'}
        accent="var(--color-sec-settings)"
        actions={<LinkButton href="/expenses">Cancel</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}

      <div className="max-w-2xl">
        <Tabs
          active={tab === 'advance' ? '/expenses/new?tab=advance' : '/expenses/new?tab=claim'}
          tabs={[
            { label: 'Expense claim', href: '/expenses/new?tab=claim' },
            { label: 'Employee advance', href: '/expenses/new?tab=advance' },
          ]}
        />

        <Card>
          {tab === 'claim' ? (
            <form action={saveExpenseAction} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Employee">
                  <input name="employee_name" defaultValue={s.userName} className={inputClass} />
                </Field>
                <Field label="Date">
                  <input type="date" name="expense_date" defaultValue={today} className={inputClass} />
                </Field>
              </div>

              <Field label="Description">
                <input name="description" required className={inputClass} placeholder="Local guide — Bali day 3" />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Amount">
                  <input name="amount" required inputMode="decimal" className={`${inputClass} text-right`} />
                </Field>
                <Field label="Input tax">
                  <select name="tax_id" className={inputClass} defaultValue="">
                    <option value="">None</option>
                    {taxes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </Field>
              </div>

              <Field label="Account">
                <select name="account_id" required className={inputClass}>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
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
              </div>

              <Field label="Paid by">
                <select name="paid_by" className={inputClass} defaultValue="employee">
                  <option value="employee">Employee (reimbursable)</option>
                  <option value="company">Company card / cash</option>
                </select>
              </Field>

              <input type="hidden" name="journal_id" value={journals.find((j) => j.type === 'general')?.id ?? ''} />

              <div className="flex items-center gap-2 pt-1">
                <button className={btn.primary}>Submit claim</button>
                <LinkButton href="/expenses">Cancel</LinkButton>
              </div>
            </form>
          ) : (
            <form action={employeeAdvanceAction} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Employee">
                  <input name="employee_name" required className={inputClass} />
                </Field>
                <Field label="Date">
                  <input type="date" name="date" defaultValue={today} className={inputClass} />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Amount">
                  <input name="amount" required inputMode="decimal" className={`${inputClass} text-right`} />
                </Field>
                <Field label="Paid from">
                  <select name="journal_id" className={inputClass}>
                    {cashJournals.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}
                  </select>
                </Field>
              </div>

              <Field label="Note"><input name="note" className={inputClass} /></Field>

              <div className="flex items-center gap-2 pt-1">
                <button className={btn.primary}>Pay advance</button>
                <LinkButton href="/expenses">Cancel</LinkButton>
              </div>
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
