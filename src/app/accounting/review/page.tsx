import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { all } from '@/server/db';
import { fmtDate } from '@/lib/accounting';
import { listDocuments } from '@/server/accounting/documents';
import { listPayments } from '@/server/accounting/payments';
import { listExpenses } from '@/server/accounting/expenses';
import {
  postDocumentAction, postPaymentAction, postEntryAction, expenseWorkflowAction,
} from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, Money, Chip, EmptyState,
  RefLink, LinkButton, StatTile, btn,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * REVIEW & POST — the one door into the ledger.
 *
 * Every other screen in this product can create something. Not one of them can
 * make it true. A document, a receipt, an expense claim and a hand-typed
 * journal all begin life as a draft, and a draft moves no balance, appears in
 * no report and proves nothing — until a person holding the capability opens
 * it, reads it, and presses Post.
 *
 * This page exists because those drafts were scattered across six screens. An
 * accountant who has imported a season of CRM invoices, has three expense
 * claims waiting and a half-finished journal from Friday had nowhere that said
 * "here is everything with your name on it". They do now, and the count in the
 * first tile is the number that should read zero at month end.
 *
 * THERE IS NO "POST ALL", and that is not an omission. The click IS the
 * review. A button that posts forty documents is a button that posts forty
 * documents nobody read, which is the exact thing this screen was built to
 * prevent.
 */
