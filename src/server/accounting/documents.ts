import 'server-only';
import { all, one, run, scalar, tx, id, nowIso } from '../db';
import { DOC_TYPES, type DocType, addDays } from '@/lib/accounting';
import { computeLine, computeWithholding } from './tax';
import { postEntry, reverseEntry, PostingError, type Actor, type PostingLine } from './engine';
import { receivableAccount, payableAccount, requireSetting } from './settings';
import { audit } from './audit';

/**
 * Customer invoices, vendor bills and both kinds of credit note.
 *
 * All four are rows in `documents`, differing by `doc_type`, and the posting
 * routine below is written ONCE against `DOC_TYPES[type].sign` rather than
 * four times with the debits and credits swapped by hand. That is the whole
 * reason for the single table: four copies of this function would drift, and a
 * credit note that debits what it should credit is a silent error that only
 * shows up as a customer balance nobody can explain.
 *
 * WHAT POSTING MEANS HERE
 *
 *   Customer invoice          Vendor bill
 *     AR            Dr          Direct cost   Dr
 *       Revenue     Cr          Input GST     Dr
 *       Output GST  Cr            AP          Cr
 *                                 TDS payable Cr
 *
 * The revenue and cost lines carry the trip's analytic account, which is what
 * makes Trip Profitability reconcile to the P&L instead of merely resembling
 * it (plan section 23).
 */

export interface DocLineInput {
  id?: string;
  productId?: string | null;
  name: string;
  qtyMilli: number;
  unitPrice: number;
  discountBps?: number;
  taxId?: string | null;
  accountId: string;
  analyticId?: string | null;
}

export interface DocInput {
  orgId: string;
  docType: DocType;
  partnerId: string;
  journalId: string;
  bookingId?: string | null;
  analyticId?: string | null;
  docDate: string;
  dueDate?: string | null;
  paymentTermsId?: string | null;
  supplierRef?: string | null;
  currency?: string;
  rateE6?: number;
  /** Vendor bills only: the TDS section to withhold under. */
  withholdingTaxId?: string | null;
  note?: string | null;
  lines: DocLineInput[];
}

export interface DocRow {
  id: string; org_id: string; doc_type: DocType; number: string | null;
  partner_id: string; partner_name?: string; journal_id: string;
  booking_id: string | null; booking_ref?: string | null; analytic_id: string | null;
  doc_date: string; due_date: string | null; supplier_ref: string | null;
  currency: string; rate_e6: number; state: string; payment_state: string;
  untaxed: number; tax_total: number; total: number; residual: number;
  withheld_tax: number; entry_id: string | null; reversal_of: string | null;
  reversed_by: string | null; note: string | null;
  created_by: string | null; created_at: string; posted_by: string | null; posted_at: string | null;
}

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export async function createDocument(input: DocInput, actor: Actor = {}): Promise<string> {
  return await tx(async () => {
    const docId = id('doc');
    const due = input.dueDate ?? await deriveDueDate(input);
    await run(
      `INSERT INTO documents
         (id, org_id, doc_type, partner_id, journal_id, booking_id, analytic_id,
          doc_date, due_date, payment_terms_id, supplier_ref, currency, rate_e6,
          state, payment_state, note, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'draft','not_paid',?,?,?)`,
      docId, input.orgId, input.docType, input.partnerId, input.journalId,
      input.bookingId ?? null, input.analyticId ?? null, input.docDate, due,
      input.paymentTermsId ?? null, input.supplierRef ?? null,
      input.currency ?? 'INR', input.rateE6 ?? 1_000_000,
      input.note ?? null, actor.id ?? null, nowIso(),
    );
    await replaceLines(input.orgId, docId, input.lines, input.analyticId ?? null);
    await recomputeTotals(input.orgId, docId, input.withholdingTaxId ?? null);
    await audit(input.orgId, actor, 'created', 'document', docId,
      `${DOC_TYPES[input.docType].label} drafted`);
    return docId;
  });
}

