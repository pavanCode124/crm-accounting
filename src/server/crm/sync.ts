import 'server-only';
import { all, run, tx } from '../db';
import { toMinor } from '@/lib/money';
import { isoDate } from '@/lib/accounting';
import { crmGet, rows, type CrmSession } from './client';
import { session, link, linkedLocalId, recordSync } from './connection';
import { upsertPartner, createBooking, listAccounts, listJournals } from '../accounting/masters';
import { createDocument } from '../accounting/documents';
import { createPayment } from '../accounting/payments';
import { audit } from '../accounting/audit';
import type { Actor } from '../accounting/engine';

/**
 * TripzoCRM → the accountant's in-tray. NOT → the ledger.
 *
 * -------------------------------------------------------------------------
 * THE RULE THIS FILE IS BUILT AROUND
 * -------------------------------------------------------------------------
 * NOTHING HERE POSTS. A sync writes drafts and master data, and stops. Every
 * imported invoice and every imported receipt lands in Review & Post, where a
 * chartered accountant opens it, checks the account, the tax and the trip it
 * is tagged to, and presses Post — the same button, running the same service,
 * as for an invoice they typed themselves.
 *
 * It used to post. The argument for it was decent: the CRM is the agency's own
 * system, the numbers are already agreed with the customer, and re-keying two
 * hundred invoices is a week nobody has. The argument against it won, and it
 * is the one that matters in a ledger: the CA signs the books. A posting that
 * appeared because a sales executive changed a status in another application
 * is a posting nobody chose, in an entry nobody read, and the first time
 * anyone examines it is when the GST return will not tie. A draft costs one
 * click per document and buys the thing the whole product is for — every
 * figure in these books was put there by a person who looked at it.
 *
 * What the sync still does, and does well: the typing. Customer, supplier,
 * trip, dates, line descriptions, amounts, currency and the link back to the
 * CRM record are all filled in. The accountant reviews rather than re-keys.
 *
 * Every record is still pushed through the SAME service the UI uses —
 * `createDocument`, `createPayment` with `post: false`, `createBooking` — so
 * an imported invoice is the identical shape as a hand-typed one, and there is
 * no second, quieter path that could have its own idea of which account a
 * receivable lands on.
 *
 * -------------------------------------------------------------------------
 * IDEMPOTENCE, AND WHY IT MATTERS MORE HERE THAN USUAL
 * -------------------------------------------------------------------------
 * Syncing twice must not import twice. In an ordinary CRUD app a duplicate is
 * an untidy row; in double-entry it is a doubled posting — revenue, receivable
 * and output tax all counted twice, and a P&L that is simply wrong. Every
 * record is therefore looked up in `crm_links` before it is created, and a
 * record that has already been imported is SKIPPED rather than updated: once
 * posted a document is immutable by design (plan section 44), so the correct
 * response to "this invoice changed in the CRM" is to edit the draft if it is
 * still a draft, and to raise a credit note if it is not — in both cases a
 * human decision, not a silent rewrite by a sync job.
 *
 * -------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT IMPORTED
 * -------------------------------------------------------------------------
 * Draft and cancelled CRM invoices. A draft is a proposal — the CRM's own
 * wording — and proposals do not belong in a ledger. They are counted in the
 * report as skipped so the number is visible rather than mysterious.
 */

// --------------------------------------------------------------------------
// The CRM shapes this module reads. Only the fields used are typed; the real
// responses carry considerably more.
// --------------------------------------------------------------------------

interface CrmOrg { id: string; name: string; extended_name?: string | null; email?: string | null; phone?: string | null; }

interface CrmLead {
  id: string; first_name: string; last_name: string | null;
  email: string | null; mobile_number: string | null;
  city_country: string | null; customer_type?: string | null;
  travel_date?: string | null; total_amount?: number | null;
  package_number?: string | null; trip_type?: string | null;
  stage?: string | null; lead_status?: string;
  adults?: number | null; children?: number | null;
}

interface CrmSupplier {
  id: string; company_name: string; alias_name: string | null;
  gstin: string | null; billing_address: string | null;
  city: string | null; country: string | null;
}

interface CrmInvoice {
  id: string; invoice_number: string; status: string;
  issue_date: string; due_date: string | null;
  customer_name: string; customer_email: string | null; customer_phone: string | null;
  customer_address: string | null; currency: string;
  lead_id: string | null; notes: string | null;
  subtotal: number; discount_amount: number; tax_amount: number; total: number;
  doc_type?: string | null;
  items?: CrmInvoiceItem[];
}

