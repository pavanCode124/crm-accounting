import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { one, resolveRange, type SearchParams } from '@/lib/range';
import { ledgerAccount } from '@/server/accounting/books';
import { listAccounts } from '@/server/accounting/masters';
import { fmtDate, kindLabel, kindSign, drCr } from '@/lib/accounting';
import { RangeBar } from '@/components/RangeBar';
import {
  PageHeader, Card, Table, Th, Td, Money, DrCrMoney, EmptyState, RefLink, StatTile,
  inputClass, btn, Banner,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * A Ledger Account — one account's folio, in the form a ledger is kept in.
 *
 * WHAT THIS HAS THAT THE GENERAL LEDGER DOES NOT: the `Particulars` column,
 * naming the CONTRA account on the other side of each entry. That column is
 * what makes a ledger readable — "By Sales A/c", "To Bank A/c" — and it cannot
 * come from the line itself, it has to be derived from the line's siblings in
 * the same entry. See ledgerAccount() in server/accounting/books.ts.
 *
 * Two presentations of the same rows are offered, because accountants want
 * both and for different jobs:
 *   - Statement form (default): one chronological list with a running balance,
 *     which is what you send a customer and what you tick against a statement.
 *   - T form: debits on the left, credits on the right, with the balancing
 *     figure carried down — the classical folio, and the one that makes the
 *     arithmetic of "balance c/d" visible.
 */
export default async function LedgerAccountPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const params = await searchParams;
  const range = resolveRange(
    { range: one(params, 'range'), from: one(params, 'from'), to: one(params, 'to') }, s.fyStartMonth,
  );
  const accountId = one(params, 'account');
  const form = one(params, 'form') === 't' ? 't' : 'statement';

  const accounts = listAccounts(s.orgId, { activeOnly: false });
  const report = accountId ? ledgerAccount(s.orgId, accountId, range) : null;

  return (
    <>
      <PageHeader
        title="Ledger Account"
        subtitle={report?.account
          ? `${report.account.code} — ${report.account.name} · ${fmtDate(range.from)} to ${fmtDate(range.to)}`
          : 'Pick an account to open its folio.'}
        accent="var(--color-sec-reports)"
      />

      <form method="get"
        className="no-print mb-5 flex flex-wrap items-end gap-2 rounded-card border border-line bg-surface px-4 py-3">
        <input type="hidden" name="range" value={range.key} />
        <input type="hidden" name="from" value={range.from} />
        <input type="hidden" name="to" value={range.to} />
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">Account</span>
          <select name="account" defaultValue={accountId ?? ''} className={`${inputClass} w-[320px]`}>
            <option value="">Select an account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">Form</span>
          <select name="form" defaultValue={form} className={`${inputClass} w-[170px]`}>
            <option value="statement">Statement</option>
            <option value="t">T-account</option>
          </select>
        </label>
        <button className={btn.primary}>Open</button>
        {accountId && (
          <Link href={`/reports/general-ledger?account=${accountId}&from=${range.from}&to=${range.to}`}
            className={btn.ghost}>
            Open in General Ledger
          </Link>
        )}
      </form>

      <RangeBar action="/reports/ledger-account" range={range}
        extra={{ account: accountId, form }} />

      {!report && (
        <Card>
          <EmptyState title="No account selected."
            hint="Choose an account above, or arrive here from the Chart of Accounts or the Trial Balance." />
        </Card>
      )}

      {report && !report.account && <Banner tone="error">That account no longer exists.</Banner>}

      {report?.account && (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Opening balance" value={Math.abs(report.opening)} compact={false}
              hint={sideWord(report.opening)} />
            <StatTile label="Debits" value={report.debit} compact={false} />
            <StatTile label="Credits" value={report.credit} compact={false} />
            <StatTile label="Closing balance" value={Math.abs(report.closing)} compact={false}
              hint={`${sideWord(report.closing)} · normally ${
                kindSign(report.account.kind) === 1 ? 'Debit' : 'Credit'}`}
              tone={onExpectedSide(report.closing, report.account.kind) ? 'neutral' : 'warn'} />
          </div>

          {!onExpectedSide(report.closing, report.account.kind) && report.closing !== 0 && (
            <Banner tone="warn">
              This {kindLabel(report.account.kind).toLowerCase()} account is carrying a{' '}
              {sideWord(report.closing).toLowerCase()} balance, which is the opposite of its normal
              side. Legitimate for an overdrawn bank or an advance from a customer — worth checking
              otherwise.
            </Banner>
          )}

          {report.truncated && (
            <Banner tone="info">
              Showing the first 1,000 postings of this window. Narrow the period to see the rest —
              the opening balance above is still exact.
            </Banner>
          )}

          {form === 't'
            ? <TAccount report={report} range={range} />
            : <StatementForm report={report} range={range} />}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Statement form
// ---------------------------------------------------------------------------

function StatementForm({ report, range }: {
  report: NonNullable<Awaited<ReturnType<typeof ledgerAccount>>>; range: { from: string; to: string };
}) {
  return (
    <Card padded={false} title="Statement form"
      subtitle="Chronological, with the balance after every posting.">
      {report.rows.length === 0 ? (
        <EmptyState title="No postings in this window."
          hint="The opening balance above still applies." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th width="105px">Date</Th><Th width="125px">Entry</Th><Th width="65px">Jnl</Th>
              <Th>Particulars</Th><Th>Narration</Th>
              <Th align="right" width="120px">Debit</Th>
              <Th align="right" width="120px">Credit</Th>
              <Th align="right" width="145px">Balance</Th>
            </tr>
          </thead>
          <tbody>
            <tr className="bg-canvas">
              <Td>{fmtDate(range.from)}</Td>
              <Td colSpan={6}><span className="font-bold">Opening balance b/f</span></Td>
              <Td align="right"><DrCrMoney value={report.opening} bold /></Td>
            </tr>
            {report.rows.map((r) => (
              <tr key={r.id} className="hover:bg-canvas">
                <Td>{fmtDate(r.entry_date)}</Td>
                <Td><RefLink href={`/accounting/entries/${r.entry_id}`}>{r.entry_no ?? 'Draft'}</RefLink></Td>
                <Td><span className="text-ink-muted">{r.journal_code}</span></Td>
                <Td>
                  <span className="font-semibold">{r.particulars}</span>
                  {r.partner_name && <span className="text-ink-muted"> — {r.partner_name}</span>}
                </Td>
                <Td><span className="text-ink-muted">{r.label ?? r.reference ?? '—'}</span></Td>
                <Td align="right"><Money value={r.debit} /></Td>
                <Td align="right"><Money value={r.credit} /></Td>
                <Td align="right"><DrCrMoney value={r.running} /></Td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-brand-soft">
              <Td colSpan={5}><span className="font-extrabold">Totals for the period</span></Td>
              <Td align="right"><Money value={report.debit} bold dash={false} /></Td>
              <Td align="right"><Money value={report.credit} bold dash={false} /></Td>
              <Td align="right"><DrCrMoney value={report.closing} bold /></Td>
            </tr>
          </tfoot>
        </Table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// T form
// ---------------------------------------------------------------------------

/**
 * The classical folio: debit side left, credit side right.
 *
 * The balancing figure is the point of this layout. The two sides are totalled
 * to the SAME grand total, and the difference between them is inserted on the
 * lighter side as "Balance c/d" — which is how a hand-kept ledger proves it
 * closed correctly. Opening balance goes in as "Balance b/d" on whichever side
 * it sits.
 *
 * Rendered as two independent tables side by side rather than one six-column
 * table, because the two sides have different row counts and a shared table
 * would force blank cells to keep them aligned.
 */
function TAccount({ report, range }: {
  report: NonNullable<Awaited<ReturnType<typeof ledgerAccount>>>; range: { from: string; to: string };
}) {
  const open = drCr(report.opening);
  const close = drCr(report.closing);

  // Opening sits on its own side; the closing balance is carried down on the
  // OPPOSITE side to the one it belongs on, which is what makes both columns
  // add to the same figure.
  const debitRows = [
    ...(open.debit ? [{ key: 'ob', date: range.from, text: 'To Balance b/d', amount: open.debit, href: null as string | null }] : []),
    ...report.rows.filter((r) => r.debit > 0).map((r) => ({
      key: r.id, date: r.entry_date, text: `To ${r.particulars}`, amount: r.debit,
      href: `/accounting/entries/${r.entry_id}`,
    })),
    ...(close.credit ? [{ key: 'cd', date: range.to, text: 'To Balance c/d', amount: close.credit, href: null }] : []),
  ];
  const creditRows = [
    ...(open.credit ? [{ key: 'ob', date: range.from, text: 'By Balance b/d', amount: open.credit, href: null as string | null }] : []),
    ...report.rows.filter((r) => r.credit > 0).map((r) => ({
      key: r.id, date: r.entry_date, text: `By ${r.particulars}`, amount: r.credit,
      href: `/accounting/entries/${r.entry_id}`,
    })),
    ...(close.debit ? [{ key: 'cd', date: range.to, text: 'By Balance c/d', amount: close.debit, href: null }] : []),
  ];

  const debitTotal = debitRows.reduce((s, r) => s + r.amount, 0);
  const creditTotal = creditRows.reduce((s, r) => s + r.amount, 0);

  return (
    <Card padded={false}
      title={`Dr.    ${report.account!.name}    Cr.`}
      subtitle="Both sides total to the same figure; the difference is the balance carried down.">
      <div className="grid md:grid-cols-2 md:divide-x md:divide-[var(--color-line)]">
        <TSide rows={debitRows} total={debitTotal} grand={Math.max(debitTotal, creditTotal)} side="Dr" />
        <TSide rows={creditRows} total={creditTotal} grand={Math.max(debitTotal, creditTotal)} side="Cr" />
      </div>
      <div className="border-t border-line px-5 py-3 text-[12.5px] text-ink-muted">
        Balance carried down: <strong className="num">{fmtAbs(report.closing)}</strong>{' '}
        {sideWord(report.closing)} — which is the balance brought down on the{' '}
        {sideWord(report.closing).toLowerCase()} side of the next period.
      </div>
    </Card>
  );
}

function TSide({ rows, total, grand, side }: {
  rows: Array<{ key: string; date: string; text: string; amount: number; href: string | null }>;
  total: number; grand: number; side: 'Dr' | 'Cr';
}) {
  return (
    <Table>
      <thead>
        <tr>
          <Th width="100px">Date</Th>
          <Th>Particulars ({side})</Th>
          <Th align="right" width="130px">Amount</Th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr><Td colSpan={3}><span className="text-ink-faint">Nil</span></Td></tr>
        )}
        {rows.map((r) => (
          <tr key={r.key} className="hover:bg-canvas">
            <Td>{fmtDate(r.date)}</Td>
            <Td>
              {r.href
                ? <Link href={r.href} className="font-semibold text-brand hover:underline">{r.text}</Link>
                : <span className="font-bold">{r.text}</span>}
            </Td>
            <Td align="right"><Money value={r.amount} /></Td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="bg-brand-soft">
          <Td colSpan={2}><span className="font-extrabold">Total</span></Td>
          <Td align="right"><Money value={total} bold dash={false} /></Td>
        </tr>
        {total !== grand && (
          <tr>
            <Td colSpan={3}>
              <span className="text-[12px] font-bold text-negative">
                Does not agree with the other side — report this.
              </span>
            </Td>
          </tr>
        )}
      </tfoot>
    </Table>
  );
}

// ---------------------------------------------------------------------------

function sideWord(balance: number): string {
  return balance > 0 ? 'Debit' : balance < 0 ? 'Credit' : 'Nil';
}

function fmtAbs(minor: number): string {
  return `₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

/** Is this balance on the side its account kind says it should be? */
function onExpectedSide(balance: number, kind: string): boolean {
  if (balance === 0) return true;
  return (balance > 0 ? 1 : -1) === kindSign(kind);
}
