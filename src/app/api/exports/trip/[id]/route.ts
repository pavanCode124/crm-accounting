import { authorise, xlsxResponse, downloadError } from '@/server/download';
import { tripWorkbook } from '@/server/accounting/exports';

export const dynamic = 'force-dynamic';

/**
 * One trip, in full, as a workbook.
 *
 * `[id]` IS THE ANALYTIC ACCOUNT and not the booking, because the analytic
 * account is what the ledger is tagged with and therefore what the report is
 * actually about. A trip can exist as a cost centre before the CRM booking
 * does, and a booking with no analytic account has nothing to drill into.
 * `/bookings/[id]` resolves its analytic account before linking here, so the
 * CRM side still starts from the record its users know.
 *
 * `reports.view`, like every other export: this is the same ledger the Trip
 * Profitability screen already prints, in the shape an accountant reconciles.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const s = await authorise('reports.view');
    const { id } = await params;
    const built = await tripWorkbook(s.orgId, id);
    if (!built) {
      return new Response('That trip no longer exists.\n', {
        status: 404, headers: { 'Content-Type': 'text/plain' },
      });
    }
    const { analytic, booking } = built.dossier;
    return xlsxResponse(built.buffer, [
      booking?.ref ?? analytic.code,
      analytic.name,
      'Trip Profitability',
    ]);
  } catch (e) {
    return downloadError(e);
  }
}
