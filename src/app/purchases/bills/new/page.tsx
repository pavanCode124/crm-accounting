import { ctx } from '@/server/bootstrap';
import { can } from '@/lib/accounting';
import { documentFormOptions } from '@/server/options';
import { msg, one, type SearchParams } from '@/lib/range';
import { PageHeader, Banner } from '@/components/ui';
import { DocumentForm } from '@/components/DocumentForm';

export const dynamic = 'force-dynamic';

export default async function NewBillPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const params = await searchParams;
  const m = msg(params);
  const options = documentFormOptions(s.orgId, 'in_invoice', can(s.role, 'bill.post'));

  return (
    <>
      <PageHeader
        title="New Vendor Bill"
        subtitle="Tag the trip and the cost lands in its margin as well as in the P&L."
        accent="var(--color-sec-purchases)"
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
