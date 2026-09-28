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
  const s = await ctx();
  const params = await searchParams;
  const range = resolveRange(
    { range: await one(params, 'range'), from: await one(params, 'from'), to: await one(params, 'to') }, s.fyStartMonth,
  );
  return (
    <CashBookView orgId={s.orgId} range={range} isCash
      selected={await one(params, 'account')} basePath="/reports/cash-book" />
  );
}
