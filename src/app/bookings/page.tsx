import { ctx } from '@/server/bootstrap';
import { one, msg, type SearchParams } from '@/lib/range';
import { listBookings, tripProfitability } from '@/server/accounting/analytics';
import { fmtDate } from '@/lib/accounting';
import { fmt } from '@/lib/money';
import {
  PageHeader, Card, Banner, Table, Th, Td, Money, Chip, EmptyState, RefLink, LinkButton,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Bookings, seen from Finance.
 *
 * The CRM owns the booking; this is its financial mirror, and creating one here
 * creates its TRIP ANALYTIC ACCOUNT at the same time. Always together — a
 * booking with no analytic account is a trip whose costs cannot be tagged, and
 * that is discovered three invoices later when its margin reads zero.
 */
export default async function BookingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const params = await searchParams;
  const m = msg(params);
  const search = one(params, 'q');
  const bookings = listBookings(s.orgId, { search, status: one(params, 'status') });
  const profit = new Map(tripProfitability(s.orgId).map((t) => [t.booking_id, t]));

  return (
    <>
      <PageHeader
        title="Bookings"
        subtitle="Every trip, with what it has earned and what it has cost so far."
        accent="var(--color-brand)"
        actions={<LinkButton href="/bookings/new" variant="primary">+ New Booking</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <Card padded={false}>
          {bookings.length === 0 ? (
            <EmptyState title="No bookings yet."
              hint="Create one here, or let the CRM push them across when a lead is marked Booked." />
          ) : (
            <Table>
              <thead>
                <tr><Th>Ref</Th><Th>Trip</Th><Th>Customer</Th><Th>Departs</Th>
                  <Th align="right">Revenue</Th><Th align="right">Cost</Th>
                  <Th align="right">Margin</Th><Th>Status</Th></tr>
              </thead>
              <tbody>
                {bookings.map((b) => {
                  const p = profit.get(b.id);
                  return (
                    <tr key={b.id} className="hover:bg-canvas">
                      <Td><RefLink href={`/bookings/${b.id}`}>{b.ref}</RefLink></Td>
                      <Td>
                        <span className="font-semibold">{b.title}</span>
                        <div className="text-[12px] text-ink-faint">
                          {b.destination} · {b.pax} pax · {b.agent_name ?? 'unassigned'}
                        </div>
                      </Td>
                      <Td>{b.partner_name ?? '—'}</Td>
                      <Td>{fmtDate(b.start_date)}</Td>
                      <Td align="right"><Money value={p?.revenue ?? 0} /></Td>
                      <Td align="right"><Money value={p?.cost ?? 0} /></Td>
                      <Td align="right">
                        {p
                          ? <span className={`num font-bold ${p.profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                            {fmt(p.profit)} · {p.margin.toFixed(1)}%
                          </span>
                          : <span className="text-ink-faint">—</span>}
                      </Td>
                      <Td><Chip state={b.status} /></Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
      </Card>
    </>
  );
}
