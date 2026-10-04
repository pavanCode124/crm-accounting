import 'server-only';
import { all, one, run, tx } from '../db';
import { isoDate } from '@/lib/accounting';
import { crmGet, rows, CrmError, type CrmSession } from './client';
import { session as storedSession, link, linkedLocalId, recordSync } from './connection';
import { crmSession as visitorSession } from './identity';
import { upsertPartner, createBooking, listJournals } from '../accounting/masters';
import { createDocument, updateDocument, getDocument, type DocInput } from '../accounting/documents';
import { createPayment, settlePendingTargets } from '../accounting/payments';
import { audit } from '../accounting/audit';
import type { Actor } from '../accounting/engine';
import {
  loadMappingContext, resolveSaleTax, mapInvoiceLines, reconcileTotal,
  type MappingContext,
} from './invoiceMapping';
import {
  mirrorInvoice, mirrorInvoicePayments, mirrorPackages,
  mirroredInvoices, mirroredInvoice, mirroredItems, mirroredPayments,
  markInvoiceImported, markPaymentImported, forgetMirrorImports, dateOnly,
  type MirroredInvoice, type MirroredItem,
} from './mirror';
import type { CrmInvoice, CrmInvoicePayment } from './invoices';
import type { CrmPackage } from './live';

/**
 * TRIPZOCRM → THIS LEDGER. One direction, two stages, and nothing posts.
 *
 * ===========================================================================
 * THE THREE RULES THIS FILE IS BUILT AROUND
 * ===========================================================================
 *
 * 1. THE CRM IS NEVER WRITTEN TO. Not an invoice, not a receipt, not a status,
 *    not a flag saying "imported". This is an accounting system; the CRM is the
 *    agency's operational system, and a mapping bug here must not be able to
 *    alter the record a customer's invoice is generated from. Enforced one
 *    level down, structurally: `crmFetch` has no method and no body parameter,
 *    so a write cannot be expressed. Nothing in this file could send one if it
 *    tried.
 *
 * 2. EVERYTHING READ IS KEPT. The fetch stage mirrors each invoice, line,
 *    receipt and package into this database (`mirror.ts`) before any accounting
 *    judgement is applied — including the whole raw payload. A ledger cannot
 *    depend on an HTTP call succeeding, and a figure already filed in a return
 *    must not change because somebody edited a row in the CRM afterwards.
 *
 * 3. NOTHING POSTS. The import stage writes DRAFT documents and DRAFT receipts,
 *    and stops. Every one lands in Review & Post, where a person opens it,
 *    checks the account, the tax and the trip it is tagged to, and presses Post
 *    — the same button, running the same service, as for an invoice typed by
 *    hand.
 *
 *    It used to post, and the argument for it was decent: the numbers are
 *    already agreed with the customer and re-keying two hundred invoices is a
 *    week nobody has. The argument against won, because the CA signs the books.
 *    A posting that appeared because a sales executive changed a status in
 *    another application is a posting nobody chose, and the first time anyone
 *    looks at it is when the GST return will not tie.
 *
 * ===========================================================================
 * WHAT THE TWO STAGES DO, AND WHY THEY ARE SEPARATE
 * ===========================================================================
 *   FETCH    Read the CRM. Mirror it verbatim. Always safe to repeat — a row
 *            is simply overwritten with a fresher reading of the same record.
 *
 *   IMPORT   Read the MIRROR, not the CRM. Decide which revenue account each
 *            line belongs on, which tax row produced the tax amount, whether a
 *            payment is an advance or a receipt. Create draft documents and
 *            receipts. Must NOT repeat, and does not: `crm_invoices.document_id`
 *            is the guard, set in the same transaction as the document.
 *
 * The import stage reads the mirror rather than the live payload on purpose.
 * It means a re-import after a failure works on exactly the bytes the first
 * attempt saw, and that the accounting decisions can be re-run — after adding a
 * missing revenue account, say — without another round trip to a CRM whose rows
 * may have moved in the meantime.
 *
 * ===========================================================================
 * IDEMPOTENCE, WHICH MATTERS MORE HERE THAN IN ORDINARY SOFTWARE
 * ===========================================================================
 * In a CRUD app a duplicate is an untidy row. In double-entry it is a DOUBLED
 * POSTING — revenue, receivable and output tax all counted twice — in books
 * that still balance perfectly and are simply wrong. So an invoice already
 * imported is SKIPPED rather than updated: once posted a document is immutable
 * by design, and the right response to "this invoice changed in the CRM" is to
 * amend the draft if it is still a draft, or to raise a credit note if it is
 * not. Both are human decisions, not a silent rewrite by an import job.
 */

// --------------------------------------------------------------------------
// The CRM shapes this module reads. Only the fields used are typed; the real
// responses carry considerably more — and `mirror.ts` keeps all of it in `raw`.
// --------------------------------------------------------------------------

interface CrmOrg {
  id: string; name: string; extended_name?: string | null;
  email?: string | null; phone?: string | null;
}

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

export interface SyncReport {
  org: string;
  /** Which token the run used, which the screen reports so it is never a mystery. */
  via: 'saved connection' | 'your sign-in';
  customers: number;
  suppliers: number;
  bookings: number;
  /** Records copied into this database from the CRM. Always safe to repeat. */
  mirroredInvoices: number;
  mirroredPayments: number;
  mirroredPackages: number;
  /** Draft documents and receipts created in the books. Never repeated. */
  invoices: number;
  payments: number;
  /**
   * Receipts matched to the invoice TripzoCRM took them against, now that both
   * sides are posted. Not money created — money put where it already said it
   * was going. See `settleTargeted`.
   */
  settled: number;
  skipped: number;
  warnings: string[];
}

function emptyReport(via: SyncReport['via']): SyncReport {
  return {
    org: '', via, customers: 0, suppliers: 0, bookings: 0, settled: 0,
    mirroredInvoices: 0, mirroredPayments: 0, mirroredPackages: 0,
    invoices: 0, payments: 0, skipped: 0, warnings: [],
  };
}

// --------------------------------------------------------------------------
// Which token the run uses
// --------------------------------------------------------------------------

/**
 * The saved service connection if there is one, otherwise the visitor's own.
 *
 * -------------------------------------------------------------------------
 * WHY TWO, AND WHY THE SAVED ONE WINS
 * -------------------------------------------------------------------------
 * The saved connection (`crm_connection`) is a SERVICE identity: one token per
 * set of books, put there deliberately on Settings → CRM Sync, and the only
 * one that still works at 3am when nobody is watching. An unattended import
 * has to use it.
 *
 * The visitor's token is the cookie the signed-in accountant is already
 * carrying. It exists because the common case is a person who has just signed
 * in, can see their agency's invoices on the Invoices screen, and presses
 * Fetch — and telling them to go and configure a second credential first, for
 * the same account they are already authenticated as, is a setup step with no
 * purpose behind it.
 *
 * THE SAVED ONE IS PREFERRED where both exist, so a scheduled import and a
 * manual one behave identically rather than differing by who happened to press
 * the button. Either way the agency check below runs on whatever token was
 * used, and it is the control that actually matters.
 */
