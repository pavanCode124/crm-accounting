import 'server-only';
import { all, one, run, scalar, tx, id, nowIso } from '../db';
import { postEntry, reverseEntry, PostingError, type Actor } from './engine';
import { receivableAccount, payableAccount, requireSetting } from './settings';
import { refreshResidual, getDocument } from './documents';
import { audit } from './audit';

/**
 * Money in and money out — plan sections 15, 16, 11 and 14.
 *
 * FOUR CASES, AND THEY ARE GENUINELY DIFFERENT:
 *
 *   Customer payment      Bank Dr / AR Cr
 *   Customer ADVANCE      Bank Dr / Customer Advance Cr    (a LIABILITY)
 *   Supplier payment      AP Dr   / Bank Cr
 *   Supplier ADVANCE      Supplier Advance Dr / Bank Cr    (an ASSET)
 *
 * The advance cases are the ones travel agencies live on and the ones a naive
 * ledger gets wrong. Money taken before the service is delivered is NOT
 * revenue and NOT a reduction of a receivable that does not exist yet — it is
 * something the agency owes the customer until the trip is invoiced. Booking
 * it straight to AR produces a negative receivable, which flatters the balance
 * sheet and hides a real liability.
 *
 * Applying an advance later is therefore a real journal entry, not a note:
 *
 *   Customer Advance Dr / AR Cr
 */

export interface PaymentInput {
  orgId: string;
  direction: 'inbound' | 'outbound';
  /**
   * Which control account this settles against. Defaults from the direction,
   * which is right for the two common cases and wrong for the two refund ones
   * — so a caller settling a credit note passes it explicitly.
   */
  side?: 'customer' | 'supplier';
  partnerId: string;
  journalId: string;
  bankAccountId?: string | null;
  bookingId?: string | null;
  payDate: string;
  amount: number;
  currency?: string;
  rateE6?: number;
  method?: string;
  reference?: string | null;
  isAdvance?: boolean;
  note?: string | null;
  /** Documents to settle straight away, in the same transaction. */
  allocations?: Array<{ documentId: string; amount: number }>;
  /**
   * Post it, or leave it in draft for someone to review first.
   *
   * Defaults to true, which is what "Receive payment" on screen means: the
   * accountant filled the form, so the accountant decided. The CRM importer
   * passes false — a receipt that arrived from another system has not been
   * looked at by anybody here yet, and a draft is exactly the right shape for
   * "this is claimed, and not yet a fact in the books".
   */
  post?: boolean;
}

export interface PaymentRow {
  id: string; number: string | null; direction: string; side: string; partner_id: string;
  partner_name?: string; journal_id: string; bank_account_id: string | null;
  booking_id: string | null; pay_date: string; amount: number; currency: string;
  method: string; reference: string | null; is_advance: number; state: string;
  unallocated: number; entry_id: string | null; note: string | null;
  created_at: string; posted_at: string | null;
}

/**
 * Create, and post unless the caller asked for a draft.
 *
 * "Receive payment" on screen posts, because the person clicking it is the
 * person deciding. An import leaves the draft for that decision to be made.
 */
export async function createPayment(input: PaymentInput, actor: Actor = {}): Promise<string> {
  return await tx(async () => {
    if (input.amount <= 0) throw new PostingError('A payment must be for a positive amount.');

    const paymentId = id('pay');
    const number = await nextPaymentNumber(input.orgId, input.direction);
    const side = input.side ?? (input.direction === 'inbound' ? 'customer' : 'supplier');
    await run(
      `INSERT INTO payments
         (id, org_id, number, direction, side, partner_id, journal_id, bank_account_id, booking_id,
          pay_date, amount, currency, rate_e6, method, reference, is_advance, state,
          unallocated, note, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)`,
      paymentId, input.orgId, number, input.direction, side, input.partnerId, input.journalId,
      input.bankAccountId ?? null, input.bookingId ?? null, input.payDate, input.amount,
      input.currency ?? 'INR', input.rateE6 ?? 1_000_000, input.method ?? 'bank',
      input.reference ?? null, input.isAdvance ? 1 : 0, input.amount,
      input.note ?? null, actor.id ?? null, nowIso(),
    );

    // A draft payment allocates nothing: an allocation moves a document's
    // residual, and a residual that moved because of an unposted receipt is a
    // debtors list that disagrees with the ledger behind it.
    if (input.post === false) return paymentId;

    await postPayment(input.orgId, paymentId, actor);

    for (const a of input.allocations ?? []) {
      await allocate(input.orgId, paymentId, a.documentId, a.amount, actor);
    }
    return paymentId;
  });
}

