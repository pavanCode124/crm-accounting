import { ctx } from '@/server/bootstrap';
import { one, msg, type SearchParams } from '@/lib/range';
import { getPartner } from '@/server/accounting/masters';
import { PageHeader, Banner } from '@/components/ui';
import { PartnerDetail } from '@/components/PartnerViews';

export const dynamic = 'force-dynamic';

export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<SearchParams>;
}) {
  const s = ctx();
  const { id } = await params;
  const sp = await searchParams;
  const m = msg(sp);
  const partner = getPartner(s.orgId, id);
  return (
    <>
      <PageHeader title={partner?.name ?? 'Unknown'} subtitle="Supplier account" accent="var(--color-sec-purchases)" />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}
      <PartnerDetail orgId={s.orgId} partnerId={id} side="supplier" basePath="/purchases/suppliers"
        tab={one(sp, 'tab') ?? 'overview'} />
    </>
  );
}
