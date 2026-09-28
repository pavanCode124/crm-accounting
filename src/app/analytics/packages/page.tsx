import { ctx } from '@/server/bootstrap';
import { one, resolveRange, type SearchParams } from '@/lib/range';
import { packageProfitability } from '@/server/accounting/analytics';
import { fmt } from '@/lib/money';
import { RangeBar } from '@/components/RangeBar';
import { PageHeader, Card, Table, Th, Td, Money, StatTile, EmptyState, Bar } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Package profitability — plan section 26.
 *
 * Several trips of the same package, added up, so the agency can see which
 * products are worth selling rather than only which individual trips went
 * well. The per-booking averages are the useful column: a package that makes
 * ₹38,000 on average is a different business decision from one that made
 * ₹38,000 once.
 */
export default async function PackagesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const range = resolveRange(
    { range: await one(params, 'range'), from: await one(params, 'from'), to: await one(params, 'to') }, s.fyStartMonth,
  );
  const rows = await packageProfitability(s.orgId, range);
  const revenue = rows.reduce((sum, r) => sum + r.revenue, 0);
  const profit = rows.reduce((sum, r) => sum + r.profit, 0);
  const peak = Math.max(1, ...rows.map((r) => r.revenue));

  return (
    <>
      <PageHeader
        title="Package Profitability"
        subtitle="Which products actually make money, once every trip sold under them is counted."
        accent="var(--color-sec-analytics)"
      />
      <RangeBar action="/analytics/packages" range={range} />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile label="Revenue" value={revenue} />
        <StatTile label="Gross profit" value={profit} tone={profit >= 0 ? 'positive' : 'negative'} />
        <StatTile label="Packages sold" value={String(rows.length)} />
      </div>

      <Card padded={false}>
        {rows.length === 0 ? (
          <EmptyState title="No package activity in this window." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Package</Th><Th align="right">Bookings</Th>
                <Th align="right">Revenue</Th><Th align="right">Cost</Th>
                <Th align="right">Profit</Th><Th align="right">Margin</Th>
                <Th align="right">Avg profit / booking</Th><Th width="140px">Share</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.package_name} className="hover:bg-canvas">
                  <Td><span className="font-semibold">{r.package_name}</span></Td>
                  <Td align="right"><span className="num">{r.bookings}</span></Td>
                  <Td align="right"><Money value={r.revenue} /></Td>
                  <Td align="right"><Money value={r.cost} /></Td>
                  <Td align="right">
                    <span className={`num font-bold ${r.profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                      {fmt(r.profit)}
                    </span>
                  </Td>
                  <Td align="right"><span className="num font-bold">{r.margin.toFixed(1)}%</span></Td>
                  <Td align="right">
                    <Money value={r.bookings ? Math.round(r.profit / r.bookings) : 0} />
                  </Td>
                  <Td><Bar value={r.revenue} max={peak} color="var(--color-sec-analytics)" /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
