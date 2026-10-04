'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireCap, actorOf, ForbiddenError } from '@/server/auth';
import { signInToCrm, signOutOfCrm } from '@/server/crm/identity';
import { ctx } from '@/server/bootstrap';
import { toMinor, qtyToMilli } from '@/lib/money';
import { isoDate, type DocType } from '@/lib/accounting';
import {
  createDocument, updateDocument, amendDocument, postDocument, reverseDocument, createCreditNote,
  getDocument,
} from '@/server/accounting/documents';
import {
  createPayment, postPayment, allocate, unallocate, applyCreditNote, applyCreditToSource, reversePayment,
  cancelAdvance,
} from '@/server/accounting/payments';
import { draftEntry, postDraft, postEntry, reverseEntry } from '@/server/accounting/engine';
import {
  importStatement, parseStatementCsv, matchToPayment, reconcileAsPayment, reconcileToAccount, transfer,
  upsertBankAccount, setDefaultBankAccount, archiveBankAccount,
} from '@/server/accounting/banking';
import { setPeriodState, closeFiscalYear, postOpeningBalances, createFiscalYear } from '@/server/accounting/periods';
import {
  createExpense, submitExpense, approveExpense, refuseExpense, reimburseExpense,
  payEmployeeAdvance, createCommission, postCommission,
} from '@/server/accounting/expenses';
import { createAsset, confirmAsset, runDepreciation, createDeferral, runDeferrals } from '@/server/accounting/assets';
import {
  upsertAccount, setAccountReconcilable, setAccountDefaultHsn, upsertJournal, upsertPartner, createBooking,
  upsertProduct, createBudget, resolvePartnerByName, findPartnerIdByName,
  upsertPaymentTerm, archivePaymentTerm, updateSequence,
  upsertAnalyticAccount, archiveAnalyticAccount,
} from '@/server/accounting/masters';
import { updateOrganisation } from '@/server/accounting/organisation';
import {
  createSettlement, updateSettlement, postSettlement, reverseSettlement, pullDocuments,
  removeDocument as removeSettlementDocument, saveCharge as saveSettlementCharge,
  removeCharge as removeSettlementCharge,
} from '@/server/accounting/settlements';
import { setSetting, type SettingKey } from '@/server/accounting/settings';
import { resetAndSeed } from '@/server/seed';
import { journalOfBankAccount } from '@/server/options';
import { run, id } from '@/server/db';
import { connect as connectCrm, disconnect as disconnectCrm } from '@/server/crm/connection';
import { setPackageTax } from '@/server/crm/packageTax';
import {
  syncFromCrm, forgetSyncLinks, refreshPackages, redraftInvoice, redraftAllDrafts,
  settleCrmReceipts,
} from '@/server/crm/sync';

/**
 * Every mutation in the product.
 *
 * TWO RULES HOLD THROUGHOUT.
 *
 * 1. `requireCap` first, always. The sidebar hides what a role cannot do, but
 *    hiding a link is a courtesy and a server action is a public endpoint. The
 *    check here is the actual control (plan section 46).
 *
 * 2. Nothing in this file does accounting. Each action reads a form, calls one
 *    service, and redirects. The debit/credit logic lives in src/server/
 *    accounting/* — plan section 49, Rule 1: the UI must not implement
 *    accounting rules.
 *
 * Errors come back through the URL rather than as a thrown 500, because the
 * useful ones are business errors — "the period is locked", "this only owes
 * ₹4,000" — and the person reading them needs the sentence, not a stack trace.
 */

type Result = { ok?: string; error?: string };

function str(f: FormData, k: string): string { return String(f.get(k) ?? '').trim(); }
function opt(f: FormData, k: string): string | null { const v = str(f, k); return v === '' ? null : v; }
function money(f: FormData, k: string): number { return toMinor(str(f, k) || '0'); }
/**
 * A percentage typed on a form, as the basis points the schema stores.
 *
 * Rounded, not truncated: a commission of 6.185% typed into a field that stores
 * hundredths of a percent has to become 619 rather than 618, or the figure the
 * agency agreed and the figure the ledger applies differ on every order of
 * every cycle, always in the channel's favour.
 */
function bps(f: FormData, k: string): number {
  return Math.round(parseFloat(str(f, k) || '0') * 100) || 0;
}
function bool(f: FormData, k: string): boolean { return f.get(k) === 'on' || f.get(k) === 'true'; }

/** Run a service call and turn any failure into a message the user can act on. */
/**
 * `await fn()`, not `fn()`. The services became asynchronous when the ledger
 * moved to Postgres, and a try/catch around an un-awaited call catches nothing:
 * the promise rejects after the handler has already returned "Done", so the
 * accountant is told a posting succeeded while the error surfaces as an
 * unhandled rejection in the server log. The await is what keeps this a guard.
 */
async function guard<T>(fn: () => T | Promise<T>): Promise<{ value?: T } & Result> {
  try {
    return { value: await fn(), ok: 'Done' };
  } catch (e) {
    const message = e instanceof ForbiddenError
      ? e.message
      : e instanceof Error ? e.message : 'Something went wrong.';
    return { error: message };
  }
}

