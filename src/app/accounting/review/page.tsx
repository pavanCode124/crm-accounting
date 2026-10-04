import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { msg, one, type SearchParams } from '@/lib/range';
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
  RefLink, LinkButton, StatTile, btn, inputClass,
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
/**
 * THE FILTER IS APPLIED IN MEMORY, AND THAT IS THE RIGHT PLACE FOR IT HERE.
 *
 * Everywhere else in this product a list filters in SQL, because a list can be
 * a year of postings and no screen should read a year to show thirty rows.
 * This queue is the opposite shape: it is bounded by its own meaning. A draft
 * is work somebody has not finished, so a healthy ledger holds a handful and an
 * unhealthy one holds a few hundred — the page already caps each section at 300
 * and the four queries run regardless, because the tiles count all of it.
 *
 * Filtering those few hundred rows in memory therefore costs nothing and buys
 * two things SQL could not give without four more parameterised queries: one
 * search box that spans FOUR UNRELATED TABLES whose "name" column is called
 * something different in each (`partner_name`, `employee_name`, `narration`),
 * and a `source` filter that exists only as a substring of a note.
 */
function matcher(q: string) {
  const needle = q.trim().toLowerCase();
  return (...fields: Array<string | null | undefined>) =>
    !needle || fields.some((f) => (f ?? '').toLowerCase().includes(needle));
}

/** Within the window, when one is given. An open end means no bound on that side. */
function inWindow(date: string, from?: string, to?: string): boolean {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

export default async function ReviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const m = await msg(params);

  const q = (await one(params, 'q') ?? '').trim();
  const kind = await one(params, 'kind') ?? '';
  const source = await one(params, 'source') ?? '';
  const from = await one(params, 'from') ?? '';
  const to = await one(params, 'to') ?? '';
  const filtered = Boolean(q || kind || source || from || to);
  const hit = matcher(q);
  /* A section is shown unless the Kind filter names a different one. */
  const wants = (k: string) => !kind || kind === k;

  const allDocs = await listDocuments(s.orgId, { state: 'draft', limit: 300 });
  const allPayments = await listPayments(s.orgId, { state: 'draft', limit: 300 });
  const allExpenses = await listExpenses(s.orgId, { state: 'submitted', limit: 300 });
  const allEntries = await all<{
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

  /*
   * `source` is asked of DOCUMENTS ONLY, because it is only a document that can
   * have come from the CRM — the importer writes drafts and nothing else. Asked
   * of the other three it would be a filter that silently empties them, so
   * instead it narrows them to nothing only when "CRM import" is chosen, which
   * is the honest answer: there are no imported receipts or expense claims.
   */
  const docs = allDocs.filter((d) =>
    wants('documents')
    && inWindow(d.doc_date, from, to)
    && hit(d.partner_name, d.number, d.booking_ref, d.note, d.doc_type)
    && (!source || (source === 'crm') === Boolean(d.note?.includes('Imported from TripzoCRM'))));

  const payments = allPayments.filter((p) =>
    wants('payments') && source !== 'crm'
    && inWindow(p.pay_date, from, to)
    && hit(p.partner_name, p.number, p.note, p.reference));

  const expenses = allExpenses.filter((e) =>
    wants('expenses') && source !== 'crm'
    && inWindow(e.expense_date, from, to)
    && hit(e.employee_name, e.number, e.description));

  const entries = allEntries.filter((e) =>
    wants('entries') && source !== 'crm'
    && inWindow(e.entry_date, from, to)
    && hit(e.narration, e.reference, e.journal_code));

  const total = docs.length + payments.length + expenses.length + entries.length;
  const grandTotal = allDocs.length + allPayments.length + allExpenses.length + allEntries.length;

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

      <form action="/accounting/review" method="get"
        className="no-print mb-5 flex flex-wrap items-end gap-2 rounded-card border border-line bg-surface px-4 py-3">
        <label className="block min-w-[220px] flex-1">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">Search</span>
          <input name="q" defaultValue={q} placeholder="Partner, number, narration, employee, trip…"
            className={inputClass} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">Kind</span>
          <select name="kind" defaultValue={kind} className={`${inputClass} w-[190px]`}>
            <option value="">Everything waiting</option>
            <option value="documents">Invoices &amp; bills</option>
            <option value="payments">Receipts &amp; payments</option>
            <option value="expenses">Expense claims</option>
            <option value="entries">Journal entries</option>
          </select>
        </label>
        {/*
          * WHOSE WORK IS THIS, which is the division the page's own note
          * describes: an accountant on this queue is doing two different jobs,
          * checking their own half-finished work and checking what another
          * system claimed. The two want different attention, and until now the
          * only way to separate them was to read the column.
          */}
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">Source</span>
          <select name="source" defaultValue={source} className={`${inputClass} w-[160px]`}>
            <option value="">Any source</option>
            <option value="crm">CRM import</option>
            <option value="local">Entered here</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">From</span>
          <input type="date" name="from" defaultValue={from} className={`${inputClass} w-[160px]`} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">To</span>
          <input type="date" name="to" defaultValue={to} className={`${inputClass} w-[160px]`} />
        </label>
        <button className={btn.ghost}>Filter</button>
        {filtered && <Link href="/accounting/review" className={btn.ghost}>Clear</Link>}
      </form>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {/*
          * THE TILES COUNT THE FILTERED VIEW, and say so when that is not the
          * whole queue. A tile that kept showing the grand total beside a
          * filtered table would be the one number on this page an accountant
          * uses to decide they are finished — "waiting in total" reading 40
          * above four rows is how a month end gets called clean while thirty-six
          * drafts sit behind a filter nobody cleared.
          */}
        <StatTile
          label={filtered ? `Matching (of ${grandTotal})` : 'Waiting in total'}
          value={String(total)}
          tone={total ? 'warn' : 'positive'}
        />
        <StatTile label="Invoices & bills" value={String(docs.length)} />
        <StatTile label="Receipts & payments" value={String(payments.length)} />
        <StatTile label="Expense claims" value={String(expenses.length)} />
        <StatTile label="Journal entries" value={String(entries.length)} />
      </div>

      {/*
        * TWO DIFFERENT EMPTIES, because they mean opposite things. An empty
        * queue is the goal and reads as congratulation; an empty FILTER is a
        * dead end, and offering "Raise an invoice" there would answer a
        * question nobody asked while hiding the thirty drafts one click away.
        */}
      {total === 0 && (
        <Card>
          {filtered ? (
            <EmptyState
              title="Nothing matches that filter."
              hint={grandTotal
                ? `${grandTotal} item(s) are still waiting under a different search.`
                : 'Nothing is waiting at all, filtered or not.'}
              action={<LinkButton href="/accounting/review" variant="primary">Clear the filter</LinkButton>}
            />
          ) : (
            <EmptyState
              title="Nothing is waiting."
              hint="Every document, receipt, claim and entry raised so far has been posted or set aside. This is what a clean month end looks like."
              action={<LinkButton href="/sales/invoices/new" variant="primary">Raise an invoice</LinkButton>}
            />
          )}
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
