import { ctx } from '@/server/bootstrap';
import { PageHeader } from '@/components/ui';
import { AgeingReport } from '@/components/AgeingReport';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const s = ctx();
  return (
    <>
      <PageHeader title="Accounts Receivable Ageing" subtitle="Who owes what, and for how long it has been owed." accent="var(--color-sec-reports)" />
      <AgeingReport orgId={s.orgId} side="customer" basePath="/sales/customers" />
    </>
  );
}