function back(path: string, r: Result): never {
  const param = r.error
    ? `error=${encodeURIComponent(r.error)}`
    : r.ok ? `ok=${encodeURIComponent(r.ok)}` : '';
  // The return path often already carries a query — `/banking/reconcile?account=…`
  // — and a second `?` silently folds the message into the previous parameter's
  // value, which showed up as the reconciliation screen filtering on an account
  // id with "?ok=Reconciled." stuck to the end of it.
  const sep = path.includes('?') ? '&' : '?';
  revalidatePath('/', 'layout');
  redirect(param ? `${path}${sep}${param}` : path);
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

/**
 * Where a successful sign-in is allowed to send someone.
 *
 * A PATH ON THIS SITE OR NOTHING. A login form that redirects to whatever a
 * query parameter says is an open redirect, and an open redirect on a login
 * form is a phishing page hosted under the agency's own domain: the victim
 * checks the address bar, sees the real site, signs in, and is handed to an
 * attacker's copy. The two rejected shapes are the ones that matter —
 * "//evil.example" is protocol-relative and leaves the site, and anything with
 * a scheme leaves it outright — so only a single leading slash survives.
 */
function safeReturn(raw: string): string {
  const next = raw.trim();
  if (!next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

export async function signInAction(formData: FormData) {
  const next = safeReturn(str(formData, 'next'));
  const email = str(formData, 'email');

  // NOT `guard`: that helper turns a failure into a redirect back to the same
  // screen, which is right here, but the PASSWORD must not travel through it on
  // the way. It is read straight into the call and never lands in a variable
  // that outlives this line, never in a log, and never in the URL the failure
  // redirects to.
  try {
    await signInToCrm(email, str(formData, 'password'));
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Sign-in failed.';
    back(`/login${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`, { error: message });
  }
  revalidatePath('/', 'layout');
  redirect(next);
}

export async function signOutAction() {
  await signOutOfCrm();
  revalidatePath('/', 'layout');
  redirect('/login');
}

// ---------------------------------------------------------------------------
// TripzoCRM — fetch, mirror, draft. NOTHING WRITES TO THE CRM.
// ---------------------------------------------------------------------------
// This block used to hold `saveCrmInvoiceAction`, `crmPaymentAction` and
// `crmDeleteInvoiceAction`, which POSTed, PATCHed and DELETEd invoices in
// TripzoCRM from this app's own forms. All three are gone, and so are the
// client functions behind them.
//
// WHY. This is an accounting system. TripzoCRM is the agency's operational
// system, and the invoice an agent raised there is what the customer's copy is
// generated from. A mapping bug, a double-submitted form or a mis-scoped token
// in a finance app must not be able to alter that record — there is no undo for
// it in the ledger, and no report here can detect it.
//
// So the traffic is one-way and the direction is enforced structurally rather
// than by convention: `crmFetch` takes no method and no body, so a write cannot
// be expressed anywhere in this codebase. What replaced the three actions is
// `importFromCrmAction` below — fetch the CRM, mirror it into this ledger's own
// Postgres, and draft documents the accountant completes and posts here.
//
// An invoice is now saved by `saveDocumentAction`, the same action a vendor bill
// uses, writing to the same `documents` table. One invoice form, one save path,
// one database — and the books can be produced from it.

/**
 * Fetch TripzoCRM and draft whatever is not in the books yet.
 *
 * TWO STAGES, AND ONLY ONE OF THEM IS REPEATABLE. The fetch mirrors every
 * invoice, line, receipt and package into this database and is always safe to
 * re-run. The import turns mirrored invoices into DRAFT documents and is
 * idempotent through `crm_invoices.document_id`, claimed in the same
 * transaction as the document — so pressing this twice cannot double a posting.
 *
 * `maxDuration` on the calling pages is what gives this room to finish: a run
 * is several hundred round trips and well past the ten seconds a serverless
 * function gets by default.
 */
export async function importFromCrmAction(formData: FormData) {
  const s = await requireCap('invoice.create');
  // Where to land afterwards. The same work is reachable from the CRM invoices
  // screen and from Settings, and a redirect that always went to one of them
  // would throw away the context the person was working in.
  const to = str(formData, 'return_to') === 'settings' ? '/settings/crm-sync' : '/crm/invoices';

  let summary: string;
  try {
    const r = await syncFromCrm(s.orgId, actorOf(s));
    summary =
      `Fetched ${r.mirroredInvoices} invoice(s) and ${r.mirroredPayments} receipt(s) from `
      + `TripzoCRM via ${r.via}. Drafted ${r.invoices} document(s) and ${r.payments} receipt(s) — `
      + `post them in Accounting → Review & Post. ${r.skipped} already in the books.`
      // Only when it did something. "0 receipt(s) matched" on every run is a
      // sentence that teaches people to stop reading the banner.
      + (r.settled
        ? ` ${r.settled} posted receipt(s) matched to the invoice TripzoCRM took them against.`
        : '')
      + (r.warnings.length
        ? ` ${r.warnings.length} thing(s) need a look: ${r.warnings.slice(0, 3).join(' ')}`
        : '');
  } catch (e) {
    back(to, { error: e instanceof Error ? e.message : 'The fetch from TripzoCRM failed.' });
  }
  revalidatePath('/crm/invoices');
  revalidatePath('/sales/invoices');
  revalidatePath('/accounting/review');
  back(to, { ok: summary });
}

/**
 * Re-draft ONE already-imported invoice from what TripzoCRM now says.
 *
 * THE SYNC CANNOT DO THIS, and deliberately: it skips every invoice already in
 * the books, because importing one twice is a doubled sale. That leaves a
 * document drafted from an earlier reading of the invoice standing in the books
 * with no way to restate it — after a fix to the mapping, after a revenue
 * account was added to the chart, or after the agent edited the invoice over
 * there.
 *
 * It OVERWRITES THE DRAFT, including anything done to it here: the GST slab
 * someone picked, an account a line was moved to, a line split in two. That is
 * why it is a button on one row rather than part of the fetch — only the person
 * looking at the screen knows whether the draft or the CRM is the better
 * statement of the invoice. `redraftInvoice` refuses outright on a POSTED
 * document, where the correction is Edit, which amends and says so.
 */
export async function redraftCrmInvoiceAction(formData: FormData) {
  const s = await requireCap('invoice.create');
  const crmId = str(formData, 'crm_id');
  const r = await guard(async () => await redraftInvoice(s.orgId, crmId, actorOf(s)));
  revalidatePath('/crm/invoices');
  revalidatePath('/sales/invoices');
  revalidatePath('/accounting/review');
  if (r.error) back('/crm/invoices', r);
  back('/crm/invoices', {
    ok: [r.value!.summary, ...r.value!.warnings].join(' '),
  });
}

/**
 * Re-draft every still-draft document from the mirror, in one go.
 *
 * The bulk form of `redraftCrmInvoiceAction`, and it carries the same warning:
 * it REPLACES each draft with what TripzoCRM says, including a GST slab or an
 * account somebody chose here. Posted documents are left alone entirely.
 *
 * Reads the mirror, not the CRM — so it is fast, it works while the CRM is
 * down, and it restates the books from exactly the bytes the import worked
 * from. Fetch first if what you want is the CRM’s latest.
 */
export async function redraftAllCrmInvoicesAction() {
  const s = await requireCap('invoice.create');
  const r = await guard(async () => await redraftAllDrafts(s.orgId, actorOf(s)));
  revalidatePath('/crm/invoices');
  revalidatePath('/sales/invoices');
  revalidatePath('/accounting/review');
  if (r.error) back('/crm/invoices', r);
  const v = r.value!;
  back('/crm/invoices', {
    ok: `${v.redrafted} draft(s) re-drafted from the mirror; ${v.skipped} posted document(s) left alone.`
      + (v.warnings.length ? ` ${v.warnings.slice(0, 3).join(' ')}` : ''),
  });
}

/**
 * Match the receipts TripzoCRM already matched.
 *
 * Reads no CRM, writes no CRM: every receipt fetched from there carries the
 * invoice it was taken against, and this allocates each posted one to its
 * posted document. It exists as its own button because the books that most
 * need it are the ones where both sides were posted BEFORE the match was
 * recorded — nothing in the ordinary course of work brings those together,
 * since nobody posts an invoice twice.
 *
 * Safe to press at any time. It allocates only what the receipt still holds and
 * the invoice still owes, so pressing it on matched books does nothing at all.
 */
export async function settleCrmReceiptsAction(formData: FormData) {
  const s = await requireCap('payment.create');
  const to = str(formData, 'return_to') || '/sales/payments';
  const r = await guard(async () => await settleCrmReceipts(s.orgId, actorOf(s)));
  revalidatePath('/sales/payments');
  revalidatePath('/sales/invoices');
  revalidatePath('/crm/invoices');
  if (r.error) back(to, r);
  const v = r.value!;
  back(to, {
    ok: v.count
      ? `${v.count} receipt(s) matched to the invoice TripzoCRM took them against, `
        + `${(v.amount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} in all.`
      : 'Nothing to match: every receipt TripzoCRM matched is already against its invoice here, '
        + 'or its invoice is not posted yet.',
  });
}

/**
 * Re-read the catalogue from TripzoCRM and refresh the stored snapshot.
 *
 * THE SCREEN ALREADY READS THE CRM on every render, so this is not what makes
 * the list current. It does two things the render cannot:
 *
 *   It makes the asking EXPLICIT. A browser back-button, a cached route segment
 *   or a tab left open since this morning can all show a catalogue that was true
 *   then. Pressing Fetch is how somebody who has just re-priced a package over
 *   there confirms this side is looking at the new figure.
 *
 *   And it updates `crm_packages`, the snapshot in THIS database. That is what
 *   the screen falls back to when the CRM does not answer, and what lets a GST
 *   rate chosen for a package still name that package after it has been removed
 *   from the catalogue. Nothing is written to the CRM — the snapshot is a copy
 *   taken here, and the catalogue over there is never told it was read.
 */
export async function fetchPackagesAction() {
  const s = await requireCap('invoice.create');
  const r = await guard(async () => await refreshPackages(s.orgId));
  revalidatePath('/crm/packages');
  if (r.error) back('/crm/packages', r);
  const count = r.value?.count ?? 0;
  const warnings = r.value?.warnings ?? [];
  back('/crm/packages', {
    ok: warnings.length
      ? `${count} package(s) read. ${warnings.join(' ')}`
      : `${count} package(s) re-read from TripzoCRM and snapshotted here.`,
  });
}

/**
 * Put a package on a GST rate.
 *
 * THE RATE IS THE AGENCY'S, THE PACKAGE IS THE CRM'S, and this is the one
 * place the two are joined. It writes to this ledger's own database — the CRM
 * is not told, and must not be: two agencies reselling the same itinerary can
 * be on different rates, and the catalogue is not the place to answer for
 * either of them.
 *
 * It changes the NEXT invoice, never the last one. A document line's tax split
 * is stored on the line when it is saved, so an invoice already raised keeps
 * the rate it was raised at.
 */
export async function setPackageTaxAction(formData: FormData) {
  const s = await requireCap('invoice.create');
  const packageId = str(formData, 'package_id');
  const taxId = str(formData, 'tax_id');
  const r = await guard(async () => await setPackageTax(
    s.orgId, packageId, taxId, opt(formData, 'package_name'), actorOf(s),
  ));
  // Named explicitly as well as through `back`'s layout-wide revalidation: the
  // redirect lands back on THIS page, and a row that still shows the old rate
  // immediately after saving it reads as a save that did not take.
  revalidatePath('/crm/packages');
  back('/crm/packages', r.error ? r : { ok: 'GST rate saved for this package.' });
}

// ---------------------------------------------------------------------------
// Documents — invoices, bills, credit notes
// ---------------------------------------------------------------------------

/**
 * Read the repeating line rows off the form.
 *
 * The new-document form posts parallel arrays (`line_name[]`, `line_qty[]`…)
 * rather than JSON, so the page works with no JavaScript at all and a half-
 * filled form survives a validation bounce.
 */
function readLines(f: FormData) {
  const names = f.getAll('line_name').map(String);
  const qtys = f.getAll('line_qty').map(String);
  const prices = f.getAll('line_price').map(String);
  const discounts = f.getAll('line_discount').map(String);
  const taxes = f.getAll('line_tax').map(String);
  const accounts = f.getAll('line_account').map(String);
  const analytics = f.getAll('line_analytic').map(String);

  // Parallel arrays again, for the same reason. `getAll` returns one entry per
  // input of that name REGARDLESS of whether it was filled, so the HSN and MRP
  // columns stay aligned with the rows beside them even when most are blank —
  // which is the usual case, and the case a sparse encoding would misalign.
  const hsns = f.getAll('line_hsn').map(String);
  const mrps = f.getAll('line_mrp').map(String);
  // TripzoCRM's own kind for the line. A select posts one entry per row like
  // every other column here, blank included, so the array stays in step.
  const itemTypes = f.getAll('line_item_type').map(String);

  return names.map((name, i) => ({
    name: name.trim(),
    qtyMilli: qtyToMilli(qtys[i] || '1'),
    unitPrice: toMinor(prices[i] || '0'),
    discountBps: Math.round(parseFloat(discounts[i] || '0') * 100),
    taxId: taxes[i] || null,
    accountId: accounts[i] || '',
    analyticId: analytics[i] || null,
    hsnCode: (hsns[i] ?? '').trim() || null,
    mrp: toMinor(mrps[i] || '0'),
    itemType: (itemTypes[i] ?? '').trim() || null,
  })).filter((l) => l.name && l.accountId && (l.unitPrice !== 0 || l.qtyMilli !== 0));
}

export async function saveDocumentAction(formData: FormData) {
  const docType = str(formData, 'doc_type') as DocType;
  const isBill = docType.startsWith('in_');
  const s = await requireCap(isBill ? 'bill.create' : 'invoice.create');
  const listPath = isBill ? '/purchases/bills' : '/sales/invoices';
  const existing = opt(formData, 'id');

  // A bounced form goes back to the screen it came from — the edit screen for
  // a draft being changed, the new-document screen otherwise.
  const formPath = existing ? `${listPath}/${existing}/edit` : `${listPath}/new`;

  const lines = readLines(formData);
  if (!lines.length) back(formPath, { error: 'Add at least one line with a description and an account.' });

  const r = await guard(async () => {
    // Typed, not chosen from a dropdown: a name with no match on this side
    // becomes a new partner here, so the customer/supplier never has to exist
    // beforehand for the first document against them to be raised.
    // The GSTIN goes in with the name, not after it: a partner minted here by
    // typing a name is created WITH its registration, and one that already
    // exists without a registration has this one filled in. Either way it is
    // typed once rather than once per invoice.
    const partyGstin = opt(formData, 'party_gstin');
    const partnerId = await resolvePartnerByName(
      s.orgId, str(formData, 'partner_name'), isBill ? 'supplier' : 'customer', actorOf(s),
      partyGstin,
    );
    const input = {
      orgId: s.orgId,
      docType,
      partnerId,
      journalId: str(formData, 'journal_id'),
      bookingId: opt(formData, 'booking_id'),
      analyticId: opt(formData, 'analytic_id'),
      docDate: str(formData, 'doc_date') || isoDate(),
      dueDate: opt(formData, 'due_date'),
      paymentTermsId: opt(formData, 'payment_terms_id'),
      supplierRef: opt(formData, 'supplier_ref'),
      currency: str(formData, 'currency') || 'INR',
      rateE6: Math.round(parseFloat(str(formData, 'rate') || '1') * 1_000_000),
      withholdingTaxId: opt(formData, 'withholding_tax_id'),
      note: opt(formData, 'note'),
      placeOfSupply: opt(formData, 'place_of_supply'),
      partyGstin,
      /*
       * SAID, NOT INFERRED. `resolveSupplyType` falls back to "a registration
       * means B2B" for everything that reaches it without this — a credit note
       * generated from an invoice, a document synced from the CRM — but a form
       * that asks the question has to send the answer, because the whole point
       * of asking is that a BLANK GSTIN on a B2B supply is a defect and on a
       * B2C one is correct. The server refuses the first.
       */
      supplyType: (str(formData, 'supply_type') === 'b2b' ? 'b2b' : 'b2c') as 'b2b' | 'b2c',
      irn: opt(formData, 'irn'),
      irnAckNo: opt(formData, 'irn_ack_no'),
      irnAckDate: opt(formData, 'irn_ack_date'),
      orderRef: opt(formData, 'order_ref'),
      orderDate: opt(formData, 'order_date'),
      /*
       * THE FIGURES THE SOURCE INVOICE STATED, which on a CRM-drafted document
       * arrived with it and on a typed one are whatever the user put in the
       * three boxes. Sent even when blank — `money()` makes that zero — because
       * clearing the tax box has to clear the tax, and a field that only ever
       * sets and never unsets is a figure nobody can remove.
       */
      statedDiscount: money(formData, 'stated_discount'),
      statedTax: money(formData, 'stated_tax'),
      statedAdvance: money(formData, 'stated_advance'),
      lines,
    };
    if (existing) {
      /*
       * THE SAME FORM, TWO DIFFERENT ACTS, AND THE DOCUMENT'S STATE DECIDES
       * WHICH.
       *
       * A draft has touched nothing, so it is rewritten in place. A POSTED
       * document has a journal entry behind it, a number taken, and possibly
       * money allocated against it — so it is AMENDED: `amendDocument` rewrites
       * the lines, recomputes the totals, and replaces the posted entry so the
       * general ledger, the trial balance, the day book and every report built
       * on them carry the new figures instead of the old ones. There is no
       * state in which the document says one thing and the ledger behind it
       * says another.
       *
       * It refuses rather than guesses where it cannot be safe: a locked
       * period, a reconciled bank line, a credit note already raised against
       * the document, or a settlement larger than the new total. Those are
       * decisions for the accountant, and `amendDocument` says which one it hit.
       *
       * Decided on the SERVER, from the stored state, rather than on a hidden
       * field the form could be wrong about.
       */
      const current = await getDocument(s.orgId, existing);
      if (!current) throw new Error('That document no longer exists.');
      if (current.state === 'draft') await updateDocument(existing, input, actorOf(s));
      else await amendDocument(existing, input, actorOf(s));
      return existing;
    }
    return await createDocument(input, actorOf(s));
  });
  if (r.error) back(formPath, r);

  const docId = r.value!;
  // An amendment has already written its entry; only a draft is posted here.
  if (bool(formData, 'post_now')) {
    const doc = await getDocument(s.orgId, docId);
    if (doc?.state === 'draft') {
      const posted = await guard(async () => await postDocument(s.orgId, docId, actorOf(s)));
      if (posted.error) back(`${listPath}/${docId}`, posted);
    }
  }
  back(`${listPath}/${docId}`, { ok: 'Saved' });
}

export async function postDocumentAction(formData: FormData) {
  const docId = str(formData, 'id');
  const isBill = str(formData, 'doc_type').startsWith('in_');
  const s = await requireCap(isBill ? 'bill.post' : 'invoice.post');
  const r = await guard(async () => await postDocument(s.orgId, docId, actorOf(s)));
  back(`${isBill ? '/purchases/bills' : '/sales/invoices'}/${docId}`, r.error ? r : { ok: 'Posted to the ledger.' });
}

export async function reverseDocumentAction(formData: FormData) {
  const docId = str(formData, 'id');
  const isBill = str(formData, 'doc_type').startsWith('in_');
  const s = await requireCap(isBill ? 'bill.post' : 'invoice.post');
  const r = await guard(async () => await reverseDocument(
    s.orgId, docId, str(formData, 'date') || isoDate(), actorOf(s), opt(formData, 'reason') ?? undefined,
  ));
  back(`${isBill ? '/purchases/bills' : '/sales/invoices'}/${docId}`, r.error ? r : { ok: 'Reversed.' });
}

export async function creditNoteAction(formData: FormData) {
  // A note takes the capability of the side it is raised on: an agency that
  // lets a purchase clerk cancel a hotel booking is not thereby letting them
  // credit a customer.
  const isBill = str(formData, 'doc_type') === 'in_invoice';
  const s = await requireCap(isBill ? 'bill.create' : 'invoice.create');
  const sourceId = str(formData, 'id');
  const pctValue = parseFloat(str(formData, 'percent') || '100');
  const r = await guard(async () => {
    const noteId = await createCreditNote(s.orgId, sourceId, {
      date: str(formData, 'date') || isoDate(),
      bps: Math.round(pctValue * 100),
      reason: str(formData, 'reason') || 'Cancellation',
    }, actorOf(s));
    if (bool(formData, 'post_now')) {
      await postDocument(s.orgId, noteId, actorOf(s));
      // Net it off the invoice it cancels straight away. A note left unmatched
      // reads as a full refund owed to the customer — see `applyCreditToSource`.
      await applyCreditToSource(s.orgId, noteId, actorOf(s));
    }
    return noteId;
  });
  if (r.error) back(`${isBill ? '/purchases/bills' : '/sales/invoices'}/${sourceId}`, r);
  const doc = await getDocument(s.orgId, r.value!);
  const path = doc?.doc_type === 'in_refund' ? '/purchases/debit-notes' : '/sales/credit-notes';
  back(`${path}/${r.value}`, { ok: isBill ? 'Debit note created.' : 'Credit note created.' });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export async function registerPaymentAction(formData: FormData) {
  const s = await requireCap('payment.create');
  const direction = str(formData, 'direction') === 'outbound' ? 'outbound' : 'inbound';
  // The side is sent by the form because the direction cannot imply it: a
  // customer refund is outbound money against the receivable side.
  const side = str(formData, 'side') === 'supplier' ? 'supplier' : 'customer';
  const docId = opt(formData, 'document_id');
  const amount = money(formData, 'amount');
  const listPath = direction === 'inbound' ? '/sales/payments' : '/purchases/payments';

  const r = await guard(async () => {
    /*
     * A document's own settle form knows the partner already and sends its id;
     * the standalone payment form has only a typed name. Taking the id first
     * is what keeps "Pay out" on a posted bill working — it has no name field
     * to read, so resolving by name alone failed it with "Supplier is required".
     */
    const partnerId = opt(formData, 'partner_id')
      ?? await resolvePartnerByName(s.orgId, str(formData, 'partner_name'), side, actorOf(s));
    /*
     * THE JOURNAL FOLLOWS THE ACCOUNT, and is resolved here rather than sent
     * by the form.
     *
     * The form used to post a fixed `journal_id` — the first bank or cash
     * journal in the list — alongside whichever account the person picked. The
     * GL side was right, because `postPayment` reads the account off the bank
     * account; the JOURNAL was whatever sorted first. So a receipt into petty
     * cash was stamped with a bank journal's entry number and appeared in the
     * bank book instead of the cash book, and the two statements an auditor
     * reconciles disagreed by exactly the cash takings.
     */
    const bankAccountId = opt(formData, 'bank_account_id');
    const journalId = await journalOfBankAccount(s.orgId, bankAccountId)
      ?? str(formData, 'journal_id');
    if (!journalId) {
      throw new Error('This account has no journal to post through. Set one under Settings → Bank & Cash.');
    }
    return await createPayment({
      orgId: s.orgId,
      direction,
      side,
      partnerId,
      journalId,
      bankAccountId,
      bookingId: opt(formData, 'booking_id'),
      payDate: str(formData, 'pay_date') || isoDate(),
      amount,
      method: str(formData, 'method') || 'bank',
      reference: opt(formData, 'reference'),
      isAdvance: bool(formData, 'is_advance'),
      /*
       * THE GST ON AN ADVANCE, AND WHY THE FORM ASKS FOR IT.
       *
       * Section 13(2) fixes the time of supply of a SERVICE at the earlier of
       * the invoice or the payment, and Notification 66/2017-CT lifted that for
       * goods only. A travel agency sells services, so money taken in September
       * against a December trip is a September liability — the receipt is also
       * a RECEIPT VOUCHER under section 31(3)(d), and Rule 50 wants the place of
       * supply on it.
       *
       * Sent only when the box is ticked. `createPayment` refuses tax on a
       * SUPPLIER advance anyway (section 16(2): no invoice, no credit), and
       * passing a rate on an ordinary receipt would tax money that the invoice
       * behind it has already taxed.
       */
      advanceTaxId: bool(formData, 'is_advance') ? opt(formData, 'advance_tax_id') : null,
      advancePlaceOfSupply: bool(formData, 'is_advance') ? opt(formData, 'advance_place_of_supply') : null,
      note: opt(formData, 'note'),
      allocations: docId && !bool(formData, 'is_advance') ? [{ documentId: docId, amount }] : [],
    }, actorOf(s));
  });

  const returnTo = str(formData, 'return_to') || listPath;
  back(returnTo, r.error ? r : { ok: 'Payment recorded.' });
}

/**
 * Post a payment that is sitting in draft.
 *
 * Only imported receipts are ever in that state — the on-screen form posts
 * what it creates — so this is the button the Review & Post queue puts next to
 * every receipt the CRM sent over. The allocation against an invoice is a
 * separate, later act: the accountant does it from the receipt or the invoice
 * once both are posted.
 */
export async function postPaymentAction(formData: FormData) {
  const s = await requireCap('payment.approve');
  const r = await guard(async () => await postPayment(s.orgId, str(formData, 'id'), actorOf(s)));
  back(str(formData, 'return_to') || '/accounting/review', r.error ? r : { ok: 'Payment posted to the ledger.' });
}

/**
 * Cancel a trip against the advance taken for it.
 *
 * ONE FORM, TWO STATUTORY DOCUMENTS, because that is what a cancellation
 * actually is: a tax invoice for what the agency keeps, and a refund voucher
 * for what it gives back. See `cancelAdvance`, which holds the reasoning and
 * the worked example; nothing here does accounting.
 *
 * `payment.approve` rather than `payment.create`. This posts an invoice, moves
 * an advance and sends money out of a bank account — which is an approval, not
 * data entry, however it is phrased on screen.
 */
export async function cancelAdvanceAction(formData: FormData) {
  const s = await requireCap('payment.approve');
  const paymentId = str(formData, 'payment_id');
  const returnTo = str(formData, 'return_to') || '/sales/payments';

  const r = await guard(async () => await cancelAdvance(s.orgId, paymentId, {
    date: str(formData, 'date') || isoDate(),
    chargeGross: money(formData, 'charge_amount'),
    taxId: opt(formData, 'tax_id'),
    reason: opt(formData, 'reason') ?? undefined,
    refund: bool(formData, 'refund'),
    bankAccountId: opt(formData, 'bank_account_id'),
    method: str(formData, 'method') || undefined,
    reference: opt(formData, 'reference'),
  }, actorOf(s)));

  if (r.error) back(returnTo, r);
  const { charge, refunded } = r.value!;
  back(returnTo, {
    ok: `Cancelled. ${(charge / 100).toFixed(2)} retained and invoiced with its GST; `
      + (refunded > 0
        ? `${(refunded / 100).toFixed(2)} refunded under a refund voucher, reversing its share of the advance tax.`
        : 'the balance stays on the customer\u2019s account.'),
  });
}

export async function allocateAction(formData: FormData) {
  const s = await requireCap('payment.create');
  const r = await guard(async () => await allocate(
    s.orgId, str(formData, 'payment_id'), str(formData, 'document_id'), money(formData, 'amount'), actorOf(s),
  ));
  back(str(formData, 'return_to') || '/sales/payments', r.error ? r : { ok: 'Allocated.' });
}

export async function unallocateAction(formData: FormData) {
  const s = await requireCap('payment.create');
  const r = await guard(async () => await unallocate(s.orgId, Number(str(formData, 'allocation_id')), actorOf(s)));
  back(str(formData, 'return_to') || '/sales/payments', r.error ? r : { ok: 'Allocation removed.' });
}

export async function applyCreditAction(formData: FormData) {
  const s = await requireCap('payment.create');
  const r = await guard(async () => await applyCreditNote(
    s.orgId, str(formData, 'credit_id'), str(formData, 'invoice_id'), money(formData, 'amount'), actorOf(s),
  ));
  back(str(formData, 'return_to') || '/sales/credit-notes', r.error ? r : { ok: 'Credit applied.' });
}

export async function reversePaymentAction(formData: FormData) {
  const s = await requireCap('payment.approve');
  const r = await guard(async () => await reversePayment(
    s.orgId, str(formData, 'id'), str(formData, 'date') || isoDate(), actorOf(s), opt(formData, 'reason') ?? undefined,
  ));
  back(str(formData, 'return_to') || '/sales/payments', r.error ? r : { ok: 'Payment reversed.' });
}

// ---------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------

export async function saveJournalEntryAction(formData: FormData) {
  const s = await requireCap('journal.create');
  const accounts = formData.getAll('line_account').map(String);
  const debits = formData.getAll('line_debit').map(String);
  const credits = formData.getAll('line_credit').map(String);
  const labels = formData.getAll('line_label').map(String);
  const partnerNames = formData.getAll('line_partner').map(String);
  const analytics = formData.getAll('line_analytic').map(String);
  // Typed, not chosen — but unlike a document's customer/supplier this tag is
  // optional, so a name that matches nothing just leaves the line untagged
  // rather than minting a partner record nobody meant to create.
  const partnerIds = await Promise.all(partnerNames.map((n) => findPartnerIdByName(s.orgId, n)));

  const lines = accounts.map((accountId, i) => ({
    accountId,
    debit: toMinor(debits[i] || '0'),
    credit: toMinor(credits[i] || '0'),
    label: labels[i] || null,
    partnerId: partnerIds[i] ?? null,
    analyticId: analytics[i] || null,
  })).filter((l) => l.accountId && (l.debit !== 0 || l.credit !== 0));

  const input = {
    orgId: s.orgId,
    journalId: str(formData, 'journal_id'),
    date: str(formData, 'date') || isoDate(),
    reference: opt(formData, 'reference'),
    narration: opt(formData, 'narration'),
    sourceModel: 'manual',
    lines,
  };

  const postNow = bool(formData, 'post_now');
  if (postNow) await requireCap('journal.post');
  const r = await guard(async () => (postNow ? await postEntry(input, actorOf(s)) : await draftEntry(input, actorOf(s))));
  if (r.error) back('/accounting/entries/new', r);
  back(`/accounting/entries/${r.value}`, { ok: postNow ? 'Posted.' : 'Saved as draft.' });
}

export async function postEntryAction(formData: FormData) {
  const s = await requireCap('journal.post');
  const entryId = str(formData, 'id');
  const r = await guard(async () => await postDraft(s.orgId, entryId, actorOf(s)));
  back(str(formData, 'return_to') || `/accounting/entries/${entryId}`, r.error ? r : { ok: 'Posted.' });
}

export async function reverseEntryAction(formData: FormData) {
  const s = await requireCap('journal.post');
  const entryId = str(formData, 'id');
  const r = await guard(async () => await reverseEntry(
    s.orgId, entryId, str(formData, 'date') || isoDate(), actorOf(s), opt(formData, 'reason') ?? undefined,
  ));
  back(`/accounting/entries/${entryId}`, r.error ? r : { ok: 'Reversed.' });
}

// ---------------------------------------------------------------------------
// Banking
// ---------------------------------------------------------------------------

export async function importStatementAction(formData: FormData) {
  const s = await requireCap('bank.reconcile');
  const bankAccountId = str(formData, 'bank_account_id');
  const file = formData.get('file');
  const pasted = str(formData, 'csv');

  const text = file instanceof File && file.size > 0 ? await file.text() : pasted;
  if (!text) back(`/banking/${bankAccountId}`, { error: 'Choose a CSV file, or paste the rows.' });

  const parsed = parseStatementCsv(text);
  if (!parsed.rows.length) {
    back(`/banking/${bankAccountId}`, { error: parsed.errors[0] ?? 'Nothing could be read from that file.' });
  }
  const r = await guard(async () => await importStatement(s.orgId, bankAccountId, parsed.rows, actorOf(s)));
  if (r.error) back(`/banking/${bankAccountId}`, r);
  back(`/banking/reconcile?account=${bankAccountId}`, {
    ok: `${r.value!.imported} line(s) imported${r.value!.skipped ? `, ${r.value!.skipped} duplicate(s) skipped` : ''}.`,
  });
}

export async function reconcileAction(formData: FormData) {
  const s = await requireCap('bank.reconcile');
  const txnId = str(formData, 'txn_id');
  const mode = str(formData, 'mode');
  const returnTo = str(formData, 'return_to') || '/banking/reconcile';

  const r = await guard(async () => {
    if (mode === 'payment') return await matchToPayment(s.orgId, txnId, str(formData, 'payment_id'), actorOf(s));
    if (mode === 'account') {
      return await reconcileToAccount(s.orgId, txnId, str(formData, 'account_id'),
        str(formData, 'label') || 'Bank entry', actorOf(s));
    }
    // The Suggested row already resolved a partner and sends its id directly;
    // the manual form below it only has a typed name plus the side implied by
    // which half of the screen (money in/out) it is in.
    const partnerId = opt(formData, 'partner_id')
      ?? await resolvePartnerByName(
        s.orgId, str(formData, 'partner_name'),
        str(formData, 'side') === 'supplier' ? 'supplier' : 'customer', actorOf(s),
      );
    return await reconcileAsPayment(s.orgId, txnId, {
      partnerId,
      documentId: opt(formData, 'document_id'),
      isAdvance: bool(formData, 'is_advance'),
    }, actorOf(s));
  });
  back(returnTo, r.error ? r : { ok: 'Reconciled.' });
}

export async function transferAction(formData: FormData) {
  const s = await requireCap('payment.create');
  const r = await guard(async () => await transfer(s.orgId, {
    fromBankAccountId: str(formData, 'from_id'),
    toBankAccountId: str(formData, 'to_id'),
    date: str(formData, 'date') || isoDate(),
    amount: money(formData, 'amount'),
    note: opt(formData, 'note') ?? undefined,
  }, actorOf(s)));
  back('/banking', r.error ? r : { ok: 'Transfer posted.' });
}

// ---------------------------------------------------------------------------
// Periods, opening balances, year end
// ---------------------------------------------------------------------------

export async function setPeriodStateAction(formData: FormData) {
  const s = await requireCap('period.close');
  const state = str(formData, 'state') as 'open' | 'locked' | 'closed';
  const r = await guard(async () => await setPeriodState(s.orgId, str(formData, 'id'), state, actorOf(s)));
  back('/accounting/periods', r.error ? r : { ok: `Period ${state}.` });
}

export async function closeYearAction(formData: FormData) {
  const s = await requireCap('period.close');
  const r = await guard(async () => await closeFiscalYear(s.orgId, str(formData, 'id'), actorOf(s)));
  back('/accounting/periods', r.error ? r : { ok: 'Year closed and rolled into retained earnings.' });
}

export async function createFiscalYearAction(formData: FormData) {
  const s = await requireCap('period.close');
  const r = await guard(async () => await createFiscalYear(s.orgId, str(formData, 'start') || isoDate(), actorOf(s)));
  back('/accounting/periods', r.error ? r : { ok: 'Fiscal year created with twelve periods.' });
}

export async function openingBalancesAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  const accounts = formData.getAll('line_account').map(String);
  const debits = formData.getAll('line_debit').map(String);
  const credits = formData.getAll('line_credit').map(String);
  const lines = accounts.map((accountId, i) => ({
    accountId,
    debit: toMinor(debits[i] || '0'),
    credit: toMinor(credits[i] || '0'),
  })).filter((l) => l.accountId && (l.debit || l.credit));

  const r = await guard(async () => await postOpeningBalances(s.orgId, {
    date: str(formData, 'date') || isoDate(),
    lines,
    balancingAccountId: opt(formData, 'balancing_account_id'),
  }, actorOf(s)));
  back('/accounting/opening-balances', r.error ? r : { ok: 'Opening balances posted.' });
}

// ---------------------------------------------------------------------------
// Expenses, advances, commissions
// ---------------------------------------------------------------------------

export async function saveExpenseAction(formData: FormData) {
  const s = await requireCap('payment.create');
  const r = await guard(async () => {
    const expenseId = await createExpense({
      orgId: s.orgId,
      employeeName: str(formData, 'employee_name') || s.userName,
      description: str(formData, 'description'),
      expenseDate: str(formData, 'expense_date') || isoDate(),
      amount: money(formData, 'amount'),
      taxId: opt(formData, 'tax_id'),
      accountId: str(formData, 'account_id'),
      analyticId: opt(formData, 'analytic_id'),
      bookingId: opt(formData, 'booking_id'),
      paidBy: str(formData, 'paid_by') === 'company' ? 'company' : 'employee',
      journalId: opt(formData, 'journal_id'),
    }, actorOf(s));
    await submitExpense(s.orgId, expenseId, actorOf(s));
    return expenseId;
  });
  back(r.error ? '/expenses/new' : '/expenses', r.error ? r : { ok: 'Expense submitted.' });
}

export async function expenseWorkflowAction(formData: FormData) {
  const action = str(formData, 'action');
  const expenseId = str(formData, 'id');
  const s = await requireCap(action === 'approve' || action === 'refuse' ? 'payment.approve' : 'payment.create');
  const r = await guard(async () => {
    if (action === 'approve') return await approveExpense(s.orgId, expenseId, actorOf(s));
    if (action === 'refuse') return await refuseExpense(s.orgId, expenseId, str(formData, 'reason') || 'Refused', actorOf(s));
    if (action === 'submit') return await submitExpense(s.orgId, expenseId, actorOf(s));
    return await reimburseExpense(s.orgId, expenseId, {
      date: str(formData, 'date') || isoDate(),
      journalId: str(formData, 'journal_id'),
    }, actorOf(s));
  });
  back(str(formData, 'return_to') || '/expenses', r.error ? r : { ok: 'Done.' });
}

export async function employeeAdvanceAction(formData: FormData) {
  const s = await requireCap('payment.create');
  const r = await guard(async () => await payEmployeeAdvance(s.orgId, {
    employeeName: str(formData, 'employee_name'),
    amount: money(formData, 'amount'),
    date: str(formData, 'date') || isoDate(),
    journalId: str(formData, 'journal_id'),
    note: opt(formData, 'note') ?? undefined,
  }, actorOf(s)));
  back(r.error ? '/expenses/new?tab=advance' : '/expenses', r.error ? r : { ok: 'Advance paid.' });
}

export async function commissionAction(formData: FormData) {
  const s = await requireCap('payment.create');
  const r = await guard(async () => {
    if (str(formData, 'action') === 'post') {
      return await postCommission(s.orgId, str(formData, 'id'), str(formData, 'date') || isoDate(), actorOf(s));
    }
    return await createCommission(s.orgId, {
      agentName: str(formData, 'agent_name'),
      bookingId: str(formData, 'booking_id'),
      basis: str(formData, 'basis') === 'revenue' ? 'revenue' : 'profit',
      rateBps: Math.round(parseFloat(str(formData, 'rate') || '0') * 100),
      fixedAmount: money(formData, 'fixed_amount'),
      dueDate: opt(formData, 'due_date'),
    }, actorOf(s));
  });
  back('/commissions', r.error ? r : { ok: 'Done.' });
}

// ---------------------------------------------------------------------------
// Assets and deferrals
// ---------------------------------------------------------------------------

export async function saveAssetAction(formData: FormData) {
  const s = await requireCap('journal.create');
  const r = await guard(async () => {
    const assetId = await createAsset({
      orgId: s.orgId,
      name: str(formData, 'name'),
      assetAccountId: str(formData, 'asset_account_id'),
      depreciationAccountId: str(formData, 'depreciation_account_id'),
      expenseAccountId: str(formData, 'expense_account_id'),
      journalId: opt(formData, 'journal_id'),
      purchaseDate: str(formData, 'purchase_date') || isoDate(),
      purchaseValue: money(formData, 'purchase_value'),
      salvageValue: money(formData, 'salvage_value'),
      method: str(formData, 'method') === 'declining' ? 'declining' : 'straight_line',
      lifeMonths: Number(str(formData, 'life_months') || '36'),
      decliningBps: Math.round(parseFloat(str(formData, 'declining_rate') || '0') * 100),
    }, actorOf(s));
    if (bool(formData, 'confirm_now')) await confirmAsset(s.orgId, assetId, actorOf(s));
    return assetId;
  });
  back(r.error ? '/assets/new?tab=assets' : '/assets?tab=assets',
    r.error ? r : { ok: 'Asset created with its schedule.' });
}

export async function runDepreciationAction(formData: FormData) {
  const s = await requireCap('journal.post');
  const r = await guard(async () => await runDepreciation(s.orgId, str(formData, 'up_to') || isoDate(), actorOf(s)));
  back('/assets', r.error ? r : { ok: `${r.value ?? 0} depreciation entr(ies) posted.` });
}

export async function saveDeferralAction(formData: FormData) {
  const s = await requireCap('journal.create');
  const r = await guard(async () => await createDeferral({
    orgId: s.orgId,
    name: str(formData, 'name'),
    kind: str(formData, 'kind') === 'revenue' ? 'revenue' : 'expense',
    balanceAccountId: str(formData, 'balance_account_id'),
    recognitionAccountId: str(formData, 'recognition_account_id'),
    journalId: opt(formData, 'journal_id'),
    amount: money(formData, 'amount'),
    dateFrom: str(formData, 'date_from') || isoDate(),
    months: Number(str(formData, 'months') || '12'),
  }, actorOf(s)));
  back(r.error ? '/assets/new?tab=deferrals' : '/assets?tab=deferrals',
    r.error ? r : { ok: 'Deferral scheduled.' });
}

export async function runDeferralsAction(formData: FormData) {
  const s = await requireCap('journal.post');
  const r = await guard(async () => await runDeferrals(s.orgId, str(formData, 'up_to') || isoDate(), actorOf(s)));
  back('/assets', r.error ? r : { ok: `${r.value ?? 0} slice(s) recognised.` });
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export async function saveAccountAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  const r = await guard(async () => await upsertAccount(s.orgId, {
    id: opt(formData, 'id') ?? undefined,
    code: str(formData, 'code'),
    name: str(formData, 'name'),
    kind: str(formData, 'kind'),
    reconcilable: bool(formData, 'reconcilable'),
    description: opt(formData, 'description'),
    defaultHsnCode: opt(formData, 'default_hsn_code'),
  }, actorOf(s)));
  // A failure bounces back to the FORM, not to the list. Sending it to the list
  // would show the reason the save failed on a page with no way to act on it,
  // having thrown away everything that was typed.
  back(r.error ? '/accounting/chart-of-accounts/new' : '/accounting/chart-of-accounts',
    r.error ? r : { ok: 'Account created.' });
}

/**
 * The "Allow Reconciliation" switch on the Chart of Accounts.
 *
 * The form sends the state it WANTS, not a "flip it" instruction. Two
 * accountants on the same screen both pressing the same switch then agree on
 * the outcome instead of racing to undo each other.
 */
export async function setReconcilableAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  const accountId = str(formData, 'id');
  const on = str(formData, 'on') === '1';
  const r = await guard(async () => await setAccountReconcilable(s.orgId, accountId, on, actorOf(s)));
  back(str(formData, 'return_to') || '/accounting/chart-of-accounts',
    r.error ? r : { ok: on ? 'Reconciliation allowed on this account.' : 'Reconciliation switched off.' });
}

/**
 * The "Default HSN / SAC" box on the Chart of Accounts.
 *
 * Inline on the row rather than on a form of its own, because setting these is
 * one pass down the chart — a dozen revenue and cost accounts, one code each,
 * done once — and a page per account would make that a dozen round trips
 * through a form with nine other fields on it.
 */
export async function setAccountHsnAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  const accountId = str(formData, 'id');
  const r = await guard(async () => await setAccountDefaultHsn(
    s.orgId, accountId, opt(formData, 'default_hsn_code'), actorOf(s),
  ));
  back(str(formData, 'return_to') || '/accounting/chart-of-accounts',
    r.error ? r : { ok: 'Default HSN / SAC saved.' });
}

export async function saveJournalAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  const r = await guard(async () => await upsertJournal(s.orgId, {
    id: opt(formData, 'id') ?? undefined,
    code: str(formData, 'code').toUpperCase(),
    name: str(formData, 'name'),
    type: str(formData, 'type'),
    defaultAccountId: opt(formData, 'default_account_id'),
  }, actorOf(s)));
  back(r.error ? '/accounting/journals/new' : '/accounting/journals',
    r.error ? r : { ok: 'Journal created.' });
}

