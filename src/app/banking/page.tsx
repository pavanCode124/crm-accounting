import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { listBankAccounts } from '@/server/accounting/banking';
import { isoDate } from '@/lib/accounting';
import { transferAction } from '@/app/actions';
import {
  PageHeader, Card, StatTile, Banner, Field, inputClass, btn, Table, Th, Td, Money, Chip,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Banking.
 *
 * Cash accounts sit in the same list as bank accounts, because to the person
 * asking "how much have we got?" petty cash is just another account — and
 * because the ledger treats them identically: both are `asset_cash`, both are
 * reconciled against something outside the system.
 */
export default async function BankingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  const accounts = await listBankAccounts(s.orgId);
  const total = accounts.reduce((sum, a) => sum + (a.balance ?? 0), 0);
  const pending = accounts.reduce((sum, a) => sum + (a.unreconciled ?? 0), 0);
  const today = isoDate();

  return (
    <>
      <PageHeader
        title="Banking"
        subtitle="Balances as the ledger has them, and the statement lines still waiting to be explained."
        accent="var(--color-sec-banking)"
        actions={
          pending > 0
            ? <Link href="/banking/reconcile" className={btn.primary}>Reconcile {pending} line(s)</Link>
            : undefined
        }
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile label="Total cash position" value={total} hint={`${accounts.length} account(s)`} />
        <StatTile label="Unreconciled lines" value={String(pending)} tone={pending ? 'warn' : 'positive'}
          hint="Imported statement lines with nothing against them" />
        <StatTile label="As at" value={new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Card title="Accounts" padded={false}>
          <Table>
            <thead>
              <tr><Th>Account</Th><Th>Bank</Th><Th>Number</Th><Th align="right">Balance</Th>
                <Th align="right">To reconcile</Th><Th /></tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="hover:bg-canvas">
                  <Td>
                    <Link href={`/banking/${a.id}`} className="font-bold text-brand hover:underline">{a.name}</Link>
                    {!!a.is_cash && <div className="mt-1"><Chip state="draft" label="Cash" /></div>}
                  </Td>
                  <Td><span className="text-ink-muted">{a.bank_name ?? '—'}</span></Td>
                  <Td>
                    <span className="num !text-left text-ink-muted">
                      {a.account_no ? `••••${a.account_no.slice(-4)}` : '—'}
                    </span>
                  </Td>
                  <Td align="right"><Money value={a.balance ?? 0} bold dash={false} /></Td>
                  <Td align="right">
                    {a.unreconciled
                      ? <Chip state="unreconciled" label={`${a.unreconciled} line(s)`} />
                      : <span className="text-ink-faint">—</span>}
                  </Td>
                  <Td align="right">
                    <Link href={`/banking/${a.id}`} className="text-[12.5px] font-bold text-brand hover:underline">
                      Open
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-canvas">
                <Td colSpan={3}><span className="font-bold">Total</span></Td>
                <Td align="right"><Money value={total} bold dash={false} /></Td>
                <Td colSpan={2} />
              </tr>
            </tfoot>
          </Table>
        </Card>

        <Card title="Internal transfer"
          subtitle="Bank to cash, or between two of the agency's own accounts.">
          <form action={transferAction} className="space-y-3">
            <Field label="From">
              <select name="from_id" className={inputClass}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="To">
              <select name="to_id" className={inputClass} defaultValue={accounts[1]?.id}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Amount">
              <input name="amount" inputMode="decimal" required className={`${inputClass} text-right`} />
            </Field>
            <Field label="Date">
              <input type="date" name="date" defaultValue={today} className={inputClass} />
            </Field>
            <Field label="Note"><input name="note" className={inputClass} /></Field>
            <button className={`${btn.primary} w-full`}>Post transfer</button>
          </form>
          <p className="mt-3 text-[12px] text-ink-faint">
            A transfer is one balanced entry between two cash accounts. It changes where the money is,
            never how much there is.
          </p>
        </Card>
      </div>
    </>
  );
}