interface CrmInvoiceItem {
  id: string; title: string; description: string | null;
  qty: number; rate: number; amount: number; item_type: string;
}

interface CrmPayment {
  id: string; invoice_id: string; amount: number; note: string | null; paid_at: string;
}

export interface SyncReport {
  org: string;
  customers: number;
  suppliers: number;
  bookings: number;
  invoices: number;
  payments: number;
  skipped: number;
  warnings: string[];
}

/**
 * Pull everything and post it.
 *
 * NOT one big transaction. A sync touches hundreds of documents across several
 * network calls, and wrapping the lot would mean a single unmappable invoice
 * at record 400 throwing away 399 correct imports — and holding a write lock
 * on the database for the whole round trip. Each record is atomic on its own
 * (the services see to that), and the identity map makes re-running the sync
 * after a failure resume rather than repeat.
 */
export async function syncFromCrm(orgId: string, actor: Actor = {}): Promise<SyncReport> {
  const s = await session(orgId);
  const report: SyncReport = {
    org: '', customers: 0, suppliers: 0, bookings: 0,
    invoices: 0, payments: 0, skipped: 0, warnings: [],
  };

  const crmOrg = await syncOrg(orgId, s, report);
  await syncSuppliers(orgId, s, report, actor);
  const leadPartner = await syncLeads(orgId, s, report, actor);
  await syncInvoices(orgId, s, report, actor, leadPartner);

  const summary =
    `${report.customers} customer(s), ${report.suppliers} supplier(s), ${report.bookings} booking(s), ` +
    `${report.invoices} invoice(s), ${report.payments} payment(s), ${report.skipped} skipped`;
  await recordSync(orgId, summary, crmOrg ? { id: crmOrg.id, name: crmOrg.name } : undefined);
  await audit(orgId, actor, 'synced', 'crm', orgId, `CRM sync — ${summary}`);
  return report;
}

// --------------------------------------------------------------------------
// The agency itself
// --------------------------------------------------------------------------

/**
 * Rename the local organisation to whatever the CRM calls it.
 *
 * This is the line that removes "Wander Travels" as a hardcoded string. The
 * name on the masthead, on every report header and in the page subtitle is now
 * read from `organizations.name`, and this is what writes it.
 */
async function syncOrg(orgId: string, s: CrmSession, report: SyncReport): Promise<CrmOrg | null> {
  try {
    const body = await crmGet<CrmOrg | { organization?: CrmOrg }>(s, '/api/organizations/mine');
    const org = (body as { organization?: CrmOrg })?.organization ?? (body as CrmOrg);
    if (!org?.name) return null;
    await run('UPDATE organizations SET name = ? WHERE id = ?', org.extended_name || org.name, orgId);
    report.org = org.extended_name || org.name;
    return org;
  } catch (e) {
    report.warnings.push(`Organisation: ${msgOf(e)}`);
    return null;
  }
}

// --------------------------------------------------------------------------
// Partners
// --------------------------------------------------------------------------

async function syncSuppliers(orgId: string, s: CrmSession, report: SyncReport, actor: Actor) {
  let list: CrmSupplier[];
  try {
    list = rows<CrmSupplier>(await crmGet(s, '/api/suppliers'), 'suppliers');
  } catch (e) {
    report.warnings.push(`Suppliers: ${msgOf(e)}`);
    return;
  }

  for (const sup of list) {
    const existing = await linkedLocalId(orgId, 'partner', sup.id);
    const address = [sup.billing_address, sup.city, sup.country].filter(Boolean).join(', ') || null;
    const localId = await upsertPartner(orgId, {
      id: existing ?? undefined,
      name: sup.company_name || sup.alias_name || 'Unnamed supplier',
      isCustomer: false,
      isSupplier: true,
      partnerType: 'b2b',
      gstin: sup.gstin,
      address,
    }, actor);
    await link(orgId, 'partner', sup.id, localId);
    if (!existing) report.suppliers++;
  }
}

/**
 * CRM leads become customers, and the ones that reached a trip become bookings.
 *
 * Returns a CRM-lead-id → local-partner-id map, because the invoice importer
 * needs it: a CRM invoice names its customer by `lead_id` where it can, and
 * matching on a name string is how two "Rahul Mehta"s become one partner who
 * owes the sum of both their trips.
 */
