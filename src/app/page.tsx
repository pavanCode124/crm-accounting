import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { dashboard, monthlySeries, expenseBreakdown } from '@/server/accounting/reports';
import { listDocuments as listDocs } from '@/server/accounting/documents';
import { tripProfitability } from '@/server/accounting/analytics';
import { auditRecent } from '@/server/accounting/audit';
import { ledgerTotals } from '@/server/accounting/engine';
import { resolveRange, one, type SearchParams } from '@/lib/range';
import { fmt, fmtCompact, marginPct } from '@/lib/money';
import { fmtDate, isoDate, daysBetween } from '@/lib/accounting';
import { RangeBar } from '@/components/RangeBar';
import {
  PageHeader, Card, StatTile, Table, Th, Td, Money, Chip, EmptyState, RefLink, Bar, LinkButton,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Finance Overview.
 *
 * Every number on this page is a read of the general ledger over the chosen
 * window — plan section 41's closing line, "all dashboard values must come from
 * accounting data". Nothing here is stored, nothing is a running total kept up
 * to date by a screen; change an invoice and this page changes with it.
 */
export default async function OverviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const params = await searchParams;
  const range = resolveRange(
    { range: one(params, 'range'), from: one(params, 'from'), to: one(params, 'to') },
    s.fyStartMonth,
  );

  const kpi = dashboard(s.orgId, range);
  const series = monthlySeries(s.orgId, range);
  const spend = expenseBreakdown(s.orgId, range).slice(0, 8);
  const trips = tripProfitability(s.orgId, {}).slice(0, 6);
  const today = isoDate();
  const overdue = listDocs(s.orgId, { docType: 'out_invoice', overdueOn: today, limit: 6 });
  const duePayables = listDocs(s.orgId, { docType: 'in_invoice', state: 'posted', limit: 40 })
    .filter((d) => d.residual > 0)
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
    .slice(0, 6);
  const proof = ledgerTotals(s.orgId);
  const recent = auditRecent(s.orgId, 8);

  const peak = Math.max(1, ...series.map((m) => Math.max(m.revenue, m.expense)));
  const spendMax = Math.max(1, ...spend.map((r) => r.amount));

  return (
    <>
      <PageHeader
        title="Finance"
        subtitle="What each trip cost against what it earned — and what the agency spends running itself."
        actions={
          <>
            <LinkButton href="/sales/invoices/new" variant="primary">+ New Invoice</LinkButton>
            <LinkButton href="/purchases/bills/new">+ Vendor Bill</LinkButton>
          </>
        }
      />

      <RangeBar action="/" range={range} />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Revenue" value={kpi.revenue} hint={range.label} href="/reports/profit-and-loss" />
        <StatTile label="Expenses" value={kpi.expenses} href="/reports/profit-and-loss" />
        <StatTile label="Profit" value={kpi.profit} tone={kpi.profit >= 0 ? 'positive' : 'negative'}
          href="/reports/profit-and-loss" />
        <StatTile label="Margin" value={marginPct(kpi.revenue, kpi.profit)}
          tone={kpi.profit >= 0 ? 'positive' : 'negative'} />
        <StatTile label="Cash & Bank" value={kpi.cash} hint="All accounts" href="/banking" />
        <StatTile label="Tax Payable" value={kpi.taxPayable} tone="warn" href="/reports/tax" />
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <StatTile
          label="To Collect"
          value={kpi.receivable}
          tone={kpi.overdueReceivable > 0 ? 'warn' : 'neutral'}
          hint={`${kpi.invoicesOpen} open invoice(s) · ${fmtCompact(kpi.overdueReceivable)} overdue`}
          href="/reports/ar-ageing"
        />
        <StatTile
          label="To Pay"
          value={kpi.payable}
          tone={kpi.overduePayable > 0 ? 'warn' : 'neutral'}
          hint={`${kpi.billsOpen} open bill(s) · ${fmtCompact(kpi.overduePayable)} overdue`}
          href="/reports/ap-ageing"
        />
      </div>

      <div className="mb-6 grid gap-5 lg:grid-cols-2">
        <Card title="Revenue and cost by month" subtitle="Posted entries only — drafts are proposals, not facts.">
          {series.length === 0 ? (
            <EmptyState title="Nothing posted in this window yet." />
          ) : (
            <div className="space-y-3">
              {series.map((m) => (
                <div key={m.month}>
                  <div className="mb-1 flex items-baseline justify-between text-[12.5px]">
                    <span className="font-bold">
                      {new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString('en-IN', {
                        month: 'short', year: '2-digit', timeZone: 'UTC',
                      })}
                    </span>
                    <span className="text-ink-muted">
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

        <Card title="Where the money went" subtitle="Direct trip costs and overheads, largest first.">
          {spend.length === 0 ? (
            <EmptyState title="Nothing recorded in this window yet." />
          ) : (
            <div className="space-y-3">
              {spend.map((r) => (
                <div key={r.code}>
                  <div className="mb-1 flex items-baseline justify-between text-[12.5px]">
                    <span className="font-semibold">{r.name}</span>
                    <Money value={r.amount} />
                  </div>
                  <Bar value={r.amount} max={spendMax} color="var(--color-brand)" />
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="mb-6 grid gap-5 lg:grid-cols-2">
        <Card title="Overdue invoices" padded={false}
          actions={<Link href="/reports/ar-ageing" className="text-[13px] font-bold text-brand hover:underline">Ageing →</Link>}>
          {overdue.length === 0 ? (
            <EmptyState title="Nothing overdue." hint="Every posted invoice is either paid or still within terms." />
          ) : (
            <Table>
              <thead><tr><Th>Invoice</Th><Th>Customer</Th><Th>Due</Th><Th align="right">Outstanding</Th></tr></thead>
              <tbody>
                {overdue.map((d) => (
                  <tr key={d.id} className="hover:bg-canvas">
                    <Td><RefLink href={`/sales/invoices/${d.id}`}>{d.number}</RefLink></Td>
                    <Td>{d.partner_name}</Td>
                    <Td>
                      <span className="text-negative font-semibold">
                        {daysBetween(d.due_date ?? d.doc_date, today)} days
                      </span>
                    </Td>
                    <Td align="right"><Money value={d.residual} bold /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title="Upcoming supplier payments" padded={false}
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
                    <Td>{fmtDate(d.due_date)}</Td>
                    <Td align="right"><Money value={d.residual} bold /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Most profitable trips" subtitle="Revenue and cost tagged to each trip in the ledger." padded={false}
          actions={<Link href="/analytics/trips" className="text-[13px] font-bold text-brand hover:underline">All trips →</Link>}>
          {trips.length === 0 ? (
            <EmptyState title="No trip analytics yet." hint="Tag invoice and bill lines to a trip to see its margin here." />
          ) : (
            <Table>
              <thead>
                <tr><Th>Trip</Th><Th align="right">Revenue</Th><Th align="right">Cost</Th>
                  <Th align="right">Profit</Th><Th align="right">Margin</Th></tr>
              </thead>
              <tbody>
                {trips.map((t) => (
                  <tr key={t.analytic_id} className="hover:bg-canvas">
                    <Td>
                      <RefLink href={t.booking_id ? `/bookings/${t.booking_id}` : `/analytics/trips`}>
                        {t.name}
                      </RefLink>
                    </Td>
                    <Td align="right"><Money value={t.revenue} /></Td>
                    <Td align="right"><Money value={t.cost} /></Td>
                    <Td align="right">
                      <span className={t.profit >= 0 ? 'num font-bold text-positive' : 'num font-bold text-negative'}>
                        {fmt(t.profit)}
                      </span>
                    </Td>
                    <Td align="right"><span className="num">{t.margin.toFixed(1)}%</span></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title="Recent activity" subtitle="Every financial action, as it was recorded.">
          <ol className="space-y-3 text-[13px]">
            {recent.map((a) => (
              <li key={a.id} className="flex gap-3">
                <span className="num w-[92px] shrink-0 !text-left text-ink-faint">
                  {new Date(a.at).toLocaleString('en-IN', {
                    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                  })}
                </span>
                <span className="min-w-0">
                  <span className="font-semibold">{a.summary ?? a.action}</span>
                  <span className="text-ink-faint"> — {a.user_name}</span>
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-5 rounded-[10px] border border-line px-3.5 py-3 text-[12.5px]">
            <div className="flex items-center justify-between">
              <span className="font-bold">Ledger proof</span>
              <Chip state={proof.balanced ? 'paid' : 'not_paid'}
                label={proof.balanced ? 'Balanced' : 'Out of balance'} />
            </div>
            <p className="mt-1.5 text-ink-muted">
              Debits {fmt(proof.debit)} · Credits {fmt(proof.credit)} across every posted entry.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}
