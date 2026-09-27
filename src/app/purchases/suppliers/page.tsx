import { ctx } from '@/server/bootstrap';
import { one, msg, type SearchParams } from '@/lib/range';
import { PageHeader, Banner } from '@/components/ui';
import { PartnerList } from '@/components/PartnerViews';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const params = await searchParams;
  const m = msg(params);
  return (
    <>
      <PageHeader title="Suppliers" subtitle="Hotels, consolidators, ground handlers and agencies — what the trips cost and what is still owed." accent="var(--color-sec-purchases)" />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}
      <PartnerList orgId={s.orgId} side="supplier" basePath="/purchases/suppliers" search={one(params, 'q')} />
    </>
  );
}
