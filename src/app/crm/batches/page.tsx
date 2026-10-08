import { ctx } from '@/server/bootstrap';
import { one, msg, type SearchParams } from '@/lib/range';
import { liveBatches, type CrmBatch } from '@/server/crm/live';
import {
  PageHeader, Card, Table, Th, Td, Chip, EmptyState, Banner, StatTile, inputClass, btn,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The agency's departures, LIVE from TripzoCRM.
 *
 * -------------------------------------------------------------------------
 * READ-ONLY, LIKE PACKAGES BESIDE IT, AND FOR THE SAME REASON
 * -------------------------------------------------------------------------
 * A batch's seats and status change daily — a departure can fill up or be
 * cancelled between two page loads — so the only honest answer is whatever
 * the CRM says right now. Nothing here is written to this ledger's own
 * database: no sync, no mirror, not even the snapshot-on-empty-read that
 * `crm_packages` gives the catalogue. A batch field is optional everywhere it
 * appears on a document form, so "empty while the CRM cannot be reached" is
 * an acceptable degrade here, same as the Trip/booking field already has.
 *
 * This is also the reason the Batch field on invoices, vendor bills, expense
 * claims and commissions shows something to pick from the moment an agency
 * starts using this ledger: unlike Trip/booking, which only has rows once a
 * CRM lead has been synced or a booking created by hand, a batch is read off
 * the CRM directly, every time.
 */
export default async function CrmBatchesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const m = await msg(params);
  const query = await one(params, 'query');

  const live = await liveBatches(query ?? undefined);
  const { rows, error, connected } = live;

  const open = rows.filter((b) => (b.status ?? 'open') === 'open');
  const seatsBooked = rows.reduce((t, b) => t + (b.seats_booked ?? 0), 0);
  const seatsTotal = rows.reduce((t, b) => t + (b.seats_total ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Batches"
        subtitle="Departures of a package, live from TripzoCRM — the unit several invoices and vendor bills are often raised against."
        accent="var(--color-sec-sales)"
        actions={
          <a className={btn.primary} href="/crm/batches">Fetch from TripzoCRM</a>
        }
      />

      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      {!connected && (
        <Banner tone="warn">
          Not signed in to TripzoCRM, so there are no batches to show. Sign out and back in with your
          CRM account.
        </Banner>
      )}
      {error && (
        <Banner tone="error">
          TripzoCRM did not answer: {error}. The ledger is unaffected — this is a connection problem
          rather than a data one.
        </Banner>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile label="Batches" value={String(rows.length)} hint={`${open.length} open`} />
        <StatTile label="Seats booked" value={String(seatsBooked)}
          hint={seatsTotal ? `of ${seatsTotal}` : undefined} />
        <StatTile label="Closed / cancelled" value={String(rows.length - open.length)} />
      </div>

      <Card
        title="Departures"
        subtitle="Pick one of these on an invoice, a vendor bill, an expense claim or a commission to tag it to this batch."
        padded={false}
      >
        <form className="flex gap-2 border-b border-line px-5 py-3">
          <input
            name="query" defaultValue={query ?? ''} placeholder="Search batches…"
            className={`${inputClass} max-w-[320px]`}
          />
          <button className={btn.ghost}>Search</button>
        </form>

        {rows.length === 0 ? (
          <EmptyState title={
            error ? 'Nothing to show while the CRM is unreachable.'
              : query ? `No batch matches "${query}".`
                : 'This agency has no batches in the CRM yet.'
          } />
        ) : (
          <div className="scroll-x">
            <Table>
              <thead>
                <tr>
                  <Th>Batch</Th><Th>Package</Th><Th>Destinations</Th>
                  <Th>Departs</Th><Th>Returns</Th>
                  <Th align="right">Seats</Th><Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id} className="hover:bg-canvas">
                    <Td>
                      <span className="font-semibold">{b.batch_name || b.batch_code || 'Batch'}</span>
                      {b.batch_name && b.batch_code && (
                        <div className="text-[11.5px] text-ink-faint">#{b.batch_code}</div>
                      )}
                    </Td>
                    <Td><span className="text-ink-muted">{b.package_name ?? '—'}</span></Td>
                    <Td>
                      <span className="text-ink-muted">
                        {b.destinations?.length ? b.destinations.join(', ') : '—'}
                      </span>
                    </Td>
                    <Td><span className="num !text-left">{fmtBatchDate(b.start_date)}</span></Td>
                    <Td><span className="num !text-left">{fmtBatchDate(b.end_date)}</span></Td>
                    <Td align="right">
                      <span className="num">
                        {b.seats_total ? `${b.seats_booked ?? 0} / ${b.seats_total}` : '—'}
                      </span>
                    </Td>
                    <Td>{statusChip(b)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </>
  );
}

function fmtBatchDate(d: string | null | undefined): string {
  if (!d) return '—';
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime())
    ? '—'
    : parsed.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function statusChip(b: CrmBatch) {
  const status = b.status ?? 'open';
  if (status === 'cancelled') return <Chip state="cancelled" label="Cancelled" />;
  if (status === 'closed') return <Chip state="draft" label="Closed" />;
  return <Chip state="posted" label="Open" />;
}
