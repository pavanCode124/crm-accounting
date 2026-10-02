import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { DocumentEdit } from '@/components/DocumentEdit';

export const dynamic = 'force-dynamic';

export default async function InvoiceEditPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<SearchParams>;
}) {
  const s = await ctx();
  const { id } = await params;
  return (
    <DocumentEdit
      orgId={s.orgId}
      docId={id}
      basePath="/sales/invoices"
      role={s.role}
      message={await msg(await searchParams)}
    />
  );
}