export async function savePartnerAction(formData: FormData) {
  const s = await requireCap('finance.view');
  const side = str(formData, 'side');
  const r = await guard(async () => await upsertPartner(s.orgId, {
    id: opt(formData, 'id') ?? undefined,
    name: str(formData, 'name'),
    isCustomer: side !== 'supplier',
    isSupplier: side === 'supplier' || bool(formData, 'is_supplier'),
    partnerType: str(formData, 'partner_type') || 'b2c',
    email: opt(formData, 'email'),
    phone: opt(formData, 'phone'),
    gstin: opt(formData, 'gstin'),
    pan: opt(formData, 'pan'),
    address: opt(formData, 'address'),
    creditLimit: money(formData, 'credit_limit'),
    tdsSection: opt(formData, 'tds_section'),
    paymentTermsId: opt(formData, 'payment_terms_id'),
    gstName: opt(formData, 'gst_name'),
    city: opt(formData, 'city'),
    stateCode: opt(formData, 'state_code'),
    shippingAddress: opt(formData, 'shipping_address'),
  }, actorOf(s)));
  back(side === 'supplier' ? '/purchases/suppliers' : '/sales/customers', r.error ? r : { ok: 'Saved.' });
}

export async function saveTaxAction(formData: FormData) {
  const s = await requireCap('tax.configure');
  const r = await guard(async () => {
    const taxId = opt(formData, 'id');
    const fields: Array<string | number | null> = [
      str(formData, 'name'),
      Math.round(parseFloat(str(formData, 'rate') || '0') * 100),
      str(formData, 'scope'),
      str(formData, 'tax_group'),
      bool(formData, 'price_included') ? 1 : 0,
      opt(formData, 'account_id'),
      money(formData, 'threshold'),
    ];
    if (taxId) {
      await run(`UPDATE taxes SET name=?, rate_bps=?, scope=?, tax_group=?, price_included=?, account_id=?, threshold=?
             WHERE id=? AND org_id=?`, ...fields, taxId, s.orgId);
      return taxId;
    }
    const newId = id('tax');
    await run(`INSERT INTO taxes (id, org_id, name, computation, rate_bps, scope, tax_group,
                            price_included, account_id, threshold, active)
         VALUES (?,?,?,'percent',?,?,?,?,?,?,1)`,
      newId, s.orgId, fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[6]);
    return newId;
  });
  back(r.error ? '/taxes/new' : '/taxes', r.error ? r : { ok: 'Tax created.' });
}

