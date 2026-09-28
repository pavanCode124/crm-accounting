import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { dashboard, monthlySeries } from '@/server/accounting/reports';
import { listDocuments as listDocs } from '@/server/accounting/documents';
import { ledgerTotals } from '@/server/accounting/engine';
import { resolveRange, one, type SearchParams } from '@/lib/range';
import { fmt, fmtCompact } from '@/lib/money';
import { fmtDate, isoDate, daysBetween } from '@/lib/accounting';
import { RangeBar } from '@/components/RangeBar';
import {
  PageHeader, Card, StatTile, Table, Th, Td, Money, EmptyState, RefLink, Bar, LinkButton,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Finance Overview.
 *
 * Every number on this page is a read of the general ledger over the chosen
 * window — plan section 41's closing line, "all dashboard values must come from
 * accounting data". Nothing here is stored, nothing is a running total kept up
 * to date by a screen; change an invoice and this page changes with it.
 *
 * WHAT THIS PAGE DELIBERATELY DOES NOT SHOW.
 *
 * It used to show nine blocks: six KPI tiles, two more tiles, a revenue chart,
 * an expense-breakdown chart, overdue invoices, upcoming payables, a trip
 * profitability table, an activity feed and a ledger proof. Every one of those
 * is a real report — and that was the problem. An accountant opening the books
 * asks a small number of questions ("what did we make, what is late, what is
 * due next"), and a page answering fifteen answers none of them quickly.
 *
 * So the expense breakdown moved back to where it belongs (the P&L), trip
 * margins to Analytics → Trips, and the activity feed to Accounting → Audit
 * Trail. What is left is the four things you cannot get anywhere else at a
 * glance: the totals, the trend, what is overdue, and what is due next.
 */
export default async function OverviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const range = resolveRange(
    { range: await one(params, 'range'), from: await one(params, 'from'), to: await one(params, 'to') },
    s.fyStartMonth,
  );

  const kpi = await dashboard(s.orgId, range);
  const series = await monthlySeries(s.orgId, range);
  const today = isoDate();
  const overdue = await listDocs(s.orgId, { docType: 'out_invoice', overdueOn: today, limit: 6 });
  const duePayables = (await listDocs(s.orgId, { docType: 'in_invoice', state: 'posted', limit: 40 }))
    .filter((d) => d.residual > 0)
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
    .slice(0, 6);
  const proof = await ledgerTotals(s.orgId);

  const peak = Math.max(1, ...series.map((m) => Math.max(m.revenue, m.expense)));

  return (
    <>
      <PageHeader
        title="Finance"
        subtitle={`${s.orgName} · ${range.label}`}
        actions={
          <>
            <LinkButton href="/sales/invoices/new" variant="primary">+ New Invoice</LinkButton>
            <LinkButton href="/purchases/bills/new">+ Vendor Bill</LinkButton>
          </>
        }
      />

      <RangeBar action="/" range={range} />

      {/*
        Six tiles, one row, and no second row of them.
        Margin came off — it is two figures already on this row divided by each
        other, and the P&L states it properly. Tax payable came off for the same
        reason the expense chart did: it is a liability balance, and the Tax
        Report is one click away.
      */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Revenue" value={kpi.revenue} href="/reports/profit-and-loss" />
        <StatTile label="Expenses" value={kpi.expenses} href="/reports/profit-and-loss" />
        <StatTile label="Profit" value={kpi.profit} tone={kpi.profit >= 0 ? 'positive' : 'negative'}
          href="/reports/profit-and-loss" />
        <StatTile label="Cash & Bank" value={kpi.cash} href="/banking" />
        <StatTile label="To Collect" value={kpi.receivable}
          tone={kpi.overdueReceivable > 0 ? 'warn' : 'neutral'}
          hint={kpi.overdueReceivable > 0
            ? `${fmtCompact(kpi.overdueReceivable)} overdue`
            : `${kpi.invoicesOpen} open`}
          href="/reports/ar-ageing" />
        <StatTile label="To Pay" value={kpi.payable}
          tone={kpi.overduePayable > 0 ? 'warn' : 'neutral'}
          hint={kpi.overduePayable > 0
            ? `${fmtCompact(kpi.overduePayable)} overdue`
            : `${kpi.billsOpen} open`}
          href="/reports/ap-ageing" />
      </div>

      <Card title="Revenue and cost by month"
        subtitle="Posted entries only — drafts are proposals, not facts." className="mb-6">
        {series.length === 0 ? (
          <EmptyState title="Nothing posted in this window yet." />
        ) : (
          <div className="space-y-3">
            {series.map((m) => (
              <div key={m.month}>
                <div className="mb-1 flex items-baseline justify-between gap-4 text-[12.5px]">
                  <span className="font-bold">
                    {new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString('en-IN', {
                      month: 'short', year: '2-digit', timeZone: 'UTC',
                    })}
                  </span>
                  <span className="whitespace-nowrap text-ink-muted">
                    {fmtCompact(m.revenue)} in · {fmtCompact(m.expense)} out ·{' '}
                    <span className={m.profit >= 0 ? 'text-positive font-bold' : 'text-negative font-bold'}>
                      {fmtCompact(m.profit)}
                    </span>
                  </span>
                </div>
                <div className="space-y-1">
                  <Bar value={m.revenue} max={peak} color="var(--color-sec-sales)" />
                  <Bar value={m.expense} max={peak} color="var(--color-sec-purchases)" />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Card title="Overdue invoices" padded={false}
          actions={<Link href="/reports/ar-ageing" className="text-[13px] font-bold text-brand hover:underline">Ageing →</Link>}>
          {overdue.length === 0 ? (
            <EmptyState title="Nothing overdue." hint="Every posted invoice is either paid or still within terms." />
          ) : (
            <Table>
              <thead><tr><Th>Invoice</Th><Th>Customer</Th><Th align="right">Late</Th><Th align="right">Outstanding</Th></tr></thead>
              <tbody>
                {overdue.map((d) => (
                  <tr key={d.id} className="hover:bg-canvas">
                    <Td><RefLink href={`/sales/invoices/${d.id}`}>{d.number}</RefLink></Td>
                    <Td>{d.partner_name}</Td>
                    <Td align="right">
                      <span className="num font-semibold text-negative">
                        {daysBetween(d.due_date ?? d.doc_date, today)}d
                      </span>
                    </Td>
                    <Td align="right"><Money value={d.residual} bold /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title="Supplier payments due" padded={false}
          actions={<Link href="/purchases/bills" className="text-[13px] font-bold text-brand hover:underline">All bills →</Link>}>
          {duePayables.length === 0 ? (
            <EmptyState title="Nothing outstanding to suppliers." />
          ) : (
            <Table>
              <thead><tr><Th>Bill</Th><Th>Supplier</Th><Th>Due</Th><Th align="right">Payable</Th></tr></thead>
              <tbody>
                {duePayables.map((d) => (
                  <tr key={d.id} className="hover:bg-canvas">
                    <Td><RefLink href={`/purchases/bills/${d.id}`}>{d.number}</RefLink></Td>
                    <Td>{d.partner_name}</Td>
                    <Td><span className="whitespace-nowrap">{fmtDate(d.due_date)}</span></Td>
                    <Td align="right"><Money value={d.residual} bold /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      {/*
        The ledger proof, as ONE LINE rather than a card.
        It answers a yes/no question an accountant wants settled before they
        trust anything above it, and a yes needs no box drawn round it. The
        activity feed that used to sit beside it moved to its own page: it was
        eight rows of timestamps competing with the figures, and its fixed
        92px timestamp column was too narrow for the string it held, so every
        row overlapped the text next to it.
      */}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-muted">
        <span className={proof.balanced ? 'font-bold text-positive' : 'font-bold text-negative'}>
          {proof.balanced ? 'Ledger balanced' : 'Ledger out of balance'}
        </span>
        <span>· Debits {fmt(proof.debit)} · Credits {fmt(proof.credit)} across every posted entry ·</span>
        <Link href="/accounting/audit" className="font-semibold text-brand hover:underline">
          Audit trail →
        </Link>
      </p>
    </>
  );
}