export async function updateDocument(docId: string, input: DocInput, actor: Actor = {}) {
  return await tx(async () => {
    const doc = await getDocument(input.orgId, docId);
    if (!doc) throw new PostingError('Unknown document.');
    // A posted document is immutable. Correcting one means a credit note or a
    // reversal, which leaves both the original and the correction on record
    // (plan section 44).
    if (doc.state !== 'draft') throw new PostingError('A posted document cannot be edited. Reverse it or raise a credit note.');
    await run(
      `UPDATE documents SET partner_id=?, journal_id=?, booking_id=?, analytic_id=?,
              doc_date=?, due_date=?, payment_terms_id=?, supplier_ref=?, currency=?, rate_e6=?, note=?
         WHERE id=? AND org_id=?`,
      input.partnerId, input.journalId, input.bookingId ?? null, input.analyticId ?? null,
      input.docDate, input.dueDate ?? await deriveDueDate(input), input.paymentTermsId ?? null,
      input.supplierRef ?? null, input.currency ?? 'INR', input.rateE6 ?? 1_000_000,
      input.note ?? null, docId, input.orgId,
    );
    await replaceLines(input.orgId, docId, input.lines, input.analyticId ?? null);
    await recomputeTotals(input.orgId, docId, input.withholdingTaxId ?? null);
    await audit(input.orgId, actor, 'modified', 'document', docId, 'Draft edited');
  });
}

async function deriveDueDate(input: DocInput): Promise<string> {
  if (input.dueDate) return input.dueDate;
  if (input.paymentTermsId) {
    const t = await one<{ days: number }>('SELECT days FROM payment_terms WHERE id = ?', input.paymentTermsId);
    if (t) return addDays(input.docDate, t.days);
  }
  return input.docDate;
}

