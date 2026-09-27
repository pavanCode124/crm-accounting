import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { one, resolveRange, type SearchParams } from '@/lib/range';
import { trialBalance } from '@/server/accounting/reports';
import { fmtDate, kindLabel, drCr } from '@/lib/accounting';
import { RangeBar } from '@/components/RangeBar';
import { PageHeader, Card, Table, Th, Td, Money, Banner, StatTile } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Trial Balance.
 *
 * The proof of the whole system. Opening plus movement equals closing, per
 * account, and the movement columns must total to the same figure — if they
 * ever do not, something has written to `journal_entry_lines` without going
 * through the posting engine, and that is the bug to chase before trusting any
 * other report on this site.
 */
export default async function TrialBalancePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const params = await searchParams;
  const range = resolveRange(
    { range: one(params, 'range'), from: one(params, 'from'), to: one(params, 'to') }, s.fyStartMonth,
  );
  const tb = trialBalance(s.orgId, range);

  // Opening and closing are stored signed; a trial balance prints them as two
  // columns each. Totalling the split columns rather than the signed figure is
  // the whole point — Dr total and Cr total agreeing IS the trial balance, and
  // a signed column summing to zero proves the same thing while showing nobody
  // the two numbers they came to check.
  const openDebit = tb.rows.reduce((sum, r) => sum + drCr(r.opening).debit, 0);
  const openCredit = tb.rows.reduce((sum, r) => sum + drCr(r.opening).credit, 0);
  const closingDebit = tb.rows.reduce((sum, r) => sum + drCr(r.closing).debit, 0);
  const closingCredit = tb.rows.reduce((sum, r) => sum + drCr(r.closing).credit, 0);

  return (
    <>
      <PageHeader
        title="Trial Balance"
        subtitle={`${fmtDate(range.from)} to ${fmtDate(range.to)}`}
        accent="var(--color-sec-reports)"
      />
      <RangeBar action="/reports/trial-balance" range={range} />

      {tb.balanced ? (
        <Banner tone="ok">
          Debits and credits agree at ₹{(tb.debit / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}.
        </Banner>
      ) : (
        <Banner tone="error">
          Out of balance by ₹{(Math.abs(tb.debit - tb.credit) / 100).toFixed(2)} — the ledger has been
          written to outside the posting engine.
        </Banner>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile label="Movement debits" value={tb.debit} compact={false} />
        <StatTile label="Movement credits" value={tb.credit} compact={false} />
        <StatTile label="Accounts with activity" value={String(tb.rows.length)} />
      </div>

      <Card padded={false}>
        <Table>
          {/*
            Six money columns in three pairs: opening balance, transactions for
            the period, closing balance — each as Debit and Credit. This is the
            format a chartered accountant reads a trial balance in, and the one
            that lets them tick opening + movement = closing across the row
            without doing sign arithmetic in their head.
          */}
          <thead>
            <tr>
              <Th /><Th /><Th />
              <Th align="center" colSpan={2}>Opening Balance</Th>
              <Th align="center" colSpan={2}>Transactions</Th>
              <Th align="center" colSpan={2}>Closing Balance</Th>
            </tr>
            <tr>
              <Th width="80px">Code</Th><Th>Account</Th><Th width="140px">Type</Th>
              <Th align="right" width="115px">Debit</Th><Th align="right" width="115px">Credit</Th>
              <Th align="right" width="115px">Debit</Th><Th align="right" width="115px">Credit</Th>
              <Th align="right" width="115px">Debit</Th><Th align="right" width="115px">Credit</Th>
            </tr>
          </thead>
          <tbody>
            {tb.rows.map((r) => {
              const open = drCr(r.opening);
              const close = drCr(r.closing);
              return (
                <tr key={r.account_id} className="hover:bg-canvas">
                  <Td><span className="num !text-left font-bold">{r.code}</span></Td>
                  <Td>
                    <Link href={`/reports/ledger-account?account=${r.account_id}&from=${range.from}&to=${range.to}`}
                      className="font-semibold text-brand hover:underline">{r.name}</Link>
                  </Td>
                  <Td><span className="text-ink-muted">{kindLabel(r.kind)}</span></Td>
                  <Td align="right"><Money value={open.debit} /></Td>
                  <Td align="right"><Money value={open.credit} /></Td>
                  <Td align="right"><Money value={r.debit} /></Td>
                  <Td align="right"><Money value={r.credit} /></Td>
                  <Td align="right"><Money value={close.debit} bold /></Td>
                  <Td align="right"><Money value={close.credit} bold /></Td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-brand-soft">
              <Td colSpan={3}><span className="font-extrabold">Totals</span></Td>
              <Td align="right"><Money value={openDebit} bold dash={false} /></Td>
              <Td align="right"><Money value={openCredit} bold dash={false} /></Td>
              <Td align="right"><Money value={tb.debit} bold dash={false} /></Td>
              <Td align="right"><Money value={tb.credit} bold dash={false} /></Td>
              <Td align="right"><Money value={closingDebit} bold dash={false} /></Td>
              <Td align="right"><Money value={closingCredit} bold dash={false} /></Td>
            </tr>
            {/* Each pair proved on its own line. All three must agree; naming
                which one failed is the difference between a bug report and a
                bug hunt. */}
            <tr>
              <Td colSpan={9}>
                <span className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] font-bold">
                  <Proof label="Opening" a={openDebit} b={openCredit} />
                  <Proof label="Transactions" a={tb.debit} b={tb.credit} />
                  <Proof label="Closing" a={closingDebit} b={closingCredit} />
                </span>
              </Td>
            </tr>
          </tfoot>
        </Table>
      </Card>
    </>
  );
}

/** One "Dr equals Cr" check, named, so a failure says which pair broke. */
function Proof({ label, a, b }: { label: string; a: number; b: number }) {
  const ok = a === b;
  return (
    <span className={ok ? 'text-positive' : 'text-negative'}>
      {label}: {ok ? 'Dr = Cr' : `out by ₹${(Math.abs(a - b) / 100).toFixed(2)}`}
    </span>
  );
}
