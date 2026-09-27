import { ctx } from '@/server/bootstrap';
import { can } from '@/lib/accounting';
import { documentFormOptions } from '@/server/options';
import { msg, one, type SearchParams } from '@/lib/range';
import { PageHeader, Banner } from '@/components/ui';
import { DocumentForm } from '@/components/DocumentForm';

export const dynamic = 'force-dynamic';

export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const params = await searchParams;
  const m = msg(params);
  const options = documentFormOptions(s.orgId, 'out_invoice', can(s.role, 'invoice.post'));

  return (
    <>
      <PageHeader
        title="New Customer Invoice"
        subtitle="Lines carry their own revenue account and tax; the receivable side is worked out for you."
        accent="var(--color-sec-sales)"
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      <DocumentForm
        {...options}
        defaults={{
          partnerId: one(params, 'partner'),
          bookingId: one(params, 'booking'),
          journalId: options.journals[0]?.id,
        }}
      />
    </>
  );
}
