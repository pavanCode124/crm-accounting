import Link from 'next/link';
import { DOC_TYPES, fmtDate, titleise, isoDate, daysBetween } from '@/lib/accounting';
import { fmt, qtyFromMilli, bpsToPct } from '@/lib/money';
import { getDocument, documentLines } from '@/server/accounting/documents';
import { allocationsFor } from '@/server/accounting/payments';
import { auditFor } from '@/server/accounting/audit';
import { journalEntry } from '@/server/accounting/reports';
import { bankAccountOptions, journalOptions } from '@/server/options';
import {
  postDocumentAction, reverseDocumentAction, creditNoteAction, registerPaymentAction, unallocateAction,
} from '@/app/actions';
import {
  PageHeader, Card, Table, Th, Td, Money, Chip, DefList, btn, inputClass, Field, Banner, RefLink,
} from './ui';

/**
 * One document, from every angle.
 *
 * The page is arranged around plan section 49's Rule 3 — every entry is
 * traceable BOTH WAYS. From here you can reach the journal entry it produced,
 * the booking it belongs to, the payments that settled it and the audit trail
 * of who did what; and each of those screens links back.
 */
export async function DocumentDetail({ orgId, docId, basePath, role, message }: {
  orgId: string; docId: string; basePath: string; role: string;
  message?: { ok?: string; error?: string };
}) {
  const doc = getDocument(orgId, docId);
  if (!doc) return <Banner tone="error">That document no longer exists.</Banner>;

  const meta = DOC_TYPES[doc.doc_type];
  const lines = documentLines(docId);
  const allocations = allocationsFor(docId);
  const trail = auditFor('document', docId);
  const entry = doc.entry_id ? journalEntry(orgId, doc.entry_id) : null;
  const isBill = meta.side === 'supplier';
  const today = isoDate();
  // Settling a document is not always money in for a customer: a credit note
  // is money OUT against the same receivable. Direction and side are decided
  // separately, from the document type.
  const payDirection = meta.sign === 1
    ? (isBill ? 'outbound' : 'inbound')
    : (isBill ? 'inbound' : 'outbound');
  const settleVerb = payDirection === 'inbound' ? 'Record a receipt' : 'Pay out';
  const overdueDays = doc.residual > 0 && doc.due_date ? daysBetween(doc.due_date, today) : 0;

  return (
    <>
      <PageHeader
        title={doc.number ?? `${meta.short} (draft)`}
        subtitle={`${meta.label} · ${doc.partner_name}${doc.booking_ref ? ` · ${doc.booking_ref}` : ''}`}
        actions={
          <>
            <Chip state={doc.state} />
            {doc.state === 'posted' && <Chip state={doc.payment_state} />}
            {doc.state === 'posted' && overdueDays > 0 && (
              <Chip state="overdue" label={`${overdueDays} days overdue`} />
            )}
          </>
        }
      />

      {message?.error && <Banner tone="error">{message.error}</Banner>}
      {message?.ok && <Banner tone="ok">{message.ok}</Banner>}

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-5">
          <Card title="Document">
            <DefList rows={[
              [isBill ? 'Supplier' : 'Customer',
                <Link key="p" href={`${isBill ? '/purchases/suppliers' : '/sales/customers'}/${doc.partner_id}`}
                  className="text-brand hover:underline">{doc.partner_name}</Link>],
              ['Date', fmtDate(doc.doc_date)],
              ['Due', fmtDate(doc.due_date)],
              ...(doc.supplier_ref ? [['Supplier reference', doc.supplier_ref] as [string, string]] : []),
              ...(doc.booking_id ? [['Booking',
                <Link key="b" href={`/bookings/${doc.booking_id}`} className="text-brand hover:underline">
                  {doc.booking_ref}
                </Link>] as [string, React.ReactNode]] : []),
              ['Currency', doc.currency === 'INR' ? 'INR' : `${doc.currency} at ₹${(doc.rate_e6 / 1e6).toFixed(4)}`],
              ...(entry ? [['Journal entry',
                <Link key="je" href={`/accounting/entries/${doc.entry_id}`} className="text-brand hover:underline">
                  {entry.entry.entry_no} · {entry.entry.journal_name}
                </Link>] as [string, React.ReactNode]] : []),
            ]} />
            {doc.note && <p className="mt-4 border-t border-line pt-4 text-[13px] text-ink-muted">{doc.note}</p>}
          </Card>

          <Card title="Lines" padded={false}>
            <Table>
              <thead>
                <tr>
                  <Th>Description</Th><Th>Account</Th><Th>Analytic</Th>
                  <Th align="right">Qty</Th><Th align="right">Price</Th><Th align="right">Disc</Th>
                  <Th>Tax</Th><Th align="right">Subtotal</Th><Th align="right">Tax</Th><Th align="right">Total</Th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <Td><span className="font-semibold">{l.name}</span></Td>
                    <Td><span className="text-ink-muted">{l.account_code} {l.account_name}</span></Td>
                    <Td><span className="text-ink-muted">{l.analytic_name ?? '—'}</span></Td>
                    <Td align="right"><span className="num">{qtyFromMilli(l.qty_milli)}</span></Td>
                    <Td align="right"><Money value={l.unit_price} dash={false} /></Td>
                    <Td align="right"><span className="num">{l.discount_bps ? bpsToPct(l.discount_bps) : '—'}</span></Td>
                    <Td><span className="text-ink-muted">{l.tax_name ?? '—'}</span></Td>
                    <Td align="right"><Money value={l.subtotal} dash={false} /></Td>
                    <Td align="right"><Money value={l.tax_amount} /></Td>
                    <Td align="right"><Money value={l.total} bold dash={false} /></Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <Td colSpan={7} />
                  <Td align="right"><span className="text-[11px] font-bold uppercase text-ink-faint">Subtotal</span></Td>
                  <Td align="right"><span className="text-[11px] font-bold uppercase text-ink-faint">Tax</span></Td>
                  <Td align="right"><span className="text-[11px] font-bold uppercase text-ink-faint">Total</span></Td>
                </tr>
                <tr>
                  <Td colSpan={7} />
                  <Td align="right"><Money value={doc.untaxed} dash={false} /></Td>
                  <Td align="right"><Money value={doc.tax_total} dash={false} /></Td>
                  <Td align="right"><Money value={doc.total} bold dash={false} /></Td>
                </tr>
              </tfoot>
            </Table>
          </Card>

          {entry && (
            <Card title="Journal entry" subtitle="What this document did to the general ledger." padded={false}
              actions={<Link href={`/accounting/entries/${doc.entry_id}`} className="text-[13px] font-bold text-brand hover:underline">Open →</Link>}>
              <Table>
                <thead><tr><Th>Account</Th><Th>Label</Th><Th align="right">Debit</Th><Th align="right">Credit</Th></tr></thead>
                <tbody>
                  {entry.lines.map((l) => (
                    <tr key={l.id}>
                      <Td>
                        <Link href={`/reports/general-ledger?account=${l.account_id}`} className="font-semibold text-brand hover:underline">
                          {l.account_code}
                        </Link>{' '}
                        <span className="text-ink-muted">{l.account_name}</span>
                      </Td>
                      <Td><span className="text-ink-muted">{l.label ?? '—'}</span></Td>
                      <Td align="right"><Money value={l.debit} /></Td>
                      <Td align="right"><Money value={l.credit} /></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}

          <Card title="Audit trail" subtitle="Every action on this document, in order.">
            <ol className="space-y-2.5 text-[13px]">
              {trail.map((a) => (
                <li key={a.id} className="flex gap-3">
                  <span className="num w-[120px] shrink-0 !text-left text-ink-faint">
                    {new Date(a.at).toLocaleString('en-IN', {
                      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                  <span><span className="font-semibold">{titleise(a.action)}</span>
                    {a.summary ? ` — ${a.summary}` : ''}
                    <span className="text-ink-faint"> · {a.user_name}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Balance">
            <dl className="space-y-2 text-[14px]">
              <SummaryRow label="Total" value={doc.total} bold />
              {doc.withheld_tax > 0 && <SummaryRow label="TDS withheld" value={-doc.withheld_tax} />}
              <SummaryRow label="Settled" value={doc.total - doc.withheld_tax - doc.residual} />
              <SummaryRow label={doc.residual > 0 ? 'Still owed' : 'Cleared'} value={doc.residual} bold />
            </dl>

            <div className="mt-5 flex flex-col gap-2 no-print">
              {doc.state === 'draft' && (
                <form action={postDocumentAction}>
                  <input type="hidden" name="id" value={doc.id} />
                  <input type="hidden" name="doc_type" value={doc.doc_type} />
                  <button className={`${btn.primary} w-full`}>Post to the ledger</button>
                </form>
              )}
              {doc.state === 'posted' && (
                <form action={reverseDocumentAction} className="space-y-2">
                  <input type="hidden" name="id" value={doc.id} />
                  <input type="hidden" name="doc_type" value={doc.doc_type} />
                  <input type="date" name="date" defaultValue={today} className={inputClass} />
                  <input name="reason" placeholder="Why is this being reversed?" className={inputClass} />
                  <button className={`${btn.danger} w-full`}>Reverse</button>
                </form>
              )}
            </div>
          </Card>

          {doc.state === 'posted' && doc.residual > 0 && (
            <Card title={settleVerb}>
              <form action={registerPaymentAction} className="space-y-3">
                <input type="hidden" name="direction" value={payDirection} />
                <input type="hidden" name="side" value={meta.side} />
                <input type="hidden" name="partner_id" value={doc.partner_id} />
                <input type="hidden" name="document_id" value={doc.id} />
                <input type="hidden" name="booking_id" value={doc.booking_id ?? ''} />
                <input type="hidden" name="return_to" value={`${basePath}/${doc.id}`} />
                <Field label="Amount">
                  <input name="amount" defaultValue={(doc.residual / 100).toFixed(2)}
                    inputMode="decimal" className={`${inputClass} text-right`} />
                </Field>
                <Field label="Date">
                  <input type="date" name="pay_date" defaultValue={today} className={inputClass} />
                </Field>
                <Field label="Paid into / from">
                  <select name="bank_account_id" className={inputClass}>
                    {bankAccountOptions(orgId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </Field>
                <input type="hidden" name="journal_id"
                  value={journalOptions(orgId, ['bank', 'cash'])[0]?.id ?? ''} />
                <Field label="Method">
                  <select name="method" className={inputClass} defaultValue="neft">
                    {['bank', 'neft', 'upi', 'card', 'cheque', 'cash', 'other'].map((m) =>
                      <option key={m} value={m}>{titleise(m)}</option>)}
                  </select>
                </Field>
                <Field label="Reference">
                  <input name="reference" placeholder="UPI / NEFT / cheque no." className={inputClass} />
                </Field>
                <button className={`${btn.primary} w-full`}>{settleVerb}</button>
              </form>
              <p className="mt-3 text-[12px] text-ink-faint">
                The bank account chosen decides which journal the entry lands in, and the amount
                is allocated to this document straight away.
              </p>
            </Card>
          )}

          <Card title="Settlements" padded={false}>
            {allocations.length === 0 ? (
              <p className="px-5 py-6 text-center text-[13px] text-ink-faint">Nothing applied yet.</p>
            ) : (
              <Table>
                <thead><tr><Th>Ref</Th><Th>Date</Th><Th align="right">Amount</Th><Th /></tr></thead>
                <tbody>
                  {allocations.map((a) => (
                    <tr key={a.id}>
                      <Td>
                        {a.payment_id
                          ? <RefLink href={`${isBill ? '/purchases' : '/sales'}/payments`}>{a.payment_number}</RefLink>
                          : <span className="font-semibold">{a.credit_number ?? 'Credit'}</span>}
                      </Td>
                      <Td>{fmtDate(a.pay_date ?? a.at.slice(0, 10))}</Td>
                      <Td align="right"><Money value={a.amount} dash={false} /></Td>
                      <Td align="right">
                        <form action={unallocateAction}>
                          <input type="hidden" name="allocation_id" value={a.id} />
                          <input type="hidden" name="return_to" value={`${basePath}/${doc.id}`} />
                          <button className="text-[12px] font-bold text-ink-faint hover:text-negative">Undo</button>
                        </form>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {doc.state === 'posted' && doc.doc_type === 'out_invoice' && (
            <Card title="Cancellation / credit note"
              subtitle="A percentage of the invoice, so a cancellation charge stays tied to the original.">
              <form action={creditNoteAction} className="space-y-3">
                <input type="hidden" name="id" value={doc.id} />
                <Field label="Credit percentage" hint="30% credited means 70% retained as a cancellation charge.">
                  <input name="percent" defaultValue="100" inputMode="decimal" className={`${inputClass} text-right`} />
                </Field>
                <Field label="Date">
                  <input type="date" name="date" defaultValue={today} className={inputClass} />
                </Field>
                <Field label="Reason">
                  <input name="reason" placeholder="Customer cancellation" className={inputClass} />
                </Field>
                <button name="post_now" value="true" className={`${btn.ghost} w-full`}>
                  Create and post credit note
                </button>
              </form>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function SummaryRow({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className="flex justify-between gap-6">
      <dt className={bold ? 'font-bold' : 'text-ink-muted'}>{label}</dt>
      <dd><Money value={value} bold={bold} dash={false} /></dd>
    </div>
  );
}
