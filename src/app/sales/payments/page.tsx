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
      <PageHeader title="Payments Received" subtitle="Receipts and customer advances, and what each one settled." accent="var(--color-sec-sales)" />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}
      <PaymentsView orgId={s.orgId} direction="inbound" />
    </>
  );
}
