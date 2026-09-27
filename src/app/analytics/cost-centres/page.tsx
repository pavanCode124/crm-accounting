import { Fragment } from 'react';
import { ctx } from '@/server/bootstrap';
import { one, resolveRange, type SearchParams } from '@/lib/range';
import { analyticProfitability } from '@/server/accounting/analytics';
import { all } from '@/server/db';
import { fmt } from '@/lib/money';
import { RangeBar } from '@/components/RangeBar';
import { PageHeader, Card, Table, Th, Td, Money, EmptyState } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Departments, branches, agents — every analytic dimension that is not a trip
 * (plan section 25).
 *
 * One page rather than three, because they are the same query with a different
 * plan code, and because the useful comparison is often across dimensions:
 * Marketing spend against Hyderabad's contribution.
 */
export default async function CostCentresPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const params = await searchParams;
  const range = resolveRange(
    { range: one(params, 'range'), from: one(params, 'from'), to: one(params, 'to') }, s.fyStartMonth,
  );

  const plans = all<{ id: string; code: string; name: string }>(
    "SELECT id, code, name FROM analytic_plans WHERE org_id = ? AND code <> 'TRIPS' ORDER BY name", s.orgId,
  );

  return (
    <>
      <PageHeader
        title="Cost Centres"
        subtitle="Departments, branches and any other dimension the agency tags its postings with."
        accent="var(--color-sec-analytics)"
      />
      <RangeBar action="/analytics/cost-centres" range={range} />

      <div className="space-y-5">
        {plans.map((plan) => {
          const rows = analyticProfitability(s.orgId, { planCode: plan.code, ...range });
          const revenue = rows.reduce((sum, r) => sum + r.revenue, 0);
          const cost = rows.reduce((sum, r) => sum + r.cost, 0);
          return (
            <Card key={plan.id} title={plan.name} padded={false}
              subtitle={`Plan code ${plan.code}`}>
              {rows.length === 0 ? (
                <EmptyState title="Nothing tagged to this plan in the window."
                  hint="Pick one of these on a journal entry or invoice line and it appears here." />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>{plan.name.replace(/s$/, '')}</Th>
                      <Th align="right">Revenue</Th><Th align="right">Cost</Th>
                      <Th align="right">Contribution</Th><Th align="right">Margin</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <Fragment key={r.analytic_id}>
                        <tr className="hover:bg-canvas">
                          <Td><span className="font-semibold">{r.name}</span></Td>
                          <Td align="right"><Money value={r.revenue} /></Td>
                          <Td align="right"><Money value={r.cost} /></Td>
                          <Td align="right">
                            <span className={`num font-bold ${r.profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                              {fmt(r.profit)}
                            </span>
                          </Td>
                          <Td align="right"><span className="num">{r.margin.toFixed(1)}%</span></Td>
                        </tr>
                      </Fragment>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-brand-soft">
                      <Td><span className="font-extrabold">Total</span></Td>
                      <Td align="right"><Money value={revenue} bold dash={false} /></Td>
                      <Td align="right"><Money value={cost} bold dash={false} /></Td>
                      <Td align="right"><Money value={revenue - cost} bold dash={false} /></Td>
                      <Td />
                    </tr>
                  </tfoot>
                </Table>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}