async function nextPaymentNumber(orgId: string, direction: string): Promise<string> {
  const code = direction === 'inbound' ? 'pay_in' : 'pay_out';
  const prefix = direction === 'inbound' ? 'RCPT' : 'PAY';
  const seq = await one<{ next_no: number }>(
    'SELECT next_no FROM sequences WHERE org_id = ? AND code = ? FOR UPDATE', orgId, code,
  );
  if (!seq) {
    await run('INSERT INTO sequences (org_id, code, prefix, padding, next_no) VALUES (?,?,?,?,?)',
      orgId, code, prefix, 4, 2);
    return `${prefix}-0001`;
  }
  await run('UPDATE sequences SET next_no = next_no + 1 WHERE org_id = ? AND code = ?', orgId, code);
  return `${prefix}-${String(seq.next_no).padStart(4, '0')}`;
}

export async function postPayment(orgId: string, paymentId: string, actor: Actor = {}): Promise<string> {
  return await tx(async () => {
    const p = await one<PaymentRow>('SELECT * FROM payments WHERE id = ? AND org_id = ?', paymentId, orgId);
    if (!p) throw new PostingError('Unknown payment.');
    if (p.state !== 'draft') throw new PostingError('This payment is already posted.');

    const bank = await bankGlAccount(orgId, p);
    const inbound = p.direction === 'inbound';
    const customerSide = p.side !== 'supplier';

    // The account the OTHER side of the bank movement lands on. It follows the
    // SIDE, not the direction: a customer refund is money out of the bank and
    // out of receivables.
    const counterAccount = p.is_advance
      ? await requireSetting(orgId, customerSide ? 'account.customer_advance' : 'account.supplier_advance')
      : customerSide
        ? await receivableAccount(orgId, p.partner_id)
        : await payableAccount(orgId, p.partner_id);

    const label = `${p.number} · ${p.method}${p.reference ? ` · ${p.reference}` : ''}`;
    const entryId = await postEntry({
      orgId,
      journalId: p.journal_id,
      date: p.pay_date,
      reference: p.number,
      narration: p.is_advance
        ? `${customerSide ? 'Customer' : 'Supplier'} advance ${p.number}`
        : `${inbound ? 'Receipt' : 'Payment'} ${p.number}`,
      sourceModel: 'payment',
      sourceId: paymentId,
      currency: p.currency,
      lines: inbound
        ? [
          { accountId: bank, debit: p.amount, label, partnerId: p.partner_id, bookingId: p.booking_id },
          { accountId: counterAccount, credit: p.amount, label, partnerId: p.partner_id, bookingId: p.booking_id },
        ]
        : [
          { accountId: counterAccount, debit: p.amount, label, partnerId: p.partner_id, bookingId: p.booking_id },
          { accountId: bank, credit: p.amount, label, partnerId: p.partner_id, bookingId: p.booking_id },
        ],
    }, actor);

    await run(`UPDATE payments SET state='posted', entry_id=?, posted_by=?, posted_at=? WHERE id=?`,
      entryId, actor.id ?? null, nowIso(), paymentId);
    await audit(orgId, actor, 'posted', 'payment', paymentId, `${p.number} posted`);
    return entryId;
  });
}

