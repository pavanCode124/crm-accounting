import Link from 'next/link';
import { ageing } from '@/server/accounting/reports';
import { AGEING_BUCKETS, isoDate } from '@/lib/accounting';
import { Card, Table, Th, Td, Money, EmptyState, StatTile, Bar } from './ui';

/**
 * AR and AP ageing.
 *
 * The buckets are the ones the plan names, and a credit note nets INSIDE the
 * bucket rather than sitting in a separate "credits" column that nobody
 * subtracts. The point of ageing is one number per customer that says how bad
 * it is; two columns to reconcile defeats it.
 */
export async function AgeingReport({ orgId, side, basePath }: {
  orgId: string; side: 'customer' | 'supplier'; basePath: string;
}) {
  const asOf = isoDate();
  const { rows, totals } = await ageing(orgId, side, asOf);
  const overdue = totals.total - totals.current;
  const worst = Math.max(1, ...rows.map((r) => Math.abs(r.total)));

  return (
    <>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total outstanding" value={totals.total} />
        <StatTile label="Within terms" value={totals.current} tone="positive" />
        <StatTile label="Overdue" value={overdue} tone={overdue > 0 ? 'negative' : 'neutral'} />
        <StatTile label="Over 90 days" value={totals.b4} tone={totals.b4 > 0 ? 'negative' : 'neutral'}
          hint="The money least likely to arrive" />
      </div>

      <Card padded={false}>
        {rows.length === 0 ? (
          <EmptyState title="Nothing outstanding." hint="Every posted document is settled." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{side === 'customer' ? 'Customer' : 'Supplier'}</Th>
                {AGEING_BUCKETS.map((b) => <Th key={b.key} align="right">{b.label}</Th>)}
                <Th align="right">Total</Th>
                <Th width="140px">Exposure</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.partner_id} className="hover:bg-canvas">
                  <Td>
                    <Link href={`${basePath}/${r.partner_id}`} className="font-bold text-brand hover:underline">
                      {r.partner_name}
                    </Link>
                  </Td>
                  <Td align="right"><Money value={r.current} /></Td>
                  <Td align="right"><Money value={r.b1} /></Td>
                  <Td align="right"><Money value={r.b2} /></Td>
                  <Td align="right"><Money value={r.b3} /></Td>
                  <Td align="right">
                    <span className={r.b4 ? 'font-bold text-negative' : ''}><Money value={r.b4} /></span>
                  </Td>
                  <Td align="right"><Money value={r.total} bold /></Td>
                  <Td><Bar value={r.total} max={worst}
                    color={r.b4 || r.b3 ? 'var(--color-negative)' : 'var(--color-brand)'} /></Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-brand-soft">
                <Td><span className="font-extrabold">Total</span></Td>
                <Td align="right"><Money value={totals.current} bold dash={false} /></Td>
                <Td align="right"><Money value={totals.b1} bold dash={false} /></Td>
                <Td align="right"><Money value={totals.b2} bold dash={false} /></Td>
                <Td align="right"><Money value={totals.b3} bold dash={false} /></Td>
                <Td align="right"><Money value={totals.b4} bold dash={false} /></Td>
                <Td align="right"><Money value={totals.total} bold dash={false} /></Td>
                <Td />
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>

      <p className="mt-4 text-[12.5px] text-ink-faint">
        Buckets are counted from each document&rsquo;s due date, as at {asOf}. Credit notes reduce the
        bucket they fall in rather than being listed separately.
      </p>
    </>
  );
}
