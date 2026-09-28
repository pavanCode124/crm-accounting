import { ctx } from '@/server/bootstrap';
import { one, resolveRange, type SearchParams } from '@/lib/range';
import { agentPerformance } from '@/server/accounting/analytics';
import { fmt } from '@/lib/money';
import { RangeBar } from '@/components/RangeBar';
import { PageHeader, Card, Table, Th, Td, Money, StatTile, EmptyState, Bar } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Agent performance — plan section 40.
 *
 * Revenue AND gross profit side by side, deliberately. An agent measured on
 * revenue alone discounts the trip away to close it; showing what the agency
 * kept, next to what the agent was paid for it, is the whole point of putting
 * this behind the ledger rather than behind the CRM's booking values.
 */
export default async function AgentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const range = resolveRange(
    { range: await one(params, 'range'), from: await one(params, 'from'), to: await one(params, 'to') }, s.fyStartMonth,
  );
  const rows = await agentPerformance(s.orgId, range);
  const revenue = rows.reduce((sum, r) => sum + r.revenue, 0);
  const profit = rows.reduce((sum, r) => sum + r.profit, 0);
  const commission = rows.reduce((sum, r) => sum + r.commission, 0);
  const peak = Math.max(1, ...rows.map((r) => r.revenue));

  return (
    <>
      <PageHeader
        title="Agent Performance"
        subtitle="What each agent sold, what the agency kept, and what the selling cost."
        accent="var(--color-sec-analytics)"
      />
      <RangeBar action="/analytics/agents" range={range} />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile label="Revenue" value={revenue} />
        <StatTile label="Gross profit" value={profit} tone={profit >= 0 ? 'positive' : 'negative'} />
        <StatTile label="Commission" value={commission}
          hint={revenue ? `${((commission / revenue) * 100).toFixed(1)}% of revenue` : undefined} />
      </div>

      <Card padded={false}>
        {rows.length === 0 ? (
          <EmptyState title="No agent activity in this window." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Agent</Th><Th align="right">Bookings</Th><Th align="right">Revenue</Th>
                <Th align="right">Cost</Th><Th align="right">Gross profit</Th>
                <Th align="right">Margin</Th><Th align="right">Commission</Th><Th width="140px">Share</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.agent_name} className="hover:bg-canvas">
                  <Td><span className="font-semibold">{r.agent_name}</span></Td>
                  <Td align="right"><span className="num">{r.bookings}</span></Td>
                  <Td align="right"><Money value={r.revenue} /></Td>
                  <Td align="right"><Money value={r.cost} /></Td>
                  <Td align="right">
                    <span className={`num font-bold ${r.profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                      {fmt(r.profit)}
                    </span>
                  </Td>
                  <Td align="right"><span className="num">{r.margin.toFixed(1)}%</span></Td>
                  <Td align="right"><Money value={r.commission} /></Td>
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
