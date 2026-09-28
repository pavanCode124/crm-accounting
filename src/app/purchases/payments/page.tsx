import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { PageHeader, Banner } from '@/components/ui';
import { PaymentsView } from '@/components/PaymentsView';

export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  return (
    <>
      <PageHeader title="Payments Made" subtitle="What has gone out to suppliers, and what is still sitting as an advance." accent="var(--color-sec-purchases)" />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}
      <PaymentsView orgId={s.orgId} direction="outbound" />
    </>
  );
}
