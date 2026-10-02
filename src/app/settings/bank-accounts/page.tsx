import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { listBankAccounts } from '@/server/accounting/banking';
import { can } from '@/lib/accounting';
import {
  saveBankAccountAction, setDefaultBankAccountAction, archiveBankAccountAction,
} from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, Field, inputClass, btn, Chip, Money, EmptyState,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Bank and cash accounts.
 *
 * -------------------------------------------------------------------------
 * WHY THIS SCREEN EXISTS
 * -------------------------------------------------------------------------
 * Every money form in the product — Receive Payment, Send Payment, Transfer,
 * Reconcile — opens a dropdown of these. Until this screen existed that list
 * came from the seed, which meant the product shipped with three accounts
 * belonging to a demo agency and no way for a real one to add its own. An
 * agency with an HDFC current, an ICICI collections account, a forex card
 * float and a petty cash tin had to choose which three it was willing to
 * misfile the rest into.
 *
 * -------------------------------------------------------------------------
 * WHAT "ADD" ACTUALLY DOES
 * -------------------------------------------------------------------------
 * Three records, in one transaction — a GL account, a journal with its own
 * number series, and the account row (see upsertBankAccount in banking.ts).
 * The alternative, which is what an accountant doing this through the Chart of
 * Accounts and Journals screens has to do, reliably produces an account that
 * posts nowhere.
 *
 * CASH IS NOT A SPECIAL CASE. Petty cash is a row here like any other: same
 * balance, same book, same dropdown. The only difference `is_cash` makes is
 * the journal type and the sort order, so cash sits at the bottom of the list
 * where people expect it.
 */