async function bankGlAccount(orgId: string, p: PaymentRow): Promise<string> {
  if (p.bank_account_id) {
    const ba = await one<{ account_id: string }>(
      'SELECT account_id FROM bank_accounts WHERE id = ? AND org_id = ?', p.bank_account_id, orgId,
    );
    if (ba) return ba.account_id;
  }
  const j = await one<{ default_account_id: string | null }>(
    'SELECT default_account_id FROM journals WHERE id = ?', p.journal_id,
  );
  if (!j?.default_account_id) {
    throw new PostingError('This journal has no bank or cash account configured.');
  }
  return j.default_account_id;
}

/**
 * Allocate part of a payment to one document (plan section 16).
 *
 * Guards, in order, because each one is a real mistake someone makes:
 *   - not more than the payment still has unallocated
 *   - not more than the document still owes
 *   - not against a draft or cancelled document
 *
 * An ADVANCE allocation also moves money in the ledger: the liability the
 * agency was carrying becomes a settlement of the receivable. A plain payment
 * already debited bank and credited AR when it posted, so allocating it is
 * matching, not posting.
 */
export async function allocate(orgId: string, paymentId: string, documentId: string, amount: number, actor: Actor = {}) {
  return await tx(async () => {
    const p = await one<PaymentRow>('SELECT * FROM payments WHERE id = ? AND org_id = ?', paymentId, orgId);
    if (!p) throw new PostingError('Unknown payment.');
    if (p.state === 'draft') throw new PostingError('Post the payment before allocating it.');

    const doc = await getDocument(orgId, documentId);
    if (!doc) throw new PostingError('Unknown document.');
    if (doc.state !== 'posted') throw new PostingError('Only a posted document can be settled.');

    /*
     * THE CONTROL ACCOUNT MUST ALLOW RECONCILIATION.
     *
     * Settling a document IS reconciling: it matches this receipt's line
     * against that invoice's line on the same control account, and the
     * document's residual is the unmatched remainder. On an account not marked
     * reconcilable that remainder means nothing, so the switch on the Chart of
     * Accounts is checked here rather than being decoration.
     *
     * The message names the account and the screen, because the person who
     * hits this is almost always looking at a control account somebody created
     * last week and forgot to switch on.
     */
    const controlId = doc.doc_type.startsWith('out_')
      ? await receivableAccount(orgId, doc.partner_id)
      : await payableAccount(orgId, doc.partner_id);
    const control = await one<{ code: string; name: string; reconcilable: number }>(
      'SELECT code, name, reconcilable FROM accounts WHERE id = ?', controlId,
    );
    if (control && !control.reconcilable) {
      throw new PostingError(
        `${control.code} ${control.name} does not allow reconciliation, so nothing can be settled ` +
        'against it. Switch it on in Accounting → Chart of Accounts.',
      );
    }

    const unallocated = await paymentUnallocated(orgId, paymentId);
    if (amount <= 0) throw new PostingError('Allocate a positive amount.');
    if (amount > unallocated) {
      throw new PostingError(`Only ${(unallocated / 100).toFixed(2)} of this payment is unallocated.`);
    }
    if (amount > doc.residual) {
      throw new PostingError(`${doc.number} only owes ${(doc.residual / 100).toFixed(2)}.`);
    }

    if (p.is_advance) {
      // The swap follows the SIDE, not the direction: applying a customer
      // advance always clears the liability against receivables, whichever way
      // the cash originally moved.
      const customerSide = p.side !== 'supplier';
      const advance = await requireSetting(orgId, customerSide ? 'account.customer_advance' : 'account.supplier_advance');
      const partnerAccount = customerSide
        ? await receivableAccount(orgId, p.partner_id)
        : await payableAccount(orgId, p.partner_id);
      await postEntry({
        orgId,
        journalId: await requireSetting(orgId, 'journal.general'),
        date: doc.doc_date > p.pay_date ? doc.doc_date : p.pay_date,
        reference: `${p.number} → ${doc.number}`,
        narration: `Advance applied to ${doc.number}`,
        sourceModel: 'payment',
        sourceId: paymentId,
        lines: customerSide
          ? [
            { accountId: advance, debit: amount, partnerId: p.partner_id, label: `Advance applied to ${doc.number}` },
            { accountId: partnerAccount, credit: amount, partnerId: p.partner_id, label: doc.number ?? '' },
          ]
          : [
            { accountId: partnerAccount, debit: amount, partnerId: p.partner_id, label: doc.number ?? '' },
            { accountId: advance, credit: amount, partnerId: p.partner_id, label: `Advance applied to ${doc.number}` },
          ],
      }, actor);
    }

    await run(
      `INSERT INTO payment_allocations (org_id, payment_id, document_id, amount, at, by_user)
       VALUES (?,?,?,?,?,?)`,
      orgId, paymentId, documentId, amount, nowIso(), actor.id ?? null,
    );
    await run('UPDATE payments SET unallocated = ? WHERE id = ?', unallocated - amount, paymentId);
    if (unallocated - amount === 0) await run(`UPDATE payments SET state='reconciled' WHERE id=?`, paymentId);
    await refreshResidual(orgId, documentId);
    await audit(orgId, actor, 'allocated', 'payment', paymentId,
      `${(amount / 100).toFixed(2)} allocated to ${doc.number}`);
  });
}

