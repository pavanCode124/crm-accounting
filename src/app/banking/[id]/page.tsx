import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { getBankAccount, listBankTransactions } from '@/server/accounting/banking';
import { fmtDate } from '@/lib/accounting';
import { importStatementAction } from '@/app/actions';
import {
  PageHeader, Card, StatTile, Banner, Table, Th, Td, Money, Chip, EmptyState, Field, inputClass, btn,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * One bank account: its balance per the ledger, and the statement lines
 * imported against it.
 *
 * Importing changes NO balance. A statement line is what the bank says
 * happened; a journal entry is what the agency says it was. The gap between
 * the two is exactly what reconciliation closes, and collapsing them would
 * throw away the only control the process has.
 */
export default async function BankAccountPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<SearchParams>;
}) {
  const s = ctx();
  const { id } = await params;
  const m = msg(await searchParams);
  const account = getBankAccount(s.orgId, id);
  if (!account) return <Banner tone="error">That bank account no longer exists.</Banner>;

  const txns = listBankTransactions(s.orgId, { bankAccountId: id, limit: 200 });
  const unreconciled = txns.filter((t) => t.state === 'unreconciled');
  const statementNet = txns.reduce((sum, t) => sum + t.amount, 0);

  return (
    <>
      <PageHeader
        title={account.name}
        subtitle={[account.bank_name, account.account_no && `••••${account.account_no.slice(-4)}`, account.currency]
          .filter(Boolean).join(' · ')}
        accent="var(--color-sec-banking)"
        actions={<Link href={`/banking/reconcile?account=${id}`} className={btn.primary}>Reconcile</Link>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile label="Balance per ledger" value={account.balance ?? 0} compact={false} />
        <StatTile label="Statement lines" value={String(txns.length)}
          hint={`${unreconciled.length} still to explain`} tone={unreconciled.length ? 'warn' : 'positive'} />
        <StatTile label="Net imported" value={statementNet} compact={false} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Card title="Statement lines" padded={false}>
          {txns.length === 0 ? (
            <EmptyState title="No statement imported yet."
              hint="Upload the bank's CSV export beside this list, or paste the rows." />
          ) : (
            <Table>
              <thead>
                <tr><Th>Date</Th><Th>Description</Th><Th>Reference</Th>
                  <Th align="right">Amount</Th><Th>Status</Th></tr>
              </thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t.id} className="hover:bg-canvas">
                    <Td>{fmtDate(t.txn_date)}</Td>
                    <Td><span className="font-semibold">{t.description}</span></Td>
                    <Td><span className="num !text-left text-ink-muted">{t.reference ?? '—'}</span></Td>
                    <Td align="right">
                      <span className={`num font-bold ${t.amount > 0 ? 'text-positive' : 'text-negative'}`}>
                        {t.amount > 0 ? '+' : '−'}₹{(Math.abs(t.amount) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </span>
                    </Td>
                    <Td><Chip state={t.state} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title="Import a statement"
          subtitle="CSV from the bank. Date plus either an Amount column or a Debit/Credit pair.">
          <form action={importStatementAction} className="space-y-3">
            <input type="hidden" name="bank_account_id" value={id} />
            <Field label="CSV file">
              <input type="file" name="file" accept=".csv,text/csv"
                className="w-full text-[13px] file:mr-3 file:rounded-[8px] file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-[12.5px] file:font-bold file:text-brand" />
            </Field>
            <Field label="…or paste the rows" hint="Header row first — dd/mm/yyyy dates are understood.">
              <textarea name="csv" rows={6} className={inputClass}
                placeholder={'Date,Narration,Ref,Withdrawal,Deposit,Balance\n27/09/2026,UPI/RAHUL,UPI/1123,,75000,842000'} />
            </Field>
            <button className={`${btn.primary} w-full`}>Import</button>
          </form>
          <p className="mt-3 text-[12px] text-ink-faint">
            Re-importing an overlapping statement is safe: a line with the same date, amount and
            reference as one already here is skipped rather than duplicated.
          </p>
        </Card>
      </div>
    </>
  );
}
