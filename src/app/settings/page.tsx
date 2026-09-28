import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { allSettings } from '@/server/accounting/settings';
import { accountOptions, journalOptions } from '@/server/options';
import { listUsers } from '@/server/accounting/masters';
import { ROLE_CAPS, FINANCE_CAPS, can, titleise } from '@/lib/accounting';
import { saveSettingsAction, resetAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, Field, inputClass, btn, Chip, DefList,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Accounting settings.
 *
 * This page is the reason the posting engine never names an account. Every
 * default below is a row in `org_settings`, and the engine asks for it by key
 * — so an agency that renumbers its chart, or keeps two advance accounts,
 * changes a dropdown here rather than a constant in a posting routine.
 */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  const current = await allSettings(s.orgId);
  const accounts = await accountOptions(s.orgId);
  const journals = await journalOptions(s.orgId);
  const users = await listUsers(s.orgId);
  const mayConfigure = can(s.role, 'coa.configure');

  const accountKeys: Array<[string, string, string]> = [
    ['account.receivable', 'Accounts receivable', 'Where a customer invoice puts what is owed.'],
    ['account.payable', 'Accounts payable', 'Where a vendor bill puts what the agency owes.'],
    ['account.customer_advance', 'Customer advances', 'A LIABILITY — money taken before the trip is invoiced.'],
    ['account.supplier_advance', 'Supplier advances', 'An ASSET — money paid before the supplier bills.'],
    ['account.customer_refund_payable', 'Customer refunds payable', 'Credits owed back on a cancellation.'],
    ['account.tds_payable', 'TDS payable', 'Withholding deducted from suppliers, owed to the government.'],
    ['account.retained_earnings', 'Retained earnings', 'Where the year-end close puts the profit.'],
    ['account.commission_expense', 'Commission expense', ''],
    ['account.commission_payable', 'Commission payable', ''],
    ['account.employee_advance', 'Employee advances', 'Runs as a balance per employee.'],
    ['account.bank_charges', 'Bank charges', ''],
    ['account.fx_gain', 'Foreign exchange gain', ''],
    ['account.fx_loss', 'Foreign exchange loss', ''],
    ['account.opening_balance', 'Opening balance / capital', 'Carries a deliberate opening difference.'],
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
  ];

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Which account the engine reaches for when nothing more specific is set."
        accent="var(--color-sec-settings)"
        actions={<Link href="/settings/products" className={btn.ghost}>Products & services →</Link>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}
      {!mayConfigure && (
        <Banner tone="info">
          Your role can read these settings but not change them. Configuring the chart of accounts
          is an admin capability.
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
              <button className={`${btn.primary} mt-5 w-full`}>Save settings</button>
            )}
          </Card>

          <Card title="Organisation">
            <DefList rows={[
              ['Name', s.orgName],
              ['Currency', s.currency],
              ['Fiscal year starts', new Date(2000, s.fyStartMonth - 1, 1)
                .toLocaleDateString('en-IN', { month: 'long' })],
              ['Signed in as', `${s.userName} · ${titleise(s.role)}`],
            ]} />
          </Card>
        </div>
      </form>

      <Card title="Finance permissions" className="mt-5" padded={false}
        subtitle="What each role may do. Enforced on the server, not by hiding buttons.">
        <Table>
          <thead>
            <tr>
              <Th>Capability</Th>
              {Object.keys(ROLE_CAPS).filter((r) => r !== 'service_role').map((r) => (
                <Th key={r} align="center">{titleise(r)}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FINANCE_CAPS.map((cap) => (
              <tr key={cap} className="hover:bg-canvas">
                <Td><span className="font-semibold">{cap}</span></Td>
                {Object.keys(ROLE_CAPS).filter((r) => r !== 'service_role').map((r) => (
                  <Td key={r} align="center">
                    {ROLE_CAPS[r].includes(cap)
                      ? <span className="font-bold text-positive">✓</span>
                      : <span className="text-ink-faint">·</span>}
                  </Td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card title="Users" className="mt-5" padded={false}>
        <Table>
          <thead><tr><Th>Name</Th><Th>Email</Th><Th>Role</Th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <Td><span className="font-semibold">{u.name}</span></Td>
                <Td><span className="text-ink-muted">{u.email ?? '—'}</span></Td>
                <Td><Chip state="draft" label={titleise(u.role)} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="px-5 py-4 text-[12.5px] text-ink-faint">
          Users and roles come from the CRM in production. Set <code>TRIPZO_USER</code> to an email
          here to see the product as that role.
        </p>
      </Card>

      {mayConfigure && (
        <Card title="Reset the books" className="mt-5"
          subtitle="Wipes every transaction and re-seeds the demo agency. There is no undo.">
          <form action={resetAction} className="flex flex-wrap items-end gap-3">
            <Field label="Type RESET to confirm">
              <input name="confirm" className={`${inputClass} w-[200px]`} placeholder="RESET" />
            </Field>
            <button className={btn.danger}>Reset and re-seed</button>
          </form>
        </Card>
      )}
    </>
  );
}
