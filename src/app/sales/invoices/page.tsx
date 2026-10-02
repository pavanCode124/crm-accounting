import { ctx } from '@/server/bootstrap';
import { one, msg, type SearchParams } from '@/lib/range';
import { PageHeader, LinkButton, Banner } from '@/components/ui';
import { DocumentList, DocumentFilters } from '@/components/DocumentList';

export const dynamic = 'force-dynamic';

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
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
        title="Customer Invoices"
        subtitle="What has been billed, what has been collected, and what is still owed."
        accent="var(--color-sec-sales)"
        actions={<LinkButton href="/sales/invoices/new" variant="primary">+ New Invoice</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}
      <DocumentFilters action="/sales/invoices" filter={filter} docType="out_invoice" />
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
