import { ctx } from '@/server/bootstrap';
import { one, resolveRange, type SearchParams } from '@/lib/range';
import { taxReport } from '@/server/accounting/reports';
import { fmtDate, titleise } from '@/lib/accounting';
import { RangeBar } from '@/components/RangeBar';
import { PageHeader, Card, Table, Th, Td, Money, StatTile, EmptyState, Banner } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Tax report — the figures a GST return and a TDS challan are filed from.
 *
 * Taken from the TAX LINES in the ledger rather than recomputed from invoice
 * totals. Those two agree today and drift the moment an invoice is reversed or
 * a rate changes mid-period, and the one that must be right is the one the
 * ledger actually posted.
 *
 * THREE liabilities, deliberately not netted:
 *
 *   GST   = output tax less input credit, filed in GSTR-3B by the 20th.
 *   TDS   = withheld from suppliers, deposited by the 7th on its own challan.
 *
 * They go to two different departments on two different dates. Showing one
 * "net payable" figure that mixed them would be a wrong cheque twice over.
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
        subtitle={`${fmtDate(range.from)} to ${fmtDate(range.to)} · GST collected against GST paid, and tax withheld from suppliers`}
        accent="var(--color-sec-taxes)"
      />
      <RangeBar action="/reports/tax" range={range} />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Output GST (collected)" value={tax.outputTotal} compact={false} />
        <StatTile label="Input GST (credit)" value={tax.inputTotal} compact={false} />
        <StatTile label="Net GST payable" value={tax.netPayable} compact={false}
          tone={tax.netPayable > 0 ? 'warn' : 'positive'}
          hint={tax.netPayable > 0 ? 'GSTR-3B, by the 20th' : 'Credit carried forward'} />
        <StatTile label="TDS withheld" value={tax.withheldTotal} compact={false}
          tone={tax.withheldTotal > 0 ? 'warn' : 'neutral'}
          hint="Deposited separately — never set off against GST" />
      </div>

      {tax.netPayable > 0 && (
        <Banner tone="warn">
          {rupees(tax.netPayable)} of GST is payable for this period. Lock the period once the
          return is filed so the figures cannot move.
        </Banner>
      )}

      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Card title="Output GST" subtitle="Charged to customers on posted invoices." padded={false}>
          <TaxTable rows={tax.output} total={tax.outputTotal} />
        </Card>
        <Card title="Input GST" subtitle="Paid to suppliers and claimable as credit." padded={false}>
          <TaxTable rows={tax.input} total={tax.inputTotal} />
        </Card>
      </div>

      <Card
        title="Tax withheld from suppliers (TDS)"
        subtitle="Deducted on vendor bills and owed to the Income Tax Department, not to the supplier."
        padded={false}
        className="mb-5"
      >
        <WithholdingTable rows={tax.withheld} total={tax.withheldTotal} />
      </Card>

      {tax.withheldUnpaid !== 0 && (
        <Banner tone={tax.withheldUnpaid > 0 ? 'warn' : 'info'}>
          {tax.withheldUnpaid > 0
            ? `${rupees(tax.withheldUnpaid)} is sitting in TDS Payable as at ${fmtDate(range.to)} — deducted from suppliers but not yet deposited by challan.`
            : `TDS Payable is overdrawn by ${rupees(-tax.withheldUnpaid)} as at ${fmtDate(range.to)}, which means more has been deposited than deducted. Check for a challan posted twice.`}
        </Banner>
      )}
    </>
  );
}

function rupees(v: number) {
  return `₹${(v / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
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
            <Td><span className="text-ink-muted">{taxGroupLabel(r.tax_group)}</span></Td>
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

/**
 * Withholding is its own table because its columns are different ones: the
 * reader needs the amount PAID to the supplier that the deduction was taken
 * from, which is the 26Q column, not a "taxable value" in the GST sense.
 */
function WithholdingTable({ rows, total }: {
  rows: Array<{ tax_id: string; name: string; tax_group: string; rate_bps: number; base: number; amount: number }>;
  total: number;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing withheld in this period."
        hint="TDS is chosen on the bill header, not on a line. Pick a section on a vendor bill and it is deducted from the payment and posted to TDS Payable."
      />
    );
  }
  return (
    <Table>
      <thead>
        <tr>
          <Th>Section</Th><Th>Type</Th><Th align="right">Rate</Th>
          <Th align="right">Amount paid</Th><Th align="right">Tax withheld</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.tax_id} className="hover:bg-canvas">
            <Td><span className="font-semibold">{r.name}</span></Td>
            <Td><span className="text-ink-muted">{taxGroupLabel(r.tax_group)}</span></Td>
            <Td align="right"><span className="num">{(r.rate_bps / 100).toFixed(2)}%</span></Td>
            <Td align="right"><Money value={r.base} /></Td>
            <Td align="right"><Money value={r.amount} bold /></Td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="bg-brand-soft">
          <Td colSpan={4}><span className="font-extrabold">Total deducted</span></Td>
          <Td align="right"><Money value={total} bold dash={false} /></Td>
        </tr>
      </tfoot>
    </Table>
  );
}

/**
 * `titleise` turns "tds" into "Tds" and "igst" into "Igst", which reads as a
 * typo in a statutory column. The acronyms are spelled the way the return
 * spells them.
 */
function taxGroupLabel(group: string) {
  const known: Record<string, string> = {
    cgst: 'CGST', sgst: 'SGST', igst: 'IGST', utgst: 'UTGST',
    cess: 'Cess', gst: 'GST', cgst_sgst: 'CGST + SGST',
    tds: 'TDS', tcs: 'TCS', vat: 'VAT',
  };
  return known[group] ?? titleise(group);
}
