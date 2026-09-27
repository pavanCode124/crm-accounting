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
        title="Customer Credit Notes"
        subtitle="Cancellations, refunds and corrections. Raised against an invoice, never by deleting one."
        accent="var(--color-sec-sales)"
        
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}
      <DocumentFilters action="/sales/credit-notes" filter={filter} />
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
