import { Fragment } from 'react';
import { ctx } from '@/server/bootstrap';
import { one, type SearchParams } from '@/lib/range';
import { balanceSheet, type BsSection } from '@/server/accounting/reports';
import { fmtDate, isoDate } from '@/lib/accounting';
import { PageHeader, Card, Table, Th, Td, Money, Banner, StatTile, inputClass, btn } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Balance Sheet.
 *
 * The line most home-made ledgers get wrong is in here explicitly: profit for
 * the CURRENT, unclosed year sits on income and expense accounts, not on
 * equity, so a balance sheet that adds up only the balance-sheet accounts is
 * out by exactly that amount. It is shown as its own equity line rather than
 * folded silently into retained earnings, so the reader can see where it came
 * from — and the proof line at the bottom says whether the statement balances.
 */
export default async function BalanceSheetPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const asOf = await one(params, 'as_of') ?? isoDate();
  const bs = await balanceSheet(s.orgId, asOf, s.fyStartMonth);

  return (
    <>
      <PageHeader
        title="Balance Sheet"
        subtitle={`Position as at ${fmtDate(asOf)}`}
        accent="var(--color-sec-reports)"
        actions={
          <form method="get" className="flex items-end gap-2">
            <label>
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">As at</span>
              <input type="date" name="as_of" defaultValue={asOf} className={`${inputClass} w-[170px]`} />
            </label>
            <button className={btn.ghost}>Apply</button>
          </form>
        }
      />

      {!bs.balanced && (
        <Banner tone="error">
          The balance sheet is out by ₹{(Math.abs(bs.difference) / 100).toFixed(2)}. That should be
          impossible while every entry is balanced — check for a posting into an account whose type
          has been changed since.
        </Banner>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total assets" value={bs.assets.total} />
        <StatTile label="Total liabilities" value={bs.liabilities.total} />
        <StatTile label="Total equity" value={bs.equity.total} />
        <StatTile label="Profit this year" value={bs.currentYearProfit}
          tone={bs.currentYearProfit >= 0 ? 'positive' : 'negative'} hint="Not yet closed to reserves" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Assets" padded={false}>
          <SectionTable section={bs.assets} />
        </Card>
        <div className="space-y-5">
          <Card title="Liabilities" padded={false}>
            <SectionTable section={bs.liabilities} />
          </Card>
          <Card title="Equity" padded={false}>
            <SectionTable section={bs.equity} extraRow={{
              label: 'Profit for the current year', amount: bs.currentYearProfit,
            }} />
          </Card>
        </div>
      </div>

      <Card className="mt-5">
        <div className="flex flex-wrap items-center justify-between gap-4 text-[14px]">
          <span className="font-bold">
            Assets <Money value={bs.assets.total} bold dash={false} />
          </span>
          <span className="text-ink-faint">=</span>
          <span className="font-bold">
            Liabilities + Equity <Money value={bs.liabilities.total + bs.equity.total} bold dash={false} />
          </span>
          <span className={`font-extrabold ${bs.balanced ? 'text-positive' : 'text-negative'}`}>
            {bs.balanced ? 'Balanced' : `Out by ₹${(Math.abs(bs.difference) / 100).toFixed(2)}`}
          </span>
        </div>
      </Card>
    </>
  );
}

function SectionTable({ section, extraRow }: {
  section: BsSection; extraRow?: { label: string; amount: number };
}) {
  return (
    <Table>
      <thead><tr><Th>Account</Th><Th align="right" width="170px">Amount</Th></tr></thead>
      <tbody>
        {section.groups.map((g) => (
          <Fragment key={g.kind}>
            <tr className="bg-canvas">
              <Td colSpan={2}>
                <span className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-ink-faint">
                  {g.label}
                </span>
              </Td>
            </tr>
            {g.rows.map((r) => (
              <tr key={r.account_id} className="hover:bg-canvas">
                <Td>
                  <span className="num !text-left pl-4 font-semibold text-ink-faint">{r.code}</span>{' '}
                  {r.name}
                </Td>
                <Td align="right"><Money value={r.amount} /></Td>
              </tr>
            ))}
          </Fragment>
        ))}
        {extraRow && (
          <tr>
            <Td><span className="pl-4 font-semibold">{extraRow.label}</span></Td>
            <Td align="right"><Money value={extraRow.amount} /></Td>
          </tr>
        )}
      </tbody>
      <tfoot>
        <tr className="bg-brand-soft">
          <Td><span className="font-extrabold">Total {section.label}</span></Td>
          <Td align="right"><Money value={section.total} bold dash={false} /></Td>
        </tr>
      </tfoot>
    </Table>
  );
}
