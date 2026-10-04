import 'server-only';
import { crmFetch, rows, describeShape, CrmError, CRM_BACKEND_URL } from './client';
import { crmSession } from './identity';

/**
 * INVOICES, READ FROM TRIPZOCRM. NEVER WRITTEN BACK.
 *
 * -------------------------------------------------------------------------
 * WHICH SYSTEM OWNS WHAT, STATED ONCE
 * -------------------------------------------------------------------------
 * TRIPZOCRM OWNS THE SALE. An agent raises the invoice on their phone, takes
 * the advance, and the customer's copy is generated there. That record is the
 * commercial truth and this app does not get a vote on it.
 *
 * THIS LEDGER OWNS THE BOOKS. A CRM invoice knows what was sold and for how
 * much; it has no journal, no revenue account per line, no CGST/SGST split and
 * no HSN. Those are the bookkeeping facts, they are decided here, and they are
 * stored here — in this app's own Postgres, which is the only database it
 * writes to.
 *
 * So the traffic is one-way. This module READS the CRM; `mirror.ts` writes
 * what it read into this ledger's database; `import.ts` turns each mirrored
 * invoice into a draft document the accountant completes and posts. Nothing in
 * this app sends a byte of change back to the CRM, and `crmFetch` has no way
 * to express one.
 *
 * -------------------------------------------------------------------------
 * THE API, NOT THE TABLE, EVEN THOUGH BOTH ARE REACHABLE
 * -------------------------------------------------------------------------
 * The CRM's tables sit in a Postgres this app could open a connection to. Going
 * through /api/* instead is deliberate: organization scoping, row-level access
 * and admin impersonation are decided by the backend, and a SELECT that goes
 * round it has to re-implement all three correctly, for ever, as they change.
 * Every call here carries the SIGNED-IN PERSON's token, so this app sees
 * exactly what that person sees on their phone — for the same reason, decided
 * in the same place.
 *
 * Ported from tripzo-crm-mobile/src/lib/invoices.ts so the two clients cannot
 * drift in their reading of one payload.
 *
 * -------------------------------------------------------------------------
 * UNITS. THIS IS THE ONE THING TO GET RIGHT.
 * -------------------------------------------------------------------------
 * The CRM answers in WHOLE RUPEES (`subtotal: 55000` is ₹55,000). This app
 * stores and formats MINOR UNITS throughout — `fmt`, `Money`, `StatTile` and
 * every ledger figure are paise. The conversion happens exactly once, at this
 * boundary, in `toMinor`, and nowhere else. A figure that crosses it
 * twice is off by a factor of a hundred, which on an invoice is the difference
 * between ₹550 and ₹55,000.
 */

// ---------------------------------------------------------------------------
// Shapes — confirmed against the live backend, not inferred from the mobile app
// ---------------------------------------------------------------------------
// The mobile app's `Invoice` is a SUBSET: it never needed the GST block,
// because a phone does not raise a tax invoice. This app does, so the columns
// the backend actually carries are typed here in full. The ones that matter and
// that the mobile type omits entirely:
//
//   seller_gstin, customer_gstin, place_of_supply   the GST identity of the supply
//   items[].hsn_sac                                 Rule 46's mandatory classification
//   amount_withheld                                 TDS the customer deducted
//   doc_type, refund_of_invoice_id                  a credit note and what it credits
//   payment_methods                                 what the invoice offers to be paid by
//
// They are already in the CRM's own schema. Nothing new had to be added there
// for the finance app to show a compliant invoice — it simply was not reading
// them.

export const CRM_INVOICE_STATUSES = ['draft', 'sent', 'paid', 'cancelled'] as const;
export type CrmInvoiceStatus = (typeof CRM_INVOICE_STATUSES)[number];

/** The line kinds the CRM's own form offers, same order. */
export const CRM_ITEM_TYPES = ['package', 'hotel', 'flight', 'transport', 'activity', 'other'] as const;

export interface CrmInvoiceItem {
  id: string;
  invoice_id?: string;
  sort_order: number;
  item_type: string;
  title: string;
  description: string | null;
  /** Whole rupees, as the CRM stores them. */
  qty: number;
  rate: number;
  amount: number;
  hsn_sac: string | null;
}

