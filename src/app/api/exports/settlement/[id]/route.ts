import { authorise, xlsxResponse, downloadError } from '@/server/download';
import { payoutWorkbook } from '@/server/accounting/exports';

export const dynamic = 'force-dynamic';

/**
 * The payout statement, as a workbook.
 *
 * `reports.view` and not a settlement-specific capability: this is a READ of
 * figures that are already on the ledger, in a different shape. The capability
 * that matters for a settlement is the one that lets someone POST it, and that
 * is checked where the posting happens.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const s = await authorise('reports.view');
    const { id } = await params;
    const built = await payoutWorkbook(s.orgId, id);
    if (!built) {
      return new Response('That settlement no longer exists.\n', {
        status: 404, headers: { 'Content-Type': 'text/plain' },
      });
    }
    return xlsxResponse(built.buffer, [
      built.settlement.partner_name ?? 'Settlement',
      built.settlement.number ?? 'draft',
      `${built.settlement.cycle_from} to ${built.settlement.cycle_to}`,
    ]);
  } catch (e) {
    return downloadError(e);
  }
}
