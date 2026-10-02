import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { one, type SearchParams } from '@/lib/range';
import { listDocuments } from '@/server/accounting/documents';
import { listPartners } from '@/server/accounting/masters';
import { listBookings } from '@/server/accounting/analytics';
import { searchNav } from '@/lib/nav';
import { fmtDate } from '@/lib/accounting';
import { PageHeader, Card, Table, Th, Td, Money, Chip, EmptyState, RefLink } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Search.
 *
 * Deliberately narrow: screens, documents, partners and bookings, which is
 * what the search bar is actually used for — "where is INV-0004", "what does
 * Rahul owe", "open BK-1025", "take me to trip profitability". A full-text
 * index over journal narrations would be more impressive and would answer none
 * of those faster.
 *
 * SCREENS COME FIRST because a query that names one is unambiguous: nobody
 * types "trip profitability" hoping for an invoice. They are also the only
 * result that costs nothing to produce — the menu registry is already in
 * memory — so the bar stops returning "nothing matched" for the easiest
 * question it gets.
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const q = (await one(await searchParams, 'q') ?? '').trim();

  if (!q) {
    return (
      <>
        <PageHeader title="Search" subtitle="Invoices, bills, customers, suppliers and bookings." />
        <Card><EmptyState title="Type something into the bar above." /></Card>
      </>
    );
  }

  const screens = searchNav(q, s.role);
  const documents = await listDocuments(s.orgId, { search: q, limit: 30 });
  const partners = await listPartners(s.orgId, { search: q, limit: 20 });
  const bookings = await listBookings(s.orgId, { search: q, limit: 20 });
  const nothing = !screens.length && !documents.length && !partners.length && !bookings.length;

  return (
    <>
      <PageHeader title={`Search — ${q}`}
        subtitle={`${screens.length + documents.length + partners.length + bookings.length} result(s)`} />

      {nothing && (
        <Card><EmptyState title="Nothing matched." hint="Try a document number, a name, a booking reference, or the name of a screen." /></Card>
      )}

      {screens.length > 0 && (
        <Card title="Screens" padded={false} className="mb-5">
          <Table>
            <thead><tr><Th>Screen</Th><Th>Section</Th></tr></thead>
            <tbody>
              {screens.map((n) => (
                <tr key={n.href} className="hover:bg-canvas">
                  <Td>
                    <Link href={n.href} className="font-bold text-brand hover:underline">{n.label}</Link>
                  </Td>
                  <Td><span className="text-ink-muted">{n.section}</span></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {documents.length > 0 && (
        <Card title="Documents" padded={false} className="mb-5">
          <Table>
            <thead>
              <tr><Th>Number</Th><Th>Partner</Th><Th>Date</Th>
                <Th align="right">Total</Th><Th align="right">Outstanding</Th><Th>Status</Th></tr>
            </thead>
            <tbody>
              {documents.map((d) => (
                <tr key={d.id} className="hover:bg-canvas">
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
        </Card>
      )}

      {partners.length > 0 && (
        <Card title="Customers & suppliers" padded={false} className="mb-5">
          <Table>
            <thead><tr><Th>Name</Th><Th>Contact</Th><Th align="right">Receivable</Th><Th align="right">Payable</Th></tr></thead>
            <tbody>
              {partners.map((p) => (
                <tr key={p.id} className="hover:bg-canvas">
                  <Td>
                    <Link href={p.is_customer ? `/sales/customers/${p.id}` : `/purchases/suppliers/${p.id}`}
                      className="font-bold text-brand hover:underline">{p.name}</Link>
                  </Td>
                  <Td><span className="text-ink-muted">{p.email ?? p.phone ?? '—'}</span></Td>
                  <Td align="right"><Money value={p.receivable ?? 0} /></Td>
                  <Td align="right"><Money value={p.payable ?? 0} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {bookings.length > 0 && (
        <Card title="Bookings" padded={false}>
          <Table>
            <thead><tr><Th>Ref</Th><Th>Trip</Th><Th>Customer</Th><Th>Departs</Th><Th>Status</Th></tr></thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id} className="hover:bg-canvas">
                  <Td><RefLink href={`/bookings/${b.id}`}>{b.ref}</RefLink></Td>
                  <Td>{b.title}</Td>
                  <Td>{b.partner_name ?? '—'}</Td>
                  <Td>{fmtDate(b.start_date)}</Td>
                  <Td><Chip state={b.status} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
