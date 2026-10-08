import Link from 'next/link';
import { DOC_TYPES, can } from '@/lib/accounting';
import { fromMinor, qtyFromMilli } from '@/lib/money';
import { getDocument, documentLines } from '@/server/accounting/documents';
import { documentFormOptions } from '@/server/options';
import { PageHeader, Banner, btn } from './ui';
import { DocumentForm, type LineDefault } from './DocumentForm';

/**
 * Reopen a document — draft or posted.
 *
 * -------------------------------------------------------------------------
 * WHY A POSTED DOCUMENT OPENS HERE AT ALL
 * -------------------------------------------------------------------------
 * It used to refuse, on the rule that a posted document is immutable and the
 * correction is a reversal or a credit note. That rule protects the right
 * thing — the ledger must never quietly disagree with the paper — but it was
 * being enforced by refusing to help: an invoice with a wrong rate on it became
 * a reversal, a fresh invoice and a second number, for one sale that was simply
 * typed wrong.
 *
 * What makes editing safe is not refusing it; it is REPLACING EVERYTHING THE
 * OLD VERSION WROTE. Saving a posted document calls `amendDocument`, which
 * rewrites the lines, recomputes the totals and the tax split, and replaces the
 * posted journal entry in place — so the general ledger, the trial balance, the
 * day book, the ageing and the tax report all carry the new figures and none of
 * them carry the old ones. The audit log keeps what it used to say.
 *
 * It still refuses where it cannot be safe, and says which: a locked or closed
 * period, a reconciled bank line, a credit note already raised against the
 * document, or a settlement bigger than the new total.
 *
 * STATUTORILY, AN AMENDMENT IS NOT INVISIBLE. An invoice already reported is
 * amended in GSTR-1 through Table 9A, in the period the correction is made.
 * That filing is outside this product; what this gives it is one set of books
 * saying what the corrected invoice says, and a record of what changed.
 */