async function syncLeads(orgId: string, s: CrmSession, report: SyncReport, actor: Actor) {
  const byLead = new Map<string, string>();
  let list: CrmLead[];
  try {
    list = rows<CrmLead>(await crmGet(s, '/api/leads'), 'leads');
  } catch (e) {
    report.warnings.push(`Leads: ${msgOf(e)}`);
    return byLead;
  }

  for (const lead of list) {
    const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim() || 'Unnamed lead';
    const existing = await linkedLocalId(orgId, 'partner', lead.id);
    const partnerId = await upsertPartner(orgId, {
      id: existing ?? undefined,
      name,
      isCustomer: true,
      isSupplier: false,
      partnerType: (lead.customer_type ?? 'b2c').toLowerCase().includes('b2b') ? 'b2b' : 'b2c',
      email: lead.email,
      phone: lead.mobile_number,
      address: lead.city_country,
    }, actor);
    await link(orgId, 'partner', lead.id, partnerId);
    byLead.set(lead.id, partnerId);
    if (!existing) report.customers++;

    // A lead becomes a BOOKING only once it has a trip attached. A lead with no
    // package and no travel date is an enquiry, and an enquiry has no costs to
    // tag — creating an analytic account for it would leave the trip
    // profitability report full of empty rows.
    const ref = lead.package_number?.trim();
    if (!ref) continue;
    if (await linkedLocalId(orgId, 'booking', lead.id)) continue;
    try {
      const bookingId = await createBooking(orgId, {
        ref,
        title: `${lead.trip_type ?? 'Trip'} — ${name}`,
        partnerId,
        customerName: name,
        destination: lead.city_country ?? null,
        pax: (lead.adults ?? 0) + (lead.children ?? 0) || 1,
        startDate: dateOnly(lead.travel_date),
        sellValue: toMinorSafe(lead.total_amount),
        status: 'confirmed',
      }, actor);
      await link(orgId, 'booking', lead.id, bookingId);
      report.bookings++;
    } catch (e) {
      // Almost always a duplicate ref, which is a CRM data question rather than
      // something this sync can resolve. Counted and named, never guessed at.
      report.warnings.push(`Booking ${ref}: ${msgOf(e)}`);
    }
  }
  return byLead;
}

// --------------------------------------------------------------------------
// Invoices and their payments
// --------------------------------------------------------------------------

async function syncInvoices(
  orgId: string, s: CrmSession, report: SyncReport, actor: Actor,
  leadPartner: Map<string, string>,
) {
  let list: CrmInvoice[];
  try {
    list = rows<CrmInvoice>(await crmGet(s, '/api/invoices'), 'invoices');
  } catch (e) {
    report.warnings.push(`Invoices: ${msgOf(e)}`);
    return;
  }

  const journal = await pickJournal(orgId, 'sale');
  const revenue = await pickAccount(orgId, ['income', 'income_other']);
  if (!journal || !revenue) {
    report.warnings.push('No sales journal or revenue account configured — invoices were not imported.');
    return;
  }

  for (const inv of list) {
    if (await linkedLocalId(orgId, 'document', inv.id)) { report.skipped++; continue; }
    // A draft is a proposal and a cancelled invoice never happened. Neither is
    // a fact the ledger should carry.
    if (inv.status === 'draft' || inv.status === 'cancelled') { report.skipped++; continue; }

    const partnerId = await resolvePartner(orgId, inv, leadPartner, actor);
    if (!partnerId) { report.warnings.push(`Invoice ${inv.invoice_number}: no customer.`); continue; }

    // The CRM stores a whole-currency decimal; the ledger stores minor units as
    // an integer. Every figure crosses that boundary exactly once, here.
    const items = inv.items?.length
      ? inv.items
      : [{ id: inv.id, title: `Invoice ${inv.invoice_number}`, description: null,
           qty: 1, rate: Number(inv.subtotal ?? inv.total ?? 0),
           amount: Number(inv.subtotal ?? inv.total ?? 0), item_type: 'other' }];

    try {
      const docId = await createDocument({
        orgId,
        docType: inv.doc_type === 'refund' ? 'out_refund' : 'out_invoice',
        partnerId,
        journalId: journal,
        docDate: dateOnly(inv.issue_date) ?? isoDate(),
        dueDate: dateOnly(inv.due_date),
        currency: inv.currency || 'INR',
        bookingId: inv.lead_id ? await linkedLocalId(orgId, 'booking', inv.lead_id) : null,
        note: [inv.notes, `Imported from TripzoCRM invoice ${inv.invoice_number}`]
          .filter(Boolean).join(' · '),
        lines: items.map((it) => ({
          name: [it.title, it.description].filter(Boolean).join(' — '),
          qtyMilli: Math.round(Number(it.qty ?? 1) * 1000) || 1000,
          unitPrice: toMinorSafe(it.rate),
          accountId: revenue,
        })),
      }, actor);

      // NOT posted. It is a draft in Review & Post until an accountant says so.
      await link(orgId, 'document', inv.id, docId);
      report.invoices++;

      await syncPayments(orgId, s, report, actor, inv, partnerId);
    } catch (e) {
      report.warnings.push(`Invoice ${inv.invoice_number}: ${msgOf(e)}`);
    }
  }
}