async function importSession(orgId: string): Promise<{ s: CrmSession; via: SyncReport['via'] }> {
  try {
    return { s: await storedSession(orgId), via: 'saved connection' };
  } catch (saved) {
    const visitor = await visitorSession();
    if (visitor) return { s: visitor, via: 'your sign-in' };
    throw saved;
  }
}

// --------------------------------------------------------------------------
// The run
// --------------------------------------------------------------------------

/**
 * Fetch from the CRM, mirror it, and draft what is not in the books yet.
 *
 * NOT one big transaction. A run touches hundreds of records across several
 * network calls, and wrapping the lot would mean one unmappable invoice at
 * record 400 throwing away 399 correct imports — while holding a write lock on
 * the database for the whole round trip. Each record is atomic on its own, and
 * the mirror's `document_id` makes a re-run after a failure RESUME rather than
 * repeat.
 */
export async function syncFromCrm(orgId: string, actor: Actor = {}): Promise<SyncReport> {
  const { s, via } = await importSession(orgId);
  const report = emptyReport(via);

  const crmOrg = await readCrmOrg(s, report);

  /*
   * =======================================================================
   * THESE BOOKS, THAT AGENCY, AND THEY HAVE TO BE THE SAME ONE
   * =======================================================================
   * The ONE check standing between a mis-typed sign-in and one agency's
   * customers, suppliers and invoices being imported into another agency's
   * ledger. Nothing about holding a valid token proves whose agency it belongs
   * to: an administrator with accounts at two agencies, or one who pasted the
   * wrong credentials, authenticates successfully and the backend then answers
   * with THAT agency's data. Every record imported afterwards would be
   * correctly scoped to this `orgId` and belong to somebody else.
   *
   * So the agency the token resolves to is compared against the agency these
   * books belong to, and a mismatch ABORTS THE RUN before a single record is
   * read. Not a warning: a warning on a report nobody reads is how the wrong
   * data gets in.
   */
  const books = await one<{ crm_org_id: string | null; name: string }>(
    'SELECT crm_org_id, name FROM organizations WHERE id = ?', orgId,
  );
  if (crmOrg?.id && books?.crm_org_id && crmOrg.id !== books.crm_org_id) {
    throw new Error(
      `That CRM account belongs to ${crmOrg.extended_name || crmOrg.name}, but these books belong `
      + `to ${books.name}. Nothing has been imported — a run on this connection would have put `
      + 'another agency’s customers, invoices and receipts into this ledger. '
      + 'Sign in with an account in this agency, or reconnect under Settings → CRM Sync.',
    );
  }

  /*
   * THE RENAME, now that the connection is known to be this agency's. The CRM
   * owns what an agency is called, so the masthead, every report header and
   * every exported statement read it from `organizations.name`, and this is
   * what keeps that in step.
   */
  if (crmOrg) {
    report.org = crmOrg.extended_name || crmOrg.name;
    await run('UPDATE organizations SET name = ? WHERE id = ?', report.org, orgId);
  }

  await syncSuppliers(orgId, s, report, actor);
  const leadPartner = await syncLeads(orgId, s, report, actor);
  await fetchPackages(orgId, s, report);
  await fetchInvoices(orgId, s, report);
  await importInvoices(orgId, report, actor, leadPartner);

  const summary =
    `${report.mirroredInvoices} invoice(s) and ${report.mirroredPayments} receipt(s) fetched; `
    + `${report.invoices} document(s) and ${report.payments} receipt(s) drafted; `
    + `${report.customers} customer(s), ${report.suppliers} supplier(s), ${report.bookings} booking(s), `
    + `${report.skipped} already in the books`;
  await recordSync(orgId, summary, crmOrg ? { id: crmOrg.id, name: crmOrg.name } : undefined);
  await audit(orgId, actor, 'synced', 'crm', orgId, `CRM fetch — ${summary}`);
  return report;
}

// --------------------------------------------------------------------------
// The agency itself
// --------------------------------------------------------------------------

/**
 * WHICH AGENCY THIS TOKEN SPEAKS FOR. It writes nothing, here or there.
 *
 * `syncFromCrm` compares the answer against the agency these books belong to
 * and aborts on a mismatch; the rename happens AFTER that check, from the same
 * answer. The order is the point — this function used to rename the local
 * organisation as its first act, which meant a connection saved with the wrong
 * credentials renamed these books after somebody else's agency before anything
 * had checked whose data it was.
 */
async function readCrmOrg(s: CrmSession, report: SyncReport): Promise<CrmOrg | null> {
  try {
    const body = await crmGet<CrmOrg | { organization?: CrmOrg }>(s, '/api/organizations/mine');
    const org = (body as { organization?: CrmOrg })?.organization ?? (body as CrmOrg);
    return org?.name ? org : null;
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
      // something this run can resolve. Counted and named, never guessed at.
      report.warnings.push(`Booking ${ref}: ${msgOf(e)}`);
    }
  }
  return byLead;
}

// --------------------------------------------------------------------------
// Stage one: fetch and mirror
// --------------------------------------------------------------------------

/**
 * The catalogue, snapshotted into this database.
 *
 * The screens still read the CRM live — a package re-priced this morning has to
 * reach this afternoon's invoice — so this is the fallback, not the source. It
 * is also what lets the GST rate chosen for a package (`crm_package_tax`) keep
 * showing the package's name after it has gone from the catalogue.
 */
async function fetchPackages(orgId: string, s: CrmSession, report: SyncReport) {
  try {
    const list = rows<CrmPackage>(
      await crmGet(s, '/api/packages?page=1&limit=500'), 'packages',
    );
    await mirrorPackages(orgId, list);
    report.mirroredPackages = list.length;
  } catch (e) {
    report.warnings.push(`Packages: ${msgOf(e)}`);
  }
}

/**
 * Every invoice the token can see, and every receipt taken against it, copied
 * into this database.
 *
 * THE LIST ROUTE DOES NOT CARRY THE LINES. `/api/invoices` answers headers;
 * `/api/invoices/:id` answers `{ invoice, items }`. An invoice mirrored from
 * the list alone would therefore have a subtotal and no lines to explain it,
 * and the importer would synthesise a single catch-all line for a sale whose
 * real breakdown was one request away. So each invoice is read individually.
 *
 * ONE INVOICE'S FAILURE IS ONE INVOICE'S FAILURE. A 404 on a record somebody
 * deleted in the CRM mid-run, or a 500 on one row, is recorded against that
 * invoice and the loop continues. Aborting the run would mean the other two
 * hundred invoices do not reach the books because of one that cannot.
 */