export async function DocumentEdit({ orgId, docId, basePath, role, message }: {
  orgId: string; docId: string; basePath: string; role: string;
  message?: { ok?: string; error?: string };
}) {
  const doc = await getDocument(orgId, docId);
  if (!doc) return <Banner tone="error">That document no longer exists.</Banner>;

  const meta = DOC_TYPES[doc.doc_type];
  const isBill = meta.side === 'supplier';

  /*
   * A CANCELLED DOCUMENT IS THE ONE THAT STILL REFUSES.
   *
   * It has been reversed: its entry is undone and a reversing entry stands
   * beside it in the ledger. Amending it would rewrite an entry that another
   * entry already answers, leaving two postings describing figures that no
   * longer belong together. The correction there is a fresh document.
   */
  if (doc.state === 'cancelled') {
    return (
      <>
        <PageHeader title={doc.number ?? meta.short} subtitle={`${meta.label} · ${doc.partner_name}`} />
        <Banner tone="error">
          This document has been reversed, so there is nothing left to amend — the ledger already
          carries the entry that undid it. Raise a fresh one.
        </Banner>
        <Link href={`${basePath}/${doc.id}`} className={btn.ghost}>Back to the document</Link>
      </>
    );
  }

  const posted = doc.state === 'posted';

  const lines = await documentLines(orgId, docId);
  const canPost = can(role, isBill ? 'bill.post' : 'invoice.post');
  const options = await documentFormOptions(orgId, doc.doc_type, canPost);

  /*
   * AMENDING IS A POSTING ACT, so it takes the posting capability.
   *
   * It rewrites a journal entry that is already in the books. Someone who may
   * raise a document but not post one may not silently restate one that has
   * been posted, and letting the form open and then fail on save would be a
   * worse way of saying so.
   */
  if (posted && !canPost) {
    return (
      <>
        <PageHeader title={doc.number ?? meta.short} subtitle={`${meta.label} · ${doc.partner_name}`} />
        <Banner tone="error">
          This document is posted, so changing it rewrites the journal entry behind it — which needs
          posting rights. Ask someone who has them, or raise a credit note instead.
        </Banner>
        <Link href={`${basePath}/${doc.id}`} className={btn.ghost}>Back to the document</Link>
      </>
    );
  }

  const lineDefaults: LineDefault[] = lines.map((l) => ({
    name: l.name,
    qty: String(qtyFromMilli(l.qty_milli)),
    price: fromMinor(l.unit_price).toFixed(2),
    discount: String(l.discount_bps / 100),
    taxId: l.tax_id ?? '',
    accountId: l.account_id,
    analyticId: l.analytic_id ?? '',
    hsn: l.hsn_code ?? '',
    // What the CRM called this line, shown back in the Type column. Blank on a
    // line raised here, which the column offers as a dash rather than guessing.
    itemType: l.item_type ?? '',
    // Blank rather than "0.00" for an MRP that was never stated: a zero in the
    // box reads as a priced line and would be saved back as one, which turns a
    // field nobody filled into a figure the invoice then prints.
    mrp: l.mrp ? fromMinor(l.mrp).toFixed(2) : '',
  }));

  return (
    <>
      {posted && (
        <Banner tone="warn">
          {doc.number} is posted. Saving rewrites its journal entry in place, so the general ledger,
          the trial balance and every report built on them carry the new figures and none of the old
          ones — and the audit log keeps what it used to say. An invoice already reported is amended
          in GSTR-1 Table 9A for the period the correction is made.
        </Banner>
      )}
      <PageHeader
        title={`Edit ${meta.short.toLowerCase()}${posted ? '' : ' (draft)'}`}
        subtitle={`${meta.label} · ${doc.partner_name}${doc.booking_ref ? ` · ${doc.booking_ref}` : ''}`}
        accent={isBill ? 'var(--color-sec-purchases)' : 'var(--color-sec-sales)'}
        actions={<Link href={`${basePath}/${doc.id}`} className={btn.ghost}>Cancel</Link>}
      />
      {message?.error && <Banner tone="error">{message.error}</Banner>}
      {message?.ok && <Banner tone="ok">{message.ok}</Banner>}
      <DocumentForm
        {...options}
        existing={{ id: doc.id }}
        defaults={{
          partnerName: doc.partner_name ?? '',
          journalId: doc.journal_id,
          bookingId: doc.booking_id ?? '',
          // The sale a vendor bill was bought for. Reopening a bill has to
          // show the invoice it was recorded against, or saving the edit would
          // quietly unlink it — and the trip's cost would vanish with it.
          linkedInvoiceId: doc.linked_invoice_id ?? '',
          crmBatchId: doc.crm_batch_id ?? '',
          batchName: doc.batch_name ?? '',
          analyticId: doc.analytic_id ?? '',
          date: doc.doc_date,
          dueDate: doc.due_date ?? '',
          paymentTermsId: doc.payment_terms_id ?? '',
          supplierRef: doc.supplier_ref ?? '',
          currency: doc.currency,
          rate: String(doc.rate_e6 / 1e6),
          withholdingTaxId: doc.withholding_tax_id ?? '',
          note: doc.note ?? '',
          placeOfSupply: doc.place_of_supply ?? '',
          // `party_gstin` rather than the joined `partner_gstin`: reopening a
          // draft has to show what the DOCUMENT says, blank included. Showing
          // the partner's instead would silently adopt it on the next save.
          partyGstin: doc.party_gstin ?? '',
          // What the document ALREADY SAYS it is. Reopening a retail invoice
          // must not quietly turn it into a B2B supply because a registration
          // was filled in on the partner afterwards.
          supplyType: doc.supply_type === 'b2b' ? 'b2b' : 'b2c',
          orderRef: doc.order_ref ?? '',
          orderDate: doc.order_date ?? '',
          /*
           * WHAT THE SOURCE INVOICE STATED, SHOWN BACK AS IT WAS STORED.
           *
           * Blank rather than "0.00" where there is nothing to state, for the
           * same reason the MRP cell above is: a zero in the box reads as a
           * figure somebody entered, and it would be saved back as one.
           */
          statedDiscount: doc.stated_discount ? fromMinor(doc.stated_discount).toFixed(2) : '',
          statedTax: doc.stated_tax ? fromMinor(doc.stated_tax).toFixed(2) : '',
          statedAdvance: doc.stated_advance ? fromMinor(doc.stated_advance).toFixed(2) : '',
          irn: doc.irn ?? '',
          irnAckNo: doc.irn_ack_no ?? '',
          irnAckDate: doc.irn_ack_date ?? '',
          lines: lineDefaults,
        }}
      />
    </>
  );
}