async function syncPayments(
  orgId: string, s: CrmSession, report: SyncReport, actor: Actor,
  inv: CrmInvoice, partnerId: string,
) {
  let list: CrmPayment[];
  try {
    list = rows<CrmPayment>(await crmGet(s, `/api/invoices/${inv.id}/payments`), 'payments');
  } catch {
    // An invoice with no payments route, or none recorded. Not a warning — it
    // is the ordinary case for an unpaid invoice.
    return;
  }

  const journal = await pickJournal(orgId, 'bank');
  if (!journal) { report.warnings.push('No bank journal — payments were not imported.'); return; }

  for (const p of list) {
    if (await linkedLocalId(orgId, 'payment', p.id)) { report.skipped++; continue; }
    const amount = toMinorSafe(p.amount);
    if (amount <= 0) continue;
    try {
      const paymentId = await createPayment({
        orgId,
        direction: 'inbound',
        partnerId,
        journalId: journal,
        payDate: dateOnly(p.paid_at) ?? isoDate(),
        amount,
        method: 'bank',
        reference: `CRM ${p.id.slice(0, 8)}`,
        /*
         * The invoice it belongs to is written into the note rather than into
         * an allocation, because the allocation cannot be made yet: the
         * invoice is a draft too, and settling a document that has not been
         * posted is meaningless. Review & Post handles the pair in the order
         * that works — post the invoice, post the receipt, and the receipt's
         * screen then offers this invoice as the obvious thing to settle.
         */
        note: [p.note, `CRM receipt against invoice ${inv.invoice_number}`]
          .filter(Boolean).join(' · '),
        post: false,
      }, actor);
      await link(orgId, 'payment', p.id, paymentId);
      report.payments++;
    } catch (e) {
      report.warnings.push(`Payment on ${inv.invoice_number}: ${msgOf(e)}`);
    }
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Which partner an invoice belongs to.
 *
 * By CRM lead id where there is one, because that is an identity rather than a
 * label. Falling back to an exact name match, and creating the partner only as
 * a last resort — an invoice whose customer does not exist yet is real enough
 * to keep, and refusing it would mean losing revenue from the books over a
 * missing contact record.
 */
async function resolvePartner(
  orgId: string, inv: CrmInvoice, leadPartner: Map<string, string>, actor: Actor,
): Promise<string | null> {
  if (inv.lead_id) {
    const byLead = leadPartner.get(inv.lead_id) ?? await linkedLocalId(orgId, 'partner', inv.lead_id);
    if (byLead) return byLead;
  }
  const name = inv.customer_name?.trim();
  if (!name) return null;

  const match = (await all<{ id: string }>(
    'SELECT id FROM partners WHERE org_id=? AND is_customer=1 AND LOWER(name)=LOWER(?) LIMIT 1',
    orgId, name,
  ))[0];
  if (match) return match.id;

  return await upsertPartner(orgId, {
    name,
    isCustomer: true,
    isSupplier: false,
    email: inv.customer_email,
    phone: inv.customer_phone,
    address: inv.customer_address,
  }, actor);
}

async function pickJournal(orgId: string, type: string): Promise<string | null> {
  return (await listJournals(orgId, type))[0]?.id ?? null;
}

async function pickAccount(orgId: string, kinds: string[]): Promise<string | null> {
  return (await listAccounts(orgId, { kinds }))[0]?.id ?? null;
}

/** A CRM timestamp is an ISO datetime; every date column here is a plain date. */
function dateOnly(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Whole-currency decimal → minor units, tolerating nulls and junk. */
function toMinorSafe(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? toMinor(String(n)) : 0;
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : 'unknown error';
}

/**
 * Clear every record a previous sync created, so the next one starts clean.
 *
 * Only reachable from the "Reset imported data" button, and deliberately blunt:
 * it drops the identity map, which means the next sync re-imports everything.
 * It does NOT delete the postings those imports made — a posted entry is never
 * deleted in this system — so it is a "let me import it again alongside" tool,
 * not an undo. The screen says so in those words.
 */
export async function forgetSyncLinks(orgId: string) {
  await tx(async () => { await run('DELETE FROM crm_links WHERE org_id = ?', orgId); });
}