async function fetchInvoices(orgId: string, s: CrmSession, report: SyncReport) {
  let list: Array<{ id: string }>;
  try {
    list = rows<{ id: string }>(await crmGet(s, '/api/invoices'), 'invoices');
  } catch (e) {
    report.warnings.push(`Invoices: ${msgOf(e)}`);
    return;
  }

  for (const stub of list) {
    if (!stub?.id) continue;
    try {
      const body = await crmGet<{ invoice?: CrmInvoice; items?: CrmInvoice['items'] } | CrmInvoice>(
        s, `/api/invoices/${encodeURIComponent(stub.id)}`,
      );
      /*
       * THE DETAIL ROUTE WRAPS AND THE LIST ROUTE DOES NOT. Handing the wrapper
       * on as the invoice is what once made every figure on the mobile detail
       * screen read "INR 0" — subtotal, total and balance were all `undefined`,
       * which a money formatter renders as zero rather than refusing, while the
       * lines still appeared because `items` sits on the wrapper too. Unwrapped
       * here, once.
       */
      const wrapped = body as { invoice?: CrmInvoice; items?: CrmInvoice['items'] };
      const inv: CrmInvoice | null = wrapped?.invoice
        ? { ...wrapped.invoice, items: wrapped.items ?? wrapped.invoice.items ?? [] }
        : (body as CrmInvoice);
      if (!inv?.id) continue;

      await mirrorInvoice(orgId, inv);
      report.mirroredInvoices++;

      /*
       * RECEIPTS ARE RE-READ FOR EVERY INVOICE, including ones already in the
       * books. This is the bug the old importer had: payments were only fetched
       * inside the branch that created a new document, so a second instalment
       * taken next month against an invoice imported last month was never seen
       * again by anything. An invoice's receipts keep arriving long after the
       * invoice itself has stopped changing, which is exactly why they are
       * fetched on their own schedule rather than on the invoice's.
       */
      try {
        const payments = rows<CrmInvoicePayment>(
          await crmGet(s, `/api/invoices/${encodeURIComponent(inv.id)}/payments`), 'payments',
        );
        await mirrorInvoicePayments(orgId, inv.id, dateOnly(inv.issue_date), payments);
        report.mirroredPayments += payments.length;
      } catch (e) {
        // An invoice with no payments route, or none recorded, is the ordinary
        // case for an unpaid invoice. Only a real failure is worth reporting.
        if (e instanceof CrmError && e.status !== 404) {
          report.warnings.push(`Receipts on ${inv.invoice_number ?? inv.id}: ${msgOf(e)}`);
        }
      }
    } catch (e) {
      report.warnings.push(`Invoice ${stub.id}: ${msgOf(e)}`);
    }
  }
}

// --------------------------------------------------------------------------
// Stage two: the mirror becomes draft books
// --------------------------------------------------------------------------

/**
 * Turn every mirrored invoice that is not in the books into a draft document.
 *
 * READS THE MIRROR, NOT THE CRM. Everything above has already been fetched, so
 * this stage makes no network calls at all — which means it can be re-run after
 * an accountant adds a missing revenue account or a missing GST rate, and the
 * invoices that failed to map the first time will map now, from exactly the
 * bytes the first attempt saw.
 */
async function importInvoices(
  orgId: string, report: SyncReport, actor: Actor, leadPartner: Map<string, string>,
) {
  const pending = await mirroredInvoices(orgId, { imported: false });
  const alreadyIn = (await mirroredInvoices(orgId, { imported: true })).length;
  report.skipped += alreadyIn;
  if (!pending.length) {
    // Receipts still have to be looked at: an invoice imported last month can
    // have collected two instalments since, and neither is in the books.
    await importPayments(orgId, report, actor);
    return;
  }

  const saleJournal = await pickJournal(orgId, 'sale');
  if (!saleJournal) {
    report.warnings.push('No sales journal is configured, so no invoice could be drafted.');
    return;
  }

  /*
   * THE AGENCY'S OWN CHART, TAXES AND GST STATE, read once for the whole run.
   *
   * Scoped to `orgId`, which is the point: this deployment holds one set of
   * books per TripzoCRM agency, and an importer that resolved "the revenue
   * account" from whatever it found first would post one agency's sales into
   * another's ledger. See `loadMappingContext`.
   */
  const ctx = await loadMappingContext(orgId);
  if (!ctx.fallbackRevenue) {
    report.warnings.push('No income account is configured, so no invoice could be drafted.');
    return;
  }

  for (const inv of pending) {
    const number = inv.invoice_number ?? inv.crm_id.slice(0, 8);

    /*
     * A CANCELLED INVOICE NEVER HAPPENED. It is mirrored — the fact that the
     * CRM holds it is worth keeping — and it is not a fact the ledger should
     * carry, so it is not drafted.
     *
     * A DRAFT IS DIFFERENT, AND IS IMPORTED. The old importer skipped CRM
     * drafts on the reasoning that a draft is a proposal. In this product's
     * actual workflow that was the wrong call: an agent raises the invoice in
     * the CRM with no books fields on it at all, and the accountant's whole job
     * is to complete it over here. A CRM draft therefore becomes a LEDGER
     * DRAFT, which moves no balance, appears in no report and proves nothing
     * until somebody posts it. Skipping it meant the invoice the accountant was
     * waiting for simply never appeared, with nothing on screen to say why.
     */
    if ((inv.status ?? '').toLowerCase() === 'cancelled') {
      report.skipped++;
      continue;
    }

    const built = await buildInvoiceDraft(orgId, ctx, inv, number, saleJournal, leadPartner, actor);
    report.warnings.push(...built.warnings);
    if (!built.input) continue;
    const { input } = built;

    try {
      /*
       * THE DOCUMENT AND ITS LINK ARE ONE TRANSACTION.
       *
       * They were two statements, and the gap between them is where a doubled
       * posting comes from: a crash, a timeout or a second import running
       * concurrently between the insert and the link leaves a document in the
       * books that nothing points at — counted in the trial balance, invisible
       * to every screen that reads the mirror — and the next run imports the
       * same invoice again beside it. `markInvoiceImported` only claims an
       * invoice whose `document_id` is still null, so the loser of a race
       * ROLLS BACK its own document rather than leaving an orphan.
       */
      const docId = await tx(async () => {
        const created = await createDocument(input, actor);

        const claimed = await markInvoiceImported(orgId, inv.crm_id, created);
        if (!claimed) {
          throw new Error(
            `Invoice ${number} was imported by another run while this one was working on it. `
            + 'Nothing has been duplicated.',
          );
        }
        // The general identity map as well as the mirror's own column: every
        // other CRM record in this app is found through `crm_links`, and an
        // invoice that is only in one of the two is an invoice half the code
        // cannot see.
        await link(orgId, 'document', inv.crm_id, created);
        return created;
      });

      /*
       * DOES THE LEDGER'S COPY SAY WHAT THE INVOICE SAID?
       *
       * Checked on every import, because every decision above — the rate that
       * was divided out, the discount spread across the lines, a qty the CRM
       * rounded — can be wrong in a way that still posts cleanly. The engine
       * cannot catch it: it has no idea what the CRM said. This is the one
       * place the two figures meet.
       */
      const ledgerTotal = (await one<{ total: number }>(
        'SELECT total FROM documents WHERE id = ? AND org_id = ?', docId, orgId,
      ))?.total ?? 0;
      const mismatch = reconcileTotal({
        // The CRM's SUBTOTAL, not its grand total: the document is worth the
        // sum of the line amounts, with the stated discount recorded beside it
        // and the stated tax carved out of it. See `reconcileTotal`.
        invoiceNumber: number, crmTotal: inv.subtotal, ledgerTotal,
      });
      if (mismatch) report.warnings.push(mismatch);

      report.invoices++;
    } catch (e) {
      report.warnings.push(`Invoice ${number}: ${msgOf(e)}`);
    }
  }

  await importPayments(orgId, report, actor);
}

