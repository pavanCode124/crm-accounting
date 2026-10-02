import Link from 'next/link';
import { fmtDate, isoDate, daysBetween, type DocType } from '@/lib/accounting';
import { listDocuments, type DocFilter } from '@/server/accounting/documents';
import { Card, Table, Th, Td, Money, Chip, EmptyState, RefLink, inputClass, btn } from './ui';

/**
 * The list behind Invoices, Bills, Credit Notes and Debit Notes.
 *
 * One component for all four because they differ only in which `doc_type` they
 * filter on and where a row links to — and because the columns an accountant
 * scans are the same in every case: number, who, when, how much, how much is
 * left, and what state it is in.
 */
export async function DocumentList({ orgId, docType, basePath, filter, emptyHint }: {
  orgId: string; docType: DocType; basePath: string; filter: DocFilter; emptyHint?: string;
}) {
  const docs = await listDocuments(orgId, { ...filter, docType });
  const today = isoDate();
  const isBill = docType.startsWith('in_');
  // Only invoices and bills have an edit screen; a credit or debit note is
  // raised from the document it corrects, never typed from scratch.
  const editable = docType === 'out_invoice' || docType === 'in_invoice';

  const totals = docs.reduce(
    (t, d) => ({ total: t.total + d.total, residual: t.residual + d.residual }),
    { total: 0, residual: 0 },
  );

  return (
    <Card padded={false}>
      {docs.length === 0 ? (
        <EmptyState
          title="Nothing here yet."
          hint={emptyHint}
          action={<Link href={`${basePath}/new`} className={btn.primary}>Create one</Link>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th width="130px">Number</Th>
              <Th>{isBill ? 'Supplier' : 'Customer'}</Th>
              <Th>Trip</Th>
              <Th width="110px">Date</Th>
              <Th width="120px">Due</Th>
              <Th align="right" width="130px">Total</Th>
              <Th align="right" width="130px">Outstanding</Th>
              <Th width="160px">Status</Th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => {
              const late = d.state === 'posted' && d.residual > 0 && d.due_date && d.due_date < today;
              return (
                <tr key={d.id} className="hover:bg-canvas">
                  <Td>
                    <RefLink href={`${basePath}/${d.id}`}>{d.number ?? 'Draft'}</RefLink>
                    {d.supplier_ref && <div className="text-[11.5px] text-ink-faint">{d.supplier_ref}</div>}
                  </Td>
                  <Td>
                    {/* The name is what the eye goes to first, so it opens the
                        document as well as the number does. */}
                    <Link href={`${basePath}/${d.id}`} className="font-semibold hover:underline">
                      {d.partner_name}
                    </Link>
                  </Td>
                  <Td>
                    {d.booking_id
                      ? <Link href={`/bookings/${d.booking_id}`} className="text-ink-muted hover:underline">{d.booking_ref}</Link>
                      : <span className="text-ink-faint">—</span>}
                  </Td>
                  <Td>{fmtDate(d.doc_date)}</Td>
                  <Td>
                    {fmtDate(d.due_date)}
                    {late && (
                      <div className="text-[11.5px] font-bold text-negative">
                        {daysBetween(d.due_date!, today)}d late
                      </div>
                    )}
                  </Td>
                  <Td align="right"><Money value={d.total} dash={false} /></Td>
                  <Td align="right"><Money value={d.residual} bold /></Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Chip state={d.state} />
                      {d.state === 'posted' && <Chip state={d.payment_state} />}
                      {/* A draft is still being written; take it straight back
                          to the editor rather than via the document. */}
                      {editable && d.state === 'draft' && (
                        <Link href={`${basePath}/${d.id}/edit`}
                          className="text-[12px] font-bold text-brand hover:underline">Edit</Link>
                      )}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-canvas">
              <Td colSpan={5}><span className="font-bold">{docs.length} document(s)</span></Td>
              <Td align="right"><Money value={totals.total} bold dash={false} /></Td>
              <Td align="right"><Money value={totals.residual} bold dash={false} /></Td>
              <Td />
            </tr>
          </tfoot>
        </Table>
      )}
    </Card>
  );
}

/**
 * The filter strip above the list: search, state, a date window — and the
 * export.
 *
 * THE EXPORT IS A SECOND SUBMIT BUTTON ON THE SAME FORM, retargeted with
 * `formAction`, and that is the whole reason it lives here rather than beside
 * the New Invoice button in the page header.
 *
 * An export has to hold exactly the rows that were on screen. A separate link
 * in the header would have to reconstruct the filter from the URL, which means
 * two places deciding what "the current view" means and one of them eventually
 * being wrong — and the reader has no way to notice, because the file looks
 * complete either way. Submitting the same form sends the same fields by
 * construction: whatever the user typed is what the workbook contains.
 */
export function DocumentFilters({ action, filter, docType }: {
  action: string;
  filter: { search?: string; state?: string; paymentState?: string; from?: string; to?: string };
  docType?: DocType;
}) {
  return (
    <form action={action} method="get"
      className="no-print mb-5 flex flex-wrap items-end gap-2 rounded-card border border-line bg-surface px-4 py-3">
      {docType && <input type="hidden" name="type" value={docType} />}
      <label className="block min-w-[220px] flex-1">
        <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">Search</span>
        <input name="q" defaultValue={filter.search} placeholder="Number, customer, supplier reference…"
          className={inputClass} />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">State</span>
        <select name="state" defaultValue={filter.state ?? ''} className={`${inputClass} w-[150px]`}>
          <option value="">All</option>
          <option value="draft">Draft</option>
          <option value="posted">Posted</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">Payment</span>
        <select name="payment" defaultValue={filter.paymentState ?? ''} className={`${inputClass} w-[160px]`}>
          <option value="">All</option>
          <option value="not_paid">Not paid</option>
          <option value="partial">Partially paid</option>
          <option value="paid">Paid</option>
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">From</span>
        <input type="date" name="from" defaultValue={filter.from} className={`${inputClass} w-[160px]`} />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">To</span>
        <input type="date" name="to" defaultValue={filter.to} className={`${inputClass} w-[160px]`} />
      </label>
      <button className={btn.ghost}>Filter</button>
      <button
        className={btn.ghost}
        formAction="/api/exports/documents"
        // A new tab, so the list the user filtered is still there when the
        // download finishes. Navigating the page itself to a file download
        // leaves some browsers on a blank document with no way back.
        formTarget="_blank"
        title="Download these rows as an Excel workbook, item by item, with the HSN and the tax split per line."
      >
        Export to Excel
      </button>
    </form>
  );
}
