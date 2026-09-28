import Link from 'next/link';
import { cashBookAccounts, ledgerAccount } from '@/server/accounting/books';
import { fmtDate } from '@/lib/accounting';
import {
  PageHeader, Card, Table, Th, Td, Money, DrCrMoney, EmptyState, RefLink, StatTile, Banner,
} from './ui';
import { RangeBar } from './RangeBar';

/**
 * The Cash Book and the Bank Book.
 *
 * ONE COMPONENT, TWO ROUTES. The two books differ in exactly one predicate —
 * `bank_accounts.is_cash` — and in the words on the page. Everything else, the
 * two-sided layout, the balance carried down, the contra column, is identical.
 * Two copies of this file would be two places to fix the next time the layout
 * changes, and the one that got missed would be the one nobody opened for a
 * month.
 *
 * WHY A CASH BOOK IS NOT JUST A LEDGER ACCOUNT. In substance it is — the same
 * account, the same postings. In FORM it is the book an agency actually keeps:
 * receipts down the left, payments down the right, one page per account, with
 * the closing balance proved at the foot. A cashier reconciling a tin of notes
 * against the system reads this shape and not a general ledger extract, and a
 * system that cannot print it gets replaced by a spreadsheet that can.
 */

export interface CashBookProps {
  orgId: string;
  range: { from: string; to: string; key: string; label: string };
  /** true = the Cash Book, false = the Bank Book. */
  isCash: boolean;
  /** The bank_accounts row being opened, if any. */
  selected?: string;
  basePath: string;
}

export async function CashBookView({ orgId, range, isCash, selected, basePath }: CashBookProps) {
  const accounts = await cashBookAccounts(orgId, range, isCash);
  const current = selected ? accounts.find((a) => a.bank_account_id === selected) : undefined;
  const book = current ? await ledgerAccount(orgId, current.account_id, range) : null;

  const noun = isCash ? 'cash' : 'bank';
  const opening = accounts.reduce((s, a) => s + a.opening, 0);
  const receipts = accounts.reduce((s, a) => s + a.receipts, 0);
  const payments = accounts.reduce((s, a) => s + a.payments, 0);
  const closing = accounts.reduce((s, a) => s + a.closing, 0);

  return (
    <>
      <PageHeader
        title={isCash ? 'Cash Book' : 'Bank Book'}
        subtitle={`${fmtDate(range.from)} to ${fmtDate(range.to)} · receipts and payments through every ${noun} account`}
        accent="var(--color-sec-banking)"
      />

      <RangeBar action={basePath} range={range} extra={{ account: selected }} />

      {accounts.length === 0 ? (
        <Card>
          <EmptyState
            title={`No ${noun} accounts are set up.`}
            hint={isCash
              ? 'Add a cash account on the Banking screen and tick "cash" to open a cash book for it.'
              : 'Add a bank account on the Banking screen to open a bank book for it.'}
          />
        </Card>
      ) : (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Opening balance" value={opening} compact={false} />
            <StatTile label="Receipts" value={receipts} compact={false} tone="positive" />
            <StatTile label="Payments" value={payments} compact={false} tone="negative" />
            <StatTile label="Closing balance" value={closing} compact={false}
              tone={closing < 0 ? 'warn' : 'neutral'}
              hint={closing < 0 ? 'Overdrawn' : undefined} />
          </div>

          {/* The index: every account, with its four figures. Choosing one opens
              the book itself below. */}
          <Card padded={false} title={`${isCash ? 'Cash' : 'Bank'} accounts`}
            subtitle="Opening plus receipts less payments equals closing, per account."
            className="mb-5">
            <Table>
              <thead>
                <tr>
                  <Th>Account</Th><Th>Details</Th>
                  <Th align="right" width="130px">Opening</Th>
                  <Th align="right" width="130px">Receipts</Th>
                  <Th align="right" width="130px">Payments</Th>
                  <Th align="right" width="145px">Closing</Th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.bank_account_id}
                    className={`hover:bg-canvas ${a.bank_account_id === selected ? 'bg-brand-soft' : ''}`}>
                    <Td>
                      <Link href={`${basePath}?account=${a.bank_account_id}&from=${range.from}&to=${range.to}`}
                        className="font-bold text-brand hover:underline">{a.label}</Link>
                    </Td>
                    <Td>
                      <span className="text-ink-muted">
                        {[a.bank_name, a.account_no].filter(Boolean).join(' · ') || '—'}
                      </span>
                    </Td>
                    <Td align="right"><DrCrMoney value={a.opening} /></Td>
                    <Td align="right"><Money value={a.receipts} /></Td>
                    <Td align="right"><Money value={a.payments} /></Td>
                    <Td align="right"><DrCrMoney value={a.closing} bold /></Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-brand-soft">
                  <Td colSpan={2}><span className="font-extrabold">All {noun} accounts</span></Td>
                  <Td align="right"><DrCrMoney value={opening} bold /></Td>
                  <Td align="right"><Money value={receipts} bold dash={false} /></Td>
                  <Td align="right"><Money value={payments} bold dash={false} /></Td>
                  <Td align="right"><DrCrMoney value={closing} bold /></Td>
                </tr>
              </tfoot>
            </Table>
          </Card>

          {!current && (
            <Card>
              <EmptyState title="Pick an account above to open its book."
                hint="The book shows every receipt and payment, with the balance carried down." />
            </Card>
          )}

          {current && book && (
            <>
              {current.closing < 0 && (
                <Banner tone="warn">
                  {current.label} is overdrawn by {money(Math.abs(current.closing))} at {fmtDate(range.to)}.
                  For a bank account that is an overdraft; for a cash tin it is impossible and means a
                  payment has been recorded that was never made.
                </Banner>
              )}
              <TwoSidedBook book={book} label={current.label} range={range} isCash={isCash} />
            </>
          )}
        </>
      )}
    </>
  );
}