export async function paymentUnallocated(orgId: string, paymentId: string): Promise<number> {
  const p = await one<{ amount: number }>('SELECT amount FROM payments WHERE id = ? AND org_id = ?', paymentId, orgId);
  if (!p) return 0;
  const used = await scalar('SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE payment_id = ?', paymentId);
  return p.amount - used;
}

/**
 * Apply a posted credit note against an invoice, with no money moving.
 *
 * Both documents already sit on the same receivable account with opposite
 * signs, so the ledger needs nothing further — this records WHICH invoice the
 * note settled, so the ageing report and the customer statement agree.
 */
export async function applyCreditNote(orgId: string, creditDocId: string, invoiceDocId: string, amount: number, actor: Actor = {}) {
  return await tx(async () => {
    const credit = await getDocument(orgId, creditDocId);
    const invoice = await getDocument(orgId, invoiceDocId);
    if (!credit || !invoice) throw new PostingError('Unknown document.');
    if (credit.state !== 'posted' || invoice.state !== 'posted') {
      throw new PostingError('Both documents must be posted.');
    }
    if (amount > credit.residual) throw new PostingError('The credit note does not have that much left.');
    if (amount > invoice.residual) throw new PostingError('The invoice does not owe that much.');

    const at = nowIso();
    await run(`INSERT INTO payment_allocations (org_id, credit_doc_id, document_id, amount, at, by_user)
         VALUES (?,?,?,?,?,?)`, orgId, creditDocId, invoiceDocId, amount, at, actor.id ?? null);
    // The note is consumed by the same mechanism, so its own residual falls.
    await run(`INSERT INTO payment_allocations (org_id, credit_doc_id, document_id, amount, at, by_user)
         VALUES (?,?,?,?,?,?)`, orgId, invoiceDocId, creditDocId, amount, at, actor.id ?? null);
    await refreshResidual(orgId, invoiceDocId);
    await refreshResidual(orgId, creditDocId);
    await audit(orgId, actor, 'allocated', 'document', creditDocId,
      `${(amount / 100).toFixed(2)} applied to ${invoice.number}`);
  });
}

/** Undo one allocation — the payment was matched to the wrong invoice. */
export async function unallocate(orgId: string, allocationId: number, actor: Actor = {}) {
  return await tx(async () => {
    const a = await one<{ payment_id: string | null; document_id: string; amount: number }>(
      'SELECT payment_id, document_id, amount FROM payment_allocations WHERE id = ? AND org_id = ?',
      allocationId, orgId,
    );
    if (!a) throw new PostingError('Unknown allocation.');
    await run('DELETE FROM payment_allocations WHERE id = ?', allocationId);
    if (a.payment_id) {
      await run(`UPDATE payments SET unallocated = ?, state = 'posted' WHERE id = ?`,
        await paymentUnallocated(orgId, a.payment_id), a.payment_id);
    }
    await refreshResidual(orgId, a.document_id);
    await audit(orgId, actor, 'unallocated', 'document', a.document_id, 'Allocation removed');
  });
}