export interface CrmInvoice {
  id: string;
  organization_id?: string;
  created_by?: string;
  lead_id: string | null;
  invoice_number: string;
  status: CrmInvoiceStatus;
  issue_date: string;
  due_date: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  business_address: string | null;
  currency: string;
  notes: string | null;
  terms: string | null;
  /** Whole rupees. Converted at the boundary — see `toMinor`. */
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
  amount_paid: number;
  balance_due: number;
  amount_withheld: number;
  created_at: string;
  updated_at?: string;
  /** 'invoice' or 'refund'. A refund is a credit note, not a bill owed on. */
  doc_type: string | null;
  refund_of_invoice_id: string | null;
  // --- the GST block -------------------------------------------------------
  seller_gstin: string | null;
  customer_gstin: string | null;
  place_of_supply: string | null;
  ship_to_address: string | null;
  payment_terms: string | null;
  payment_methods?: string[] | null;
  items?: CrmInvoiceItem[];
}

export interface CrmInvoicePayment {
  id: string;
  invoice_id: string;
  amount: number;
  note: string | null;
  /** A DATE, not a timestamp — the backend stores "2026-09-27". */
  paid_at: string;
  method: string | null;
  reference_no: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * CRM rupees to ledger paise.
 *
 * `Number(null)` is 0 and `Number(undefined)` is NaN, and both reach a money
 * formatter as something — zero in the first case, "NaN" or a silent 0 in the
 * second. Neither belongs on an invoice, so the coercion is done once, here,
 * and anything that is not a finite number becomes a clean zero.
 */
export function toMinor(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface LiveResult<T> {
  rows: T[];
  error: string | null;
  connected: boolean;
  /** Only when nothing came back: what was called and what shape answered. */
  probe: { path: string; shape: string } | null;
}

async function session() {
  const s = await crmSession();
  if (!s) throw new CrmError(401, 'Not signed in to TripzoCRM.');
  return s;
}

/**
 * Every invoice the signed-in person can see.
 *
 * `/api/invoices` answers a BARE ARRAY — confirmed against the live backend,
 * not assumed. `rows` tolerates the wrapped shapes too, because the backend is
 * not consistent across routes and a list that silently reads as empty is the
 * worst way for this to fail.
 */
export async function listInvoices(): Promise<LiveResult<CrmInvoice>> {
  const s = await crmSession();
  if (!s) return { rows: [], error: null, connected: false, probe: null };
  const path = '/api/invoices';
  try {
    const body = await crmFetch<unknown>(s, path);
    const found = rows<CrmInvoice>(body, 'invoices');
    return {
      rows: found,
      error: null,
      connected: true,
      probe: found.length ? null : { path: `${CRM_BACKEND_URL}${path}`, shape: describeShape(body) },
    };
  } catch (e) {
    return {
      rows: [],
      error: e instanceof CrmError ? `${e.message} (HTTP ${e.status})` : 'TripzoCRM could not be reached.',
      connected: true,
      probe: { path: `${CRM_BACKEND_URL}${path}`, shape: 'the request failed' },
    };
  }
}

/**
 * One invoice, with its lines.
 *
 * THE DETAIL ROUTE ANSWERS `{ invoice, items }` AND THE LIST ROUTE ANSWERS THE
 * ROW ITSELF. Handing the wrapper back as the invoice is what made every figure
 * on the mobile detail screen read "INR 0" — subtotal, total and balance were
 * all `undefined`, which a money formatter renders as zero rather than
 * refusing, while the line items still appeared because `items` happens to sit
 * on the wrapper too. So the screen showed real charges under a total of
 * nothing. Unwrapped here, once, for every caller.
 */
export async function getInvoice(id: string): Promise<CrmInvoice | null> {
  const s = await session();
  const body = await crmFetch<{ invoice?: CrmInvoice; items?: CrmInvoiceItem[] } | CrmInvoice>(
    s, `/api/invoices/${encodeURIComponent(id)}`,
  );
  const wrapped = body as { invoice?: CrmInvoice; items?: CrmInvoiceItem[] };
  const invoice = wrapped?.invoice
    ? { ...wrapped.invoice, items: wrapped.items ?? wrapped.invoice.items ?? [] }
    : (body as CrmInvoice);
  return invoice?.id ? invoice : null;
}

export async function invoicePayments(id: string): Promise<CrmInvoicePayment[]> {
  const s = await session();
  return rows<CrmInvoicePayment>(
    await crmFetch(s, `/api/invoices/${encodeURIComponent(id)}/payments`), 'payments',
  );
}

// ---------------------------------------------------------------------------
// THERE ARE NO WRITES, AND THAT IS THE POINT OF THIS MODULE
// ---------------------------------------------------------------------------
// This file used to carry `createInvoice`, `updateInvoice`, `deleteInvoice` and
// `addInvoicePayment`, and the invoice screens wrote straight through them into
// TripzoCRM. They are gone.
//
// THE ARGUMENT FOR THEM was that there is only one invoice and it belongs to
// the CRM, so an edit here should change the record everybody sees. It is a
// coherent position and it is not the one this product takes, because it makes
// an ACCOUNTING app a writer to an agency's OPERATIONAL system. A mapping bug,
// a double-submitted form or a mis-scoped token then does not produce a wrong
// report — it produces a wrong invoice, in the system the customer's copy is
// generated from, and no amount of care in the ledger can undo that.
//
// SO THE DIRECTION IS FIXED: TripzoCRM is fetched and never written.
//   * `mirror.ts` writes every fetched invoice, line and receipt into THIS
//     ledger's own Postgres, so nothing read is lost and the books do not
//     depend on an HTTP call succeeding.
//   * `import.ts` turns each mirrored invoice into a DRAFT ledger document,
//     where the accountant adds the journal, the revenue accounts, the tax
//     rows and the HSN codes the CRM has no concept of.
//   * Every later edit — and every posting — happens on that document, in this
//     database. The CRM is never told, because it never asked.
//
// `crmFetch` enforces this one level down: it has no method and no body
// parameter, so a write cannot be expressed here even by mistake.

// ---------------------------------------------------------------------------
// Derived readings
// ---------------------------------------------------------------------------

/**
 * The status to SHOW, which is not always the one stored.
 *
 * The backend recomputes `amount_paid` and `balance_due` after every payment
 * but leaves `status` where it was, so an invoice paid off in instalments stays
 * "sent" with a zero balance — drawn as SENT beside "Fully paid" and counted
 * among the unpaid. Anything not cancelled whose balance has reached zero on a
 * real total is paid, whatever the column says.
 *
 * Ported verbatim from the mobile app so the two clients never disagree about
 * one invoice.
 */
export function effectiveStatus(inv: CrmInvoice): CrmInvoiceStatus {
  if (inv.status === 'cancelled' || inv.status === 'paid') return inv.status;
  const total = Number(inv.total ?? 0);
  const balance = Number(inv.balance_due ?? 0);
  if (total > 0 && Number.isFinite(balance) && balance <= 0) return 'paid';
  return inv.status;
}

/**
 * What is still owed, never below zero.
 *
 * An invoice paid past its total — a second instalment recorded on top of a
 * full one — comes back with a NEGATIVE balance. Summed as-is that negative
 * SUBTRACTS from every other customer's debt, so the Outstanding figure on the
 * list quietly under-reports by the size of somebody's overpayment.
 */
export function outstanding(inv: CrmInvoice): number {
  const n = toMinor(inv.balance_due);
  return n > 0 && effectiveStatus(inv) !== 'cancelled' ? n : 0;
}

/**
 * An unpaid invoice past its due date.
 *
 * Compared by calendar DAY, not by timestamp: an invoice due today is not
 * overdue at 9am because it was issued at midnight.
 */
export function isOverdue(inv: CrmInvoice, today = new Date()): boolean {
  const status = effectiveStatus(inv);
  if (status === 'paid' || status === 'cancelled') return false;
  if (!inv.due_date) return false;
  const due = new Date(inv.due_date);
  if (Number.isNaN(due.getTime())) return false;
  due.setHours(23, 59, 59, 999);
  return due.getTime() < today.getTime();
}

/** Which chip colour this app's `Chip` should use for a CRM status. */
export const STATUS_CHIP: Record<string, string> = {
  draft: 'draft', sent: 'partial', paid: 'paid', cancelled: 'cancelled',
};
