import { authorise, xlsxResponse, downloadError } from '@/server/download';
import { documentListWorkbook } from '@/server/accounting/exports';
import { DOC_TYPES, type DocType } from '@/lib/accounting';
import type { DocFilter } from '@/server/accounting/documents';

export const dynamic = 'force-dynamic';

/**
 * A list of documents in the item-level statement layout.
 *
 * THE FILTERS ARE THE SCREEN'S OWN, passed straight through, so the file holds
 * exactly the rows the user was looking at when they clicked. An export that
 * silently returns everything instead of the filtered view is the single most
 * misleading thing this feature could do: the reader checks a total against
 * what was on screen, and it does not match for a reason they cannot see.
 *
 * `doc_type` is validated against the closed set rather than interpolated,
 * since it reaches the SQL as a filter value and an unknown type should be a
 * refusal rather than an empty workbook that looks like a quiet month.
 */
export async function GET(req: Request) {
  try {
    const s = await authorise('reports.view');
    const q = new URL(req.url).searchParams;

    const types = q.getAll('type').filter((t): t is DocType => t in DOC_TYPES);
    if (q.getAll('type').length && !types.length) {
      return new Response('Unknown document type.\n', {
        status: 400, headers: { 'Content-Type': 'text/plain' },
      });
    }

    const filter: DocFilter = {
      docType: types.length ? types : undefined,
      state: q.get('state') ?? undefined,
      // `payment` is what the list screen's own filter strip calls it, and that
      // strip is what submits here. Both spellings are honoured so the route
      // also reads a hand-written link without the caller having to know which
      // name the UI happened to pick.
      paymentState: q.get('payment_state') ?? q.get('payment') ?? undefined,
      partnerId: q.get('partner') ?? undefined,
      bookingId: q.get('booking') ?? undefined,
      from: q.get('from') ?? undefined,
      to: q.get('to') ?? undefined,
      search: q.get('q') ?? undefined,
      // Higher than a screen's page, because this is the file someone hands an
      // auditor, and lower than unbounded, because the whole set is held in
      // memory while the workbook is assembled.
      limit: 5000,
    };

    const label = types.length === 1 ? `${DOC_TYPES[types[0]].short}s` : 'Orders';
    const buffer = await documentListWorkbook(s.orgId, filter, label);
    return xlsxResponse(buffer, [
      s.orgName, label,
      filter.from && filter.to ? `${filter.from} to ${filter.to}` : null,
    ]);
  } catch (e) {
    return downloadError(e);
  }
}
