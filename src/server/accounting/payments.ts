import 'server-only';
import { all, one, run, scalar, tx, id, nowIso } from '../db';
import { postEntry, reverseEntry, PostingError, type Actor, type PostingLine } from './engine';
import { receivableAccount, payableAccount, requireSetting, getSetting } from './settings';
import { refreshResidual, getDocument, createDocument, postDocument } from './documents';
import { splitInclusive } from '../crm/packageTax';
import { getTax, computeLine } from './tax';
import { audit } from './audit';
import { formatDocNumber } from '@/lib/accounting';
import { roundHalfUp } from '@/lib/money';

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
  /**
   * The GST this advance carries — a tax row, exactly as an invoice line
   * carries one, so the rate, the CGST/SGST split and the accounts are all
   * configuration rather than numbers in this file.
   *
   * SERVICES ARE TAXED WHEN THE MONEY ARRIVES. Section 13(2) of the CGST Act
   * fixes the time of supply of a service at the EARLIER of the invoice or the
   * receipt of payment, and Notification 66/2017-CT — the one that stopped GST
   * being payable on advances — lifted it for GOODS only. A travel agency sells
   * services, so ₹47,200 taken in September against a trip in December is a
   * September liability, and `createPayment` is where that liability is
   * recognised. The receipt is also a statutory document in its own right under
   * section 31(3)(d): a RECEIPT VOUCHER, whose serial number is this payment's.
   *
   * CUSTOMER SIDE ONLY. An advance PAID to a supplier buys no input credit —
   * section 16(2)(a) and (b) make the credit depend on an invoice and on the
   * service having been received — so tagging one with tax here would book a
   * claim that does not exist yet. The supplier's own tax arrives with their
   * bill, and `postDocument` handles it there.
   */
  advanceTaxId?: string | null;
  /**
   * The place of supply as at the advance, which Rule 50 requires on the
   * receipt voucher and which decides CGST+SGST against IGST on it.
   *
   * Rule 50's two provisos cover the honest cases where it is not yet known at
   * all: where the rate is not determinable the advance is taxed at 18%, and
   * where the NATURE of the supply is not determinable it is treated as
   * inter-State. Both are choices the agency makes by picking the tax and the
   * state here; neither is guessed.
   */
  advancePlaceOfSupply?: string | null;
  /**
   * Set on a REFUND VOUCHER (section 31(3)(e)): the receipt it is giving back.
   *
   * The refund has to reverse the tax THAT RECEIPT carried rather than today's
   * rate, so it points at the receipt instead of carrying a rate of its own.
   */
  refundOf?: string | null;
  note?: string | null;
  /**
   * The document this money was received against, as the source system stated
   * it — for TripzoCRM, the invoice the receipt was recorded on.
   *
   * IT IS NOT AN ALLOCATION, and the difference is the whole point. An
   * allocation moves a document's residual and cannot exist until both sides
   * are posted; this is the INTENT, which arrives with the money and is kept
   * until the books can act on it. `settleTargeted` is what acts on it, from
   * whichever side posts last.
   *
   * Without it the importer threw the match away: TripzoCRM knew the ₹14,000
   * was for INV-000015, and this ledger drafted it as money from that customer
   * with nothing against it, so it stood in "Unallocated money" offering itself
   * to any open invoice they had.
   */
  targetDocumentId?: string | null;
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
  advance_tax_id: string | null; advance_tax_base: number; advance_tax_amount: number;
  advance_place_of_supply: string | null; refund_of: string | null;
  cancelled_by_doc_id: string | null;
  /** The document this money was received against. See `PaymentInput`. */
  target_document_id: string | null;
  created_at: string; posted_at: string | null;
  /** The trip this money is for — joined by listPayments, absent elsewhere. */
  trip_id?: string | null; trip_ref?: string | null; trip_title?: string | null;
  /**
   * The document this receipt was taken against, named — joined by
   * listPayments so a screen offering to allocate money can say what the money
   * already says it is for. `target_crm_number` is the number on the invoice
   * the agent raised, which is the one they recognise; `target_number` is this
   * ledger's, which is blank while that document is still a draft.
   */
  target_number?: string | null; target_state?: string | null;
  target_crm_number?: string | null;
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
    const side = input.side ?? (input.direction === 'inbound' ? 'customer' : 'supplier');
    const number = await nextPaymentNumber(input.orgId, input.direction, !!input.refundOf);

    /*
     * THE TAX IS WORKED OUT BEFORE THE ROW IS WRITTEN, so a receipt never
     * exists in a state where the bank figure and the split disagree.
     *
     * A refund voucher does not compute a rate of its own: it reverses the
     * receipt it is giving back, pro-rata, because the liability it releases is
     * the one THAT receipt created at THAT rate. Working it out afresh here
     * would quietly use today's rate to undo last September's tax.
     */
    let taxAmount = 0;
    let taxBase = 0;
    let splits: Array<{ taxId: string | null; name: string; group: string; rateBps: number; base: number; amount: number; accountId: string | null }> = [];
    if (input.refundOf) {
      const source = await one<PaymentRow>(
        'SELECT * FROM payments WHERE id = ? AND org_id = ?', input.refundOf, input.orgId,
      );
      if (!source) throw new PostingError('Unknown advance to refund against.');
      const share = shareOfAdvanceTax(await paymentTaxes(input.orgId, source.id), input.amount, source.amount);
      splits = share.map((r) => ({
        taxId: r.tax_id, name: r.tax_name, group: r.tax_group, rateBps: r.rate_bps,
        base: r.base, amount: r.amount, accountId: r.account_id,
      }));
      taxAmount = splits.reduce((t, x) => t + x.amount, 0);
      taxBase = splits.reduce((t, x) => Math.max(t, x.base), 0);
    } else if (input.isAdvance && input.advanceTaxId) {
      if (side !== 'customer') {
        throw new PostingError(
          'Only an advance RECEIVED from a customer carries GST. An advance paid to a supplier buys no ' +
          'input credit until their invoice arrives — section 16(2) — so the tax comes with the bill.',
        );
      }
      const computed = await splitAdvanceTax(input.orgId, input.advanceTaxId, input.amount);
      splits = computed.splits;
      taxAmount = computed.taxAmount;
      taxBase = computed.splits.reduce((t, x) => Math.max(t, x.base), 0);
    }

    await run(
      `INSERT INTO payments
         (id, org_id, number, direction, side, partner_id, journal_id, bank_account_id, booking_id,
          pay_date, amount, currency, rate_e6, method, reference, is_advance, state,
          unallocated, note, advance_tax_id, advance_tax_base, advance_tax_amount,
          advance_place_of_supply, refund_of, target_document_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?)`,
      paymentId, input.orgId, number, input.direction, side, input.partnerId, input.journalId,
      input.bankAccountId ?? null, input.bookingId ?? null, input.payDate, input.amount,
      input.currency ?? 'INR', input.rateE6 ?? 1_000_000, input.method ?? 'bank',
      input.reference ?? null, input.isAdvance ? 1 : 0, input.amount,
      input.note ?? null, input.advanceTaxId ?? null, taxBase, taxAmount,
      input.advancePlaceOfSupply ?? null, input.refundOf ?? null,
      input.targetDocumentId ?? null,
      actor.id ?? null, nowIso(),
    );
    for (const x of splits) {
      await run(
        `INSERT INTO payment_taxes (id, org_id, payment_id, tax_id, tax_name, tax_group, rate_bps, base, amount, account_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id('pt'), input.orgId, paymentId, x.taxId, x.name, x.group, x.rateBps, x.base, x.amount, x.accountId,
      );
    }

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

// ---------------------------------------------------------------------------
// GST on advances
// ---------------------------------------------------------------------------

/** One component of an advance's tax, as it was stored when the money arrived. */
export interface PaymentTaxRow {
  id: string; tax_id: string | null; tax_name: string; tax_group: string;
  rate_bps: number; base: number; amount: number; account_id: string | null;
}

export async function paymentTaxes(orgId: string, paymentId: string): Promise<PaymentTaxRow[]> {
  return await all<PaymentTaxRow>(
    `SELECT id, tax_id, tax_name, tax_group, rate_bps, base, amount, account_id
       FROM payment_taxes WHERE org_id = ? AND payment_id = ? ORDER BY id`, orgId, paymentId,
  );
}

/**
 * Back the tax out of an advance, because the money that arrived is inclusive
 * of it.
 *
 * THIS IS A DIVISION, NOT A MULTIPLICATION, and it is the same mistake the tax
 * engine warns about on a tax-included price. ₹47,200 received at 18% is
 * ₹40,000 of advance and ₹7,200 of tax — not ₹47,200 less 18%, which is
 * ₹38,704 and wrong by ₹1,296 on every receipt.
 *
 * It HAS to be inclusive. What the bank shows is what the customer actually
 * sent; there is no second payment coming for the tax on the first. The agency
 * is the one who owes the ₹7,200 out of it, which is why the liability it
 * carries to the traveller is ₹40,000 and not the whole ₹47,200.
 *
 * ROUNDING GOES TO THE ADVANCE, never to the tax. The tax figure is the one
 * that gets filed and the one the government reconciles; the advance is a
 * balance that will be cleared against an invoice or refunded in full either
 * way. So the components are computed from the backed-out base, summed, and the
 * remainder of the receipt is whatever is left — which is what keeps
 * `bank = advance + tax` true to the paisa on every receipt, with no plug line.
 */
export async function splitAdvanceTax(orgId: string, taxId: string, gross: number): Promise<{
  base: number; taxAmount: number; splits: Array<{ taxId: string; name: string; group: string; rateBps: number; base: number; amount: number; accountId: string | null }>;
}> {
  const tax = await getTax(orgId, taxId);
  if (!tax) throw new PostingError('Unknown tax on this advance.');
  if (tax.computation !== 'percent') {
    throw new PostingError('An advance can only carry a percentage tax — a fixed-amount tax has no base to back out.');
  }
  const base = roundHalfUp((gross * 10000) / (10000 + tax.rate_bps));
  const amounts = await computeLine(orgId, { qtyMilli: 1000, unitPrice: base, discountBps: 0, taxId });
  const splits = amounts.splits.map((x) => ({
    taxId: x.taxId, name: x.name, group: x.group, rateBps: x.rateBps,
    base: x.base, amount: x.amount, accountId: x.accountId,
  }));
  const taxAmount = splits.reduce((t, x) => t + x.amount, 0);
  if (taxAmount >= gross) {
    throw new PostingError('The tax on this advance comes to the whole receipt. Check the rate.');
  }
  return { base: gross - taxAmount, taxAmount, splits };
}

/**
 * The slice of an advance's tax that belongs to PART of it.
 *
 * An advance is rarely consumed in one go: ₹47,200 may settle an ₹11,800
 * cancellation invoice and be refunded as to the rest, and each of those two
 * events has to carry its own share of the ₹7,200 already paid to the
 * government — or the two halves together reverse more or less than was ever
 * charged.
 *
 * PRO-RATA ON THE GROSS, and the last component absorbs the rounding so the
 * parts always sum back to the whole. Distributing the remainder instead of
 * rounding each component independently is what stops a three-way split of a
 * receipt from losing a paisa that then has to be plugged at the ledger.
 */
export function shareOfAdvanceTax(rows: PaymentTaxRow[], part: number, whole: number): PaymentTaxRow[] {
  if (!rows.length || whole <= 0) return [];
  if (part >= whole) return rows;
  const total = rows.reduce((t, r) => t + r.amount, 0);
  const target = roundHalfUp((total * part) / whole);
  const out = rows.map((r) => ({
    ...r,
    base: roundHalfUp((r.base * part) / whole),
    amount: roundHalfUp((r.amount * part) / whole),
  }));
  const drift = target - out.reduce((t, r) => t + r.amount, 0);
  if (drift) out[out.length - 1].amount += drift;
  return out;
}

/**
 * The ledger lines an advance's tax produces, on whichever side it is needed.
 *
 * `credit` when the liability is being RECOGNISED (money arriving), `debit`
 * when it is being RELEASED — the advance applied to an invoice that now
 * charges the tax itself, or refunded under a refund voucher. Every line
 * carries `taxId` and `taxBase`, which is what puts it in the tax report
 * beside the invoices without a second query having to know it exists.
 */
function advanceTaxPostings(rows: PaymentTaxRow[], side: 'credit' | 'debit', base: {
  partnerId?: string | null; bookingId?: string | null; label: string;
}): PostingLine[] {
  return rows.filter((r) => r.amount !== 0).map((r) => {
    if (!r.account_id) {
      throw new PostingError(`Tax "${r.tax_name}" has no account configured, so the GST on this advance cannot be posted.`);
    }
    return {
      accountId: r.account_id,
      label: `${r.tax_name} \u00b7 ${base.label}`,
      partnerId: base.partnerId ?? null,
      bookingId: base.bookingId ?? null,
      taxId: r.tax_id,
      taxBase: r.base,
      ...(side === 'credit' ? { credit: r.amount } : { debit: r.amount }),
    };
  });
}

/**
 * The serial number on the voucher.
 *
 * THREE SERIES, NOT TWO, because a refund voucher is its own statutory
 * document. Section 31(3)(e) requires one whenever an advance is taken, no
 * supply follows and no invoice was ever issued, and Rule 51 requires it to
 * carry a consecutive serial number of its own. Numbering it in the outbound
 * payments series would have buried it among supplier payments, where neither
 * the agency nor an officer reconciling GSTR-1 Table 11B could find the set.
 */
async function nextPaymentNumber(orgId: string, direction: string, isRefundVoucher = false): Promise<string> {
  const code = isRefundVoucher ? 'pay_refund_voucher' : direction === 'inbound' ? 'pay_in' : 'pay_out';
  const prefix = isRefundVoucher ? 'RV' : direction === 'inbound' ? 'RCPT' : 'PAY';
  // Prefix and padding off the row — Settings → Numbering owns them once the
  // series exists. `prefix` above only seeds a series that is not there yet.
  const seq = await one<{ prefix: string; padding: number; next_no: number }>(
    'SELECT prefix, padding, next_no FROM sequences WHERE org_id = ? AND code = ? FOR UPDATE', orgId, code,
  );
  if (!seq) {
    await run('INSERT INTO sequences (org_id, code, prefix, padding, next_no) VALUES (?,?,?,?,?)',
      orgId, code, prefix, 4, 2);
    return formatDocNumber(prefix, 4, 1);
  }
  await run('UPDATE sequences SET next_no = next_no + 1 WHERE org_id = ? AND code = ?', orgId, code);
  return formatDocNumber(seq.prefix, seq.padding, seq.next_no);
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

    /*
     * THE TAX INSIDE AN ADVANCE IS NOT OWED TO THE CUSTOMER, so it does not sit
     * in the advance account.
     *
     *   Bank                Dr 47,200     what actually arrived
     *     Customer Advances   Cr 40,000   what the traveller is owed back
     *     Output CGST         Cr  3,600   what the government is owed, now
     *     Output SGST         Cr  3,600
     *
     * Crediting the whole ₹47,200 to Customer Advances — which is what this did
     * before the tax existed — overstates the liability to the traveller by the
     * GST and understates the GST liability to nil, so the September return is
     * short by ₹7,200 and the balance sheet says the agency owes a customer
     * money it has already paid away. On a REFUND VOUCHER the identical lines
     * run the other way, which is how the government's share comes back.
     *
     * The tax lines carry `taxId` and `taxBase`, so the tax report picks them
     * up with the invoices and GSTR-1 Table 11A falls out of the ledger rather
     * than out of a spreadsheet.
     */
    const taxRows = p.advance_tax_amount ? await paymentTaxes(orgId, paymentId) : [];
    const counterAmount = p.amount - p.advance_tax_amount;
    const tag = { partnerId: p.partner_id, bookingId: p.booking_id, label };
    const counterSide: PostingLine[] = [
      { accountId: counterAccount, ...tag, ...(inbound ? { credit: counterAmount } : { debit: counterAmount }) },
      ...advanceTaxPostings(taxRows, inbound ? 'credit' : 'debit', tag),
    ];
    const bankSide: PostingLine = {
      accountId: bank, ...tag, ...(inbound ? { debit: p.amount } : { credit: p.amount }),
    };

    const entryId = await postEntry({
      orgId,
      journalId: p.journal_id,
      date: p.pay_date,
      reference: p.number,
      narration: p.refund_of
        ? `Refund voucher ${p.number}`
        : p.is_advance
          ? `${customerSide ? 'Customer' : 'Supplier'} advance ${p.number}`
          : `${inbound ? 'Receipt' : 'Payment'} ${p.number}`,
      sourceModel: 'payment',
      sourceId: paymentId,
      currency: p.currency,
      lines: inbound ? [bankSide, ...counterSide] : [...counterSide, bankSide],
    }, actor);

    await run(`UPDATE payments SET state='posted', entry_id=?, posted_by=?, posted_at=? WHERE id=?`,
      entryId, actor.id ?? null, nowIso(), paymentId);
    await audit(orgId, actor, 'posted', 'payment', paymentId, `${p.number} posted`);

    // The money said what it was for when it arrived. Now that it is in the
    // books, put it there — if the invoice is posted too. See `settleTargeted`.
    await settleTargeted(orgId, paymentId, actor);
    return entryId;
  });
}

/**
 * ===========================================================================
 * PUT A PAYMENT WHERE IT SAID IT WAS GOING, ONCE BOTH SIDES ARE IN THE BOOKS.
 * ===========================================================================
 * A receipt fetched from TripzoCRM already knows its invoice: the agent took
 * ₹14,000 against INV-000015 and the CRM recorded it there. What this ledger
 * did with that was nothing — the receipt was drafted as money from a customer
 * and the match was dropped — so once both were posted the invoice read "Still
 * owed ₹44,998" with the ₹14,000 standing beside it under "Unallocated money",
 * offering itself to any open invoice that customer had. Two places showing the
 * same rupees as available is how a receipt gets applied twice.
 *
 * WHY IT IS CALLED FROM BOTH SIDES. Either can be posted first: the accountant
 * may post the receipt while the invoice is still in Review & Post, or post the
 * invoice weeks after the receipt. So `postPayment` tries, `postDocument` tries,
 * and whichever runs second is the one that succeeds. Running it twice costs a
 * read and allocates nothing the second time.
 *
 * WHAT IT WILL NOT DO:
 *   NOT MORE THAN EITHER SIDE HAS LEFT. The lesser of what the payment still
 *     holds and what the document still owes, so a ₹20,000 receipt against a
 *     ₹14,000 balance settles the balance and keeps ₹6,000 on account.
 *   NOT ACROSS PARTNERS. A target naming another customer's document is a
 *     mapping fault, not an instruction, and settling it would move one
 *     customer's money onto another's ledger.
 *   NOT A DRAFT, EITHER SIDE. `allocate` refuses both, and refusing earlier
 *     keeps this silent where silence is correct: not-yet is the ordinary
 *     state of a targeted payment, not a failure to report.
 */
export async function settleTargeted(
  orgId: string, paymentId: string, actor: Actor = {},
): Promise<number> {
  const p = await one<PaymentRow>(
    'SELECT * FROM payments WHERE id = ? AND org_id = ?', paymentId, orgId,
  );
  if (!p?.target_document_id || p.state !== 'posted' || p.unallocated <= 0) return 0;

  const doc = await getDocument(orgId, p.target_document_id);
  if (!doc || doc.state !== 'posted' || doc.residual <= 0) return 0;
  if (doc.partner_id !== p.partner_id) return 0;

  const amount = Math.min(p.unallocated, doc.residual);
  if (amount <= 0) return 0;
  await allocate(orgId, paymentId, p.target_document_id, amount, actor);
  return amount;
}

/** Every payment waiting on THIS document, settled now that it is posted. */
export async function settleTargetedForDocument(
  orgId: string, documentId: string, actor: Actor = {},
): Promise<number> {
  const rows = await all<{ id: string }>(
    `SELECT id FROM payments
      WHERE org_id = ? AND target_document_id = ? AND state = 'posted' AND unallocated > 0
      ORDER BY pay_date, number`,
    orgId, documentId,
  );
  let settled = 0;
  for (const r of rows) settled += await settleTargeted(orgId, r.id, actor);
  return settled;
}

/**
 * ===========================================================================
 * MONEY THIS DOCUMENT HAS BEEN TAKEN FOR THAT IS NOT IN THE BOOKS YET.
 * ===========================================================================
 * A receipt fetched from TripzoCRM is DRAFTED, deliberately: posting is a
 * person's act, and an importer that posted straight into the ledger would be
 * another system writing the agency's books. But a draft is also invisible to
 * every figure that matters — the residual, the Settled line, the AR ageing —
 * and the consequence was a posted invoice reading "Settled 0.00 · Still owed
 * 26,999.00" on a screen that said, four inches higher, that ₹8,500 had
 * already been collected against it. Both statements were true and the page
 * did not reconcile them, so the reader is left to decide which to believe.
 *
 * WHAT IS RETURNED IS A PENDING FIGURE, NOT A SETTLEMENT. The Balance card
 * prints it on its own row, under its own heading, below the real Settled
 * figure — never added into it. A draft has not cleared a debt; it is money
 * somebody has told us about. Naming it is what lets the two figures sit
 * beside each other honestly, and it is what turns "why does this not add up"
 * into "post the receipt".
 *
 * ONLY WHAT IS STILL UNALLOCATED AND ONLY AGAINST A LIVE DOCUMENT, so a
 * cancelled receipt or one already matched does not reappear here as money
 * waiting to arrive twice.
 */
export interface PendingReceipt {
  id: string;
  number: string | null;
  pay_date: string;
  amount: number;
  method: string;
  reference: string | null;
  is_advance: number;
  state: string;
}

export async function pendingReceiptsFor(
  orgId: string, documentId: string,
): Promise<PendingReceipt[]> {
  return await all<PendingReceipt>(
    `SELECT id, number, pay_date, amount, method, reference, is_advance, state
       FROM payments
      WHERE org_id = ? AND target_document_id = ? AND state = 'draft'
      ORDER BY pay_date, number`,
    orgId, documentId,
  );
}

/**
 * POST EVERY DRAFTED RECEIPT THIS DOCUMENT WAS TAKEN FOR, AND SETTLE THEM.
 *
 * ONE DELIBERATE ACT, NOT AN AUTOMATIC ONE. It is a button on the document,
 * pressed by a person looking at the figure, because posting a receipt debits
 * the bank and credits the customer — a real entry in a real ledger, in a
 * period that may be about to be locked and against a bank line somebody will
 * reconcile. The import stays a draft; this is the step where the agency says
 * the money is theirs.
 *
 * WHAT IT WILL NOT DO:
 *   NOT POST THE INVOICE. A receipt can post against a draft invoice and will
 *     simply sit unallocated until the invoice posts — `settleTargeted` runs
 *     from both sides. Posting the sale on the user's behalf because they
 *     asked to record a receipt would be deciding something far larger than
 *     what was clicked.
 *   NOT GIVE UP ON THE SET BECAUSE ONE FAILED. A locked period or a missing
 *     bank account stops that receipt and no other; the rest post, and the
 *     failures come back named. Three receipts and one problem is a far better
 *     answer than nothing posted because of the third.
 *
 * `allocated` IS MEASURED AS THE FALL IN THE DOCUMENT'S RESIDUAL, not counted
 * up from what this function allocated itself — and that distinction is a bug
 * this comment exists to stop coming back. `postPayment` already settles each
 * receipt against its target on the way out, so the sweep below finds nothing
 * left to do on a posted invoice and returning ITS figure reported "0 settled,
 * held on account" about a receipt that had in fact just cleared ₹8,500 of the
 * balance on screen.
 *
 * The residual is the one thing that cannot be wrong about this: it is what
 * the document owes, recomputed from the allocations, whoever wrote them. And
 * it stays correct for the case the naive count would also have got wrong —
 * a receipt larger than the balance, which settles the balance and keeps the
 * rest on account.
 */
export async function postReceiptsForDocument(
  orgId: string, documentId: string, actor: Actor = {},
): Promise<{ posted: number; amount: number; allocated: number; failures: string[] }> {
  const pending = await pendingReceiptsFor(orgId, documentId);
  const before = (await getDocument(orgId, documentId))?.residual ?? 0;
  const out = { posted: 0, amount: 0, allocated: 0, failures: [] as string[] };
  for (const r of pending) {
    try {
      await postPayment(orgId, r.id, actor);
      out.posted++;
      out.amount += r.amount;
    } catch (e) {
      out.failures.push(
        `${r.number ?? (r.reference ?? 'A receipt')} of ${(r.amount / 100).toFixed(2)}: `
        + (e instanceof Error ? e.message : 'could not be posted.'),
      );
    }
  }
  /*
   * AND THEN MATCH, FROM THIS SIDE AS WELL.
   *
   * `postPayment` already calls `settleTargeted` for each one, so on a posted
   * invoice this finds nothing left to do. It is here for the other order: a
   * receipt posted while the invoice was still a draft stays unallocated, and
   * this is the sweep that catches it the moment both sides are in the books —
   * the same call `postDocument` makes, which costs a read when there is
   * nothing waiting.
   */
  await settleTargetedForDocument(orgId, documentId, actor);
  const after = (await getDocument(orgId, documentId))?.residual ?? 0;
  out.allocated = Math.max(0, before - after);
  return out;
}

/**
 * Settle every payment in the books that is still waiting on its target.
 *
 * THE BACKFILL, and it is why this is a sweep rather than only a hook. The
 * hooks catch everything posted from now on; a ledger that has been running
 * already has receipts and invoices posted on both sides of a match that was
 * never recorded, and nothing in the ordinary course of work will ever bring
 * those two together — nobody posts an invoice twice.
 *
 * Safe to run at any time, which is what lets the CRM sync end with it: it
 * allocates only what both sides still have outstanding, so running it on books
 * with nothing waiting does nothing at all.
 */
export async function settlePendingTargets(
  orgId: string, actor: Actor = {},
): Promise<{ count: number; amount: number }> {
  const rows = await all<{ id: string }>(
    `SELECT p.id FROM payments p
       JOIN documents d ON d.id = p.target_document_id AND d.org_id = p.org_id
      WHERE p.org_id = ? AND p.state = 'posted' AND p.unallocated > 0
        AND d.state = 'posted' AND d.residual > 0
      ORDER BY p.pay_date, p.number`,
    orgId,
  );
  const out = { count: 0, amount: 0 };
  for (const r of rows) {
    const amount = await settleTargeted(orgId, r.id, actor);
    if (amount > 0) { out.count++; out.amount += amount; }
  }
  return out;
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
      /*
       * THE ADVANCE'S OWN GST COMES BACK OUT AS THE INVOICE'S GOES IN.
       *
       * Both cannot stand. The advance was taxed under section 13(2) because
       * the money arrived first; the invoice now taxes the SAME supply in full.
       * Leaving both would charge the traveller's trip to GST twice and leave
       * the agency ₹7,200 out of pocket against a return nobody can reconcile.
       * So applying the advance releases the tax it carried:
       *
       *   Customer Advances  Dr 40,000      the liability to the traveller
       *   Output CGST        Dr  3,600      the advance-stage tax, released
       *   Output SGST        Dr  3,600
       *     Accounts Receivable  Cr 47,200  what the invoice is settled by
       *
       * This is GSTR-1 Table 11B — "adjustment of advances against invoices" —
       * expressed in the ledger, and it is why the amount allocated is the
       * GROSS receipt while the advance account only ever held the net.
       *
       * PRO-RATA, because an advance is often applied in parts: each part
       * releases its own share, and the shares add back to the whole.
       */
      const share = shareOfAdvanceTax(await paymentTaxes(orgId, paymentId), amount, p.amount);
      const releasedTax = share.reduce((t, r) => t + r.amount, 0);
      const tag = { partnerId: p.partner_id, label: `Advance applied to ${doc.number}` };
      const advanceSide: PostingLine[] = [
        { accountId: advance, ...tag, ...(customerSide ? { debit: amount - releasedTax } : { credit: amount - releasedTax }) },
        ...advanceTaxPostings(share, customerSide ? 'debit' : 'credit', tag),
      ];
      const partnerLine: PostingLine = {
        accountId: partnerAccount, partnerId: p.partner_id, label: doc.number ?? '',
        ...(customerSide ? { credit: amount } : { debit: amount }),
      };
      await postEntry({
        orgId,
        journalId: await requireSetting(orgId, 'journal.general'),
        date: doc.doc_date > p.pay_date ? doc.doc_date : p.pay_date,
        reference: `${p.number} → ${doc.number}`,
        narration: `Advance applied to ${doc.number}`,
        sourceModel: 'payment',
        sourceId: paymentId,
        lines: customerSide ? [...advanceSide, partnerLine] : [partnerLine, ...advanceSide],
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

// ---------------------------------------------------------------------------
// Cancelling a trip against an advance
// ---------------------------------------------------------------------------

export interface CancelAdvanceInput {
  /** When the cancellation happens. The invoice and the refund both take it. */
  date: string;
  /**
   * What the agency keeps, GROSS — inclusive of the GST on it.
   *
   * INCLUSIVE BECAUSE THAT IS HOW A CANCELLATION POLICY IS WRITTEN. "70% of the
   * booking is retained" is 70% of what the traveller paid, and what they paid
   * was tax-inclusive. Asking for the figure net of GST would mean the agency
   * computing the back-out by hand before it could type the number its own
   * policy produced, and getting it wrong the first time.
   */
  chargeGross: number;
  /**
   * The tax the charge carries. Defaults to the one the ADVANCE carried.
   *
   * Circular 178/10/2022-GST, paragraphs 11.2 to 11.4: allowing cancellation
   * against a fee is not an independent supply of "tolerating" anything — it is
   * part and parcel of the tour operator service itself, naturally bundled with
   * it, and is therefore ASSESSED AT THE SAME RATE AS THE PRINCIPAL SUPPLY. So
   * the right default is not 18% and not nothing; it is whatever rate this
   * booking was being sold at, which is the rate its advance was taxed at.
   */
  taxId?: string | null;
  /** Where the retained charge is recognised. Defaults to the agency's setting. */
  accountId?: string | null;
  journalId?: string | null;
  reason?: string;
  /**
   * Pay the balance back now, or leave it on the customer's account.
   *
   * BOTH ARE REAL. A traveller cancelling for good gets their money back, and a
   * traveller moving to another date leaves it where it is. Only the first
   * issues a refund voucher, because section 31(3)(e) requires one where an
   * advance is returned and no invoice was issued — money staying on account
   * has not been returned.
   */
  refund?: boolean;
  /** Which account the refund leaves from. Required when refunding. */
  bankAccountId?: string | null;
  method?: string;
  reference?: string | null;
}

/**
 * Cancel a trip against the advance taken for it, and put the GST right.
 *
 * ===========================================================================
 * THE PROBLEM THIS SOLVES
 * ===========================================================================
 * A traveller pays ₹47,200 in September against a December trip. Section 13(2)
 * fixes the time of supply of a SERVICE at the earlier of the invoice or the
 * payment, so the agency owed the ₹7,200 inside that receipt in September's
 * GSTR-3B — months before any trip ran, and it has been paid to the government.
 *
 * In November the traveller cancels. Under the agency's policy ₹11,800 is
 * retained and ₹35,400 goes back. The agency has now paid ₹7,200 of tax on a
 * supply that, in the end, was ₹11,800 and not ₹47,200. Without an adjustment
 * it is ₹5,400 out of pocket, permanently, and its return cannot be reconciled
 * to its own books.
 *
 * ===========================================================================
 * WHAT THE LAW SAYS HAPPENS, AND THEREFORE WHAT THIS DOES
 * ===========================================================================
 * TWO EVENTS, NOT ONE, AND THEY ARE TAXED DIFFERENTLY.
 *
 * 1. THE RETAINED CHARGE IS A TAXABLE SUPPLY, AT THE PACKAGE'S OWN RATE.
 *    Circular 178/10/2022-GST paragraphs 11.1 to 11.4 settle this. Allowing a
 *    booking to be cancelled against a fee is not the separate declared service
 *    of "agreeing to tolerate an act" under paragraph 5(e) of Schedule II; it is
 *    a facilitation naturally bundled with the tour operator service, and under
 *    section 8(a) a composite supply is assessed as its principal supply. So the
 *    ₹11,800 retained is taxed at the rate the package was sold at — the same
 *    rate, not 18% by reflex — and a TAX INVOICE is raised for it. (Paragraph
 *    11.5 is the opposite case and does not apply here: earnest money forfeited
 *    on a sale of immovable property is a mere flow of money and is not taxable.
 *    A travel booking is not that.)
 *
 *    So: a real `out_invoice`, posted, with its own number and its own tax
 *    split — not a note, not a memo, and not a reduction of something else.
 *
 * 2. THE REST OF THE ADVANCE IS RETURNED, AND ITS TAX COMES BACK WITH IT.
 *    Section 31(3)(e) requires a REFUND VOUCHER where an advance is received,
 *    no supply is made and no invoice is issued. Rule 51 gives it its own
 *    consecutive series, which is why `nextPaymentNumber` has a third one. The
 *    tax it reverses is the tax THAT RECEIPT carried, pro-rata — not today's
 *    rate — which is why `createPayment` reads the stored split rather than
 *    recomputing one. In GSTR-1 this is Table 11B, "adjustment of advances".
 *
 * ===========================================================================
 * THE WORKED EXAMPLE, END TO END
 * ===========================================================================
 *   September   receipt ₹47,200 = advance ₹40,000 + output GST ₹7,200
 *               Bank Dr 47,200 / Customer Advances Cr 40,000 / Output GST Cr 7,200
 *
 *   November    cancellation invoice ₹11,800 = value ₹10,000 + GST ₹1,800
 *               AR Dr 11,800 / Cancellation Fees Cr 10,000 / Output GST Cr 1,800
 *
 *               advance applied to it, releasing its own share of the Sept tax
 *               Customer Advances Dr 10,000 / Output GST Dr 1,800 / AR Cr 11,800
 *
 *               refund voucher ₹35,400
 *               Customer Advances Dr 30,000 / Output GST Dr 5,400 / Bank Cr 35,400
 *
 *   Net GST borne: 7,200 − 1,800 − 5,400 + 1,800 = 1,800 — exactly the tax on
 *   the ₹11,800 the agency actually kept. Customer Advances nets to nil. The
 *   traveller has ₹35,400 back. Nothing is plugged and nothing is written off.
 *
 * ===========================================================================
 * BUILT OUT OF WHAT ALREADY EXISTS
 * ===========================================================================
 * There is no new posting logic in here, deliberately. The invoice is
 * `createDocument` + `postDocument`; releasing the advance's tax is `allocate`,
 * which already does the Table 11B swap pro-rata; the refund is `createPayment`
 * with `refundOf`, which already reverses a stored split. This function is the
 * ORDER those three happen in and the arithmetic that connects them — which is
 * precisely the part a person gets wrong at month end.
 *
 * ONE TRANSACTION. A cancellation that raised the invoice and then failed on
 * the refund would leave the traveller invoiced for a trip they cancelled and
 * no money moving. All of it commits or none of it does.
 */
export async function cancelAdvance(
  orgId: string, paymentId: string, input: CancelAdvanceInput, actor: Actor = {},
): Promise<{ documentId: string | null; refundId: string | null; charge: number; refunded: number }> {
  return await tx(async () => {
    const p = await one<PaymentRow>('SELECT * FROM payments WHERE id = ? AND org_id = ?', paymentId, orgId);
    if (!p) throw new PostingError('Unknown receipt.');
    if (!p.is_advance) {
      throw new PostingError(
        'This receipt was taken against an invoice, not as an advance. Cancelling that invoice is a ' +
        'credit note raised from the document itself.',
      );
    }
    if (p.side === 'supplier' || p.direction !== 'inbound') {
      throw new PostingError('Only an advance RECEIVED from a customer is cancelled this way.');
    }
    if (p.state === 'draft') throw new PostingError('Post the receipt before cancelling against it.');
    if (p.state === 'cancelled') throw new PostingError('This receipt has been reversed.');
    if (p.cancelled_by_doc_id) {
      throw new PostingError(
        'A cancellation has already been processed against this receipt. Reverse that one first — ' +
        'two cancellation charges on one advance would charge the traveller twice.',
      );
    }

    const available = await paymentUnallocated(orgId, paymentId);
    if (available <= 0) {
      throw new PostingError('This advance has already been applied in full, so there is nothing to cancel.');
    }
    const chargeGross = Math.max(0, Math.round(input.chargeGross));
    if (chargeGross > available) {
      throw new PostingError(
        `The cancellation charge of ${(chargeGross / 100).toFixed(2)} is more than the ` +
        `${(available / 100).toFixed(2)} still sitting on this advance. The agency cannot retain ` +
        'money it was never given.',
      );
    }
    if (input.refund && !input.bankAccountId) {
      throw new PostingError('Say which account the refund leaves from.');
    }

    /*
     * THE RATE FOLLOWS THE PACKAGE, NOT A CONSTANT.
     *
     * Circular 178 paragraph 11.3: the cancellation fee is assessed at the rate
     * of the principal supply. The advance was taxed at that rate when it
     * arrived, so the advance's own tax row is the right default and the only
     * one that cannot drift from what the booking was sold at.
     */
    const taxId = input.taxId ?? p.advance_tax_id ?? null;
    const tax = taxId ? await getTax(orgId, taxId) : null;
    if (taxId && !tax) throw new PostingError('Unknown tax on the cancellation charge.');

    let documentId: string | null = null;
    let charged = 0;

    if (chargeGross > 0) {
      const accountId = input.accountId
        ?? await getSetting(orgId, 'account.cancellation_charges');
      if (!accountId) {
        throw new PostingError(
          'No account is set for cancellation charges, so the retained amount has nowhere to be ' +
          'recognised. Set one under Settings → Default Accounts.',
        );
      }
      const journalId = input.journalId ?? await requireSetting(orgId, 'journal.sale');

      /*
       * THE LINE PRICE IS THE TAXABLE VALUE, AND THE BACK-OUT HAPPENS ONCE.
       *
       * `chargeGross` is inclusive because a cancellation policy is written
       * inclusive. A document line's `unit_price` is what tax is computed ON, so
       * handing it the gross would tax the tax. A tax row that is itself marked
       * price-included already backs its own out in `computeLine`, and doing it
       * twice is the same bug in the other direction — hence the branch.
       */
      const unitPrice = tax && !tax.price_included
        ? splitInclusive(chargeGross, tax.rate_bps).net
        : chargeGross;

      documentId = await createDocument({
        orgId,
        docType: 'out_invoice',
        partnerId: p.partner_id,
        journalId,
        bookingId: p.booking_id,
        docDate: input.date,
        dueDate: input.date,
        placeOfSupply: p.advance_place_of_supply,
        note: input.reason
          ?? `Cancellation charge retained against advance ${p.number}`,
        lines: [{
          name: input.reason
            ? `Cancellation charges — ${input.reason}`
            : 'Cancellation charges',
          qtyMilli: 1000,
          unitPrice,
          discountBps: 0,
          taxId,
          accountId,
          analyticId: null,
        }],
      }, actor);
      await postDocument(orgId, documentId, actor);

      /*
       * ALLOCATED AT THE DOCUMENT'S OWN TOTAL, NOT AT `chargeGross`.
       *
       * The tax engine rounds each component half-up and sums the rounded
       * parts, which is what the printed invoice shows; `splitInclusive` rounds
       * once. On a rate that does not divide evenly the two can land a paisa
       * apart, and `allocate` quite rightly refuses to settle more than a
       * document owes. Reading the posted total back is what makes the retained
       * amount and the invoice agree to the paisa in every case, instead of in
       * most of them.
       */
      const doc = (await getDocument(orgId, documentId))!;
      charged = Math.min(doc.total, available);
      if (charged > 0) await allocate(orgId, paymentId, documentId, charged, actor);
    }

    /*
     * THE REFUND VOUCHER, FOR WHATEVER THE AGENCY IS NOT KEEPING.
     *
     * `refundOf` is what makes it reverse SEPTEMBER's tax rather than compute
     * November's: `createPayment` reads the stored split off the receipt and
     * takes this amount's pro-rata share of it. The share the cancellation
     * invoice already released and the share this reverses add back to the
     * whole, which is why neither is worked out independently.
     */
    const refundable = available - charged;
    let refundId: string | null = null;
    if (input.refund && refundable > 0) {
      /*
       * THE JOURNAL FOLLOWS THE ACCOUNT THE MONEY LEAVES FROM, not the one the
       * receipt arrived through. A refund paid out of petty cash while the
       * advance came in by NEFT would otherwise be stamped with a bank journal's
       * entry number and appear in the bank book rather than the cash book —
       * the same defect `registerPaymentAction` resolves for an ordinary
       * payment, and for the same reason. The receipt's own journal is the
       * fallback, for an account with none configured.
       */
      const refundJournal = (await one<{ journal_id: string | null }>(
        'SELECT journal_id FROM bank_accounts WHERE id = ? AND org_id = ?',
        input.bankAccountId ?? null, orgId,
      ))?.journal_id ?? p.journal_id;

      refundId = await createPayment({
        orgId,
        direction: 'outbound',
        side: 'customer',
        partnerId: p.partner_id,
        journalId: refundJournal,
        bankAccountId: input.bankAccountId,
        bookingId: p.booking_id,
        payDate: input.date,
        amount: refundable,
        method: input.method ?? p.method,
        reference: input.reference ?? null,
        isAdvance: true,
        refundOf: paymentId,
        note: input.reason ?? `Refund of advance ${p.number} on cancellation`,
      }, actor);

      /*
       * THE ADVANCE IS CLOSED, BY HAND, BECAUSE A REFUND IS NOT AN ALLOCATION.
       *
       * `unallocated` normally falls because an allocation row was written
       * against a document. A refund voucher settles no document — the money
       * went back to the traveller — so nothing would have moved it, and the
       * receipt would have gone on advertising itself as money available to
       * apply to the next invoice. It is not: it is in the customer's bank.
       */
      await run(`UPDATE payments SET unallocated = 0, state = 'reconciled' WHERE id = ?`, paymentId);
    }

    // Stamped last, so a cancellation that threw anywhere above leaves the
    // receipt exactly as it was and can be attempted again.
    await run('UPDATE payments SET cancelled_by_doc_id = ? WHERE id = ?',
      documentId ?? refundId ?? paymentId, paymentId);

    await audit(orgId, actor, 'cancelled', 'payment', paymentId,
      `${p.number} cancelled — ${(charged / 100).toFixed(2)} retained, ` +
      `${((input.refund ? refundable : 0) / 100).toFixed(2)} refunded`,
      { reason: input.reason ?? null, documentId, refundId, charged, refundable });

    return { documentId, refundId, charge: charged, refunded: input.refund ? refundable : 0 };
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

/**
 * Net a posted credit note off the invoice it was raised against.
 *
 * A credit note REDUCES A BILL. It is not a refund, and the two are not
 * interchangeable: the customer is only owed cash to the extent he has already
 * paid more than the charge being retained. Leaving the note unmatched made the
 * system say otherwise — the note sat at its full value marked "Not Paid" with
 * a Pay out box beside it defaulted to that figure, so cancelling a ₹1,36,500
 * invoice at 70% offered to send ₹95,550 to a customer who had paid a ₹20,000
 * advance. The ledger was right throughout; the document residuals were the
 * thing that had never been told the two halves belong together.
 *
 * `min(note, invoice)` is the whole rule, and it falls out correctly in every
 * case because the invoice's residual already carries whatever has been paid:
 *
 *   nothing paid    invoice 1,36,500 · note 95,550 → owes 40,950, no refund
 *   advance 20,000  invoice 1,16,500 · note 95,550 → owes 20,950, no refund
 *   paid in full    invoice        0 · note 95,550 → refund 95,550
 *   advance 1,20,000 invoice  16,500 · note 95,550 → refund 79,050
 *
 * Whatever is left on the note afterwards is exactly the cash due back, so the
 * Pay out default becomes correct rather than dangerous.
 */
export async function applyCreditToSource(orgId: string, creditDocId: string, actor: Actor = {}): Promise<number> {
  const credit = await getDocument(orgId, creditDocId);
  if (!credit || credit.state !== 'posted' || !credit.reversal_of) return 0;
  const invoice = await getDocument(orgId, credit.reversal_of);
  if (!invoice || invoice.state !== 'posted') return 0;
  const amount = Math.min(credit.residual, invoice.residual);
  if (amount <= 0) return 0;
  await applyCreditNote(orgId, creditDocId, invoice.id, amount, actor);
  return amount;
}

/** Posted customer invoices this partner still owes on, newest first. */
export async function openInvoicesFor(orgId: string, partnerId: string, docType: string) {
  return await all<{ id: string; number: string | null; doc_date: string; total: number; residual: number }>(
    `SELECT id, number, doc_date, total, residual
       FROM documents
      WHERE org_id = ? AND partner_id = ? AND doc_type = ?
        AND state = 'posted' AND residual > 0
      ORDER BY doc_date DESC, number DESC`,
    orgId, partnerId, docType,
  );
}

/** Undo one allocation — the payment was matched to the wrong invoice. */
export async function unallocate(orgId: string, allocationId: number, actor: Actor = {}) {
  return await tx(async () => {
    const a = await one<{ payment_id: string | null; document_id: string; credit_doc_id: string | null; amount: number }>(
      'SELECT payment_id, document_id, credit_doc_id, amount FROM payment_allocations WHERE id = ? AND org_id = ?',
      allocationId, orgId,
    );
    if (!a) throw new PostingError('Unknown allocation.');
    await run('DELETE FROM payment_allocations WHERE id = ?', allocationId);
    if (a.payment_id) {
      await run(`UPDATE payments SET unallocated = ?, state = 'posted' WHERE id = ?`,
        await paymentUnallocated(orgId, a.payment_id), a.payment_id);
    }
    /*
     * A CREDIT NOTE'S ALLOCATION IS A PAIR, AND IT IS UNDONE AS A PAIR.
     *
     * `applyCreditNote` writes the match in both directions so each document's
     * residual falls. Deleting one half left the other still counting itself
     * consumed: Undo from the invoice freed the invoice while the note stayed
     * "Paid" with nothing behind it, and the two documents then disagreed about
     * the same ₹76,500 with no screen showing why.
     *
     * Matched on the pair's own shape and deleted by id, so a partner with two
     * identical allocations loses exactly the one being undone.
     */
    if (a.credit_doc_id) {
      await run(
        `DELETE FROM payment_allocations WHERE id = (
           SELECT id FROM payment_allocations
            WHERE org_id = ? AND document_id = ? AND credit_doc_id = ? AND amount = ?
            LIMIT 1)`,
        orgId, a.credit_doc_id, a.document_id, a.amount,
      );
      await refreshResidual(orgId, a.credit_doc_id);
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
  // The trip comes off the payment when one was picked on the form, and off
  // the document it was applied to when it was not. An advance taken for a
  // trip and later applied to that trip's invoice should read the same on
  // this screen either way round, and an accountant allocating a receipt is
  // not going to go back and stamp the booking on it a second time.
  return await all<PaymentRow>(
    `SELECT p.*, pt.name AS partner_name,
            b.id AS trip_id, b.ref AS trip_ref, b.title AS trip_title,
            td.number AS target_number, td.state AS target_state,
            tc.invoice_number AS target_crm_number
       FROM payments p
       LEFT JOIN partners pt ON pt.id = p.partner_id
       LEFT JOIN documents td ON td.id = p.target_document_id AND td.org_id = p.org_id
       LEFT JOIN crm_invoices tc ON tc.document_id = p.target_document_id AND tc.org_id = p.org_id
       LEFT JOIN bookings b ON b.id = COALESCE(p.booking_id, (
              SELECT d.booking_id FROM payment_allocations a
                JOIN documents d ON d.id = a.document_id
               WHERE a.payment_id = p.id AND d.booking_id IS NOT NULL
               ORDER BY a.id LIMIT 1))
      WHERE ${clauses.join(' AND ')}
      ORDER BY p.pay_date DESC, p.created_at DESC LIMIT ${f.limit ?? 200}`,
    ...params,
  );
}

export async function allocationsFor(orgId: string, documentId: string) {
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
      WHERE a.org_id = ? AND a.document_id = ? ORDER BY a.id`, orgId, documentId,
  );
}

export async function allocationsOfPayment(orgId: string, paymentId: string) {
  return await all<{ id: number; amount: number; document_id: string; number: string | null; doc_date: string }>(
    `SELECT a.id, a.amount, a.document_id, d.number, d.doc_date
       FROM payment_allocations a JOIN documents d ON d.id = a.document_id
      WHERE a.org_id = ? AND a.payment_id = ? ORDER BY a.id`, orgId, paymentId,
  );
}