export async function saveProductAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  const r = await guard(async () => await upsertProduct(s.orgId, {
    id: opt(formData, 'id') ?? undefined,
    name: str(formData, 'name'),
    category: str(formData, 'category') || 'other',
    salePrice: money(formData, 'sale_price'),
    costPrice: money(formData, 'cost_price'),
    incomeAccountId: opt(formData, 'income_account_id'),
    expenseAccountId: opt(formData, 'expense_account_id'),
    saleTaxId: opt(formData, 'sale_tax_id'),
    purchaseTaxId: opt(formData, 'purchase_tax_id'),
    hsnCode: opt(formData, 'hsn_code'),
    mrp: money(formData, 'mrp'),
    variant: opt(formData, 'variant'),
  }, actorOf(s)));
  back(r.error ? '/settings/products/new' : '/settings/products',
    r.error ? r : { ok: 'Product created.' });
}

export async function createBookingAction(formData: FormData) {
  const s = await requireCap('finance.view');
  const r = await guard(async () => await createBooking(s.orgId, {
    ref: str(formData, 'ref'),
    title: str(formData, 'title'),
    customerName: opt(formData, 'customer_name'),
    destination: opt(formData, 'destination'),
    packageName: opt(formData, 'package_name'),
    agentName: opt(formData, 'agent_name'),
    branch: opt(formData, 'branch'),
    pax: Number(str(formData, 'pax') || '1'),
    startDate: opt(formData, 'start_date'),
    endDate: opt(formData, 'end_date'),
    sellValue: money(formData, 'sell_value'),
  }, actorOf(s)));
  if (r.error) back('/bookings/new', r);
  back(`/bookings/${r.value}`, { ok: 'Booking created with its trip analytic account.' });
}