/**
 * ONE MIRRORED INVOICE -> THE DOCUMENT INPUT IT BECOMES.
 *
 * Lifted out of the import loop because it is now wanted TWICE: once when the
 * invoice first reaches the books, and once when somebody asks for a draft to
 * be re-drafted from the CRM — see `redraftInvoice`. Two copies of this
 * translation would be two copies that drift, and the drift would show as an
 * invoice whose re-draft disagrees with its import for reasons nobody can see.
 *
 * It decides nothing about WHERE the input goes. Reading the mirror, resolving
 * the customer and mapping the lines is all it does; creating, updating and
 * claiming are the caller’s, which is what lets one caller refuse to touch a
 * posted document while the other is free to create one.
 */
async function buildInvoiceDraft(
  orgId: string,
  ctx: MappingContext,
  inv: MirroredInvoice,
  number: string,
  saleJournal: string,
  leadPartner: Map<string, string>,
  actor: Actor,
): Promise<{ input: DocInput | null; warnings: string[] }> {
  const warnings: string[] = [];

  const partnerId = await resolvePartner(orgId, inv, leadPartner, actor);
  if (!partnerId) {
    warnings.push(`Invoice ${number} names no customer, so it could not be drafted.`);
    return { input: null, warnings };
  }

  const items = await mirroredItems(orgId, inv.crm_id);

  /*
   * WHERE THE SUPPLY WAS MADE TO, and it is a posting input rather than a
   * label — against the agency’s own state it decides CGST+SGST versus IGST.
   * The invoice’s own `place_of_supply` wins because an agent who set one
   * meant it; a customer GSTIN’s first two digits ARE its state and are the
   * next best answer; and failing both this is left null so `createDocument`
   * can fall back to the partner’s own state.
   */
  const placeOfSupply =
    (inv.place_of_supply ?? '').trim()
    || (inv.customer_gstin ?? '').trim().slice(0, 2)
    || null;

  /*
   * WHICH SLAB THE CRM’S TAX FIGURE LOOKS LIKE, WHICH IS A SUGGESTION AND NOT
   * AN AMOUNT.
   *
   * The amount is the CRM’s own and is carried across untouched as
   * `statedTax`; all this decides is whether a slab can be attached to the
   * lines, so an invoice that WAS raised at a configured rate arrives already
   * classified instead of waiting for someone to pick the rate it plainly is.
   * One that was not arrives unclassified, and the accountant chooses on the
   * edit screen — which changes no figure on the invoice, only which tax
   * accounts the stated figure is split across.
   */
  const taxable = inv.subtotal - inv.discount_amount;
  const tax = resolveSaleTax(ctx, {
    taxable, taxAmount: inv.tax_amount, placeOfSupply, invoiceNumber: number,
  });
  if (tax.warning) warnings.push(tax.warning);

  const mapped = mapInvoiceLines(ctx, itemsForMapping(items, inv, number), {
    taxId: tax.taxId,
    invoiceNumber: number,
  });
  warnings.push(...mapped.warnings);
  if (!mapped.lines.length) {
    warnings.push(`Invoice ${number}: no line could be mapped to an account.`);
    return { input: null, warnings };
  }

  return {
    warnings,
    input: {
      orgId,
      docType: (inv.doc_type ?? '').toLowerCase() === 'refund' ? 'out_refund' : 'out_invoice',
      partnerId,
      journalId: saleJournal,
      docDate: inv.issue_date ?? isoDate(),
      dueDate: inv.due_date,
      currency: inv.currency || 'INR',
      bookingId: inv.lead_id ? await linkedLocalId(orgId, 'booking', inv.lead_id) : null,
      /*
       * THE GST IDENTITY OF THE SUPPLY, carried across rather than left for
       * somebody to re-type. All three are SNAPSHOTS on the document: a
       * customer who re-registers or moves state must not retrospectively
       * change the tax on an invoice already issued.
       *
       * `supplyType` is derived from the registration because that is the only
       * evidence available — a customer GSTIN means a supply to a registered
       * business, which GSTR-1 reports invoice-wise in Table 4A, and no GSTIN
       * means a consumer, reported in aggregate.
       */
      placeOfSupply,
      partyGstin: (inv.customer_gstin ?? '').trim() || null,
      supplyType: ((inv.customer_gstin ?? '').trim() ? 'b2b' : 'b2c') as 'b2b' | 'b2c',
      /*
       * THE CRM’S OWN NUMBER GOES IN `order_ref`, NOT IN `number`.
       *
       * `documents.number` is this ledger’s own serial, taken from a sequence
       * inside the posting transaction, and it has to be gapless and unique for
       * an auditor. Overwriting it with the CRM’s string would put another
       * system’s numbering into the agency’s statutory series. `order_ref` is
       * the column for "the counterparty’s or the channel’s own reference",
       * which is exactly what this is — and it is indexed, so searching the
       * ledger by the number on the CRM invoice finds the document.
       */
      orderRef: inv.invoice_number,
      orderDate: inv.issue_date,
      /*
       * THE THREE FIGURES THE CRM HOLDS FOR THE WHOLE INVOICE, CARRIED ACROSS
       * AS THEY WERE TYPED.
       *
       * They used to be inferred into the lines — the discount as a percentage
       * off each one, the tax as a rate divided back out of an amount — and the
       * inference MOVED THE TOTAL: an invoice the customer holds for 44,998
       * stood in the books at 43,499.57. Recorded instead: the lines are worth
       * what the CRM’s lines are worth, the discount is stated because the
       * prices already account for it, the tax is carved out of that sum rather
       * than added to it, and the advance is the reader’s context — the money
       * itself arrives as receipts.
       */
      statedDiscount: inv.discount_amount,
      statedTax: inv.tax_amount,
      statedAdvance: inv.amount_paid,
      note: noteFor(inv, number),
      lines: mapped.lines,
    },
  };
}

