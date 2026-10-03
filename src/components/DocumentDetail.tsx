import Link from 'next/link';
import { DOC_TYPES, fmtDate, titleise, isoDate, daysBetween } from '@/lib/accounting';
import { stateName } from '@/server/accounting/organisation';
import { fmt, qtyFromMilli, bpsToPct } from '@/lib/money';
import { getDocument, documentLines, documentLineTaxes } from '@/server/accounting/documents';
import { allocationsFor, listPayments, openInvoicesFor } from '@/server/accounting/payments';
import { auditFor } from '@/server/accounting/audit';
import { journalEntry } from '@/server/accounting/reports';
import { bankAccountOptions, journalOptions } from '@/server/options';
import {
  postDocumentAction, reverseDocumentAction, creditNoteAction, registerPaymentAction, unallocateAction,
  allocateAction, applyCreditAction,
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
  const doc = await getDocument(orgId, docId);
  if (!doc) return <Banner tone="error">That document no longer exists.</Banner>;

  const meta = DOC_TYPES[doc.doc_type];
  const lines = await documentLines(docId);
  const lineTaxes = await documentLineTaxes(docId);
  const allocations = await allocationsFor(docId);
  const trail = await auditFor('document', docId);
  const entry = doc.entry_id ? await journalEntry(orgId, doc.entry_id) : null;
  const isBill = meta.side === 'supplier';
  const today = isoDate();
  // Settling a document is not always money in for a customer: a credit note
  // is money OUT against the same receivable. Direction and side are decided
  // separately, from the document type.
  const payDirection = meta.sign === 1
    ? (isBill ? 'outbound' : 'inbound')
    : (isBill ? 'inbound' : 'outbound');
  const settleVerb = payDirection === 'inbound' ? 'Record a receipt' : 'Pay out';
  /*
   * MONEY ALREADY WITH THIS PARTNER, SHOWN WHERE IT IS ABOUT TO BE SPENT.
   *
   * An advance paid before the bill arrived sits unallocated against the
   * supplier. Settling the bill from here used to offer only a fresh payment,
   * so the full amount went out a second time and the advance was left
   * floating — the supplier's account carried a debit nobody had written off
   * and the books disagreed with what was actually paid. Offering the advance
   * on the same card is what lets it be applied first, with the Pay out
   * default then falling to whatever is genuinely still owed.
   */
  const advances = doc.state === 'posted' && doc.residual > 0 && doc.partner_id
    ? await listPayments(orgId, {
      partnerId: doc.partner_id, side: meta.side, direction: payDirection, unallocatedOnly: true,
    })
    : [];
  const advanceTotal = advances.reduce((t, p) => t + p.unallocated, 0);
  /*
   * A CREDIT NOTE IS A REDUCTION OF A BILL BEFORE IT IS EVER A REFUND.
   *
   * Cash is only owed back once the customer has paid more than the charge
   * being retained, so the open invoices come first and Pay out is what is left
   * after them. Offering only Pay out — which is what this screen used to do —
   * invited a ₹95,550 payout against a ₹20,000 advance.
   */
  const isCreditNote = meta.sign === -1;
  // The split the Balance card reports. `allocationsFor` already carries
  // `credit_doc_id`, so this needs no further query.
  const settledTotal = doc.total - doc.withheld_tax - doc.residual;
  const creditedTotal = allocations.reduce((t, a) => t + (a.credit_doc_id ? a.amount : 0), 0);
  const receivedTotal = settledTotal - creditedTotal;
  const openInvoices = isCreditNote && doc.state === 'posted' && doc.residual > 0 && doc.partner_id
    ? await openInvoicesFor(orgId, doc.partner_id, isBill ? 'in_invoice' : 'out_invoice')
    : [];
  // Applying the advances covers this much of the bill; the rest is the
  // payment that still has to leave the bank.
  const afterAdvances = Math.max(0, doc.residual - advanceTotal);
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
            {/*
              A plain anchor, not a form: a download is a GET, so the link works
              from a right-click, can be copied, and does not need this page to
              still be mounted when the file arrives.
            */}
            <a href={`/api/exports/document/${doc.id}`} className={btn.ghost}>
              Export to Excel
            </a>
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
              /*
               * THE GST IDENTITY AND THE PLACE OF SUPPLY, shown always rather
               * than only when set.
               *
               * A missing GSTIN on a B2B invoice and a missing place of supply
               * are both defects — the first costs the customer their input
               * credit, the second is the field that decides whether the tax
               * charged was the right one. Hiding the row when it is empty
               * hides the defect; an em dash in a labelled row is a question
               * the person looking at the document can answer.
               */
              ['GSTIN', doc.partner_gstin ?? '—'],
              ...(doc.partner_gst_name ? [['Registered name', doc.partner_gst_name] as [string, string]] : []),
              ['Place of supply', stateName(doc.place_of_supply) ?? '—'],
              ...(doc.order_ref ? [[
                'Order reference',
                `${doc.order_ref}${doc.order_date ? ` · ${fmtDate(doc.order_date)}` : ''}`,
              ] as [string, string]] : []),
              ...(doc.irn ? [['IRN',
                <span key="irn" className="break-all text-[12px] num !text-left">
                  {doc.irn}
                  {doc.irn_ack_no && <span className="text-ink-faint"> · ack {doc.irn_ack_no}</span>}
                </span>] as [string, React.ReactNode]] : []),
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
                  <Th>Description</Th><Th>HSN / SAC</Th><Th>Account</Th><Th>Analytic</Th>
                  <Th align="right">Qty</Th><Th align="right">MRP</Th>
                  <Th align="right">Price</Th><Th align="right">Disc</Th>
                  <Th>Tax</Th><Th align="right">Subtotal</Th><Th align="right">Tax</Th><Th align="right">Total</Th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <Td>
                      <span className="font-semibold">{l.name}</span>
                      {l.variant && <div className="text-[11.5px] text-ink-faint">{l.variant}</div>}
                    </Td>
                    <Td><span className="num !text-left text-ink-muted">{l.hsn_code ?? '—'}</span></Td>
                    <Td><span className="text-ink-muted">{l.account_code} {l.account_name}</span></Td>
                    <Td><span className="text-ink-muted">{l.analytic_name ?? '—'}</span></Td>
                    <Td align="right"><span className="num">{qtyFromMilli(l.qty_milli)}</span></Td>
                    <Td align="right"><Money value={l.mrp} /></Td>
                    <Td align="right"><Money value={l.unit_price} dash={false} /></Td>
                    <Td align="right"><span className="num">{l.discount_bps ? bpsToPct(l.discount_bps) : '—'}</span></Td>
                    <Td>
                      <span className="text-ink-muted">{l.tax_name ?? '—'}</span>
                      {/*
                        THE COMPONENTS, FROM THE STORED SPLIT.
                        "GST 5%" is what the line was charged under; "CGST 2.5%
                        10.69 · SGST 2.5% 10.69" is what the ledger did and what
                        the return is filed on. These are read from the split
                        written when the document was saved, NOT recomputed from
                        the tax table — so a rate changed since does not quietly
                        restate an invoice already issued.
                      */}
                      {(lineTaxes.get(l.id) ?? []).map((t) => (
                        <div key={t.id} className="text-[11.5px] text-ink-faint">
                          {t.tax_name} · {fmt(t.amount)}
                        </div>
                      ))}
                    </Td>
                    <Td align="right"><Money value={l.subtotal} dash={false} /></Td>
                    <Td align="right"><Money value={l.tax_amount} /></Td>
                    <Td align="right"><Money value={l.total} bold dash={false} /></Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <Td colSpan={9} />
                  <Td align="right"><span className="text-[11px] font-bold uppercase text-ink-faint">Subtotal</span></Td>
                  <Td align="right"><span className="text-[11px] font-bold uppercase text-ink-faint">Tax</span></Td>
                  <Td align="right"><span className="text-[11px] font-bold uppercase text-ink-faint">Total</span></Td>
                </tr>
                <tr>
                  <Td colSpan={9} />
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
              {/*
                * Money and credit are never added into one "Settled" figure.
                * A cancelled trip is settled in both, and the agency's first
                * question is always how much of it actually arrived.
                */}
              {creditedTotal > 0 ? (
                <>
                  <SummaryRow label={isBill ? 'Paid in cash' : 'Received in cash'} value={receivedTotal} />
                  <SummaryRow label={isBill ? 'Debit notes applied' : 'Credit notes applied'} value={creditedTotal} />
                </>
              ) : (
                <SummaryRow label="Settled" value={settledTotal} />
              )}
              <SummaryRow label={doc.residual > 0 ? 'Still owed' : 'Cleared'} value={doc.residual} bold />
            </dl>
            {creditedTotal > 0 && !isCreditNote && (
              <p className="mt-3 text-[12px] text-ink-faint">
                {fmt(creditedTotal)} of this was cancelled by a credit note, not collected.
                {receivedTotal > 0 && ` ${fmt(receivedTotal)} was actually received from ${doc.partner_name}.`}
              </p>
            )}

            <div className="mt-5 flex flex-col gap-2 no-print">
              {doc.state === 'draft' && (
                <>
                  <form action={postDocumentAction}>
                    <input type="hidden" name="id" value={doc.id} />
                    <input type="hidden" name="doc_type" value={doc.doc_type} />
                    <button className={`${btn.primary} w-full`}>Post to the ledger</button>
                  </form>
                  {/* Only here, and only while it is a draft: once posted the
                      document is immutable and the correction is a reversal. */}
                  <Link href={`${basePath}/${doc.id}/edit`} className={`${btn.ghost} w-full text-center`}>
                    Edit draft
                  </Link>
                </>
              )}
              {/* Reversing is refused while anything is allocated (see
                  `reverseDocument`), so say why here rather than offering a
                  button whose only outcome is that error. */}
              {doc.state === 'posted' && allocations.length > 0 && (
                <p className="text-[12px] text-ink-faint">
                  {fmt(allocations.reduce((t, a) => t + a.amount, 0))} is settled against this
                  document, so it cannot be reversed. Remove it under Settlements first — or
                  raise a credit note if the money is staying where it is.
                </p>
              )}
              {doc.state === 'posted' && allocations.length === 0 && (
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

          {advances.length > 0 && (
            <Card title="Advance on account"
              subtitle={`${fmt(advanceTotal)} already paid to ${doc.partner_name} with nothing against it. Apply it before paying the rest.`}>
              <div className="space-y-3">
                {advances.map((p) => {
                  const applicable = Math.min(p.unallocated, doc.residual);
                  return (
                    <form key={p.id} action={allocateAction}
                      className="flex flex-wrap items-center gap-2 border-b border-line pb-3 last:border-0 last:pb-0">
                      <input type="hidden" name="payment_id" value={p.id} />
                      <input type="hidden" name="document_id" value={doc.id} />
                      <input type="hidden" name="return_to" value={`${basePath}/${doc.id}`} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-bold">{p.number}</div>
                        <div className="text-[11.5px] text-ink-faint">
                          {fmtDate(p.pay_date)} · {titleise(p.method)} · {fmt(p.unallocated)} unapplied
                        </div>
                      </div>
                      <input name="amount" defaultValue={(applicable / 100).toFixed(2)}
                        inputMode="decimal" className={`${inputClass} w-[110px] text-right`} />
                      <button className={btn.ghost}>Apply</button>
                    </form>
                  );
                })}
              </div>
            </Card>
          )}

          {openInvoices.length > 0 && (
            <Card title="Apply to an invoice"
              subtitle="Reduces what is owed. No money moves — use this before paying anything out.">
              <div className="space-y-3">
                {openInvoices.map((inv) => {
                  const applicable = Math.min(inv.residual, doc.residual);
                  return (
                    <form key={inv.id} action={applyCreditAction}
                      className="flex flex-wrap items-center gap-2 border-b border-line pb-3 last:border-0 last:pb-0">
                      <input type="hidden" name="credit_id" value={doc.id} />
                      <input type="hidden" name="invoice_id" value={inv.id} />
                      <input type="hidden" name="return_to" value={`${basePath}/${doc.id}`} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-bold">{inv.number}</div>
                        <div className="text-[11.5px] text-ink-faint">
                          {fmtDate(inv.doc_date)} · {fmt(inv.residual)} still owed
                        </div>
                      </div>
                      <input name="amount" defaultValue={(applicable / 100).toFixed(2)}
                        inputMode="decimal" className={`${inputClass} w-[110px] text-right`} />
                      <button className={btn.ghost}>Apply</button>
                    </form>
                  );
                })}
              </div>
            </Card>
          )}

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
                  {/* Defaults to what is left AFTER the advances above are
                      applied, so the obvious path does not pay twice. */}
                  <input name="amount" defaultValue={(afterAdvances / 100).toFixed(2)}
                    inputMode="decimal" className={`${inputClass} text-right`} />
                </Field>
                <Field label="Date">
                  <input type="date" name="pay_date" defaultValue={today} className={inputClass} />
                </Field>
                <Field label="Paid into / from">
                  <select name="bank_account_id" className={inputClass}>
                    {(await bankAccountOptions(orgId)).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </Field>
                <input type="hidden" name="journal_id"
                  value={(await journalOptions(orgId, ['bank', 'cash']))[0]?.id ?? ''} />
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
                {advanceTotal > 0 && ` ${fmt(advanceTotal)} of advance is already with this partner — the amount above is what remains once it is applied.`}
              </p>
              {openInvoices.length > 0 && (
                <p className="mt-2 text-[12px] font-semibold text-negative">
                  {doc.partner_name} still owes {fmt(openInvoices.reduce((t, i) => t + i.residual, 0))} on
                  open invoices. Apply this note to them first — paying cash out now refunds money
                  that was never received.
                </p>
              )}
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

          {/*
            * BOTH SIDES RAISE A NOTE, AND THE BILL SIDE IS NOT THE RARE ONE.
            *
            * This read `doc_type === 'out_invoice'`, so a vendor bill had no way
            * to raise anything — yet a cancelled trip is exactly when the agency
            * needs one, because the hotel and the airline have already been paid
            * in full. `createCreditNote` has always handled both (it picks
            * `in_refund` off the source type); only this gate was one-sided, so
            * the debit note list could never be anything but empty.
            */}
          {doc.state === 'posted' && (doc.doc_type === 'out_invoice' || doc.doc_type === 'in_invoice') && (
            <Card title={isBill ? 'Cancellation / debit note' : 'Cancellation / credit note'}
              subtitle={isBill
                ? 'A percentage of the bill, for what the supplier has agreed to refund.'
                : 'A percentage of the invoice, so a cancellation charge stays tied to the original.'}>
              <form action={creditNoteAction} className="space-y-3">
                <input type="hidden" name="id" value={doc.id} />
                <input type="hidden" name="doc_type" value={doc.doc_type} />
                <Field label={isBill ? 'Refund percentage' : 'Credit percentage'}
                  hint={isBill
                    ? `How much of ${fmt(doc.total)} the supplier is giving back. 100 cancels the bill in full; 70 recovers ${fmt(Math.round(doc.total * 0.7))} and leaves ${fmt(doc.total - Math.round(doc.total * 0.7))} as their retained charge.`
                    : `How much of ${fmt(doc.total)} is cancelled. 100 cancels it in full; 70 credits ${fmt(Math.round(doc.total * 0.7))} and keeps ${fmt(doc.total - Math.round(doc.total * 0.7))} as the cancellation charge.`}>
                  <input name="percent" defaultValue="100" inputMode="decimal" className={`${inputClass} text-right`} />
                </Field>
                <Field label="Date">
                  <input type="date" name="date" defaultValue={today} className={inputClass} />
                </Field>
                <Field label="Reason">
                  <input name="reason" placeholder={isBill ? 'Supplier cancellation' : 'Customer cancellation'} className={inputClass} />
                </Field>
                <button name="post_now" value="true" className={`${btn.ghost} w-full`}>
                  {isBill ? 'Create and post debit note' : 'Create and post credit note'}
                </button>
              </form>
              {isBill && (
                <p className="mt-3 text-[12px] text-ink-faint">
                  The input GST on the refunded portion is reversed with it, which is what the
                  supplier&apos;s own credit note will report against your GSTIN.
                </p>
              )}
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
