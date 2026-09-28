import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { DocumentDetail } from '@/components/DocumentDetail';

export const dynamic = 'force-dynamic';

export default async function InvoicePage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<SearchParams>;
}) {
  const s = await ctx();
  const { id } = await params;
  return (
    <DocumentDetail
      orgId={s.orgId}
      docId={id}
      basePath="/sales/invoices"
      role={s.role}
      message={await msg(await searchParams)}
    />
  );
}