export async function saveBudgetAction(formData: FormData) {
  const s = await requireCap('budget.manage');
  const accounts = formData.getAll('line_account').map(String);
  const analytics = formData.getAll('line_analytic').map(String);
  const planned = formData.getAll('line_planned').map(String);
  const r = await guard(async () => await createBudget(s.orgId, {
    name: str(formData, 'name'),
    owner: opt(formData, 'owner'),
    dateFrom: str(formData, 'date_from'),
    dateTo: str(formData, 'date_to'),
    lines: accounts.map((a, i) => ({
      accountId: a || null,
      analyticId: analytics[i] || null,
      planned: toMinor(planned[i] || '0'),
    })).filter((l) => l.planned !== 0),
  }, actorOf(s)));
  back(r.error ? '/budgets/new' : '/budgets', r.error ? r : { ok: 'Budget created.' });
}

export async function saveSettingsAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  const r = await guard(async () => {
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith('setting.') || typeof value !== 'string' || !value) continue;
      await setSetting(s.orgId, key.slice('setting.'.length) as SettingKey, value);
    }
  });
  back('/settings/accounts', r.error ? r : { ok: 'Defaults saved.' });
}

/**
 * Wipe and re-seed.
 *
 * A developer convenience, and gated behind the capability an ordinary agent
 * will never hold — but it is destructive by design, so the screen asks for a
 * typed confirmation before it calls this.
 */