/**
 * Re-draft ONE invoice’s document from the mirror, in place.
 *
 * ===========================================================================
 * WHY THIS EXISTS, AND WHY IT IS A BUTTON RATHER THAN PART OF THE SYNC
 * ===========================================================================
 * An import is a translation, and a translation can be corrected — by a fix to
 * the mapping, by a revenue account added to the chart, or by the agent editing
 * the invoice in the CRM. The document already drafted from the old reading
 * then stands in the books saying something nobody believes any more, and
 * before this there was no way to restate it: the sync skips every invoice it
 * has already imported, deliberately, because importing one twice is a doubled
 * sale.
 *
 * It is NOT part of the sync because it OVERWRITES WORK. Everything the
 * accountant did to the draft — the GST slab they picked, an account they moved
 * a line to, a line they split in two — is replaced by what the CRM says. That
 * is exactly right when the figures were wrong and exactly wrong when they were
 * being corrected, and only the person looking at the screen knows which. So it
 * is asked for, one invoice at a time.
 *
 * IT REFUSES ON A POSTED DOCUMENT, and that refusal is the whole safety
 * property: a posted entry is in the trial balance, in the GST summary and
 * possibly in a filed return, and restating it silently from another system
 * would be an un-audited rewrite of the books. The correction there is Edit,
 * which amends and records that it did.
 */
export async function redraftInvoice(
  orgId: string, crmId: string, actor: Actor,
): Promise<{ summary: string; warnings: string[] }> {
  const inv = await mirroredInvoice(orgId, crmId);
  if (!inv) throw new Error('That invoice is not in the mirror. Fetch from TripzoCRM first.');
  if (!inv.document_id) throw new Error('That invoice has not been drafted yet — import it first.');

  const doc = await getDocument(orgId, inv.document_id);
  if (!doc) throw new Error('The document this invoice became no longer exists.');
  if (doc.state !== 'draft') {
    throw new Error(
      `${doc.number ?? 'That document'} is ${doc.state}, so it cannot be re-drafted from the CRM — `
      + 'a posted entry is already in the trial balance and possibly in a filed return. Use Edit on '
      + 'the document, which amends it and records that it was amended.',
    );
  }

  const saleJournal = await pickJournal(orgId, 'sale');
  if (!saleJournal) throw new Error('No sales journal is configured.');
  const ctx = await loadMappingContext(orgId);
  const number = inv.invoice_number ?? inv.crm_id.slice(0, 8);
  const built = await buildInvoiceDraft(orgId, ctx, inv, number, saleJournal, new Map(), actor);
  if (!built.input) {
    throw new Error(built.warnings[0] ?? `Invoice ${number} could not be mapped.`);
  }

  await updateDocument(inv.document_id, built.input, actor);
  const after = await getDocument(orgId, inv.document_id);
  const mismatch = reconcileTotal({
    invoiceNumber: number, crmTotal: inv.subtotal, ledgerTotal: after?.total ?? 0,
  });
  /*
   * THE SUMMARY AND THE WARNINGS ARE RETURNED APART, not as one sentence.
   *
   * They were one string, and `redraftAllDrafts` then had to cut the summary
   * off the front to collect the warnings — which it did at the first full
   * stop, landing inside "44998.00" and reporting "00 across 5 line(s)" as
   * though it were a problem. Two fields cost nothing and cannot be mis-split.
   */
  return {
    summary:
      `${number} re-drafted from TripzoCRM: ${((after?.total ?? 0) / 100).toFixed(2)} across `
      + `${built.input.lines.length} line(s).`,
    warnings: [...built.warnings, mismatch ?? ''].filter(Boolean),
  };
}

/**
 * Re-draft EVERY imported invoice whose document is still a draft.
 *
 * The same act as `redraftInvoice`, applied to the queue rather than to one
 * row, and it exists because the one-at-a-time version is the wrong shape for
 * the case that actually arises: a correction to the mapping is a correction to
 * every invoice drafted under the old one, and sixteen buttons is sixteen
 * chances to miss one.
 *
 * IT STILL TOUCHES NOTHING POSTED. `redraftInvoice` refuses there, and this
 * does not even offer those rows to it — a posted entry is in the trial balance
 * and possibly in a filed return, and the correction for one is Edit, which
 * amends and records that it did.
 *
 * ONE INVOICE’S FAILURE IS NOT THE RUN’S. Each is re-drafted in its own
 * transaction and a failure is collected rather than thrown: fifteen restated
 * invoices and one named problem is a far better answer than nothing restated
 * because the sixteenth has no revenue account.
 */
export async function redraftAllDrafts(
  orgId: string, actor: Actor,
): Promise<{ redrafted: number; skipped: number; warnings: string[] }> {
  const imported = await mirroredInvoices(orgId, { imported: true });
  const out = { redrafted: 0, skipped: 0, warnings: [] as string[] };

  for (const inv of imported) {
    if (inv.doc_state !== 'draft') { out.skipped++; continue; }
    const number = inv.invoice_number ?? inv.crm_id.slice(0, 8);
    try {
      const note = await redraftInvoice(orgId, inv.crm_id, actor);
      out.redrafted++;
      // The warnings only: sixteen per-invoice confirmations reading
      // "re-drafted as 44998.00" would bury the one line that needs a look.
      out.warnings.push(...note.warnings);
    } catch (e) {
      out.warnings.push(`${number}: ${msgOf(e)}`);
    }
  }
  return out;
}

/**
 * An invoice with no lines still has a total, and a document with no lines
 * cannot be posted.
 *
 * So one line is synthesised from the invoice's own subtotal, on the catch-all
 * revenue account, carrying the invoice number as its description — a draft an
 * accountant can split up, rather than a sale missing from the books entirely.
 * It is the honest shape of what the CRM actually said: a total, and no
 * breakdown.
 */
function itemsForMapping(items: MirroredItem[], inv: MirroredInvoice, number: string) {
  if (items.length) {
    return items.map((it) => ({
      id: it.crm_id,
      title: it.title ?? `Invoice ${number}`,
      description: it.description,
      // Back to the units `mapInvoiceLines` takes — it speaks the CRM's
      // decimals, because that is what it was written against. The mirror holds
      // milli-quantities and paise, so this is the one place they convert back.
      qty: it.qty_milli / 1000,
      rate: it.rate / 100,
      amount: it.amount / 100,
      item_type: it.item_type ?? 'other',
      hsn_sac: it.hsn_sac,
    }));
  }
  const gross = (inv.subtotal || inv.total) / 100;
  return [{
    id: inv.crm_id,
    title: `Invoice ${number}`,
    description: null,
    qty: 1,
    rate: gross,
    amount: gross,
    item_type: 'other',
    hsn_sac: null,
  }];
}

