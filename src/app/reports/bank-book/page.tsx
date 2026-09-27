import { ctx } from '@/server/bootstrap';
import { one, resolveRange, type SearchParams } from '@/lib/range';
import { CashBookView } from '@/components/CashBookView';

export const dynamic = 'force-dynamic';

/**
 * The Bank Book — every bank account, in receipts-and-payments form.
 *
 * NOT the same screen as Banking › Reconciliation. This is the BOOK side only:
 * what the ledger says passed through the account. Reconciliation is the book
 * set against the statement, and the difference between the two figures is the
 * reconciliation itself.
 */
export default async function BankBookPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const params = await searchParams;
  const range = resolveRange(
    { range: one(params, 'range'), from: one(params, 'from'), to: one(params, 'to') }, s.fyStartMonth,
  );
  return (
    <CashBookView orgId={s.orgId} range={range} isCash={false}
      selected={one(params, 'account')} basePath="/reports/bank-book" />
  );
}