export async function reversePayment(orgId: string, paymentId: string, date: string, actor: Actor = {}, reason?: string) {
  return await tx(async () => {
    const p = await one<PaymentRow>('SELECT * FROM payments WHERE id = ? AND org_id = ?', paymentId, orgId);
    if (!p) throw new PostingError('Unknown payment.');
    if (p.state === 'cancelled') throw new PostingError('Already cancelled.');
    for (const a of await all<{ id: number }>('SELECT id FROM payment_allocations WHERE payment_id = ?', paymentId)) {
      await unallocate(orgId, a.id, actor);
    }
    if (p.entry_id) await reverseEntry(orgId, p.entry_id, date, actor, reason);
    await run(`UPDATE payments SET state='cancelled' WHERE id=?`, paymentId);
    await audit(orgId, actor, 'reversed', 'payment', paymentId, reason ?? 'Payment reversed');
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getPayment(orgId: string, paymentId: string): Promise<PaymentRow | null> {
  return await one<PaymentRow>(
    `SELECT p.*, pt.name AS partner_name FROM payments p
       LEFT JOIN partners pt ON pt.id = p.partner_id
      WHERE p.id = ? AND p.org_id = ?`, paymentId, orgId,
  );
}

export async function listPayments(orgId: string, f: {
  direction?: 'inbound' | 'outbound';
  /** Prefer this over `direction` on the two payment screens: a customer
   *  refund is outbound money that still belongs on the Sales side. */
  side?: 'customer' | 'supplier';
  partnerId?: string; from?: string; to?: string;
  state?: string; unallocatedOnly?: boolean; limit?: number;
} = {}): Promise<PaymentRow[]> {
  const clauses = ['p.org_id = ?'];
  const params: Array<string | number> = [orgId];
  if (f.direction) { clauses.push('p.direction = ?'); params.push(f.direction); }
  if (f.side) { clauses.push('p.side = ?'); params.push(f.side); }
  if (f.partnerId) { clauses.push('p.partner_id = ?'); params.push(f.partnerId); }
  if (f.state) { clauses.push('p.state = ?'); params.push(f.state); }
  if (f.from) { clauses.push('p.pay_date >= ?'); params.push(f.from); }
  if (f.to) { clauses.push('p.pay_date <= ?'); params.push(f.to); }
  if (f.unallocatedOnly) clauses.push("p.unallocated > 0 AND p.state <> 'cancelled'");
  return await all<PaymentRow>(
    `SELECT p.*, pt.name AS partner_name FROM payments p
       LEFT JOIN partners pt ON pt.id = p.partner_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY p.pay_date DESC, p.created_at DESC LIMIT ${f.limit ?? 200}`,
    ...params,
  );
}

export async function allocationsFor(documentId: string) {
  return await all<{
    id: number; amount: number; at: string; payment_id: string | null;
    payment_number: string | null; pay_date: string | null; method: string | null;
    credit_doc_id: string | null; credit_number: string | null;
  }>(
    `SELECT a.id, a.amount, a.at, a.payment_id, p.number AS payment_number,
            p.pay_date, p.method, a.credit_doc_id, c.number AS credit_number
       FROM payment_allocations a
       LEFT JOIN payments p ON p.id = a.payment_id
       LEFT JOIN documents c ON c.id = a.credit_doc_id
      WHERE a.document_id = ? ORDER BY a.id`, documentId,
  );
}

export async function allocationsOfPayment(paymentId: string) {
  return await all<{ id: number; amount: number; document_id: string; number: string | null; doc_date: string }>(
    `SELECT a.id, a.amount, a.document_id, d.number, d.doc_date
       FROM payment_allocations a JOIN documents d ON d.id = a.document_id
      WHERE a.payment_id = ? ORDER BY a.id`, paymentId,
  );
}