/**
 * What the accountant reviewing the draft needs to read on it.
 *
 * TDS THE CUSTOMER DEDUCTED IS RECORDED HERE, NOT POSTED, and the distinction
 * is deliberate. `amount_withheld` on a SALES invoice is income tax the
 * customer withheld out of what they paid the agency — a Section 194 deduction
 * on the agency's own receipts. It is an ASSET: tax already paid on the
 * agency's behalf, set off at assessment, which is why the chart has
 * `TDS Receivable (Income Tax)` and why booking it as an expense makes the
 * agency pay the same tax twice.
 *
 * It is NOT the document's `withholdingTaxId` — that field is for a VENDOR
 * BILL, where the agency is the one withholding and the credit is TDS Payable.
 * Posting it here would create a liability where there is an asset.
 *
 * It also is not a fact about the invoice: nothing is withheld until the
 * customer actually pays, and how much depends on what they pay. So it is
 * recorded in plain words where the accountant will read it, and realised
 * against TDS Receivable when the short receipt is entered.
 */
function noteFor(inv: MirroredInvoice, number: string): string {
  const draft = (inv.status ?? '').toLowerCase() === 'draft'
    ? 'The CRM still has this invoice as a DRAFT — confirm it has been issued before posting'
    : null;
  return [
    inv.notes,
    `Imported from TripzoCRM invoice ${number}`,
    draft,
    inv.amount_withheld > 0
      ? `Customer withheld ${(inv.amount_withheld / 100).toFixed(2)} as TDS — book it to `
        + 'TDS Receivable when the receipt is entered'
      : null,
  ].filter(Boolean).join(' · ');
}

/**
 * Every mirrored receipt that is not in the books yet, as a draft payment.
 *
 * -------------------------------------------------------------------------
 * AN ADVANCE AND A RECEIPT ARE DIFFERENT POSTINGS, AND THE CRM DOES NOT SAY
 * WHICH IS WHICH
 * -------------------------------------------------------------------------
 * Money taken BEFORE the invoice was raised is an advance. Section 13(2) of the
 * CGST Act fixes the time of supply of a service at the EARLIER of the invoice
 * or the receipt of payment, and Notification 66/2017-CT lifted that for goods
 * only — so ₹47,200 taken in September against a December trip is a SEPTEMBER
 * liability. It lands on Customer Advances with the GST backed out of it
 * (₹40,000 owed to the traveller, ₹7,200 owed to the government), and the
 * receipt itself is a statutory document under section 31(3)(d): a receipt
 * voucher.
 *
 * Money taken on or after the invoice settles the receivable and carries no tax
 * of its own — the invoice already charged it.
 *
 * TripzoCRM records both as "a payment on an invoice" and draws no distinction,
 * so the comparison is made at mirror time and stored (`is_advance`). Deriving
 * it again here would read whatever the invoice's date had become since.
 *
 * -------------------------------------------------------------------------
 * WHY NOTHING IS ALLOCATED
 * -------------------------------------------------------------------------
 * An allocation moves a document's residual, and a residual that moved because
 * of an UNPOSTED receipt is a debtors list disagreeing with the ledger behind
 * it. Both sides are drafts here. Review & Post handles the pair in the order
 * that works — post the invoice, post the receipt — and the receipt's own screen
 * then offers that invoice as the obvious thing to settle.
 */