export async function resetAction(formData: FormData) {
  await requireCap('coa.configure');
  if (str(formData, 'confirm') !== 'RESET') back('/settings', { error: 'Type RESET to confirm.' });
  const r = await guard(async () => await resetAndSeed());
  back('/settings', r.error ? r : { ok: 'Books reset and re-seeded.' });
}

// ---------------------------------------------------------------------------
// TripzoCRM sync
// ---------------------------------------------------------------------------

/**
 * Sign in to the CRM and remember the session.
 *
 * `async` rather than sync because it is a network call, which is also why the
 * usual `guard()` cannot wrap it — that helper takes a synchronous thunk.
 */
export async function crmConnectAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  const email = str(formData, 'email');
  const password = String(formData.get('password') ?? '');
  if (!email || !password) back('/settings/crm-sync', { error: 'Email and password are both needed.' });
  try {
    await connectCrm(s.orgId, email, password);
  } catch (e) {
    // The message is shown to a person, so it must not carry the password or a
    // stack. client.ts already writes these for a reader.
    back('/settings/crm-sync', { error: e instanceof Error ? e.message : 'Could not connect.' });
  }
  back('/settings/crm-sync', { ok: `Connected to TripzoCRM as ${email}.` });
}

/**
 * The Settings → CRM Sync button. The same run as `importFromCrmAction`.
 *
 * ONE IMPLEMENTATION, TWO DOORS. A second copy of the summary-building and the
 * error handling is a second place for them to disagree about what a run did,
 * which on a screen reporting an import is the one thing that must not happen.
 */
