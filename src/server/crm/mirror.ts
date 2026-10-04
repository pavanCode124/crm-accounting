import 'server-only';
import { all, one, run, nowIso } from '../db';
import type { CrmInvoice, CrmInvoiceItem, CrmInvoicePayment } from './invoices';
import type { CrmPackage } from './live';

/**
 * THE CRM MIRROR: everything read from TripzoCRM, written into THIS database.
 *
 * ===========================================================================
 * THE ONE RULE THIS MODULE SERVES
 * ===========================================================================
 * TripzoCRM is READ. This ledger is WRITTEN. Nothing in the accounting app
 * sends a change back to the CRM — not an invoice, not a receipt, not a status
 * — and `crmFetch` has no method or body parameter, so it cannot.
 *
 * That rule has a consequence, and this module is it: if the CRM cannot be
 * edited then the thing being edited has to live somewhere else, and it has to
 * be COMPLETE before anybody edits it. So every invoice, line, receipt and
 * package the app reads is copied here first, into the ledger's own Postgres,
 * and every later act — adding the journal, the revenue accounts, the tax rows,
 * the HSN codes, posting, allocating an advance — happens against that copy.
 *
 * ===========================================================================
 * MIRRORING IS NOT IMPORTING, AND KEEPING THEM APART IS THE DESIGN
 * ===========================================================================
 *   MIRRORING (here)       is faithful and reversible. It records what the CRM
 *                          said, in the CRM's own terms, with no accounting
 *                          judgement applied. Re-running it is always safe: a
 *                          row is overwritten with a fresher reading of the
 *                          same record.
 *
 *   IMPORTING (import.ts)  is a judgement. It decides which revenue account a
 *                          line belongs on, which tax row produced an amount,
 *                          whether a payment is an advance or a receipt — and
 *                          it creates ledger documents, which are answerable
 *                          records. Re-running it must NOT repeat, which is
 *                          why it is idempotent through `document_id`.
 *
 * Collapsing the two would mean a re-fetch either silently restating documents
 * an accountant has already reviewed, or refusing to pick up a correction made
 * in the CRM. Split, a fetch always brings the latest reading, and what happens
 * to a document that was already created from an older one is a decision with
 * a person behind it.
 *
 * ===========================================================================
 * UNITS
 * ===========================================================================
 * The CRM answers in WHOLE RUPEES (`subtotal: 55000` is ₹55,000). Every money
 * column in this schema is PAISE. The conversion happens here, once, on the way
 * in, and nowhere else — a figure that crosses the boundary twice is out by a
 * factor of a hundred, which on an invoice is ₹550 against ₹55,000.
 */

// ---------------------------------------------------------------------------
// Coercion at the boundary
// ---------------------------------------------------------------------------

/**
 * CRM rupees → ledger paise, tolerating everything the backend actually sends.
 *
 * `Number(null)` is 0 and `Number(undefined)` is NaN, and both reach a money
 * column as something — zero in the first case, a crash or a silent zero in the
 * second. Some rows carry a numeric string. All three are resolved here so no
 * caller has to think about it.
 */
