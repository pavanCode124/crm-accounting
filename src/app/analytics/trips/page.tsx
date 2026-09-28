import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { one, resolveRange, type SearchParams } from '@/lib/range';
import { tripProfitability } from '@/server/accounting/analytics';
import { fmt } from '@/lib/money';
import { RangeBar } from '@/components/RangeBar';
import { PageHeader, Card, Table, Th, Td, Money, StatTile, EmptyState, Bar } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Trip profitability — plan section 23.
 *
 * These are not a second set of numbers kept beside the ledger. Each row is the
 * SAME journal entry lines, sliced by the trip's analytic account, which is
 * why the totals here add up to the P&L rather than approximating it. Edit an
 * invoice and the margin below changes with it.
 */
export default async function TripsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const range = resolveRange(
    { range: await one(params, 'range'), from: await one(params, 'from'), to: await one(params, 'to') }, s.fyStartMonth,
  );
  const trips = await tripProfitability(s.orgId, range);

  const revenue = trips.reduce((sum, t) => sum + t.revenue, 0);
  const cost = trips.reduce((sum, t) => sum + t.cost, 0);
  const profit = revenue - cost;
  const peak = Math.max(1, ...trips.map((t) => t.revenue));
  const thin = trips.filter((t) => t.margin < 10 && t.revenue > 0);

  return (
    <>
      <PageHeader
        title="Trip Profitability"
        subtitle="What each trip earned against what it cost to run — straight from the ledger."
        accent="var(--color-sec-analytics)"
      />
      <RangeBar action="/analytics/trips" range={range} />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Trip revenue" value={revenue} />
        <StatTile label="Trip cost" value={cost} />
        <StatTile label="Gross profit" value={profit} tone={profit >= 0 ? 'positive' : 'negative'} />
        <StatTile label="Thin margins" value={String(thin.length)}
          tone={thin.length ? 'warn' : 'positive'} hint="Trips under 10% margin" />
      </div>

      <Card title="Thinnest margin first" padded={false}
        subtitle="The order that matters: a trip losing money is worth more attention than one making it.">
        {trips.length === 0 ? (
          <EmptyState title="No trips with posted activity in this window."
            hint="Tag an invoice or a vendor bill to a booking and it appears here." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Trip</Th><Th>Booking</Th>
                <Th align="right">Revenue</Th><Th align="right">Cost</Th>
                <Th align="right">Profit</Th><Th align="right">Margin</Th><Th width="160px">Share</Th>
              </tr>
            </thead>
            <tbody>
              {[...trips].sort((a, b) => a.margin - b.margin).map((t) => (
                <tr key={t.analytic_id} className="hover:bg-canvas">
                  <Td><span className="font-semibold">{t.name}</span></Td>
                  <Td>
                    {t.booking_id
                      ? <Link href={`/bookings/${t.booking_id}`} className="font-bold text-brand hover:underline">
                        {t.booking_ref}
                      </Link>
                      : <span className="text-ink-faint">—</span>}
                  </Td>
                  <Td align="right"><Money value={t.revenue} /></Td>
                  <Td align="right"><Money value={t.cost} /></Td>
                  <Td align="right">
                    <span className={`num font-bold ${t.profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                      {fmt(t.profit)}
                    </span>
                  </Td>
                  <Td align="right">
                    <span className={`num font-bold ${t.margin < 10 ? 'text-negative' : ''}`}>
                      {t.margin.toFixed(1)}%
                    </span>
                  </Td>
                  <Td><Bar value={t.revenue} max={peak} color="var(--color-sec-analytics)" /></Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-brand-soft">
                <Td colSpan={2}><span className="font-extrabold">Total</span></Td>
                <Td align="right"><Money value={revenue} bold dash={false} /></Td>
                <Td align="right"><Money value={cost} bold dash={false} /></Td>
                <Td align="right"><Money value={profit} bold dash={false} /></Td>
                <Td align="right">
                  <span className="num font-extrabold">
                    {revenue ? ((profit / revenue) * 100).toFixed(1) : '0.0'}%
                  </span>
                </Td>
                <Td />
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>
    </>
  );
}
