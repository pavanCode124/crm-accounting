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
        title="Vendor Bills"
        subtitle="What suppliers have charged the agency, and what is still to pay them."
        accent="var(--color-sec-purchases)"
        actions={<LinkButton href="/purchases/bills/new" variant="primary">+ New Bill</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}
      <DocumentFilters action="/purchases/bills" filter={filter} />
      <DocumentList
        orgId={s.orgId}
        docType="in_invoice"
        basePath="/purchases/bills"
        filter={filter}
        emptyHint="A bill posts the trip cost, the input tax and the payable in one entry."
      />
    </>
  );
}