/**
 * The book itself: receipts on the left, payments on the right.
 *
 * Deliberately the same shape as the T-account on the Ledger Account screen,
 * with the two sides renamed. A debit to a cash account IS a receipt, and a
 * credit IS a payment; calling them so on this page and Dr/Cr on that one is
 * the difference between a page a cashier can use and one they cannot.
 */
function TwoSidedBook({ book, label, range, isCash }: {
  book: NonNullable<Awaited<ReturnType<typeof ledgerAccount>>>;
  label: string;
  range: { from: string; to: string };
  isCash: boolean;
}) {
  const receipts = book.rows.filter((r) => r.debit > 0);
  const payments = book.rows.filter((r) => r.credit > 0);

  // Opening on the receipts side when positive (money in hand), and the closing
  // balance carried down on the payments side, so both columns total alike.
  const left = [
    ...(book.opening > 0
      ? [{ key: 'ob', date: range.from, text: 'To Balance b/d', sub: null as string | null, amount: book.opening, href: null as string | null }]
      : []),
    ...receipts.map((r) => ({
      key: r.id, date: r.entry_date, text: `To ${r.particulars}`,
      sub: r.partner_name ?? r.label, amount: r.debit,
      href: `/accounting/entries/${r.entry_id}`,
    })),
    ...(book.closing < 0
      ? [{ key: 'cd', date: range.to, text: 'To Balance c/d', sub: null, amount: -book.closing, href: null }]
      : []),
  ];
  const right = [
    ...(book.opening < 0
      ? [{ key: 'ob', date: range.from, text: 'By Balance b/d (overdrawn)', sub: null as string | null, amount: -book.opening, href: null as string | null }]
      : []),
    ...payments.map((r) => ({
      key: r.id, date: r.entry_date, text: `By ${r.particulars}`,
      sub: r.partner_name ?? r.label, amount: r.credit,
      href: `/accounting/entries/${r.entry_id}`,
    })),
    ...(book.closing > 0
      ? [{ key: 'cd', date: range.to, text: 'By Balance c/d', sub: null, amount: book.closing, href: null }]
      : []),
  ];

  const leftTotal = left.reduce((s, r) => s + r.amount, 0);
  const rightTotal = right.reduce((s, r) => s + r.amount, 0);

  return (
    <Card padded={false}
      title={`${label} — ${isCash ? 'Cash' : 'Bank'} Book`}
      subtitle="Receipts left, payments right. Both sides total to the same figure.">
      {book.truncated && (
        <div className="border-b border-line px-5 py-3 text-[12.5px] text-warn">
          Showing the first 1,000 postings of this window; the totals below cover only those rows.
          Narrow the period for a book that foots.
        </div>
      )}
      <div className="grid md:grid-cols-2 md:divide-x md:divide-[var(--color-line)]">
        <BookSide rows={left} total={leftTotal} agrees={leftTotal === rightTotal} heading="Receipts (Dr)" />
        <BookSide rows={right} total={rightTotal} agrees={leftTotal === rightTotal} heading="Payments (Cr)" />
      </div>
      <div className="border-t border-line px-5 py-3 text-[12.5px] text-ink-muted">
        Closing balance at {fmtDate(range.to)}:{' '}
        <strong className="num">{money(Math.abs(book.closing))}</strong>{' '}
        {book.closing >= 0 ? 'in hand' : 'overdrawn'}.
      </div>
    </Card>
  );
}

function BookSide({ rows, total, agrees, heading }: {
  rows: Array<{ key: string; date: string; text: string; sub: string | null; amount: number; href: string | null }>;
  total: number; agrees: boolean; heading: string;
}) {
  return (
    <Table>
      <thead>
        <tr>
          <Th width="100px">Date</Th><Th>{heading}</Th><Th align="right" width="130px">Amount</Th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <tr><Td colSpan={3}><span className="text-ink-faint">Nil</span></Td></tr>}
        {rows.map((r) => (
          <tr key={r.key} className="hover:bg-canvas">
            <Td>{fmtDate(r.date)}</Td>
            <Td>
              {r.href
                ? <RefLink href={r.href}>{r.text}</RefLink>
                : <span className="font-bold">{r.text}</span>}
              {r.sub && <span className="block text-[12px] text-ink-faint">{r.sub}</span>}
            </Td>
            <Td align="right"><Money value={r.amount} /></Td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="bg-brand-soft">
          <Td colSpan={2}><span className="font-extrabold">Total</span></Td>
          <Td align="right"><Money value={total} bold dash={false} /></Td>
        </tr>
        {!agrees && (
          <tr>
            <Td colSpan={3}>
              <span className="text-[12px] font-bold text-negative">
                The two sides do not agree — the postings shown are incomplete.
              </span>
            </Td>
          </tr>
        )}
      </tfoot>
    </Table>
  );
}

function money(minor: number): string {
  return `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}
