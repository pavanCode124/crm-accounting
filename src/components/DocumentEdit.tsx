import Link from 'next/link';
import { DOC_TYPES, can } from '@/lib/accounting';
import { fromMinor, qtyFromMilli } from '@/lib/money';
import { getDocument, documentLines } from '@/server/accounting/documents';
import { documentFormOptions } from '@/server/options';
import { PageHeader, Banner, btn } from './ui';
import { DocumentForm, type LineDefault } from './DocumentForm';

/**
 * Reopen a draft.
 *
 * A draft has touched nothing — no number taken, no journal entry, no payment
 * against it — so it is the one state in the product where a document can be
 * changed in place. Once it is posted the correction is a reversal or a credit
 * note instead, and this screen refuses rather than pretending otherwise
 * (`updateDocument` refuses it again on the server).
 */
export async function DocumentEdit({ orgId, docId, basePath, role, message }: {
  orgId: string; docId: string; basePath: string; role: string;
  message?: { ok?: string; error?: string };
}) {
  const doc = await getDocument(orgId, docId);
  if (!doc) return <Banner tone="error">That document no longer exists.</Banner>;

  const meta = DOC_TYPES[doc.doc_type];
  const isBill = meta.side === 'supplier';

  if (doc.state !== 'draft') {
    return (
      <>
        <PageHeader title={doc.number ?? meta.short} subtitle={`${meta.label} · ${doc.partner_name}`} />
        <Banner tone="error">
          This document has been posted, so it can no longer be edited. Reverse it or raise a credit
          note from the document itself.
        </Banner>
        <Link href={`${basePath}/${doc.id}`} className={btn.ghost}>Back to the document</Link>
      </>
    );
  }

  const lines = await documentLines(docId);
  const options = await documentFormOptions(orgId, doc.doc_type, can(role, isBill ? 'bill.post' : 'invoice.post'));

  const lineDefaults: LineDefault[] = lines.map((l) => ({
    name: l.name,
    qty: String(qtyFromMilli(l.qty_milli)),
    price: fromMinor(l.unit_price).toFixed(2),
    discount: String(l.discount_bps / 100),
    taxId: l.tax_id ?? '',
    accountId: l.account_id,
    analyticId: l.analytic_id ?? '',
    hsn: l.hsn_code ?? '',
    // Blank rather than "0.00" for an MRP that was never stated: a zero in the
    // box reads as a priced line and would be saved back as one, which turns a
    // field nobody filled into a figure the invoice then prints.
    mrp: l.mrp ? fromMinor(l.mrp).toFixed(2) : '',
  }));

  return (
    <>
      <PageHeader
        title={`Edit ${meta.short.toLowerCase()} (draft)`}
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
          orderRef: doc.order_ref ?? '',
          orderDate: doc.order_date ?? '',
          irn: doc.irn ?? '',
          irnAckNo: doc.irn_ack_no ?? '',
          irnAckDate: doc.irn_ack_date ?? '',
          lines: lineDefaults,
        }}
      />
    </>
  );
}
