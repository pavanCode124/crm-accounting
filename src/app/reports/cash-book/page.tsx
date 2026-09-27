import { ctx } from '@/server/bootstrap';
import { one, resolveRange, type SearchParams } from '@/lib/range';
import { CashBookView } from '@/components/CashBookView';

export const dynamic = 'force-dynamic';

/**
 * The Cash Book — every cash account, in receipts-and-payments form.
 *
 * The layout lives in CashBookView, shared with the Bank Book; the two differ
 * only in the `is_cash` flag and the words on the page.
 */
export default async function CashBookPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const params = await searchParams;
  const range = resolveRange(
    { range: one(params, 'range'), from: one(params, 'from'), to: one(params, 'to') }, s.fyStartMonth,
  );
  return (
    <CashBookView orgId={s.orgId} range={range} isCash
      selected={one(params, 'account')} basePath="/reports/cash-book" />
  );
}