async function replaceLines(orgId: string, docId: string, lines: DocLineInput[], docAnalytic: string | null) {
  await run('DELETE FROM document_lines WHERE document_id = ?', docId);
  // Sequential, not Promise.all: these inserts share the posting transaction's
  // one connection, and `seq` must land in the order the accountant typed.
  for (const [i, l] of lines.entries()) {
    const amounts = await computeLine(orgId, l);
    await run(
      `INSERT INTO document_lines
         (id, org_id, document_id, seq, product_id, name, qty_milli, unit_price,
          discount_bps, tax_id, account_id, analytic_id, subtotal, tax_amount, total)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      l.id ?? id('dl'), orgId, docId, i, l.productId ?? null, l.name,
      l.qtyMilli, l.unitPrice, l.discountBps ?? 0, l.taxId ?? null, l.accountId,
      l.analyticId ?? docAnalytic, amounts.subtotal, amounts.taxAmount, amounts.total,
    );
  }
}

/**
 * Roll the lines up onto the header.
 *
 * The tax total is the sum of the per-line rounded taxes, not a tax on the sum.
 * A customer checking the invoice adds the column they can see, and the ledger
 * has to agree with the paper.
 */
export async function recomputeTotals(orgId: string, docId: string, withholdingTaxId: string | null = null) {
  const rows = await all<{ subtotal: number; tax_amount: number; total: number }>(
    'SELECT subtotal, tax_amount, total FROM document_lines WHERE document_id = ?', docId,
  );
  const untaxed = rows.reduce((s, r) => s + r.subtotal, 0);
  const taxTotal = rows.reduce((s, r) => s + r.tax_amount, 0);
  const total = untaxed + taxTotal;

  const doc = await one<{ doc_type: string; withheld_tax: number }>(
    'SELECT doc_type, withheld_tax FROM documents WHERE id = ?', docId,
  );
  let withheld = doc?.withheld_tax ?? 0;
  if (withholdingTaxId !== null) {
    withheld = doc?.doc_type.startsWith('in_')
      ? (await computeWithholding(orgId, withholdingTaxId, untaxed)).amount
      : 0;
  }

  await run(
    'UPDATE documents SET untaxed=?, tax_total=?, total=?, withheld_tax=? WHERE id=? AND org_id=?',
    untaxed, taxTotal, total, withheld, docId, orgId,
  );
  await refreshResidual(orgId, docId);
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

export async function postDocument(orgId: string, docId: string, actor: Actor = {}): Promise<string> {
  return await tx(async () => {
    const doc = await getDocument(orgId, docId);
    if (!doc) throw new PostingError('Unknown document.');
    if (doc.state === 'posted') throw new PostingError('This document is already posted.');
    if (doc.state === 'cancelled') throw new PostingError('A cancelled document cannot be posted.');

    const lines = await all<{
      id: string; name: string; account_id: string; analytic_id: string | null;
      subtotal: number; tax_amount: number; tax_id: string | null;
    }>(`SELECT id, name, account_id, analytic_id, subtotal, tax_amount, tax_id
          FROM document_lines WHERE document_id = ? ORDER BY seq`, docId);
    if (!lines.length) throw new PostingError('A document with no lines cannot be posted.');

    const meta = DOC_TYPES[doc.doc_type];
    // Take the number BEFORE the lines are built: the partner line is labelled
    // with it, and assigning it afterwards left every posted invoice's
    // receivable line reading "Customer Invoice" instead of "INV-0006".
    const number = doc.number ?? await takeDocumentNumber(orgId, doc);
    const isSale = meta.side === 'customer';
    // A credit note is the same entry with the sides swapped. One flag, not a
    // second code path.
    const flip = meta.sign === -1;

    const postings: PostingLine[] = [];

    // --- the income or expense side, one line per document line -------------
    for (const l of lines) {
      const amounts = await computeLine(orgId, {
        qtyMilli: 1000, unitPrice: l.subtotal, discountBps: 0, taxId: l.tax_id,
      });
      const base: PostingLine = {
        accountId: l.account_id,
        label: l.name,
        partnerId: doc.partner_id,
        bookingId: doc.booking_id,
        analyticId: l.analytic_id ?? doc.analytic_id ?? null,
      };
      // Sale: revenue is credited. Purchase: cost is debited. Reverse for notes.
      if (isSale !== flip) postings.push({ ...base, credit: l.subtotal });
      else postings.push({ ...base, debit: l.subtotal });

      for (const split of amounts.splits) {
        if (!split.amount) continue;
        if (!split.accountId) throw new PostingError(`Tax "${split.name}" has no account configured.`);
        const taxLine: PostingLine = {
          accountId: split.accountId,
          label: split.name,
          partnerId: doc.partner_id,
          taxId: split.taxId,
          taxBase: split.base,
        };
        // Output tax is a liability (credit); input tax is an asset (debit).
        if (isSale !== flip) postings.push({ ...taxLine, credit: split.amount });
        else postings.push({ ...taxLine, debit: split.amount });
      }
    }

    // --- the partner side ---------------------------------------------------
    const partnerAccount = isSale
      ? await receivableAccount(orgId, doc.partner_id)
      : await payableAccount(orgId, doc.partner_id);
    const payable = doc.total - doc.withheld_tax;

    postings.push({
      accountId: partnerAccount,
      partnerId: doc.partner_id,
      label: number,
      bookingId: doc.booking_id,
      ...(isSale !== flip ? { debit: payable } : { credit: payable }),
    });

    // --- TDS withheld on a vendor bill -------------------------------------
    // The agency owes this to the government rather than to the supplier, so it
    // splits off the payable rather than reducing the expense.
    if (doc.withheld_tax > 0 && !isSale) {
      postings.push({
        accountId: await requireSetting(orgId, 'account.tds_payable'),
        partnerId: doc.partner_id,
        label: 'TDS withheld',
        ...(flip ? { debit: doc.withheld_tax } : { credit: doc.withheld_tax }),
      });
    }

    const entryId = await postEntry({
      orgId,
      journalId: doc.journal_id,
      date: doc.doc_date,
      reference: number,
      narration: `${meta.label} ${number}`,
      sourceModel: 'document',
      sourceId: docId,
      currency: doc.currency,
      lines: postings,
    }, actor);

    await run(
      `UPDATE documents SET state='posted', number=?, entry_id=?, posted_by=?, posted_at=?
         WHERE id=? AND org_id=?`,
      number, entryId, actor.id ?? null, nowIso(), docId, orgId,
    );
    await refreshResidual(orgId, docId);
    await audit(orgId, actor, 'posted', 'document', docId, `${meta.label} ${number} posted`);
    return entryId;
  });
}

async function takeDocumentNumber(orgId: string, doc: DocRow): Promise<string> {
  const journal = await one<{ sequence_code: string; code: string }>(
    'SELECT sequence_code, code FROM journals WHERE id = ?', doc.journal_id,
  );
  const seqCode = `doc_${journal?.sequence_code ?? DOC_TYPES[doc.doc_type].seq}`;
  const prefix = doc.doc_type === 'out_invoice' ? 'INV'
    : doc.doc_type === 'out_refund' ? 'CN'
      : doc.doc_type === 'in_invoice' ? 'BILL' : 'DN';
  const existing = await one<{ next_no: number }>(
    'SELECT next_no FROM sequences WHERE org_id = ? AND code = ? FOR UPDATE', orgId, seqCode,
  );
  if (!existing) {
    await run('INSERT INTO sequences (org_id, code, prefix, padding, next_no) VALUES (?,?,?,?,?)',
      orgId, seqCode, prefix, 4, 2);
    return `${prefix}-0001`;
  }
  await run('UPDATE sequences SET next_no = next_no + 1 WHERE org_id = ? AND code = ?', orgId, seqCode);
  return `${prefix}-${String(existing.next_no).padStart(4, '0')}`;
}

/**
 * Reverse a posted document.
 *
 * Nothing is deleted. The journal entry is reversed on `date`, the document is
 * marked cancelled and both halves stay visible — which is what lets an auditor
 * see what was corrected and when.
 */
export async function reverseDocument(orgId: string, docId: string, date: string, actor: Actor = {}, reason?: string) {
  return await tx(async () => {
    const doc = await getDocument(orgId, docId);
    if (!doc) throw new PostingError('Unknown document.');
    if (doc.state !== 'posted') throw new PostingError('Only a posted document can be reversed.');
    if (doc.entry_id) await reverseEntry(orgId, doc.entry_id, date, actor, reason);
    await run(`UPDATE documents SET state='cancelled', payment_state='reversed' WHERE id=? AND org_id=?`, docId, orgId);
    await audit(orgId, actor, 'reversed', 'document', docId, reason ?? 'Reversed');
  });
}

/**
 * Raise a credit note against a posted invoice (plan section 22).
 *
 * `bps` lets a partial cancellation be taken as a percentage of the original —
 * which is what a cancellation charge is: "you get 20% back" is a 2000 bps
 * credit note, not a hand-typed set of lines that no longer tie to the invoice.
 */
export async function createCreditNote(
  orgId: string,
  sourceDocId: string,
  opts: { date: string; bps?: number; reason?: string; journalId?: string },
  actor: Actor = {},
): Promise<string> {
  return await tx(async () => {
    const doc = await getDocument(orgId, sourceDocId);
    if (!doc) throw new PostingError('Unknown document.');
    if (doc.state !== 'posted') throw new PostingError('Credit notes are raised against posted documents.');
    const bps = opts.bps ?? 10000;

    const lines = await all<{
      name: string; account_id: string; analytic_id: string | null;
      subtotal: number; tax_id: string | null; product_id: string | null;
    }>(`SELECT name, account_id, analytic_id, subtotal, tax_id, product_id
          FROM document_lines WHERE document_id = ? ORDER BY seq`, sourceDocId);

    const creditType: DocType = doc.doc_type === 'out_invoice' ? 'out_refund' : 'in_refund';
    const noteId = await createDocument({
      orgId,
      docType: creditType,
      partnerId: doc.partner_id,
      journalId: opts.journalId ?? doc.journal_id,
      bookingId: doc.booking_id,
      analyticId: doc.analytic_id,
      docDate: opts.date,
      dueDate: opts.date,
      currency: doc.currency,
      rateE6: doc.rate_e6,
      note: `${opts.reason ?? 'Credit note'} — against ${doc.number}`,
      lines: lines.map((l) => ({
        name: l.name,
        productId: l.product_id,
        qtyMilli: 1000,
        unitPrice: Math.round((l.subtotal * bps) / 10000),
        taxId: l.tax_id,
        accountId: l.account_id,
        analyticId: l.analytic_id,
      })),
    }, actor);

    await run('UPDATE documents SET reversal_of=? WHERE id=?', sourceDocId, noteId);
    await run('UPDATE documents SET reversed_by=? WHERE id=?', noteId, sourceDocId);
    await audit(orgId, actor, 'credit_note', 'document', sourceDocId,
      `Credit note drafted for ${(bps / 100).toFixed(0)}% — ${opts.reason ?? ''}`.trim());
    return noteId;
  });
}

// ---------------------------------------------------------------------------
// Residual and payment state
// ---------------------------------------------------------------------------

/**
 * What is still owed on a document, from its allocations.
 *
 * The column is a cache for list speed. It is recomputed here on every change
 * and never written by hand, so it can be rebuilt from the allocations at any
 * time — which is the test in plan section 56 that customer balances reconcile
 * to AR.
 */
export async function refreshResidual(orgId: string, docId: string) {
  const doc = await one<{ total: number; withheld_tax: number; state: string; doc_type: string }>(
    'SELECT total, withheld_tax, state, doc_type FROM documents WHERE id = ? AND org_id = ?', docId, orgId,
  );
  if (!doc) return;
  const allocated = await scalar(
    'SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE document_id = ?', docId,
  );
  const payable = doc.total - (doc.doc_type.startsWith('in_') ? doc.withheld_tax : 0);
  const residual = Math.max(payable - allocated, 0);

  let state = 'not_paid';
  if (doc.state === 'cancelled') state = 'reversed';
  else if (residual === 0 && payable !== 0) state = 'paid';
  else if (allocated > 0) state = 'partial';

  await run('UPDATE documents SET residual=?, payment_state=? WHERE id=?', residual, state, docId);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getDocument(orgId: string, docId: string): Promise<DocRow | null> {
  return await one<DocRow>(
    `SELECT d.*, p.name AS partner_name, b.ref AS booking_ref
       FROM documents d
       LEFT JOIN partners p ON p.id = d.partner_id
       LEFT JOIN bookings b ON b.id = d.booking_id
      WHERE d.id = ? AND d.org_id = ?`, docId, orgId,
  );
}

export async function documentLines(docId: string) {
  return await all<{
    id: string; seq: number; name: string; product_id: string | null;
    qty_milli: number; unit_price: number; discount_bps: number;
    tax_id: string | null; tax_name: string | null; account_id: string;
    account_code: string; account_name: string; analytic_id: string | null;
    analytic_name: string | null; subtotal: number; tax_amount: number; total: number;
  }>(
    `SELECT dl.*, t.name AS tax_name, a.code AS account_code, a.name AS account_name,
            an.name AS analytic_name
       FROM document_lines dl
       LEFT JOIN taxes t ON t.id = dl.tax_id
       LEFT JOIN accounts a ON a.id = dl.account_id
       LEFT JOIN analytic_accounts an ON an.id = dl.analytic_id
      WHERE dl.document_id = ? ORDER BY dl.seq`, docId,
  );
}

export interface DocFilter {
  docType?: DocType | DocType[];
  state?: string;
  paymentState?: string;
  partnerId?: string;
  bookingId?: string;
  from?: string;
  to?: string;
  search?: string;
  overdueOn?: string;
  limit?: number;
}

export async function listDocuments(orgId: string, f: DocFilter = {}): Promise<DocRow[]> {
  const types = f.docType ? (Array.isArray(f.docType) ? f.docType : [f.docType]) : null;
  const clauses: string[] = ['d.org_id = ?'];
  const params: Array<string | number> = [orgId];

  if (types) {
    clauses.push(`d.doc_type IN (${types.map(() => '?').join(',')})`);
    params.push(...types);
  }
  if (f.state) { clauses.push('d.state = ?'); params.push(f.state); }
  if (f.paymentState) { clauses.push('d.payment_state = ?'); params.push(f.paymentState); }
  if (f.partnerId) { clauses.push('d.partner_id = ?'); params.push(f.partnerId); }
  if (f.bookingId) { clauses.push('d.booking_id = ?'); params.push(f.bookingId); }
  if (f.from) { clauses.push('d.doc_date >= ?'); params.push(f.from); }
  if (f.to) { clauses.push('d.doc_date <= ?'); params.push(f.to); }
  if (f.overdueOn) {
    clauses.push("d.state = 'posted' AND d.residual > 0 AND d.due_date < ?");
    params.push(f.overdueOn);
  }
  if (f.search) {
    clauses.push('(d.number LIKE ? OR p.name LIKE ? OR d.supplier_ref LIKE ?)');
    const like = `%${f.search}%`;
    params.push(like, like, like);
  }

  const limit = f.limit ?? 200;
  return await all<DocRow>(
    `SELECT d.*, p.name AS partner_name, b.ref AS booking_ref
       FROM documents d
       LEFT JOIN partners p ON p.id = d.partner_id
       LEFT JOIN bookings b ON b.id = d.booking_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY d.doc_date DESC, d.created_at DESC
      LIMIT ${limit}`,
    ...params,
  );
}
