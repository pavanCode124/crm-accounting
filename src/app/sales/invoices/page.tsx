import { ctx } from '@/server/bootstrap';
import { one, msg, type SearchParams } from '@/lib/range';
import { PageHeader, LinkButton, Banner } from '@/components/ui';
import { DocumentList, DocumentFilters } from '@/components/DocumentList';

export const dynamic = 'force-dynamic';

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
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
        title="Customer Invoices"
        subtitle="What has been billed, what has been collected, and what is still owed."
        accent="var(--color-sec-sales)"
        actions={<LinkButton href="/sales/invoices/new" variant="primary">+ New Invoice</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}
      <DocumentFilters action="/sales/invoices" filter={filter} />
      <DocumentList
        orgId={s.orgId}
        docType="out_invoice"
        basePath="/sales/invoices"
        filter={filter}
        emptyHint="Raise an invoice against a booking and its revenue, tax and receivable are posted in one balanced entry."
      />
    </>
  );
}