export async function crmSyncAction() {
  const f = new FormData();
  f.set('return_to', 'settings');
  await importFromCrmAction(f);
}

export async function crmDisconnectAction() {
  const s = await requireCap('coa.configure');
  const r = await guard(async () => await disconnectCrm(s.orgId));
  back('/settings/crm-sync', r.error ? r : { ok: 'Disconnected. The stored token has been deleted.' });
}

export async function crmForgetLinksAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  if (str(formData, 'confirm') !== 'FORGET') {
    back('/settings/crm-sync', { error: 'Type FORGET to confirm.' });
  }
  const r = await guard(async () => await forgetSyncLinks(s.orgId));
  back('/settings/crm-sync', r.error ? r : { ok: 'Import history cleared. The next sync will re-import everything.' });
}

void ctx;

// ---------------------------------------------------------------------------
// Configuration — the agency, its accounts, its series, its dimensions
// ---------------------------------------------------------------------------
/*
 * Everything below exists because the alternative was a seed script. A product
 * that serves one agency can be configured by whoever deploys it; a product
 * that serves fifty cannot, and every one of these actions replaces a row that
 * used to be typed into src/server/seed.ts by hand.
 */

export async function saveOrganisationAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  const r = await guard(async () => await updateOrganisation(s.orgId, {
    name: str(formData, 'name'),
    legalName: opt(formData, 'legal_name'),
    gstin: opt(formData, 'gstin'),
    pan: opt(formData, 'pan'),
    stateCode: opt(formData, 'state_code'),
    country: opt(formData, 'country'),
    currency: str(formData, 'currency') || undefined,
    fyStartMonth: Number(str(formData, 'fy_start_month') || '0') || undefined,
    address: opt(formData, 'address'),
    city: opt(formData, 'city'),
    email: opt(formData, 'email'),
    phone: opt(formData, 'phone'),
    website: opt(formData, 'website'),
    invoiceTerms: opt(formData, 'invoice_terms'),
    invoiceFooter: opt(formData, 'invoice_footer'),
    defaultHsnCode: opt(formData, 'default_hsn_code'),
  }, actorOf(s)));
  back('/settings/organisation', r.error ? r : { ok: 'Agency details saved.' });
}

