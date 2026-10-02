import 'server-only';
import { ctx } from './bootstrap';
import { ForbiddenError } from './auth';
import { can, type FinanceCap } from '@/lib/accounting';
import { XLSX_CONTENT_TYPE, downloadName } from './xlsx';

/**
 * The shared half of every download route.
 *
 * WHY THESE ARE ROUTES AND NOT SERVER ACTIONS. A server action returns a value
 * to React; a download has to be a plain GET that the browser handles itself,
 * so the link works from a right-click, survives being copied into a bookmark,
 * and does not require the page it was clicked on to still exist. It also means
 * a spreadsheet is never held in a React payload on its way to the client.
 *
 * `requireCap` IS CALLED HERE AND NOT ONLY ON THE PAGE. A route handler is a
 * public endpoint: the button that reaches it is drawn only for a role that may
 * see the figures, and the button is a courtesy (plan section 46). An export is
 * the whole ledger in one file, which makes it the single most valuable thing
 * in the product to a reader who should not have it.
 */
export async function authorise(cap: FinanceCap) {
  const s = await ctx();
  if (!can(s.role, cap)) throw new ForbiddenError(cap);
  return s;
}

/**
 * The response a workbook goes out in.
 *
 * `attachment` rather than `inline`: a browser handed a spreadsheet inline with
 * no handler for it renders the zip as text, and the reader's first experience
 * of the feature is a screenful of binary. `no-store` because the figures move
 * — a cached payout statement is one that disagrees with the ledger it came
 * from, and the reader has no way to tell.
 */
export function xlsxResponse(buffer: Buffer, parts: Array<string | null | undefined>): Response {
  const name = downloadName(parts);
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Length': String(buffer.length),
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * What a download route says when it cannot produce a file.
 *
 * Plain text and the right status, not a redirect to a banner: the response is
 * going into a download slot, and a browser that follows a redirect out of one
 * shows the user nothing at all. A sentence they can read is the minimum.
 */
export function downloadError(e: unknown): Response {
  if (e instanceof ForbiddenError) {
    return new Response(`${e.message}\n`, { status: 403, headers: { 'Content-Type': 'text/plain' } });
  }
  const message = e instanceof Error ? e.message : 'The export could not be produced.';
  return new Response(`${message}\n`, { status: 400, headers: { 'Content-Type': 'text/plain' } });
}
