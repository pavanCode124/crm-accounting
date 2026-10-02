import { authorise, xlsxResponse, downloadError } from '@/server/download';
import { documentWorkbook } from '@/server/accounting/exports';
import { DOC_TYPES, type DocType } from '@/lib/accounting';

export const dynamic = 'force-dynamic';

/** One invoice, bill or note, as the tax document it is. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const s = await authorise('finance.view');
    const { id } = await params;
    const built = await documentWorkbook(s.orgId, id);
    if (!built) {
      return new Response('That document no longer exists.\n', {
        status: 404, headers: { 'Content-Type': 'text/plain' },
      });
    }
    const meta = DOC_TYPES[built.doc.doc_type as DocType];
    return xlsxResponse(built.buffer, [
      meta.short,
      built.doc.number ?? 'draft',
      built.doc.partner_name,
    ]);
  } catch (e) {
    return downloadError(e);
  }
}