function paise(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** A quantity as thousandths, so 2.5 nights is exact rather than nearly exact. */
function milli(v: number | string | null | undefined): number {
  const n = Number(v ?? 1);
  return Number.isFinite(n) && n !== 0 ? Math.round(n * 1000) : 1000;
}

/** A CRM timestamp is an ISO datetime; every date column here is a plain date. */
export function dateOnly(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * The payload as stored, with nothing dropped — and with the nested lists taken
 * out of it.
 *
 * The invoice's `items` are mirrored as rows of their own, so keeping a second
 * copy inside `raw` would double the storage and, worse, leave two versions of
 * the same lines that can disagree after a re-fetch. What `raw` is for is the
 * fields this app does not have a column for YET; the lines are not among them.
 */
function rawOf(payload: unknown, omit: string[] = []): string {
  try {
    const obj = { ...(payload as Record<string, unknown>) };
    for (const k of omit) delete obj[k];
    return JSON.stringify(obj);
  } catch {
    // A payload with a cycle in it cannot be stringified, and failing the whole
    // import over the forensic copy would be the wrong trade.
    return '{}';
  }
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/**
 * Write one CRM invoice and its lines into the mirror.
 *
 * `document_id` and `imported_at` ARE NOT TOUCHED on a conflict, and that
 * omission is the most important line in the statement. They say "this invoice
 * has become a document in the books"; a re-fetch is a fresher reading of the
 * CRM, not a reason to forget that. Overwriting them would make the importer
 * create a SECOND document for an invoice it had already brought across —
 * revenue, receivable and output tax all counted twice, in books that still
 * balance.
 */
export async function mirrorInvoice(orgId: string, inv: CrmInvoice): Promise<void> {
  const at = nowIso();
  await run(
    `INSERT INTO crm_invoices (
       org_id, crm_id, invoice_number, status, doc_type, refund_of_crm_id, lead_id,
       issue_date, due_date, customer_name, customer_email, customer_phone,
       customer_address, business_address, ship_to_address,
       customer_gstin, seller_gstin, place_of_supply, payment_terms,
       currency, notes, terms,
       subtotal, discount_amount, tax_amount, total, amount_paid, balance_due, amount_withheld,
       crm_created_at, crm_updated_at, fetched_at, raw
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (org_id, crm_id) DO UPDATE SET
       invoice_number = excluded.invoice_number,
       status = excluded.status,
       doc_type = excluded.doc_type,
       refund_of_crm_id = excluded.refund_of_crm_id,
       lead_id = excluded.lead_id,
       issue_date = excluded.issue_date,
       due_date = excluded.due_date,
       customer_name = excluded.customer_name,
       customer_email = excluded.customer_email,
       customer_phone = excluded.customer_phone,
       customer_address = excluded.customer_address,
       business_address = excluded.business_address,
       ship_to_address = excluded.ship_to_address,
       customer_gstin = excluded.customer_gstin,
       seller_gstin = excluded.seller_gstin,
       place_of_supply = excluded.place_of_supply,
       payment_terms = excluded.payment_terms,
       currency = excluded.currency,
       notes = excluded.notes,
       terms = excluded.terms,
       subtotal = excluded.subtotal,
       discount_amount = excluded.discount_amount,
       tax_amount = excluded.tax_amount,
       total = excluded.total,
       amount_paid = excluded.amount_paid,
       balance_due = excluded.balance_due,
       amount_withheld = excluded.amount_withheld,
       crm_created_at = excluded.crm_created_at,
       crm_updated_at = excluded.crm_updated_at,
       fetched_at = excluded.fetched_at,
       raw = excluded.raw`,
    orgId, inv.id, text(inv.invoice_number), text(inv.status),
    text(inv.doc_type) ?? 'invoice', text(inv.refund_of_invoice_id), text(inv.lead_id),
    dateOnly(inv.issue_date), dateOnly(inv.due_date),
    text(inv.customer_name), text(inv.customer_email), text(inv.customer_phone),
    text(inv.customer_address), text(inv.business_address), text(inv.ship_to_address),
    text(inv.customer_gstin)?.toUpperCase() ?? null,
    text(inv.seller_gstin)?.toUpperCase() ?? null,
    text(inv.place_of_supply), text(inv.payment_terms),
    text(inv.currency) ?? 'INR', text(inv.notes), text(inv.terms),
    paise(inv.subtotal), paise(inv.discount_amount), paise(inv.tax_amount), paise(inv.total),
    paise(inv.amount_paid), paise(inv.balance_due), paise(inv.amount_withheld),
    text(inv.created_at), text(inv.updated_at), at,
    rawOf(inv, ['items']),
  );

  if (inv.items) await mirrorInvoiceItems(orgId, inv.id, inv.items);
}

/**
 * Replace an invoice's mirrored lines with what the CRM currently says.
 *
 * DELETE-THEN-INSERT, not an upsert per line. The CRM's own update endpoint
 * deletes an invoice's lines and rewrites them, so a line id is not stable
 * across an edit over there — and more to the point, a line REMOVED in the CRM
 * has to disappear here. An upsert would leave it behind for ever, and the
 * mirror would state a subtotal nobody can reconstruct from its own lines.
 */
async function mirrorInvoiceItems(orgId: string, crmInvoiceId: string, items: CrmInvoiceItem[]) {
  const at = nowIso();
  await run('DELETE FROM crm_invoice_items WHERE org_id = ? AND crm_invoice_id = ?', orgId, crmInvoiceId);
  let seq = 0;
  for (const it of items) {
    await run(
      `INSERT INTO crm_invoice_items (
         org_id, crm_id, crm_invoice_id, sort_order, item_type, title, description,
         qty_milli, rate, amount, hsn_sac, fetched_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (org_id, crm_id) DO UPDATE SET
         crm_invoice_id = excluded.crm_invoice_id,
         sort_order = excluded.sort_order, item_type = excluded.item_type,
         title = excluded.title, description = excluded.description,
         qty_milli = excluded.qty_milli, rate = excluded.rate, amount = excluded.amount,
         hsn_sac = excluded.hsn_sac, fetched_at = excluded.fetched_at`,
      orgId,
      // A line the CRM gave no id to still has to be a row. The invoice id and
      // the ordinal identify it as well as anything can, and leaving it out
      // would mean a mirrored invoice whose lines do not add up to its own
      // subtotal — which is the one inconsistency this table exists to prevent.
      text(it.id) ?? `${crmInvoiceId}:${seq}`,
      crmInvoiceId,
      Number.isFinite(Number(it.sort_order)) ? Number(it.sort_order) : seq,
      text(it.item_type) ?? 'other', text(it.title), text(it.description),
      milli(it.qty), paise(it.rate), paise(it.amount), text(it.hsn_sac), at,
    );
    seq++;
  }
}

/**
 * Write the receipts taken against one invoice.
 *
 * `issueDate` decides `is_advance`, and that decision is MADE HERE rather than
 * left to the posting side. Money that arrived before the invoice was raised is
 * an advance: section 13(2) of the CGST Act fixes the time of supply of a
 * service at the earlier of the invoice or the payment, so it is a liability in
 * the month it landed, carrying output GST backed out of it, on Customer
 * Advances rather than on receivables. Money that arrived on or after the
 * invoice settles the receivable.
 *
 * The CRM calls both "a payment on an invoice" and draws no distinction, so
 * somebody has to. Writing it down at mirror time means the answer cannot drift
 * later when the invoice's own date is corrected — the advance was still an
 * advance when it was taken, and a return filed on it says so.
 */
export async function mirrorInvoicePayments(
  orgId: string, crmInvoiceId: string, issueDate: string | null, payments: CrmInvoicePayment[],
): Promise<void> {
  const at = nowIso();
  for (const p of payments) {
    const paidAt = dateOnly(p.paid_at);
    const isAdvance = Boolean(issueDate && paidAt && paidAt < issueDate);
    await run(
      `INSERT INTO crm_invoice_payments (
         org_id, crm_id, crm_invoice_id, amount, paid_at, method, reference_no, note,
         is_advance, crm_created_at, fetched_at, raw
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (org_id, crm_id) DO UPDATE SET
         crm_invoice_id = excluded.crm_invoice_id,
         amount = excluded.amount, paid_at = excluded.paid_at,
         method = excluded.method, reference_no = excluded.reference_no,
         note = excluded.note, is_advance = excluded.is_advance,
         crm_created_at = excluded.crm_created_at, fetched_at = excluded.fetched_at,
         raw = excluded.raw`,
      orgId, p.id, crmInvoiceId, paise(p.amount), paidAt,
      text(p.method), text(p.reference_no), text(p.note),
      isAdvance ? 1 : 0, text(p.created_at), at, rawOf(p),
    );
  }
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

/**
 * Snapshot the catalogue.
 *
 * NOT a replacement for reading it live. A package re-priced this morning has
 * to reach this afternoon's invoice, so the screens ask the CRM first. This is
 * the fallback for when it does not answer — and the thing that lets a GST rate
 * be chosen for a package (`crm_package_tax`) show the package's NAME rather
 * than a bare id after it has been removed from the catalogue.
 *
 * A package deleted in the CRM is LEFT HERE rather than cleared, deliberately.
 * An invoice already raised under it keeps the rate and the price it was raised
 * at — a document line's figures are snapshotted onto the line — and deleting
 * the snapshot would leave that invoice describing a package nothing can name.
 */
export async function mirrorPackages(orgId: string, packages: CrmPackage[]): Promise<void> {
  const at = nowIso();
  for (const p of packages) {
    await run(
      `INSERT INTO crm_packages (
         org_id, crm_id, package_name, package_number, package_code, slug,
         price, currency, days, nights, destinations, is_visible,
         crm_updated_at, fetched_at, raw
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (org_id, crm_id) DO UPDATE SET
         package_name = excluded.package_name,
         package_number = excluded.package_number,
         package_code = excluded.package_code,
         slug = excluded.slug,
         price = excluded.price,
         currency = excluded.currency,
         days = excluded.days,
         nights = excluded.nights,
         destinations = excluded.destinations,
         is_visible = excluded.is_visible,
         crm_updated_at = excluded.crm_updated_at,
         fetched_at = excluded.fetched_at,
         raw = excluded.raw`,
      orgId, p.id, text(p.package_name), text(p.package_number), text(p.package_code),
      text(p.slug), paise(p.price), text(p.currency) ?? 'INR',
      Number(p.days ?? 0) || 0, Number(p.nights ?? 0) || 0,
      // Stored as JSON rather than a delimited string: a destination legitimately
      // contains a comma ("Paris, France"), and splitting on one later would
      // turn one place into two.
      JSON.stringify(p.destinations ?? []),
      p.is_visible === false ? 0 : 1,
      text(p.updated_at), at, rawOf(p),
    );
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface MirroredInvoice {
  crm_id: string;
  invoice_number: string | null;
  status: string | null;
  doc_type: string | null;
  lead_id: string | null;
  issue_date: string | null;
  due_date: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  customer_gstin: string | null;
  place_of_supply: string | null;
  currency: string;
  notes: string | null;
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
  amount_paid: number;
  balance_due: number;
  amount_withheld: number;
  fetched_at: string;
  document_id: string | null;
  imported_at: string | null;
  /** Joined from `documents` so one query answers "what became of this". */
  doc_number?: string | null;
  doc_state?: string | null;
  doc_total?: number | null;
}

const INVOICE_COLUMNS = `
  i.crm_id, i.invoice_number, i.status, i.doc_type, i.lead_id, i.issue_date, i.due_date,
  i.customer_name, i.customer_email, i.customer_phone, i.customer_address,
  i.customer_gstin, i.place_of_supply, i.currency, i.notes,
  i.subtotal, i.discount_amount, i.tax_amount, i.total,
  i.amount_paid, i.balance_due, i.amount_withheld,
  i.fetched_at, i.document_id, i.imported_at,
  d.number AS doc_number, d.state AS doc_state, d.total AS doc_total`;

/**
 * Every mirrored invoice, newest first, with what it became in the books.
 *
 * LEFT JOIN, not an inner one: the rows that matter most on the import screen
 * are precisely the ones with no document behind them yet.
 */
export async function mirroredInvoices(orgId: string, opts: { imported?: boolean } = {}) {
  const where = opts.imported === true ? 'AND i.document_id IS NOT NULL'
    : opts.imported === false ? 'AND i.document_id IS NULL'
      : '';
  return await all<MirroredInvoice>(
    `SELECT ${INVOICE_COLUMNS}
       FROM crm_invoices i
       LEFT JOIN documents d ON d.id = i.document_id AND d.org_id = i.org_id
      WHERE i.org_id = ? ${where}
      ORDER BY i.issue_date DESC NULLS LAST, i.invoice_number DESC`,
    orgId,
  );
}

export async function mirroredInvoice(orgId: string, crmId: string): Promise<MirroredInvoice | null> {
  return await one<MirroredInvoice>(
    `SELECT ${INVOICE_COLUMNS}
       FROM crm_invoices i
       LEFT JOIN documents d ON d.id = i.document_id AND d.org_id = i.org_id
      WHERE i.org_id = ? AND i.crm_id = ?`,
    orgId, crmId,
  );
}

/** The mirror row a ledger document came from, for the provenance panel. */
export async function mirroredInvoiceOfDocument(orgId: string, docId: string): Promise<MirroredInvoice | null> {
  return await one<MirroredInvoice>(
    `SELECT ${INVOICE_COLUMNS}
       FROM crm_invoices i
       LEFT JOIN documents d ON d.id = i.document_id AND d.org_id = i.org_id
      WHERE i.org_id = ? AND i.document_id = ?`,
    orgId, docId,
  );
}

export interface MirroredItem {
  crm_id: string;
  sort_order: number;
  item_type: string | null;
  title: string | null;
  description: string | null;
  qty_milli: number;
  rate: number;
  amount: number;
  hsn_sac: string | null;
}

export async function mirroredItems(orgId: string, crmInvoiceId: string) {
  return await all<MirroredItem>(
    `SELECT crm_id, sort_order, item_type, title, description, qty_milli, rate, amount, hsn_sac
       FROM crm_invoice_items WHERE org_id = ? AND crm_invoice_id = ? ORDER BY sort_order`,
    orgId, crmInvoiceId,
  );
}

export interface MirroredPayment {
  crm_id: string;
  crm_invoice_id: string;
  amount: number;
  paid_at: string | null;
  method: string | null;
  reference_no: string | null;
  note: string | null;
  is_advance: number;
  payment_id: string | null;
  imported_at: string | null;
}

export async function mirroredPayments(orgId: string, crmInvoiceId: string) {
  return await all<MirroredPayment>(
    `SELECT crm_id, crm_invoice_id, amount, paid_at, method, reference_no, note,
            is_advance, payment_id, imported_at
       FROM crm_invoice_payments WHERE org_id = ? AND crm_invoice_id = ? ORDER BY paid_at`,
    orgId, crmInvoiceId,
  );
}

export interface MirroredPackage {
  crm_id: string;
  package_name: string | null;
  package_number: string | null;
  package_code: string | null;
  /** Paise, inclusive of the GST the agency sells it at. */
  price: number;
  currency: string;
  days: number;
  nights: number;
  destinations: string | null;
  is_visible: number;
  fetched_at: string;
}

export async function mirroredPackages(orgId: string) {
  return await all<MirroredPackage>(
    `SELECT crm_id, package_name, package_number, package_code, price, currency,
            days, nights, destinations, is_visible, fetched_at
       FROM crm_packages WHERE org_id = ? ORDER BY package_name`,
    orgId,
  );
}

/** When the catalogue snapshot was last refreshed, for a screen that is using it. */
export async function packagesFetchedAt(orgId: string): Promise<string | null> {
  return (await one<{ at: string | null }>(
    'SELECT MAX(fetched_at) AS at FROM crm_packages WHERE org_id = ?', orgId,
  ))?.at ?? null;
}

// ---------------------------------------------------------------------------
// The link back to the books
// ---------------------------------------------------------------------------

/**
 * Record that this CRM invoice has become that ledger document.
 *
 * `WHERE document_id IS NULL` is the idempotence guard, and it belongs in the
 * statement rather than in the caller. Two imports racing — a scheduled one and
 * an accountant pressing the button — would otherwise both see a free invoice,
 * both create a document, and the second would overwrite the first's link:
 * leaving one document in the books that nothing points at, counted in the
 * trial balance, invisible to every screen that reads this table. The UPDATE
 * returning no row is how the loser finds out it lost.
 */
export async function markInvoiceImported(
  orgId: string, crmId: string, documentId: string,
): Promise<boolean> {
  const rows = await all<{ crm_id: string }>(
    `UPDATE crm_invoices SET document_id = ?, imported_at = ?
      WHERE org_id = ? AND crm_id = ? AND document_id IS NULL
      RETURNING crm_id`,
    documentId, nowIso(), orgId, crmId,
  );
  return rows.length > 0;
}

export async function markPaymentImported(
  orgId: string, crmId: string, paymentId: string,
): Promise<boolean> {
  const rows = await all<{ crm_id: string }>(
    `UPDATE crm_invoice_payments SET payment_id = ?, imported_at = ?
      WHERE org_id = ? AND crm_id = ? AND payment_id IS NULL
      RETURNING crm_id`,
    paymentId, nowIso(), orgId, crmId,
  );
  return rows.length > 0;
}

/**
 * Forget which mirrored records became which ledger records.
 *
 * NOT an undo. The documents and payments the earlier import created are still
 * in the books and still will be afterwards — a posted entry is never deleted
 * in this system. What this does is let the importer run again ALONGSIDE them,
 * which is a deliberate act on books somebody intends to rebuild, and the
 * screen offering it says so in those words.
 */
export async function forgetMirrorImports(orgId: string): Promise<void> {
  await run('UPDATE crm_invoices SET document_id = NULL, imported_at = NULL WHERE org_id = ?', orgId);
  await run('UPDATE crm_invoice_payments SET payment_id = NULL, imported_at = NULL WHERE org_id = ?', orgId);
}

/** Counts for the import screen's tiles. */
export async function mirrorCounts(orgId: string) {
  return (await one<{
    invoices: number; imported: number; payments: number; paid_imported: number; packages: number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM crm_invoices WHERE org_id = ?) AS invoices,
       (SELECT COUNT(*) FROM crm_invoices WHERE org_id = ? AND document_id IS NOT NULL) AS imported,
       (SELECT COUNT(*) FROM crm_invoice_payments WHERE org_id = ?) AS payments,
       (SELECT COUNT(*) FROM crm_invoice_payments WHERE org_id = ? AND payment_id IS NOT NULL) AS paid_imported,
       (SELECT COUNT(*) FROM crm_packages WHERE org_id = ?) AS packages`,
    orgId, orgId, orgId, orgId, orgId,
  ))!;
}
