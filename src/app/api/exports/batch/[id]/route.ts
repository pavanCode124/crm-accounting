import { authorise, xlsxResponse, downloadError } from '@/server/download';
import { batchWorkbook } from '@/server/accounting/exports';

export const dynamic = 'force-dynamic';

/**
 * One TripzoCRM departure's margin, in full — every invoice raised against
 * it and every cost tagged to it directly or inherited from one of those
 * invoices. The same figures the "By batch" card on `/analytics/trips` shows.
 * `reports.view`, like every other export.
 *
 * `[id]` is the CRM's own batch id (`crm_batch_id`), not a row in this
 * ledger's database — a batch is read live, never stored, so there is
 * nothing here to look up except the documents, bills, claims and
 * commissions that were tagged with it.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const s = await authorise('reports.view');
    const { id } = await params;
    const built = await batchWorkbook(s.orgId, id);
    if (!built) {
      return new Response('No invoices have been tagged to that batch.\n', {
        status: 404, headers: { 'Content-Type': 'text/plain' },
      });
    }
    return xlsxResponse(built.buffer, [
      built.batch.batch_name ?? 'Batch',
      'Profitability',
    ]);
  } catch (e) {
    return downloadError(e);
  }
}
