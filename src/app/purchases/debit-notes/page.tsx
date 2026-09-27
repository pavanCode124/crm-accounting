import { ctx } from '@/server/bootstrap';
import { one, msg, type SearchParams } from '@/lib/range';
import { PageHeader, LinkButton, Banner } from '@/components/ui';
import { DocumentList, DocumentFilters } from '@/components/DocumentList';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const params = await searchParams;
  const m = msg(params);
  const filter = {
    search: one(params, 'q'),
    state: one(params, 'state'),
    paymentState: one(params, 'payment'),
    from: one(params, 'from'),
    to: one(params, 'to'),
  };

  return (
    <>
      <PageHeader
        title="Vendor Debit Notes"
        subtitle="Credit received from a supplier — a cancelled room, a refunded ticket."
        accent="var(--color-sec-purchases)"
        
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}
      <DocumentFilters action="/purchases/debit-notes" filter={filter} />
      <DocumentList
        orgId={s.orgId}
        docType="in_refund"
        basePath="/purchases/debit-notes"
        filter={filter}
        emptyHint="Open a posted bill to raise one against it."
      />
    </>
  );
}
