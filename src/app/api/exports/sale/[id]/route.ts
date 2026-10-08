import { authorise, xlsxResponse, downloadError } from '@/server/download';
import { saleWorkbook } from '@/server/accounting/exports';

export const dynamic = 'force-dynamic';

/**
 * One customer invoice's margin, in full — the same figures the "By invoice"
 * card on `/analytics/trips` shows, downloadable for whoever was not looking
 * at the screen. `reports.view`, like every other export.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const s = await authorise('reports.view');
    const { id } = await params;
    const built = await saleWorkbook(s.orgId, id);
    if (!built) {
      return new Response('That invoice no longer exists.\n', {
        status: 404, headers: { 'Content-Type': 'text/plain' },
      });
    }
    return xlsxResponse(built.buffer, [
      built.sale.number ?? built.sale.crm_number ?? 'Invoice',
      'Profitability',
    ]);
  } catch (e) {
    return downloadError(e);
  }
}