export default async function ReviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);

  const docs = await listDocuments(s.orgId, { state: 'draft', limit: 300 });
  const payments = await listPayments(s.orgId, { state: 'draft', limit: 300 });
  const expenses = await listExpenses(s.orgId, { state: 'submitted', limit: 300 });
  const entries = await all<{
    id: string; entry_date: string; reference: string | null; narration: string | null;
    journal_code: string; debit: number; credit: number;
  }>(
    // Debit and credit both, because a DRAFT entry is the one place in this
    // system where they can differ — and a queue that printed a single
    // "Amount" would hide the unbalanced one until Post refused it.
    `SELECT e.id, e.entry_date, e.reference, e.narration, j.code AS journal_code,
            COALESCE((SELECT SUM(l.debit)  FROM journal_entry_lines l WHERE l.entry_id = e.id),0) AS debit,
            COALESCE((SELECT SUM(l.credit) FROM journal_entry_lines l WHERE l.entry_id = e.id),0) AS credit
       FROM journal_entries e JOIN journals j ON j.id = e.journal_id
      WHERE e.org_id = ? AND e.state = 'draft'
      ORDER BY e.entry_date DESC LIMIT 300`,
    s.orgId,
  );

  const total = docs.length + payments.length + expenses.length + entries.length;

  return (
    <>
      <PageHeader
        title="Review &amp; Post"
        subtitle="Everything waiting on an accountant's decision. Nothing here is in the books yet — no balance, no report and no return includes any of it until you post it."
        accent="var(--color-sec-accounting)"
        actions={<LinkButton href="/accounting/entries">Journal entries</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Waiting in total" value={String(total)} tone={total ? 'warn' : 'positive'} />
        <StatTile label="Invoices & bills" value={String(docs.length)} />
        <StatTile label="Receipts & payments" value={String(payments.length)} />
        <StatTile label="Expense claims" value={String(expenses.length)} />
        <StatTile label="Journal entries" value={String(entries.length)} />
      </div>

      {total === 0 && (
        <Card>
          <EmptyState
            title="Nothing is waiting."
            hint="Every document, receipt, claim and entry raised so far has been posted or set aside. This is what a clean month end looks like."
            action={<LinkButton href="/sales/invoices/new" variant="primary">Raise an invoice</LinkButton>}
          />
        </Card>
      )}

      {docs.length > 0 && (
        <Card
          title="Invoices and bills"
          subtitle="Check the partner, the account each line lands on, the tax and the trip it is tagged to. A posted document cannot be edited — only credited — so the reading happens now."
        >
          <Table>
            <thead>
              <tr>
                <Th>Date</Th><Th>Type</Th><Th>Partner</Th><Th>Trip</Th>
                <Th align="right">Total</Th><Th>Raised by</Th><Th align="right">Action</Th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-t border-hair">
                  <Td>{fmtDate(d.doc_date)}</Td>
                  <Td><Chip state={d.doc_type} /></Td>
                  <Td>
                    <RefLink href={`${listPathOf(d.doc_type)}/${d.id}`}>{d.partner_name ?? '—'}</RefLink>
                  </Td>
                  <Td>{d.booking_ref ?? '—'}</Td>
                  <Td align="right"><Money value={d.total} bold /></Td>
                  <Td>{sourceOf(d.note)}</Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-2">
                      <Link href={`${listPathOf(d.doc_type)}/${d.id}`} className={btn.ghost}>Open</Link>
                      <form action={postDocumentAction}>
                        <input type="hidden" name="id" value={d.id} />
                        <input type="hidden" name="doc_type" value={d.doc_type} />
                        <button className={btn.primary}>Post</button>
                      </form>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {payments.length > 0 && (
        <Card
          title="Receipts and payments"
          subtitle="Posting moves the money in the ledger. Settling it against an invoice is the step after — open the receipt and allocate it, which is what clears the debtor."
        >
          <Table>
            <thead>
              <tr>
                <Th>Date</Th><Th>Number</Th><Th>Partner</Th><Th>Reference</Th>
                <Th align="right">Amount</Th><Th align="right">Action</Th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-t border-hair">
                  <Td>{fmtDate(p.pay_date)}</Td>
                  <Td>{p.number ?? '—'}</Td>
                  <Td>{p.partner_name ?? '—'}</Td>
                  <Td><span className="text-ink-muted">{p.note ?? p.reference ?? '—'}</span></Td>
                  <Td align="right"><Money value={p.amount} bold /></Td>
                  <Td align="right">
                    <form action={postPaymentAction}>
                      <input type="hidden" name="id" value={p.id} />
                      <input type="hidden" name="return_to" value="/accounting/review" />
                      <button className={btn.primary}>Post</button>
                    </form>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {expenses.length > 0 && (
        <Card
          title="Expense claims"
          subtitle="Approving is posting: the claim becomes a cost in the books and, where an employee paid it, a liability to pay them back."
        >
          <Table>
            <thead>
              <tr>
                <Th>Date</Th><Th>Number</Th><Th>Who</Th><Th>What</Th>
                <Th align="right">Amount</Th><Th align="right">Action</Th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id} className="border-t border-hair">
                  <Td>{fmtDate(e.expense_date)}</Td>
                  <Td>{e.number}</Td>
                  <Td>{e.employee_name}</Td>
                  <Td>{e.description}</Td>
                  <Td align="right"><Money value={e.amount} bold /></Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-2">
                      <form action={expenseWorkflowAction}>
                        <input type="hidden" name="id" value={e.id} />
                        <input type="hidden" name="action" value="refuse" />
                        <input type="hidden" name="reason" value="Refused on review" />
                        <input type="hidden" name="return_to" value="/accounting/review" />
                        <button className={btn.ghost}>Refuse</button>
                      </form>
                      <form action={expenseWorkflowAction}>
                        <input type="hidden" name="id" value={e.id} />
                        <input type="hidden" name="action" value="approve" />
                        <input type="hidden" name="return_to" value="/accounting/review" />
                        <button className={btn.primary}>Approve &amp; post</button>
                      </form>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {entries.length > 0 && (
        <Card
          title="Journal entries"
          subtitle="A draft entry may be unbalanced; a posted one never is. The two columns are the check — where they differ, Post is disabled until you open it and fix it."
        >
          <Table>
            <thead>
              <tr>
                <Th>Date</Th><Th>Journal</Th><Th>Narration</Th>
                <Th align="right">Debit</Th><Th align="right">Credit</Th><Th align="right">Action</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t border-hair">
                  <Td>{fmtDate(e.entry_date)}</Td>
                  <Td>{e.journal_code}</Td>
                  <Td>
                    <RefLink href={`/accounting/entries/${e.id}`}>
                      {e.narration ?? e.reference ?? 'Draft entry'}
                    </RefLink>
                  </Td>
                  <Td align="right"><Money value={e.debit} /></Td>
                  <Td align="right"><Money value={e.credit} bold={e.debit !== e.credit} /></Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-2">
                      <Link href={`/accounting/entries/${e.id}`} className={btn.ghost}>Open</Link>
                      <form action={postEntryAction}>
                        <input type="hidden" name="id" value={e.id} />
                        <input type="hidden" name="return_to" value="/accounting/review" />
                        <button className={btn.primary} disabled={e.debit !== e.credit}>Post</button>
                      </form>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}

function listPathOf(docType: string): string {
  if (docType === 'in_invoice') return '/purchases/bills';
  if (docType === 'in_refund') return '/purchases/debit-notes';
  if (docType === 'out_refund') return '/sales/credit-notes';
  return '/sales/invoices';
}

/**
 * Where a draft came from, in two words.
 *
 * An accountant working this queue is doing two different jobs: checking their
 * own half-finished work, and checking what another system claimed. The note
 * carries the CRM invoice number when the sync wrote it, so the column can say
 * which without a second table.
 */
function sourceOf(note: string | null) {
  if (note?.includes('Imported from TripzoCRM')) {
    return <span className="text-[12px] font-semibold text-ink-muted">CRM import</span>;
  }
  return <span className="text-[12px] text-ink-faint">Entered here</span>;
}