export async function saveBankAccountAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  const r = await guard(async () => await upsertBankAccount(s.orgId, {
    id: opt(formData, 'id') ?? undefined,
    name: str(formData, 'name'),
    bankName: opt(formData, 'bank_name'),
    accountNo: opt(formData, 'account_no'),
    ifsc: opt(formData, 'ifsc'),
    branchName: opt(formData, 'branch_name'),
    swift: opt(formData, 'swift'),
    upiId: opt(formData, 'upi_id'),
    note: opt(formData, 'note'),
    currency: str(formData, 'currency') || 'INR',
    isCash: str(formData, 'kind') === 'cash',
    isDefault: bool(formData, 'is_default'),
  }, actorOf(s)));
  back('/settings/bank-accounts', r.error ? r : {
    ok: opt(formData, 'id')
      ? 'Account updated.'
      : 'Account added, with its ledger account and its own journal.',
  });
}

export async function setDefaultBankAccountAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  const r = await guard(async () => await setDefaultBankAccount(s.orgId, str(formData, 'id'), actorOf(s)));
  back('/settings/bank-accounts', r.error ? r : { ok: 'Default account changed.' });
}

export async function archiveBankAccountAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  const r = await guard(async () => await archiveBankAccount(s.orgId, str(formData, 'id'), actorOf(s)));
  back('/settings/bank-accounts', r.error ? r : { ok: 'Account archived. Its history is untouched.' });
}

export async function savePaymentTermAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  const r = await guard(async () => await upsertPaymentTerm(s.orgId, {
    id: opt(formData, 'id') ?? undefined,
    name: str(formData, 'name'),
    days: Number(str(formData, 'days') || '0'),
    note: opt(formData, 'note'),
  }, actorOf(s)));
  back('/settings/payment-terms', r.error ? r : { ok: 'Payment term saved.' });
}

export async function archivePaymentTermAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  const r = await guard(async () => await archivePaymentTerm(s.orgId, str(formData, 'id'), actorOf(s)));
  back('/settings/payment-terms', r.error ? r : { ok: 'Term archived.' });
}

/**
 * Save every series on the Numbering screen in one submit.
 *
 * One form, not one per row: the prefixes an agency changes at a year end are
 * changed TOGETHER, and saving them one at a time is how half a chart ends up
 * on the new financial year and half on the old.
 */
export async function saveNumberingAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  const codes = formData.getAll('seq_code').map(String);
  const prefixes = formData.getAll('seq_prefix').map(String);
  const paddings = formData.getAll('seq_padding').map(String);
  const nexts = formData.getAll('seq_next').map(String);
  const r = await guard(async () => {
    for (let i = 0; i < codes.length; i += 1) {
      await updateSequence(s.orgId, {
        code: codes[i],
        prefix: prefixes[i] ?? '',
        padding: Number(paddings[i] || '5'),
        nextNo: Number(nexts[i] || '1'),
      }, actorOf(s));
    }
  });
  back('/settings/numbering', r.error ? r : { ok: 'Numbering saved.' });
}

export async function saveAnalyticAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  const r = await guard(async () => await upsertAnalyticAccount(s.orgId, {
    id: opt(formData, 'id') ?? undefined,
    planCode: str(formData, 'plan_code'),
    code: str(formData, 'code'),
    name: str(formData, 'name'),
  }, actorOf(s)));
  back('/settings/dimensions', r.error ? r : { ok: 'Saved.' });
}

export async function archiveAnalyticAction(formData: FormData) {
  const s = await requireCap('coa.configure');
  const r = await guard(async () => await archiveAnalyticAccount(s.orgId, str(formData, 'id'), actorOf(s)));
  back('/settings/dimensions', r.error ? r : { ok: 'Archived.' });
}

// ---------------------------------------------------------------------------
// Settlements — channel payout cycles
// ---------------------------------------------------------------------------

/**
 * WHICH CAPABILITY A SETTLEMENT NEEDS, and why it is the payment ones.
 *
 * Drafting a cycle moves nothing, so it sits with `payment.create` beside
 * receiving a receipt — which is what it is, a receipt with its deductions
 * written down. POSTING one books commission, GST, TCS and TDS and discharges
 * every invoice in the cycle, so it takes `payment.approve`: it is the single
 * largest entry this product writes from one click, and an agent who may raise
 * an invoice should not be the person who decides what a channel kept.
 */
export async function saveSettlementAction(formData: FormData) {
  const s = await requireCap('payment.create');
  const existing = opt(formData, 'id');
  const formPath = existing ? `/settlements/${existing}` : '/settlements/new';

  const r = await guard(async () => {
    const partnerId = await resolvePartnerByName(
      s.orgId, str(formData, 'partner_name'), 'customer', actorOf(s),
    );
    const input = {
      orgId: s.orgId,
      partnerId,
      cycleFrom: str(formData, 'cycle_from') || isoDate(),
      cycleTo: str(formData, 'cycle_to') || isoDate(),
      commissionBps: bps(formData, 'commission_pct'),
      chargeGstBps: bps(formData, 'charge_gst_pct'),
      shippingCharge: money(formData, 'shipping_charge'),
      returnCharge: money(formData, 'return_charge'),
      tcsBps: bps(formData, 'tcs_pct'),
      tdsBps: bps(formData, 'tds_pct'),
      previousUnsettled: money(formData, 'previous_unsettled'),
      payDate: opt(formData, 'pay_date'),
      utr: opt(formData, 'utr'),
      bankAccountId: opt(formData, 'bank_account_id'),
      journalId: await journalOfBankAccount(s.orgId, opt(formData, 'bank_account_id')),
      note: opt(formData, 'note'),
    };
    if (existing) { await updateSettlement(existing, input, actorOf(s)); return existing; }
    return await createSettlement(input, actorOf(s));
  });
  if (r.error) back(formPath, r);
  back(`/settlements/${r.value}`, { ok: 'Saved.' });
}

export async function postSettlementAction(formData: FormData) {
  const s = await requireCap('payment.approve');
  const settlementId = str(formData, 'id');
  const r = await guard(async () => await postSettlement(s.orgId, settlementId, actorOf(s)));
  back(`/settlements/${settlementId}`, r.error ? r : { ok: 'Settlement posted to the ledger.' });
}

export async function reverseSettlementAction(formData: FormData) {
  const s = await requireCap('payment.approve');
  const settlementId = str(formData, 'id');
  const r = await guard(async () => await reverseSettlement(
    s.orgId, settlementId, str(formData, 'date') || isoDate(), actorOf(s),
    opt(formData, 'reason') ?? undefined,
  ));
  back(`/settlements/${settlementId}`, r.error ? r : { ok: 'Reversed.' });
}

export async function refillSettlementAction(formData: FormData) {
  const s = await requireCap('payment.create');
  const settlementId = str(formData, 'id');
  const r = await guard(async () => await pullDocuments(s.orgId, settlementId, actorOf(s)));
  back(`/settlements/${settlementId}`, r.error ? r : { ok: 'Orders refreshed from the ledger.' });
}

export async function removeSettlementOrderAction(formData: FormData) {
  const s = await requireCap('payment.create');
  const settlementId = str(formData, 'settlement_id');
  const r = await guard(async () => await removeSettlementDocument(
    s.orgId, settlementId, str(formData, 'row_id'), actorOf(s),
  ));
  back(`/settlements/${settlementId}`, r.error ? r : { ok: 'Order removed.' });
}

/**
 * Save one charge row.
 *
 * An EMPTY amount deletes the row rather than storing a nil charge, because the
 * form draws every charge the catalogue knows and most of them are blank in any
 * given cycle. Keeping twenty zero rows per settlement would make the ledger's
 * audit trail unreadable and the statement no different.
 */
export async function saveSettlementChargeAction(formData: FormData) {
  const s = await requireCap('payment.create');
  const settlementId = str(formData, 'settlement_id');
  const amount = money(formData, 'amount');
  const existing = opt(formData, 'id');
  const r = await guard(async () => {
    if (!amount && existing) return await removeSettlementCharge(s.orgId, settlementId, existing, actorOf(s));
    if (!amount) return undefined;
    const gst = str(formData, 'gst_amount');
    return await saveSettlementCharge(s.orgId, settlementId, {
      id: existing,
      code: str(formData, 'code'),
      amount,
      // Blank means "work the GST out at the cycle's rate"; a typed figure,
      // zero included, is the channel's own and is taken as stated.
      gstAmount: gst === '' ? null : toMinor(gst),
      accountId: opt(formData, 'account_id'),
      note: opt(formData, 'note'),
    }, actorOf(s));
  });
  back(`/settlements/${settlementId}`, r.error ? r : { ok: 'Charge saved.' });
}
