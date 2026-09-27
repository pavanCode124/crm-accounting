import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { one, resolveRange, type SearchParams } from '@/lib/range';
import {
  supplierCostReport, bookingPaymentReport, customerLifetimeValue, cancellationReport,
} from '@/server/accounting/analytics';
import { fmt } from '@/lib/money';
import { fmtDate } from '@/lib/accounting';
import { RangeBar } from '@/components/RangeBar';
import { PageHeader, Card, Table, Th, Td, Money, Chip, EmptyState, RefLink, Tabs } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The travel-specific reports of plan section 40, in one place.
 *
 * Tabs rather than five sidebar entries: they are asked one after another in
 * the same conversation — "which suppliers cost us most, who still owes us,
 * which customers are worth keeping" — and splitting them across the menu made
 * that conversation a navigation exercise.
 */
export default async function TravelReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const params = await searchParams;
  const tab = one(params, 'tab') ?? 'suppliers';
  const range = resolveRange(
    { range: one(params, 'range'), from: one(params, 'from'), to: one(params, 'to') }, s.fyStartMonth,
  );

  const tabs = [
    { label: 'Supplier costs', href: '/reports/travel?tab=suppliers' },
    { label: 'Booking payments', href: '/reports/travel?tab=bookings' },
    { label: 'Customer value', href: '/reports/travel?tab=customers' },
    { label: 'Cancellations', href: '/reports/travel?tab=cancellations' },
  ];

  return (
    <>
      <PageHeader
        title="Travel Reports"
        subtitle="The questions a travel agency asks that a generic ledger cannot answer."
        accent="var(--color-sec-reports)"
      />
      <Tabs tabs={tabs} active={`/reports/travel?tab=${tab}`} />
      <RangeBar action="/reports/travel" range={range} extra={{ tab }} />

      {tab === 'suppliers' && <SupplierCosts orgId={s.orgId} range={range} />}
      {tab === 'bookings' && <BookingPayments orgId={s.orgId} />}
      {tab === 'customers' && <CustomerValue orgId={s.orgId} />}
      {tab === 'cancellations' && <Cancellations orgId={s.orgId} />}
    </>
  );
}

function SupplierCosts({ orgId, range }: { orgId: string; range: { from: string; to: string } }) {
  const rows = supplierCostReport(orgId, range);
  const purchases = rows.reduce((s, r) => s + r.purchases, 0);
  return (
    <Card title="Supplier cost report" subtitle="What was bought, what has been paid, what is still owed."
      padded={false}>
      {rows.length === 0 ? <EmptyState title="No purchases in this window." /> : (
        <Table>
          <thead>
            <tr><Th>Supplier</Th><Th align="right">Bills</Th><Th align="right">Purchases</Th>
              <Th align="right">Paid</Th><Th align="right">Outstanding</Th><Th align="right">Share</Th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.partner_id} className="hover:bg-canvas">
                <Td>
                  <Link href={`/purchases/suppliers/${r.partner_id}`} className="font-bold text-brand hover:underline">
                    {r.name}
                  </Link>
                </Td>
                <Td align="right"><span className="num">{r.bills}</span></Td>
                <Td align="right"><Money value={r.purchases} /></Td>
                <Td align="right"><Money value={r.paid} /></Td>
                <Td align="right"><Money value={r.outstanding} bold /></Td>
                <Td align="right">
                  <span className="num">{purchases ? ((r.purchases / purchases) * 100).toFixed(1) : '0.0'}%</span>
                </Td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-brand-soft">
              <Td colSpan={2}><span className="font-extrabold">Total</span></Td>
              <Td align="right"><Money value={purchases} bold dash={false} /></Td>
              <Td align="right"><Money value={rows.reduce((s, r) => s + r.paid, 0)} bold dash={false} /></Td>
              <Td align="right"><Money value={rows.reduce((s, r) => s + r.outstanding, 0)} bold dash={false} /></Td>
              <Td />
            </tr>
          </tfoot>
        </Table>
      )}
    </Card>
  );
}

function BookingPayments({ orgId }: { orgId: string }) {
  const rows = bookingPaymentReport(orgId);
  return (
    <Card title="Booking payment report" subtitle="Every booking, what it was invoiced and what has landed."
      padded={false}>
      {rows.length === 0 ? <EmptyState title="No bookings yet." /> : (
        <Table>
          <thead>
            <tr><Th>Booking</Th><Th>Customer</Th><Th align="right">Invoiced</Th>
              <Th align="right">Paid</Th><Th align="right">Balance</Th><Th>Due</Th><Th>Status</Th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.booking_id} className="hover:bg-canvas">
                <Td>
                  <RefLink href={`/bookings/${r.booking_id}`}>{r.ref}</RefLink>
                  <div className="text-[12px] text-ink-faint">{r.title}</div>
                </Td>
                <Td>{r.partner_name ?? '—'}</Td>
                <Td align="right"><Money value={r.total} /></Td>
                <Td align="right"><Money value={r.paid} /></Td>
                <Td align="right"><Money value={r.balance} bold /></Td>
                <Td>{fmtDate(r.due_date)}</Td>
                <Td><Chip state={r.status} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function CustomerValue({ orgId }: { orgId: string }) {
  const rows = customerLifetimeValue(orgId);
  return (
    <Card title="Customer lifetime value"
      subtitle="Revenue is net of tax, so it compares like with like across GST rates." padded={false}>
      {rows.length === 0 ? <EmptyState title="No customer activity yet." /> : (
        <Table>
          <thead>
            <tr><Th>Customer</Th><Th align="right">Bookings</Th><Th align="right">Revenue</Th>
              <Th align="right">Gross profit</Th><Th align="right">Outstanding</Th><Th align="right">Margin</Th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.partner_id} className="hover:bg-canvas">
                <Td>
                  <Link href={`/sales/customers/${r.partner_id}`} className="font-bold text-brand hover:underline">
                    {r.name}
                  </Link>
                </Td>
                <Td align="right"><span className="num">{r.bookings}</span></Td>
                <Td align="right"><Money value={r.revenue} /></Td>
                <Td align="right">
                  <span className={`num font-bold ${r.profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                    {fmt(r.profit)}
                  </span>
                </Td>
                <Td align="right"><Money value={r.outstanding} /></Td>
                <Td align="right">
                  <span className="num">{r.revenue ? ((r.profit / r.revenue) * 100).toFixed(1) : '0.0'}%</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Cancellations({ orgId }: { orgId: string }) {
  const rows = cancellationReport(orgId);
  return (
    <Card title="Cancellation report"
      subtitle="What was billed, what was credited back, and what the trip still cost the agency." padded={false}>
      {rows.length === 0 ? (
        <EmptyState title="No cancelled bookings." hint="Good." />
      ) : (
        <Table>
          <thead>
            <tr><Th>Booking</Th><Th align="right">Invoiced</Th><Th align="right">Credited</Th>
              <Th align="right">Cost incurred</Th><Th align="right">Net impact</Th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.booking_id} className="hover:bg-canvas">
                <Td>
                  <RefLink href={`/bookings/${r.booking_id}`}>{r.ref}</RefLink>
                  <div className="text-[12px] text-ink-faint">{r.title}</div>
                </Td>
                <Td align="right"><Money value={r.revenue} /></Td>
                <Td align="right"><Money value={r.refund} /></Td>
                <Td align="right"><Money value={r.cost} /></Td>
                <Td align="right">
                  <span className={`num font-bold ${r.net >= 0 ? 'text-positive' : 'text-negative'}`}>
                    {fmt(r.net)}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
