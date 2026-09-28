import { ctx } from '@/server/bootstrap';
import { PageHeader } from '@/components/ui';
import { AgeingReport } from '@/components/AgeingReport';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const s = await ctx();
  return (
    <>
      <PageHeader title="Accounts Payable Ageing" subtitle="What the agency owes its suppliers, and what is already late." accent="var(--color-sec-reports)" />
      <AgeingReport orgId={s.orgId} side="supplier" basePath="/purchases/suppliers" />
    </>
  );
}
