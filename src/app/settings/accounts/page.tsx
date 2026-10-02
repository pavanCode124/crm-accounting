import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { allSettings } from '@/server/accounting/settings';
import { accountOptions, journalOptions } from '@/server/options';
import { can } from '@/lib/accounting';
import { saveSettingsAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Field, inputClass, btn,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Default accounts and journals.
 *
 * This page is the reason the posting engine never names an account. Every
 * default below is a row in `org_settings`, and the engine asks for it by key
 * — so an agency that renumbers its chart, or keeps two advance accounts,
 * changes a dropdown here rather than a constant in a posting routine.
 *
 * It was moved off the main Settings page when settings became a section
 * rather than a page: this is the screen an accountant visits twice, at
 * onboarding and when a posting fails with "setting X is not configured", and
 * it was previously buried above a permissions matrix and a reset button.
 */
export default async function DefaultAccountsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  const current = await allSettings(s.orgId);
  const accounts = await accountOptions(s.orgId);
  const journals = await journalOptions(s.orgId);
  const mayConfigure = can(s.role, 'coa.configure');

  const accountKeys: Array<[string, string, string]> = [
    ['account.receivable', 'Accounts receivable', 'Where a customer invoice puts what is owed.'],
    ['account.payable', 'Accounts payable', 'Where a vendor bill puts what the agency owes.'],
    ['account.customer_advance', 'Customer advances', 'A LIABILITY — money taken before the trip is invoiced.'],
    ['account.supplier_advance', 'Supplier advances', 'An ASSET — money paid before the supplier bills.'],
    ['account.customer_refund_payable', 'Customer refunds payable', 'Credits owed back on a cancellation.'],
    ['account.input_tax', 'Input tax', 'GST paid on supplier bills, recoverable.'],
    ['account.output_tax', 'Output tax', 'GST charged on invoices, payable.'],
    ['account.tds_payable', 'TDS payable', 'Withholding deducted from suppliers, owed to the government.'],
    ['account.retained_earnings', 'Retained earnings', 'Where the year-end close puts the profit.'],
    ['account.current_year', 'Current year earnings', 'The running result, before the year is closed.'],
    ['account.commission_expense', 'Commission expense', ''],
    ['account.commission_payable', 'Commission payable', ''],
    ['account.employee_advance', 'Employee advances', 'Runs as a balance per employee.'],
    ['account.bank_charges', 'Bank charges', ''],
    ['account.fx_gain', 'Foreign exchange gain', ''],
    ['account.fx_loss', 'Foreign exchange loss', ''],
    ['account.rounding', 'Rounding difference', 'Absorbs the paise a tax split cannot divide evenly.'],
    ['account.opening_balance', 'Opening balance / capital', 'Carries a deliberate opening difference.'],
    /*
     * CHANNEL SETTLEMENTS. Three cost accounts rather than one, because an
     * agency deciding whether a channel is worth selling through compares
     * commission (which scales with value) against logistics (which scales with
     * order count) against the fixed charges it pays whether anything sold or
     * not. One bucket hides exactly that comparison.
     *
     * The last two are ASSETS and the labels say so. TCS and TDS arrive looking
     * like deductions, and booking them as costs understates the profit and
     * loses the set-off — the agency then pays the same tax twice.
     */
    ['account.channel_commission', 'Channel commission', 'What an OTA or marketplace keeps on each order.'],
    ['account.channel_shipping', 'Channel shipping & returns', 'Per-order logistics and return fees.'],
    ['account.channel_charges', 'Channel charges — other', 'Storage, advertising, recall and one-off notes.'],
    ['account.channel_recovery', 'Channel recoveries', 'What a channel pays BACK — reimbursements and credit notes.'],
    ['account.tcs_receivable', 'TCS receivable', 'An ASSET. Tax collected on the agency’s behalf, set off at assessment.'],
    ['account.tds_receivable', 'TDS receivable', 'An ASSET. Income tax withheld under 194-O, not a cost.'],
  ];

  const journalKeys: Array<[string, string]> = [
    ['journal.sale', 'Customer invoices'],
    ['journal.sale_refund', 'Customer credit notes'],
    ['journal.purchase', 'Vendor bills'],
    ['journal.purchase_refund', 'Vendor credit notes'],
    ['journal.bank', 'Default bank'],
    ['journal.cash', 'Default cash'],
    ['journal.customer_payment', 'Customer payments'],
    ['journal.vendor_payment', 'Supplier payments'],
    ['journal.general', 'Miscellaneous / adjustments'],
    ['journal.expense', 'Employee expenses'],
    ['journal.asset', 'Depreciation & deferrals'],
  ];

  const missing = [...accountKeys, ...journalKeys].filter(([key]) => !current[key]).length;

  return (
    <>
      <PageHeader
        title="Default Accounts & Journals"
        subtitle="Which account the engine reaches for when nothing more specific is set."
        accent="var(--color-sec-settings)"
        actions={
          <Link href="/accounting/chart-of-accounts" className={btn.ghost}>Chart of accounts →</Link>
        }
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}
      {!mayConfigure && (
        <Banner tone="info">
          Your role can read these settings but not change them. Configuring the chart of accounts
          is an admin capability.
        </Banner>
      )}
      {missing > 0 && (
        <Banner tone="warn">
          {missing} default{missing === 1 ? ' is' : 's are'} not set. A posting that needs one fails at
          the moment it is attempted, naming the key — which is a far better outcome than a silent
          posting to the wrong account, but it still stops the person trying to raise an invoice.
        </Banner>
      )}

      <form action={saveSettingsAction} className="grid gap-5 lg:grid-cols-2">
        <Card title="Default accounts"
          subtitle="Named here, never in the posting code — that is what makes the chart configurable.">
          <div className="space-y-3">
            {accountKeys.map(([key, label, hint]) => (
              <Field key={key} label={label} hint={hint || undefined}>
                <select name={`setting.${key}`} defaultValue={current[key] ?? ''}
                  disabled={!mayConfigure} className={inputClass}>
                  <option value="">— not set —</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </Field>
            ))}
          </div>
        </Card>

        <div className="space-y-5">
          <Card title="Default journals">
            <div className="space-y-3">
              {journalKeys.map(([key, label]) => (
                <Field key={key} label={label}>
                  <select name={`setting.${key}`} defaultValue={current[key] ?? ''}
                    disabled={!mayConfigure} className={inputClass}>
                    <option value="">— not set —</option>
                    {journals.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}
                  </select>
                </Field>
              ))}
            </div>
            {mayConfigure && (
              <button className={`${btn.primary} mt-5 w-full`}>Save defaults</button>
            )}
          </Card>
        </div>
      </form>
    </>
  );
}
