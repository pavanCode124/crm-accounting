import { ctx } from '@/server/bootstrap';
import { one, msg, type SearchParams } from '@/lib/range';
import { PageHeader, Banner } from '@/components/ui';
import { PartnerList } from '@/components/PartnerViews';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const m = await msg(params);
  return (
    <>
      <PageHeader title="Customers" subtitle="The CRM customer, with the financial side attached — what they owe and what they have paid." accent="var(--color-sec-sales)" />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}
      <PartnerList orgId={s.orgId} side="customer" basePath="/sales/customers" search={await one(params, 'q')} />
    </>
  );
}
