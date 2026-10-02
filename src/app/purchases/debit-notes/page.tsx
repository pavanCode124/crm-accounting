import { ctx } from '@/server/bootstrap';
import { one, msg, type SearchParams } from '@/lib/range';
import { PageHeader, LinkButton, Banner } from '@/components/ui';
import { DocumentList, DocumentFilters } from '@/components/DocumentList';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const m = await msg(params);
  const filter = {
    search: await one(params, 'q'),
    state: await one(params, 'state'),
    paymentState: await one(params, 'payment'),
    from: await one(params, 'from'),
    to: await one(params, 'to'),
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
      <DocumentFilters action="/purchases/debit-notes" filter={filter} docType="in_refund" />
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
