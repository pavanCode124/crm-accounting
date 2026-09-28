import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { bookingFinancials } from '@/server/accounting/analytics';
import { listDocuments } from '@/server/accounting/documents';
import { listPayments } from '@/server/accounting/payments';
import { generalLedger } from '@/server/accounting/reports';
import { fmtDate, isoDate, titleise } from '@/lib/accounting';
import { fmt, marginPct } from '@/lib/money';
import {
  PageHeader, Card, Banner, Table, Th, Td, Money, Chip, StatTile, DefList, EmptyState, RefLink, btn, Bar,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The booking financial tab — plan section 42.
 *
 * "The financial control centre for the trip", and it earns that by reading
 * only the ledger: selling price from the posted invoices, received from the
 * posted payments, cost from every line tagged to the trip's analytic account
 * — including a cash expense that never had a vendor bill behind it, which is
 * exactly the cost a spreadsheet forgets.
 */
export default async function BookingPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<SearchParams>;
}) {
  const s = await ctx();
  const { id } = await params;
  const m = await msg(await searchParams);
  const fin = await bookingFinancials(s.orgId, id);
  if (!fin) return <Banner tone="error">That booking no longer exists.</Banner>;

  const { booking } = fin;
  const invoices = await listDocuments(s.orgId, { bookingId: id, docType: ['out_invoice', 'out_refund'] });
  const bills = await listDocuments(s.orgId, { bookingId: id, docType: ['in_invoice', 'in_refund'] });
  const payments = (await listPayments(s.orgId, { limit: 200 })).filter((p) => p.booking_id === id);
  const ledger = booking.analytic_id
    ? await generalLedger(s.orgId, { from: '1900-01-01', to: isoDate(), analyticId: booking.analytic_id })
    : { lines: [], opening: 0 };
  const costMax = Math.max(1, ...fin.costLines.map((c) => c.amount));

  return (
    <>
      <PageHeader
        title={`${booking.ref} — ${booking.title}`}
        subtitle={[booking.destination, booking.package_name, `${booking.pax} pax`,
          booking.agent_name && `Agent: ${booking.agent_name}`].filter(Boolean).join(' · ')}
        accent="var(--color-brand)"
        actions={
          <>
            <Chip state={booking.status} />
            <Link href={`/sales/invoices/new?booking=${id}&partner=${booking.partner_id ?? ''}`}
              className={btn.primary}>+ Invoice</Link>
            <Link href={`/purchases/bills/new?booking=${id}`} className={btn.ghost}>+ Bill</Link>
          </>
        }
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Invoiced" value={fin.invoiced} compact={false} />
        <StatTile label="Received" value={fin.received} compact={false} tone="positive" />
        <StatTile label="Outstanding" value={fin.outstanding} compact={false}
          tone={fin.outstanding > 0 ? 'warn' : 'positive'} />
        <StatTile label="Unapplied advance" value={fin.advances} compact={false} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-5">
          <Card title="Trip profit and loss"
            subtitle="Revenue and cost tagged to this trip, in the general ledger.">
            <div className="grid gap-5 sm:grid-cols-[1fr_auto]">
              <div className="space-y-3">
                {fin.costLines.length === 0 ? (
                  <p className="text-[13px] text-ink-faint">No costs tagged to this trip yet.</p>
                ) : fin.costLines.map((c) => (
                  <div key={c.code}>
                    <div className="mb-1 flex items-baseline justify-between text-[13px]">
                      <span className="font-semibold">{c.name}</span>
                      <Money value={c.amount} />
                    </div>
                    <Bar value={c.amount} max={costMax} color="var(--color-sec-purchases)" />
                  </div>
                ))}
              </div>
              <dl className="min-w-[220px] space-y-2 border-line text-[14px] sm:border-l sm:pl-5">
                <Row label="Revenue" value={fin.revenue} />
                <Row label="Total cost" value={fin.cost} />
                <div className="border-t border-line pt-2">
                  <Row label="Gross profit" value={fin.profit} bold />
                </div>
                <div className="flex justify-between gap-6">
                  <dt className="font-bold">Margin</dt>
                  <dd className={`num font-bold ${fin.profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                    {marginPct(fin.revenue, fin.profit)}
                  </dd>
                </div>
              </dl>
            </div>
          </Card>

          <Card title="Invoices" padded={false}>
            {invoices.length === 0 ? <EmptyState title="Nothing invoiced yet." /> : (
              <Table>
                <thead><tr><Th>Number</Th><Th>Date</Th><Th align="right">Total</Th>
                  <Th align="right">Outstanding</Th><Th>Status</Th></tr></thead>
                <tbody>
                  {invoices.map((d) => (
                    <tr key={d.id}>
                      <Td><RefLink href={`/d/${d.id}`}>{d.number ?? 'Draft'}</RefLink></Td>
                      <Td>{fmtDate(d.doc_date)}</Td>
                      <Td align="right"><Money value={d.total} dash={false} /></Td>
                      <Td align="right"><Money value={d.residual} /></Td>
                      <Td><Chip state={d.state === 'posted' ? d.payment_state : d.state} /></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card title="Supplier bills" padded={false}>
            {bills.length === 0 ? <EmptyState title="No supplier costs billed yet." /> : (
              <Table>
                <thead><tr><Th>Number</Th><Th>Supplier</Th><Th>Date</Th>
                  <Th align="right">Total</Th><Th align="right">Payable</Th><Th>Status</Th></tr></thead>
                <tbody>
                  {bills.map((d) => (
                    <tr key={d.id}>
                      <Td><RefLink href={`/d/${d.id}`}>{d.number ?? 'Draft'}</RefLink></Td>
                      <Td>{d.partner_name}</Td>
                      <Td>{fmtDate(d.doc_date)}</Td>
                      <Td align="right"><Money value={d.total} dash={false} /></Td>
                      <Td align="right"><Money value={d.residual} /></Td>
                      <Td><Chip state={d.state === 'posted' ? d.payment_state : d.state} /></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card title="Ledger for this trip" padded={false}
            subtitle="Every posted line tagged to the trip's analytic account.">
            {ledger.lines.length === 0 ? <EmptyState title="Nothing tagged to this trip yet." /> : (
              <Table>
                <thead><tr><Th>Date</Th><Th>Entry</Th><Th>Account</Th><Th>Label</Th>
                  <Th align="right">Debit</Th><Th align="right">Credit</Th></tr></thead>
                <tbody>
                  {ledger.lines.map((l) => (
                    <tr key={l.id}>
                      <Td>{fmtDate(l.entry_date)}</Td>
                      <Td><RefLink href={`/accounting/entries/${l.entry_id}`}>{l.entry_no}</RefLink></Td>
                      <Td><span className="text-ink-muted">{l.account_code} {l.account_name}</span></Td>
                      <Td><span className="text-ink-muted">{l.label ?? '—'}</span></Td>
                      <Td align="right"><Money value={l.debit} /></Td>
                      <Td align="right"><Money value={l.credit} /></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Trip">
            <DefList rows={[
              ['Customer', booking.partner_id
                ? <Link key="c" href={`/sales/customers/${booking.partner_id}`} className="text-brand hover:underline">
                  {booking.partner_name}
                </Link>
                : '—'],
              ['Destination', booking.destination ?? '—'],
              ['Package', booking.package_name ?? '—'],
              ['Agent', booking.agent_name ?? '—'],
              ['Travellers', String(booking.pax)],
              ['Departs', fmtDate(booking.start_date)],
              ['Returns', fmtDate(booking.end_date)],
              ['Quoted value', fmt(booking.sell_value)],
            ]} />
          </Card>

          <Card title="Accounting">
            <DefList rows={[
              ['Invoices', String(fin.counts.invoices)],
              ['Supplier bills', String(fin.counts.bills)],
              ['Payments', String(fin.counts.payments)],
              ['Credit notes', String(fin.counts.refunds)],
            ]} />
            {booking.analytic_id && (
              <Link href={`/reports/general-ledger?analytic=${booking.analytic_id}`}
                className="mt-4 block text-[13px] font-bold text-brand hover:underline">
                Full ledger extract →
              </Link>
            )}
          </Card>

          <Card title="Payments" padded={false}>
            {payments.length === 0 ? <EmptyState title="Nothing received or paid yet." /> : (
              <Table>
                <thead><tr><Th>Ref</Th><Th>Date</Th><Th align="right">Amount</Th></tr></thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <Td>
                        <span className="font-bold">{p.number}</span>
                        <div className="text-[11.5px] text-ink-faint">
                          {titleise(p.direction === 'inbound' ? 'received' : 'paid')}
                          {p.is_advance ? ' · advance' : ''}
                        </div>
                      </Td>
                      <Td>{fmtDate(p.pay_date)}</Td>
                      <Td align="right">
                        <span className={`num font-bold ${p.direction === 'inbound' ? 'text-positive' : 'text-negative'}`}>
                          {p.direction === 'inbound' ? '+' : '−'}{fmt(p.amount).replace('₹', '₹')}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className="flex justify-between gap-6">
      <dt className={bold ? 'font-bold' : 'text-ink-muted'}>{label}</dt>
      <dd><Money value={value} bold={bold} dash={false} /></dd>
    </div>
  );
}
