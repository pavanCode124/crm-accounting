'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireCap, actorOf, ForbiddenError } from '@/server/auth';
import { ctx } from '@/server/bootstrap';
import { toMinor, qtyToMilli } from '@/lib/money';
import { isoDate, type DocType } from '@/lib/accounting';
import {
  createDocument, updateDocument, postDocument, reverseDocument, createCreditNote, getDocument,
} from '@/server/accounting/documents';
import {
  createPayment, postPayment, allocate, unallocate, applyCreditNote, reversePayment,
} from '@/server/accounting/payments';
import { draftEntry, postDraft, postEntry, reverseEntry } from '@/server/accounting/engine';
import {
  importStatement, parseStatementCsv, matchToPayment, reconcileAsPayment, reconcileToAccount, transfer,
} from '@/server/accounting/banking';
import { setPeriodState, closeFiscalYear, postOpeningBalances, createFiscalYear } from '@/server/accounting/periods';
import {
  createExpense, submitExpense, approveExpense, refuseExpense, reimburseExpense,
  payEmployeeAdvance, createCommission, postCommission,
} from '@/server/accounting/expenses';
import { createAsset, confirmAsset, runDepreciation, createDeferral, runDeferrals } from '@/server/accounting/assets';
import {
  upsertAccount, setAccountReconcilable, upsertJournal, upsertPartner, createBooking,
  upsertProduct, createBudget, resolvePartnerByName, findPartnerIdByName,
} from '@/server/accounting/masters';
import { setSetting, type SettingKey } from '@/server/accounting/settings';
import { resetAndSeed } from '@/server/seed';
import { run, id } from '@/server/db';
import { connect as connectCrm, disconnect as disconnectCrm } from '@/server/crm/connection';
import { syncFromCrm, forgetSyncLinks } from '@/server/crm/sync';

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

  return names.map((name, i) => ({
    name: name.trim(),
    qtyMilli: qtyToMilli(qtys[i] || '1'),
    unitPrice: toMinor(prices[i] || '0'),
    discountBps: Math.round(parseFloat(discounts[i] || '0') * 100),
    taxId: taxes[i] || null,
    accountId: accounts[i] || '',
    analyticId: analytics[i] || null,
  })).filter((l) => l.name && l.accountId && (l.unitPrice !== 0 || l.qtyMilli !== 0));
}

export async function saveDocumentAction(formData: FormData) {
  const docType = str(formData, 'doc_type') as DocType;
  const isBill = docType.startsWith('in_');
  const s = await requireCap(isBill ? 'bill.create' : 'invoice.create');
  const listPath = isBill ? '/purchases/bills' : '/sales/invoices';
  const existing = opt(formData, 'id');

  const lines = readLines(formData);
  if (!lines.length) back(`${listPath}/new`, { error: 'Add at least one line with a description and an account.' });

  const r = await guard(async () => {
    // Typed, not chosen from a dropdown: a name with no match on this side
    // becomes a new partner here, so the customer/supplier never has to exist
    // beforehand for the first document against them to be raised.
    const partnerId = await resolvePartnerByName(
      s.orgId, str(formData, 'partner_name'), isBill ? 'supplier' : 'customer', actorOf(s),
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
      lines,
    };
    if (existing) { await updateDocument(existing, input, actorOf(s)); return existing; }
    return await createDocument(input, actorOf(s));
  });
  if (r.error) back(`${listPath}/new`, r);

  const docId = r.value!;
  if (bool(formData, 'post_now')) {
    const posted = await guard(async () => await postDocument(s.orgId, docId, actorOf(s)));
    if (posted.error) back(`${listPath}/${docId}`, posted);
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
  const s = await requireCap('invoice.create');
  const sourceId = str(formData, 'id');
  const pctValue = parseFloat(str(formData, 'percent') || '100');
  const r = await guard(async () => {
    const noteId = await createCreditNote(s.orgId, sourceId, {
      date: str(formData, 'date') || isoDate(),
      bps: Math.round(pctValue * 100),
      reason: str(formData, 'reason') || 'Cancellation',
    }, actorOf(s));
    if (bool(formData, 'post_now')) await postDocument(s.orgId, noteId, actorOf(s));
    return noteId;
  });
  if (r.error) back(`/sales/invoices/${sourceId}`, r);
  const doc = await getDocument(s.orgId, r.value!);
  const path = doc?.doc_type === 'in_refund' ? '/purchases/debit-notes' : '/sales/credit-notes';
  back(`${path}/${r.value}`, { ok: 'Credit note created.' });
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
    const partnerId = await resolvePartnerByName(s.orgId, str(formData, 'partner_name'), side, actorOf(s));
    return await createPayment({
      orgId: s.orgId,
      direction,
      side,
      partnerId,
      journalId: str(formData, 'journal_id'),
      bankAccountId: opt(formData, 'bank_account_id'),
      bookingId: opt(formData, 'booking_id'),
      payDate: str(formData, 'pay_date') || isoDate(),
      amount,
      method: str(formData, 'method') || 'bank',
      reference: opt(formData, 'reference'),
      isAdvance: bool(formData, 'is_advance'),
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
      basis: str(formData, 'basis') === 'margin' ? 'margin' : 'revenue',
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
  back('/settings', r.error ? r : { ok: 'Settings saved.' });
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

export async function crmSyncAction() {
  const s = await requireCap('coa.configure');
  let summary: string;
  try {
    const r = await syncFromCrm(s.orgId, actorOf(s));
    summary =
      `Imported ${r.customers} customer(s), ${r.suppliers} supplier(s), ${r.bookings} booking(s), ` +
      `${r.invoices} invoice(s) and ${r.payments} payment(s) as DRAFTS — post them in ` +
      `Accounting → Review & Post. ${r.skipped} already present.` +
      (r.warnings.length ? ` ${r.warnings.length} warning(s) — see below.` : '');
  } catch (e) {
    back('/settings/crm-sync', { error: e instanceof Error ? e.message : 'Sync failed.' });
  }
  back('/settings/crm-sync', { ok: summary });
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