async function draftCrmReceipts(orgId: string, report: SyncReport, actor: Actor) {
  const unimported = await all<{
    crm_id: string; crm_invoice_id: string; amount: number; paid_at: string | null;
    method: string | null; reference_no: string | null; note: string | null; is_advance: number;
    invoice_number: string | null; document_id: string | null;
    place_of_supply: string | null; customer_gstin: string | null; lead_id: string | null;
    customer_name: string | null; customer_email: string | null; customer_phone: string | null;
    customer_address: string | null; issue_date: string | null;
    subtotal: number; discount_amount: number; tax_amount: number; total: number;
    amount_paid: number; balance_due: number; amount_withheld: number;
    status: string | null; doc_type: string | null; currency: string;
    notes: string | null; due_date: string | null; fetched_at: string; imported_at: string | null;
  }>(
    `SELECT p.crm_id, p.crm_invoice_id, p.amount, p.paid_at, p.method, p.reference_no, p.note,
            p.is_advance,
            i.invoice_number, i.document_id, i.place_of_supply, i.customer_gstin, i.lead_id,
            i.customer_name, i.customer_email, i.customer_phone, i.customer_address,
            i.issue_date, i.subtotal, i.discount_amount, i.tax_amount, i.total,
            i.amount_paid, i.balance_due, i.amount_withheld, i.status, i.doc_type,
            i.currency, i.notes, i.due_date, i.fetched_at, i.imported_at
       FROM crm_invoice_payments p
       JOIN crm_invoices i ON i.org_id = p.org_id AND i.crm_id = p.crm_invoice_id
      WHERE p.org_id = ? AND p.payment_id IS NULL AND p.amount > 0
      ORDER BY p.paid_at`,
    orgId,
  );
  if (!unimported.length) return;

  const bank = await defaultBank(orgId);
  if (!bank) {
    report.warnings.push(
      'No bank or cash journal is configured, so the CRM receipts were not drafted. '
      + 'Add a bank account under Settings → Bank Accounts and run this again.',
    );
    return;
  }

  /*
   * THE RATE AN ADVANCE'S GST IS BACKED OUT AT.
   *
   * It is the rate the invoice it belongs to was raised under, derived the same
   * way the document's own tax was — not a constant, and not today's default.
   * An advance taken against a 5% tour-operator package owes 5%, and charging
   * it 18% because that is the commoner rate overstates a liability the agency
   * then pays.
   *
   * Where no rate can be derived the advance is drafted WITHOUT tax and the run
   * says so by name. That is the honest failure: an untaxed advance is visibly
   * incomplete in Review & Post, where an accountant sets the rate before
   * posting, whereas a guessed rate is a filed figure nobody questioned.
   */
  const ctx = await loadMappingContext(orgId);

  for (const p of unimported) {
    const invoiceNumber = p.invoice_number ?? p.crm_invoice_id.slice(0, 8);
    const partnerId = await resolvePartner(orgId, {
      crm_id: p.crm_invoice_id,
      lead_id: p.lead_id,
      customer_name: p.customer_name,
      customer_email: p.customer_email,
      customer_phone: p.customer_phone,
      customer_address: p.customer_address,
    }, new Map(), actor);
    if (!partnerId) {
      report.warnings.push(`Receipt on ${invoiceNumber}: no customer, so it was not drafted.`);
      continue;
    }

    const isAdvance = p.is_advance === 1;
    let advanceTaxId: string | null = null;
    if (isAdvance) {
      const placeOfSupply = (p.place_of_supply ?? '').trim()
        || (p.customer_gstin ?? '').trim().slice(0, 2) || null;
      const derived = resolveSaleTax(ctx, {
        taxable: p.subtotal - p.discount_amount,
        taxAmount: p.tax_amount,
        placeOfSupply,
        invoiceNumber,
      });
      advanceTaxId = derived.taxId;
      /*
       * AN INVOICE THAT CHARGED NO TAX IS NOT A FAILED DERIVATION.
       *
       * An exempt supply, a zero-rated export, an agency not registered under
       * GST — all legitimately carry `tax_amount` of nothing, and an advance
       * against one owes nothing either. Warning about it would put a line on
       * every run that an accountant has to read and dismiss, which is how the
       * warnings that DO matter stop being read.
       */
      if (!advanceTaxId && p.tax_amount > 0) {
        report.warnings.push(
          `The advance of ${(p.amount / 100).toFixed(2)} on invoice ${invoiceNumber} was taken `
          + 'before the invoice was raised, so GST is due on it in the month it arrived '
          + '(section 13(2)). No rate could be derived from the invoice, so the draft receipt '
          + 'carries NO tax — set the rate on it in Review & Post before posting.',
        );
      }
    }

    try {
      await tx(async () => {
        const paymentId = await createPayment({
          orgId,
          direction: 'inbound',
          side: 'customer',
          partnerId,
          journalId: bank.journalId,
          bankAccountId: bank.bankAccountId,
          bookingId: p.lead_id ? await linkedLocalId(orgId, 'booking', p.lead_id) : null,
          payDate: p.paid_at ?? p.issue_date ?? isoDate(),
          amount: p.amount,
          currency: p.currency || 'INR',
          // The CRM's `method` is free text and this column is a closed set, so
          // anything unrecognised falls to `bank` rather than writing a value
          // no screen can render. The original is kept in the note.
          method: normaliseMethod(p.method),
          reference: p.reference_no ?? `CRM ${p.crm_id.slice(0, 8)}`,
          isAdvance,
          advanceTaxId,
          advancePlaceOfSupply: isAdvance
            ? ((p.place_of_supply ?? '').trim() || null)
            : null,
          note: [
            p.note,
            isAdvance
              ? `CRM advance received against invoice ${invoiceNumber}, before it was raised`
              : `CRM receipt against invoice ${invoiceNumber}`,
            p.method && normaliseMethod(p.method) === 'bank' && p.method.toLowerCase() !== 'bank'
              ? `Method in the CRM: ${p.method}`
              : null,
          ].filter(Boolean).join(' · '),
          /*
           * THE INVOICE THIS MONEY WAS TAKEN FOR, carried across rather than
           * dropped.
           *
           * TripzoCRM records every receipt against an invoice — that is what
           * `crm_invoice_payments.crm_invoice_id` is — and the importer used to
           * throw the match away, drafting the money as "from this customer"
           * and nothing more. The result was an invoice reading "Still owed
           * 44,998.00" with its own 14,000 standing beside it under Unallocated
           * money, offered for allocation against any open invoice that
           * customer had: the same rupees apparently available twice.
           *
           * It is an INTENT, not an allocation. Nothing moves until both this
           * receipt and that document are posted, and then `settleTargeted`
           * matches them from whichever side posts last.
           */
          targetDocumentId: p.document_id,
          // A draft, like everything else here. Posting is a person's act.
          post: false,
        }, actor);

        const claimed = await markPaymentImported(orgId, p.crm_id, paymentId);
        if (!claimed) {
          throw new Error(
            `The receipt of ${(p.amount / 100).toFixed(2)} on ${invoiceNumber} was imported by `
            + 'another run while this one was working on it. Nothing has been duplicated.',
          );
        }
        await link(orgId, 'payment', p.crm_id, paymentId);
      });
      report.payments++;
    } catch (e) {
      report.warnings.push(`Receipt on ${invoiceNumber}: ${msgOf(e)}`);
    }
  }

  /*
   * AND THEN PUT WHATEVER IS WAITING WHERE IT SAID IT WAS GOING.
   *
   * Everything drafted above is a draft, so none of it is settled by this run.
   * What this catches is the books as they already stand: receipts posted in an
   * earlier session against invoices posted since, and — the case that made
   * this necessary — every receipt imported before the match was recorded at
   * all, which no amount of ordinary work would ever bring together, because
   * nobody posts an invoice twice.
   *
   * It allocates only what both sides still have outstanding, so on books with
   * nothing waiting it does nothing.
   */
}

/**
 * Draft what is new, then put every receipt where it said it was going.
 *
 * TWO PASSES, AND THE SECOND RUNS EVEN WHEN THE FIRST HAS NOTHING TO DO. That
 * is the whole reason this wrapper exists: the drafting pass returns early when
 * every receipt is already imported, which on a ledger that has been syncing
 * for a while is EVERY run — and the matching is exactly what those older
 * receipts need. Leaving it inside meant the fix never reached the books it was
 * written for.
 */
async function importPayments(orgId: string, report: SyncReport, actor: Actor) {
  await draftCrmReceipts(orgId, report, actor);
  const swept = await settleCrmReceipts(orgId, actor);
  report.settled += swept.count;
}

/**
 * Put every receipt against the invoice TripzoCRM took it for — reading only
 * this database.
 *
 * NO NETWORK, WHICH IS THE POINT OF IT BEING SEPARATELY CALLABLE. Both halves
 * work from the mirror and the books: which invoice each receipt belongs to was
 * recorded when it was fetched, and whether both sides are posted is a fact
 * about this ledger. A fetch that cannot reach the CRM — an expired token, an
 * outage, an agency on a plane — must not be what stands between an accountant
 * and a receipt being matched to its invoice.
 *
 * Idempotent, and that is what lets it be a button: it writes an intent only
 * where there is none, and allocates only what both sides still have
 * outstanding. Running it on matched books does nothing.
 */
export async function settleCrmReceipts(
  orgId: string, actor: Actor,
): Promise<{ count: number; amount: number }> {
  await backfillPaymentTargets(orgId);
  return await settlePendingTargets(orgId, actor);
}

/**
 * Tell receipts already in the books which invoice they were taken against.
 *
 * THE MATCH WAS ALWAYS IN THE MIRROR and never on the payment:
 * `crm_invoice_payments` has recorded the invoice every receipt belongs to
 * since the first sync, and the importer simply did not carry it onto the
 * payment it drafted. Receipts imported before `target_document_id` existed
 * therefore have nothing for `settleTargeted` to act on, and nothing in the
 * ordinary course of work would ever give them one.
 *
 * ONE STATEMENT, AND IT ONLY EVER FILLS A BLANK. A target someone set by hand
 * is a decision and is left alone; so is a receipt whose invoice is not in the
 * books yet, which will be picked up by the next run once it is. Writing the
 * intent is not settling anything — `settlePendingTargets` does that next, and
 * only where both sides are posted and still outstanding.
 */
