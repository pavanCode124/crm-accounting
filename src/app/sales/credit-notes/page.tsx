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
        title="Customer Credit Notes"
        subtitle="Cancellations, refunds and corrections. Raised against an invoice, never by deleting one."
        accent="var(--color-sec-sales)"
        
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}
      <DocumentFilters action="/sales/credit-notes" filter={filter} docType="out_refund" />
      <DocumentList
        orgId={s.orgId}
        docType="out_refund"
        basePath="/sales/credit-notes"
        filter={filter}
        emptyHint="Open a posted invoice and use Cancellation / credit note to raise one."
      />
    </>
  );
}
