import { authorise, xlsxResponse, downloadError } from '@/server/download';
import { taxWorkbook } from '@/server/accounting/exports';
import { ctx } from '@/server/bootstrap';
import { resolveRange } from '@/lib/range';

export const dynamic = 'force-dynamic';

/**
 * The tax report, as a workbook.
 *
 * THE PERIOD IS RESOLVED THE SAME WAY THE SCREEN RESOLVES IT, through
 * `resolveRange` and the organisation's own financial-year start. A route that
 * parsed `from`/`to` by hand would disagree with the page the button sits on
 * for every preset — and a GST workbook covering a different quarter from the
 * one on screen is worse than no workbook, because nothing about the file says
 * which quarter it holds until someone reconciles it and cannot.
 */
export async function GET(req: Request) {
  try {
    const s = await authorise('reports.view');
    const q = new URL(req.url).searchParams;
    const { fyStartMonth } = await ctx();
    const range = resolveRange(
      { range: q.get('range') ?? undefined, from: q.get('from') ?? undefined, to: q.get('to') ?? undefined },
      fyStartMonth,
    );
    const buffer = await taxWorkbook(s.orgId, range);
    return xlsxResponse(buffer, [s.orgName, 'Tax Report', `${range.from} to ${range.to}`]);
  } catch (e) {
    return downloadError(e);
  }
}
