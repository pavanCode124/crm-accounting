import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { DocumentDetail } from '@/components/DocumentDetail';

export const dynamic = 'force-dynamic';

export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<SearchParams>;
}) {
  const s = ctx();
  const { id } = await params;
  return (
    <DocumentDetail
      orgId={s.orgId}
      docId={id}
      basePath="/purchases/debit-notes"
      role={s.role}
      message={msg(await searchParams)}
    />
  );
}
