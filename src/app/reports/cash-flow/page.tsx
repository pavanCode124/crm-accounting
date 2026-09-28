import { Fragment } from 'react';
import { ctx } from '@/server/bootstrap';
import { one, resolveRange, type SearchParams } from '@/lib/range';
import { cashFlow } from '@/server/accounting/reports';
import { fmtDate } from '@/lib/accounting';
import { RangeBar } from '@/components/RangeBar';
import { PageHeader, Card, Table, Th, Td, Money, StatTile, EmptyState } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Cash Flow, direct method.
 *
 * Built by looking at what sat on the OTHER side of every entry that touched a
 * cash account — so it reads as "₹6L came in from customers, ₹4L went to
 * hotels" rather than as a reconciliation starting from net profit. An agency
 * owner asks where the money went, not how depreciation was added back.
 */
export default async function CashFlowPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const range = resolveRange(
    { range: await one(params, 'range'), from: await one(params, 'from'), to: await one(params, 'to') }, s.fyStartMonth,
  );
  const cf = await cashFlow(s.orgId, range);

  return (
    <>
      <PageHeader
        title="Cash Flow"
        subtitle={`${fmtDate(range.from)} to ${fmtDate(range.to)} · where the cash actually moved`}
        accent="var(--color-sec-reports)"
      />
      <RangeBar action="/reports/cash-flow" range={range} />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile label="Opening cash" value={cf.opening} compact={false} />
        <StatTile label="Net movement" value={cf.net} compact={false}
          tone={cf.net >= 0 ? 'positive' : 'negative'} />
        <StatTile label="Closing cash" value={cf.closing} compact={false} />
      </div>

      <Card padded={false}>
        {cf.sections.length === 0 ? (
          <EmptyState title="No cash moved in this window." />
        ) : (
          <Table>
            <thead><tr><Th>Item</Th><Th align="right" width="180px">Cash effect</Th></tr></thead>
            <tbody>
              {cf.sections.map((section) => (
                <Fragment key={section.key}>
                  <tr className="bg-canvas">
                    <Td colSpan={2}>
                      <span className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-ink-faint">
                        {section.label}
                      </span>
                    </Td>
                  </tr>
                  {section.rows.map((r) => (
                    <tr key={r.code} className="hover:bg-canvas">
                      <Td>
                        <span className="num !text-left pl-4 font-semibold text-ink-faint">{r.code}</span>{' '}
                        {r.name}
                      </Td>
                      <Td align="right">
                        {/*
                          Sign convention: positive is cash IN. A revenue account
                          shows positive because money came from customers; a cost
                          account shows negative because it went out.
                        */}
                        <Money value={r.amount} sign dash={false} />
                      </Td>
                    </tr>
                  ))}
                  <tr>
                    <Td><span className="pl-4 font-bold">Net from {section.label.toLowerCase()}</span></Td>
                    <Td align="right"><Money value={section.total} bold dash={false} sign /></Td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-brand-soft">
                <Td><span className="font-extrabold">Net change in cash</span></Td>
                <Td align="right"><Money value={cf.net} bold dash={false} sign /></Td>
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>
    </>
  );
}
