import { ctx } from '@/server/bootstrap';
import { one, resolveRange, priorYear, type SearchParams } from '@/lib/range';
import { profitAndLoss, type PlSection } from '@/server/accounting/reports';
import { fmtDate } from '@/lib/accounting';
import { marginPct } from '@/lib/money';
import { RangeBar } from '@/components/RangeBar';
import { PageHeader, Card, Table, Th, Td, Money, StatTile } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Profit & Loss — plan section 39.
 *
 * Laid out the way a travel agency reads it: revenue, then the DIRECT cost of
 * delivering those trips, then gross profit, then what it costs to keep the
 * office open. Gross margin is the number that tells an agency whether it is
 * pricing correctly; net margin tells it whether it is the right size. Rolling
 * both into one "expenses" block hides the first question entirely.
 */
export default async function PlPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const range = resolveRange(
    { range: await one(params, 'range'), from: await one(params, 'from'), to: await one(params, 'to') }, s.fyStartMonth,
  );
  const prior = priorYear(range);
  const pl = await profitAndLoss(s.orgId, range, prior);

  return (
    <>
      <PageHeader
        title="Profit & Loss"
        subtitle={`${fmtDate(range.from)} to ${fmtDate(range.to)} · generated from the general ledger`}
        accent="var(--color-sec-reports)"
      />
      <RangeBar action="/reports/profit-and-loss" range={range} />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Revenue" value={pl.revenue.total} />
        <StatTile label="Gross profit" value={pl.grossProfit}
          tone={pl.grossProfit >= 0 ? 'positive' : 'negative'}
          hint={`${marginPct(pl.revenue.total, pl.grossProfit)} gross margin`} />
        <StatTile label="Operating costs" value={pl.operating.total + pl.depreciation.total} />
        <StatTile label="Net profit" value={pl.netProfit}
          tone={pl.netProfit >= 0 ? 'positive' : 'negative'}
          hint={`${marginPct(pl.revenue.total, pl.netProfit)} net margin`} />
      </div>

      <Card padded={false}>
        <Table>
          <thead>
            <tr>
              <Th>Account</Th>
              <Th align="right" width="180px">This period</Th>
              <Th align="right" width="180px">Last year</Th>
            </tr>
          </thead>
          <tbody>
            <Section section={pl.revenue} />
            <Section section={pl.costOfSales} />
            <Subtotal label="Gross Profit" value={pl.grossProfit}
              compare={pl.comparison?.grossProfit} emphasis />
            <Section section={pl.operating} />
            <Section section={pl.depreciation} />
            <Subtotal label="Net Profit" value={pl.netProfit}
              compare={pl.comparison?.netProfit} emphasis strong />
          </tbody>
        </Table>
      </Card>

      <p className="mt-4 text-[12.5px] text-ink-faint">
        Only posted entries are included. Drafts are proposals and never appear in a statement.
      </p>
    </>
  );
}

function Section({ section }: { section: PlSection }) {
  if (section.rows.length === 0) return null;
  return (
    <>
      <tr className="bg-canvas">
        <Td colSpan={3}>
          <span className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-ink-faint">
            {section.label}
          </span>
        </Td>
      </tr>
      {section.rows.map((r) => (
        <tr key={r.account_id} className="hover:bg-canvas">
          <Td>
            <span className="num !text-left pl-4 font-semibold text-ink-faint">{r.code}</span>{' '}
            <span>{r.name}</span>
          </Td>
          <Td align="right"><Money value={r.amount} /></Td>
          <Td align="right"><span className="num text-ink-faint">—</span></Td>
        </tr>
      ))}
      <tr>
        <Td><span className="pl-4 font-bold">Total {section.label}</span></Td>
        <Td align="right"><Money value={section.total} bold dash={false} /></Td>
        <Td align="right"><span className="num text-ink-faint">—</span></Td>
      </tr>
    </>
  );
}

function Subtotal({ label, value, compare, emphasis, strong }: {
  label: string; value: number; compare?: number; emphasis?: boolean; strong?: boolean;
}) {
  return (
    <tr className={emphasis ? 'bg-brand-soft' : ''}>
      <Td>
        <span className={strong ? 'text-[15px] font-extrabold' : 'font-extrabold'}>{label}</span>
      </Td>
      <Td align="right">
        <span className={`num font-extrabold ${value < 0 ? 'text-negative' : 'text-positive'} ${strong ? 'text-[15px]' : ''}`}>
          {value < 0 ? '-' : ''}₹{(Math.abs(value) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
        </span>
      </Td>
      <Td align="right">
        {compare === undefined
          ? <span className="num text-ink-faint">—</span>
          : <Money value={compare} />}
      </Td>
    </tr>
  );
}