export default async function BankAccountsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  const accounts = await listBankAccounts(s.orgId);
  const mayConfigure = can(s.role, 'coa.configure');
  const banks = accounts.filter((a) => !a.is_cash);
  const cash = accounts.filter((a) => a.is_cash);

  return (
    <>
      <PageHeader
        title="Bank & Cash Accounts"
        subtitle="Every account money can land in. Each one carries its own ledger account and its own journal."
        accent="var(--color-sec-settings)"
        actions={<Link href="/banking" className={btn.ghost}>Balances & reconciliation →</Link>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}
      {!mayConfigure && (
        <Banner tone="info">
          You can see the accounts but not change them — adding one creates a ledger account and a
          journal, which is an admin capability.
        </Banner>
      )}
      {cash.length === 0 && (
        <Banner tone="warn">
          There is no cash account. Add one called Petty Cash — a travel agency pays guides, tips and
          local transport in cash, and without an account for it those payments have nowhere to go.
        </Banner>
      )}

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-5">
          <Card title="Bank accounts" padded={false}
            subtitle="The default is what every payment form opens on.">
            {banks.length === 0 ? (
              <EmptyState title="No bank account yet." hint="Add the agency's main current account first." />
            ) : (
              <AccountTable rows={banks} mayConfigure={mayConfigure} />
            )}
          </Card>

          <Card title="Cash accounts" padded={false}
            subtitle="Petty cash, a branch float, a tour leader's advance tin — each its own account.">
            {cash.length === 0 ? (
              <EmptyState title="No cash account yet." />
            ) : (
              <AccountTable rows={cash} mayConfigure={mayConfigure} />
            )}
          </Card>
        </div>

        {mayConfigure && (
          <Card title="Add an account"
            subtitle="Creates the ledger account and the journal with it — nothing further to set up.">
            <form action={saveBankAccountAction} className="space-y-3">
              <Field label="Name" hint="What people pick in the dropdown. “HDFC — Current” beats “Account 2”.">
                <input name="name" required className={inputClass} placeholder="HDFC Bank — Current" />
              </Field>
              <Field label="Type">
                <select name="kind" defaultValue="bank" className={inputClass}>
                  <option value="bank">Bank account</option>
                  <option value="cash">Cash / petty cash</option>
                </select>
              </Field>
              <Field label="Bank" hint="Leave blank for a cash account.">
                <input name="bank_name" className={inputClass} placeholder="HDFC Bank Ltd" />
              </Field>
              <Field label="Account number">
                <input name="account_no" className={inputClass} placeholder="50100234561234" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="IFSC">
                  <input name="ifsc" className={inputClass} placeholder="HDFC0000123" />
                </Field>
                <Field label="Branch">
                  <input name="branch_name" className={inputClass} placeholder="Andheri East" />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="SWIFT" hint="For supplier payments abroad.">
                  <input name="swift" className={inputClass} placeholder="HDFCINBB" />
                </Field>
                <Field label="UPI ID">
                  <input name="upi_id" className={inputClass} placeholder="agency@hdfcbank" />
                </Field>
              </div>
              <Field label="Currency"
                hint="Anything other than the company currency books through the FX accounts.">
                <input name="currency" defaultValue={s.currency} maxLength={3}
                  className={`${inputClass} uppercase`} />
              </Field>
              <Field label="Note">
                <input name="note" className={inputClass} placeholder="Collections only — no outward payments" />
              </Field>
              <label className="flex items-center gap-2 text-[13px] font-semibold">
                <input type="checkbox" name="is_default" />
                Make this the default account
              </label>
              <button className={`${btn.primary} w-full`}>Add account</button>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}

function AccountTable({ rows, mayConfigure }: {
  rows: Awaited<ReturnType<typeof listBankAccounts>>; mayConfigure: boolean;
}) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Account</Th><Th>Bank</Th><Th>Number</Th><Th>Pay into</Th><Th>Currency</Th>
          <Th align="right">Balance</Th><Th />
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => (
          <tr key={a.id} className="hover:bg-canvas">
            <Td>
              <Link href={`/banking/${a.id}`} className="font-bold text-brand hover:underline">{a.name}</Link>
              {!!a.is_default && <span className="ml-2"><Chip state="posted" label="Default" /></span>}
              {a.note && <div className="text-[11.5px] text-ink-faint">{a.note}</div>}
            </Td>
            <Td>
              <span className="text-ink-muted">{a.bank_name ?? '—'}</span>
              {a.branch_name && <div className="text-[11.5px] text-ink-faint">{a.branch_name}</div>}
            </Td>
            <Td>
              {/* Masked. A settings list is read over shoulders and screen-shared;
                  the last four is enough to tell two accounts apart. */}
              <span className="num !text-left text-ink-muted">
                {a.account_no ? `••••${a.account_no.slice(-4)}` : '—'}
              </span>
              {a.ifsc && <div className="text-[11.5px] text-ink-faint">{a.ifsc}</div>}
            </Td>
            <Td>
              {/* Unmasked on purpose. A UPI handle and a SWIFT code are what you
                  hand a payer; they are not secrets the way an account number is,
                  and hiding them means looking the account up somewhere else. */}
              <span className="num !text-left text-ink-muted">{a.upi_id ?? '—'}</span>
              {a.swift && <div className="text-[11.5px] text-ink-faint">SWIFT {a.swift}</div>}
            </Td>
            <Td><span className="text-ink-muted">{a.currency}</span></Td>
            <Td align="right"><Money value={a.balance ?? 0} bold dash={false} /></Td>
            <Td align="right">
              {mayConfigure && (
                <div className="flex justify-end gap-3">
                  {!a.is_default && (
                    <form action={setDefaultBankAccountAction}>
                      <input type="hidden" name="id" value={a.id} />
                      <button className="text-[12px] font-bold text-ink-faint hover:text-brand">
                        Make default
                      </button>
                    </form>
                  )}
                  <form action={archiveBankAccountAction}>
                    <input type="hidden" name="id" value={a.id} />
                    <button className="text-[12px] font-bold text-ink-faint hover:text-negative">
                      Archive
                    </button>
                  </form>
                </div>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