async function backfillPaymentTargets(orgId: string): Promise<void> {
  await run(
    `UPDATE payments SET target_document_id = sub.document_id
       FROM (SELECT cp.payment_id, i.document_id
               FROM crm_invoice_payments cp
               JOIN crm_invoices i ON i.org_id = cp.org_id AND i.crm_id = cp.crm_invoice_id
              WHERE cp.org_id = ? AND cp.payment_id IS NOT NULL
                AND i.document_id IS NOT NULL) sub
      WHERE payments.id = sub.payment_id
        AND payments.org_id = ?
        AND payments.target_document_id IS NULL`,
    orgId, orgId,
  );
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** The closed set `payments.method` holds, from the CRM's free text. */
function normaliseMethod(raw: string | null): string {
  const v = (raw ?? '').trim().toLowerCase();
  if (['cash', 'bank', 'upi', 'card', 'cheque', 'neft', 'other'].includes(v)) return v;
  if (v.includes('upi')) return 'upi';
  if (v.includes('card') || v.includes('credit') || v.includes('debit')) return 'card';
  if (v.includes('cheque') || v.includes('check')) return 'cheque';
  if (v.includes('neft') || v.includes('imps') || v.includes('rtgs') || v.includes('transfer')) return 'neft';
  if (v.includes('cash')) return 'cash';
  return 'bank';
}

/**
 * Where an imported receipt lands: the agency's default bank account and the
 * journal that account posts through.
 *
 * THE ACCOUNT DECIDES THE JOURNAL, not the other way round. A receipt into
 * petty cash belongs in the cash book, and an importer that picked one fixed
 * bank journal for everything put cash receipts under a bank entry number. The
 * fallback — the lowest-coded journal of the matching type — exists so a
 * hand-inserted bank account with no journal on it degrades to a posting in the
 * right KIND of book rather than to an exception at the moment money arrives.
 */
async function defaultBank(orgId: string): Promise<{ journalId: string; bankAccountId: string | null } | null> {
  const acct = await one<{ id: string; journal_id: string | null; is_cash: number }>(
    `SELECT id, journal_id, is_cash FROM bank_accounts
      WHERE org_id = ? AND active = 1 ORDER BY is_default DESC, is_cash, name LIMIT 1`,
    orgId,
  );
  if (acct?.journal_id) return { journalId: acct.journal_id, bankAccountId: acct.id };

  const journal = await one<{ id: string }>(
    `SELECT id FROM journals WHERE org_id = ? AND active = 1 AND type = ? ORDER BY code LIMIT 1`,
    orgId, acct?.is_cash ? 'cash' : 'bank',
  );
  if (!journal) return null;
  return { journalId: journal.id, bankAccountId: acct?.id ?? null };
}

/**
 * Which partner an invoice belongs to.
 *
 * By CRM lead id where there is one, because that is an identity rather than a
 * label. Falling back to an exact name match, and creating the partner only as
 * a last resort — an invoice whose customer does not exist here yet is real
 * enough to keep, and refusing it would mean losing revenue from the books over
 * a missing contact record.
 */
async function resolvePartner(
  orgId: string,
  inv: {
    crm_id: string; lead_id: string | null; customer_name: string | null;
    customer_email: string | null; customer_phone: string | null; customer_address: string | null;
  },
  leadPartner: Map<string, string>,
  actor: Actor,
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

/*
 * `pickAccount` USED TO LIVE HERE AND HAS BEEN DELETED ON PURPOSE.
 *
 * It returned the lowest-coded account of a given kind, and the importer called
 * it once with `['income','income_other']` and put EVERY line of EVERY imported
 * invoice on the answer. A year of hotel bookings, flight tickets, visa fees
 * and tour packages therefore all landed in Package Revenue: the trial balance
 * was right, the P&L was one line, and the question an agency asks its books —
 * which part of what we sell actually makes money — had no answer in them.
 *
 * Revenue is now classified per line from the CRM's own `item_type`, through an
 * explicit table in `invoiceMapping.ts`, with the fallback stated and warned
 * about rather than silently applied. Nothing should reintroduce a "first
 * account of the right kind" helper here; if a new importer needs a default, it
 * needs a mapping.
 */

/** Whole-currency decimal → minor units, tolerating nulls and junk. */
function toMinorSafe(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : 'unknown error';
}

/**
 * Clear every record a previous import created, so the next one starts clean.
 *
 * Only reachable from the "Reset imported data" button, and deliberately blunt:
 * it drops the identity map and the mirror's own links, which means the next run
 * re-imports everything. It does NOT delete the postings those imports made — a
 * posted entry is never deleted in this system — so it is a "let me import it
 * again alongside" tool, not an undo. The screen says so in those words.
 *
 * THE MIRROR ITSELF IS KEPT. What the CRM said is a reading of history and is
 * worth having whatever happens to the books drafted from it; only the links
 * saying "this became that" are cleared.
 */
export async function forgetSyncLinks(orgId: string) {
  await tx(async () => {
    await run('DELETE FROM crm_links WHERE org_id = ?', orgId);
    await forgetMirrorImports(orgId);
  });
}

/**
 * Re-read the catalogue alone, without touching invoices or the books.
 *
 * The Packages screen reads the CRM live on every render, so this does not
 * exist to make the list fresher — it exists to REFRESH THE SNAPSHOT, which is
 * what the screen falls back to when the CRM does not answer and what keeps a
 * GST rate chosen for a package able to name that package later. Separate from
 * the full run because re-pricing a package is a frequent, cheap act and
 * drafting a season of invoices is not.
 */
export async function refreshPackages(orgId: string): Promise<{ count: number; warnings: string[] }> {
  const { s, via } = await importSession(orgId);
  const report = emptyReport(via);
  await fetchPackages(orgId, s, report);
  return { count: report.mirroredPackages, warnings: report.warnings };
}

/**
 * The receipts and advances the CRM has recorded against one ledger document.
 *
 * For the provenance panel on an invoice: an accountant looking at a draft
 * needs to know that ₹40,000 of it has already been collected over there,
 * whether or not those receipts have reached the books yet.
 */
export async function crmReceiptsOfDocument(orgId: string, docId: string) {
  const inv = await one<{ crm_id: string }>(
    'SELECT crm_id FROM crm_invoices WHERE org_id = ? AND document_id = ?', orgId, docId,
  );
  return inv ? await mirroredPayments(orgId, inv.crm_id) : [];
}
