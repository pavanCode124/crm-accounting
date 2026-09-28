import { ctx } from '@/server/bootstrap';
import { one, resolveRange, type SearchParams } from '@/lib/range';
import { taxReport } from '@/server/accounting/reports';
import { fmtDate, titleise } from '@/lib/accounting';
import { RangeBar } from '@/components/RangeBar';
import { PageHeader, Card, Table, Th, Td, Money, StatTile, EmptyState, Banner } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Tax report — the figures a GST return is filed from.
 *
 * Taken from the TAX LINES in the ledger rather than recomputed from invoice
 * totals. Those two agree today and drift the moment an invoice is reversed or
 * a rate changes mid-period, and the one that must be right is the one the
 * ledger actually posted.
 */
export default async function TaxReportPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const range = resolveRange(
    { range: await one(params, 'range'), from: await one(params, 'from'), to: await one(params, 'to') }, s.fyStartMonth,
  );
  const tax = await taxReport(s.orgId, range);

  return (
    <>
      <PageHeader
        title="Tax Report"
        subtitle={`${fmtDate(range.from)} to ${fmtDate(range.to)} · output tax collected against input tax paid`}
        accent="var(--color-sec-taxes)"
      />
      <RangeBar action="/reports/tax" range={range} />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile label="Output tax (collected)" value={tax.outputTotal} compact={false} />
        <StatTile label="Input tax (credit)" value={tax.inputTotal} compact={false} />
        <StatTile label="Net payable" value={tax.netPayable} compact={false}
          tone={tax.netPayable > 0 ? 'warn' : 'positive'}
          hint={tax.netPayable > 0 ? 'Owed to the government' : 'Credit carried forward'} />
      </div>

      {tax.netPayable > 0 && (
        <Banner tone="warn">
          ₹{(tax.netPayable / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} of tax is
          payable for this period. Lock the period once the return is filed so the figures cannot move.
        </Banner>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Output tax" subtitle="Charged to customers on posted invoices." padded={false}>
          <TaxTable rows={tax.output} total={tax.outputTotal} />
        </Card>
        <Card title="Input tax" subtitle="Paid to suppliers and claimable as credit." padded={false}>
          <TaxTable rows={tax.input} total={tax.inputTotal} />
        </Card>
      </div>
    </>
  );
}

function TaxTable({ rows, total }: {
  rows: Array<{ tax_id: string; name: string; tax_group: string; base: number; amount: number }>;
  total: number;
}) {
  if (rows.length === 0) return <EmptyState title="Nothing in this period." />;
  return (
    <Table>
      <thead>
        <tr><Th>Tax</Th><Th>Group</Th><Th align="right">Taxable value</Th><Th align="right">Tax</Th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.tax_id} className="hover:bg-canvas">
            <Td><span className="font-semibold">{r.name}</span></Td>
            <Td><span className="text-ink-muted">{titleise(r.tax_group)}</span></Td>
            <Td align="right"><Money value={r.base} /></Td>
            <Td align="right"><Money value={r.amount} bold /></Td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="bg-brand-soft">
          <Td colSpan={3}><span className="font-extrabold">Total</span></Td>
          <Td align="right"><Money value={total} bold dash={false} /></Td>
        </tr>
      </tfoot>
    </Table>
  );
}
