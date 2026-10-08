import { ctx } from '@/server/bootstrap';
import { msg, one, type SearchParams } from '@/lib/range';
import { accountOptions, journalOptions, analyticOptions, bookingOptions, saleOptions, batchOptions } from '@/server/options';
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
  const s = await ctx();
  const params = await searchParams;
  const m = await msg(params);
  const tab = await one(params, 'tab') === 'advance' ? 'advance' : 'claim';

  const accounts = await accountOptions(s.orgId, ['expense_direct', 'expense_operating']);
  const journals = await journalOptions(s.orgId);
  const cashJournals = await journalOptions(s.orgId, ['bank', 'cash']);
  const analytics = await analyticOptions(s.orgId);
  const bookings = await bookingOptions(s.orgId);
  const sales = await saleOptions(s.orgId);
  const batches = await batchOptions(s.orgId);
  const taxes = await listTaxes(s.orgId, 'purchase');
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

              {/*
                THE SALE COMES FIRST, AND IT IS THE FIELD THAT MATTERS.

                A guide paid in cash on day three is a cost of the package that
                was sold, and it reaches that package's margin only if somebody
                says which package. The Trip field below used to be the only
                way to say it — and a trip is a CRM booking, which exists only
                for a lead carrying a package number, so for an agency without
                those it could not be filled and the cost reached nothing.

                Naming the invoice fills the trip in too, on the server, where
                the invoice has one. The two fields under it are kept for the
                agencies that work in bookings and for a cost that belongs to a
                trip but to no single invoice on it.
              */}
              <Field label="Against customer invoice"
                hint="The sale this was spent on. It is what puts the cost into that sale's margin — and into its trip's, where there is one.">
                <select name="linked_invoice_id" className={inputClass} defaultValue="">
                  <option value="">— not against a particular sale</option>
                  {sales.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Trip" hint="Only needed when the sale above does not already say which trip, or there is no invoice.">
                  <select name="booking_id" className={inputClass} defaultValue="">
                    <option value="">— from the invoice</option>
                    {bookings.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                  </select>
                </Field>
                <Field label="Analytic">
                  <select name="analytic_id" className={inputClass} defaultValue="">
                    <option value="">— from the invoice</option>
                    {analytics.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                </Field>
              </div>

              {/*
                Live from TripzoCRM, same field as on invoices and bills — a
                guide paid in cash on day three of a departure is often a cost
                of the whole batch rather than of one traveller's invoice.

                NO HIDDEN "batch_name" SNAPSHOT HERE, unlike the invoice form:
                this page is a server component with no script to keep one in
                sync via onChange. `saveExpenseAction` resolves the label from
                the chosen id against the same live list on save instead — see
                `resolveBatchName` in src/app/actions.ts.
              */}
              <Field label="Batch" hint="The CRM departure this was spent on, if it is for the batch as a whole rather than one invoice.">
                <select name="crm_batch_id" className={inputClass} defaultValue="">
                  <option value="">— not against a particular batch</option>
                  {batches.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                </select>
              </Field>

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
