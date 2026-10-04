import 'server-only';
import { all, one, run, tx, id, nowIso, nextNumber } from '../db';
import { pct } from '@/lib/money';
import { postEntry, reverseEntry, PostingError, type Actor, type PostingLine } from './engine';
import { receivableAccount, requireSetting, getSetting } from './settings';
import { refreshResidual } from './documents';
import { audit } from './audit';

/**
 * Channel settlements — the payout statement.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * An agency that sells through an OTA or a marketplace is not paid per invoice.
 * The channel collects the full fare from the traveller, keeps its commission,
 * its shipping and storage charges and the GST on all of them, withholds TCS
 * and TDS, and remits ONE net amount per cycle with a statement attached.
 *
 * Booking that remittance as a plain receipt is the mistake this module exists
 * to prevent, and it is not a cosmetic one. The difference between the gross
 * collected and the net received has to land SOMEWHERE, and if the receipt is
 * all that is recorded then:
 *
 *   - receivables stay permanently short by the commission, so the AR ageing
 *     fills with small residuals nobody can clear and the channel's account
 *     never reaches nil;
 *   - the commission, shipping and storage are never recognised as costs, so
 *     the P&L overstates the margin on every trip sold through the channel;
 *   - the input GST on those charges is never claimed, which is real money;
 *   - the TCS and TDS the channel withheld are never recorded as advance tax,
 *     so they cannot be set off at assessment.
 *
 * ---------------------------------------------------------------------------
 * HOW IT POSTS
 * ---------------------------------------------------------------------------
 * ONE journal entry, and the bank side of it is the NET — because the bank
 * statement has exactly one line for the cycle, and a reconciliation screen
 * that has to match one statement line against two entries is a reconciliation
 * screen nobody finishes.
 *
 *   Bank                        Dr   net payout
 *   Channel commission          Dr   commission on every order in the cycle
 *   Channel shipping            Dr   shipping and return fees
 *   <each cycle-level charge>   Dr   storage, advertising, recall, ...
 *   Input GST                   Dr   the GST on all of the above
 *   TCS receivable              Dr   collected by the channel on our behalf
 *   TDS receivable              Dr   withheld under 194-O / 194-Q
 *        Accounts Receivable    Cr   the GROSS the channel collected
 *        <each addition>        Cr   reimbursements, credit notes in our favour
 *
 * The receivable is credited for the gross, not the net, which is the whole
 * point: that is what the channel actually collected on the agency's behalf,
 * and it is what the invoices in the cycle are owed.
 *
 * DISCHARGING THE INVOICES. A residual only ever moves through an allocation
 * (see `refreshResidual` in documents.ts), and there is no payment row here to
 * hang one on — the cash that arrived was the net. So the settlement writes
 * allocation rows carrying its own id, for each document's gross. The ledger
 * and the residuals then agree: the receivable is credited by the gross and the
 * documents are discharged for the same gross.
 */

// ---------------------------------------------------------------------------
// The charge catalogue
// ---------------------------------------------------------------------------

/**
 * The cycle-level lines a channel statement can carry.
 *
 * A CATALOGUE AND NOT FREE TEXT, because the point of the feature is that the
 * agency's statement reconciles against the channel's own. Two cycles that
 * spell "Storage Charge" differently do not add up across a year, and a report
 * grouped on a typed label is a report with eleven storage rows in it. The
 * labels are the ones the channels themselves print, so a figure can be checked
 * against the PDF it came from without translating.
 *
 * `gst` marks the charges a channel levies GST on — a reimbursement for
 * inventory it lost is a recovery, not a supply, and carries none.
 *
 * `account` is the SETTING the default account is resolved through, never an
 * account code: an agency that renumbers its chart changes a setting, not this
 * table (plan section 7).
 */
export interface ChargeKind {
  code: string;
  label: string;
  section: 'deduction' | 'addition';
  /** Which block of the statement it prints under. */
  block: 'additions' | 'deductions' | 'one_time';
  gst: boolean;
  account: 'account.channel_charges' | 'account.channel_recovery';
}

export const CHARGE_KINDS: ChargeKind[] = [
  // --- other additions: money the channel owes back ------------------------
  { code: 'lost_damaged_inventory', label: 'Lost/Damaged Inventory', section: 'addition', block: 'additions', gst: false, account: 'account.channel_recovery' },
  { code: 'tds_reimbursement', label: 'TDS Reimbursement', section: 'addition', block: 'additions', gst: false, account: 'account.channel_recovery' },
  { code: 'tcs_reimbursement', label: 'TCS Reimbursement', section: 'addition', block: 'additions', gst: false, account: 'account.channel_recovery' },
  { code: 'pre_grn_loss', label: 'Pre GRN Losses', section: 'addition', block: 'additions', gst: false, account: 'account.channel_recovery' },
  { code: 'pre_grn_damage', label: 'Pre GRN Damage', section: 'addition', block: 'additions', gst: false, account: 'account.channel_recovery' },
  { code: 'post_rtv_loss', label: 'Post RTV Losses', section: 'addition', block: 'additions', gst: false, account: 'account.channel_recovery' },
  { code: 'post_rtv_damage', label: 'Post RTV Damage', section: 'addition', block: 'additions', gst: false, account: 'account.channel_recovery' },
  { code: 'rtv_incorrect', label: 'RTV Incorrect Items Delivered', section: 'addition', block: 'additions', gst: false, account: 'account.channel_recovery' },
  // --- other deductions: cycle charges, not per order ----------------------
  { code: 'storage', label: 'Storage Charge', section: 'deduction', block: 'deductions', gst: true, account: 'account.channel_charges' },
  { code: 'ads', label: 'Ads Budget Spend', section: 'deduction', block: 'deductions', gst: true, account: 'account.channel_charges' },
  { code: 'recall', label: 'Recall Charge', section: 'deduction', block: 'deductions', gst: true, account: 'account.channel_charges' },
  // --- one-timer adjustments ----------------------------------------------
  { code: 'credit_note', label: 'Credit Note', section: 'addition', block: 'one_time', gst: true, account: 'account.channel_recovery' },
  { code: 'debit_note', label: 'Debit Note', section: 'deduction', block: 'one_time', gst: true, account: 'account.channel_charges' },
  { code: 'pending_charges_paid', label: 'Pending Charges Paid', section: 'deduction', block: 'one_time', gst: false, account: 'account.channel_charges' },
];

export function chargeKind(code: string): ChargeKind | undefined {
  return CHARGE_KINDS.find((k) => k.code === code);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface SettlementRow {
  id: string; org_id: string; number: string | null;
  partner_id: string; partner_name?: string;
  cycle_from: string; cycle_to: string;
  commission_bps: number; charge_gst_bps: number;
  shipping_charge: number; return_charge: number;
  tcs_bps: number; tds_bps: number; previous_unsettled: number;
  pay_date: string | null; utr: string | null;
  bank_account_id: string | null; bank_account_name?: string | null; journal_id: string | null;
  state: string;
  customer_payable: number; deductions: number; additions: number; net_payout: number;
  entry_id: string | null; payment_id: string | null; note: string | null;
  created_by: string | null; created_at: string;
  posted_by: string | null; posted_at: string | null;
  orders?: number;
}

export interface SettlementDocRow {
  id: string; settlement_id: string; document_id: string; kind: string;
  gross: number; commission: number; commission_gst: number;
  shipping: number; shipping_gst: number; return_fee: number; return_gst: number;
  tcs: number; tds: number; deductions: number; additions: number; payout: number;
  status: string;
  /** Joined from the document, for the statement and the screen. */
  number: string | null; doc_type: string; doc_date: string; order_ref: string | null;
  order_date: string | null; place_of_supply: string | null; irn: string | null;
  residual: number; untaxed: number; tax_total: number; total: number;
}

export interface SettlementChargeRow {
  id: string; settlement_id: string; seq: number; code: string; label: string;
  section: string; amount: number; gst_amount: number;
  account_id: string | null; note: string | null;
}

export interface SettlementInput {
  orgId: string;
  partnerId: string;
  cycleFrom: string;
  cycleTo: string;
  commissionBps?: number;
  chargeGstBps?: number;
  shippingCharge?: number;
  returnCharge?: number;
  tcsBps?: number;
  tdsBps?: number;
  previousUnsettled?: number;
  payDate?: string | null;
  utr?: string | null;
  bankAccountId?: string | null;
  journalId?: string | null;
  note?: string | null;
}

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export async function createSettlement(input: SettlementInput, actor: Actor = {}): Promise<string> {
  if (input.cycleTo < input.cycleFrom) {
    throw new PostingError('The cycle ends before it starts.');
  }
  return await tx(async () => {
    const settlementId = id('set');
    await run(
      `INSERT INTO settlements
         (id, org_id, number, partner_id, cycle_from, cycle_to, commission_bps, charge_gst_bps,
          shipping_charge, return_charge, tcs_bps, tds_bps, previous_unsettled,
          pay_date, utr, bank_account_id, journal_id, state, note, created_by, created_at)
       VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?)`,
      settlementId, input.orgId, input.partnerId, input.cycleFrom, input.cycleTo,
      input.commissionBps ?? 0, input.chargeGstBps ?? 1800,
      input.shippingCharge ?? 0, input.returnCharge ?? 0,
      input.tcsBps ?? 0, input.tdsBps ?? 0, input.previousUnsettled ?? 0,
      input.payDate ?? null, input.utr ?? null, input.bankAccountId ?? null,
      input.journalId ?? null, input.note ?? null, actor.id ?? null, nowIso(),
    );
    // Pulled in on creation rather than left to a second click: a cycle with no
    // orders in it is an empty screen that tells the user nothing about whether
    // the dates were wrong or the sync has not run.
    await pullDocuments(input.orgId, settlementId, actor);
    await audit(input.orgId, actor, 'created', 'settlement', settlementId,
      `Cycle ${input.cycleFrom} to ${input.cycleTo} drafted`);
    return settlementId;
  });
}

export async function updateSettlement(settlementId: string, input: SettlementInput, actor: Actor = {}) {
  return await tx(async () => {
    const s = await getSettlement(input.orgId, settlementId);
    if (!s) throw new PostingError('Unknown settlement.');
    if (s.state !== 'draft') throw new PostingError('A posted settlement cannot be edited. Reverse it first.');
    await run(
      `UPDATE settlements SET partner_id=?, cycle_from=?, cycle_to=?, commission_bps=?,
              charge_gst_bps=?, shipping_charge=?, return_charge=?, tcs_bps=?, tds_bps=?,
              previous_unsettled=?, pay_date=?, utr=?, bank_account_id=?, journal_id=?, note=?
         WHERE id=? AND org_id=?`,
      input.partnerId, input.cycleFrom, input.cycleTo, input.commissionBps ?? 0,
      input.chargeGstBps ?? 1800, input.shippingCharge ?? 0, input.returnCharge ?? 0,
      input.tcsBps ?? 0, input.tdsBps ?? 0, input.previousUnsettled ?? 0,
      input.payDate ?? null, input.utr ?? null, input.bankAccountId ?? null,
      input.journalId ?? null, input.note ?? null, settlementId, input.orgId,
    );
    // The partner or the window may have moved, so the document set is rebuilt
    // rather than merely re-costed.
    await pullDocuments(input.orgId, settlementId, actor);
    await audit(input.orgId, actor, 'modified', 'settlement', settlementId, 'Draft edited');
  });
}

/**
 * Fill the cycle with the channel's documents.
 *
 * WHICH DOCUMENTS. Posted sales documents for this partner, dated inside the
 * window, that still owe something. The residual test is what makes the pull
 * idempotent: an invoice already settled in an earlier cycle is not dragged
 * into this one, which is the mistake that would double-credit the receivable.
 *
 * Anything a user has already deleted from the draft by hand stays out, because
 * removal sets no flag — this only ADDS what is missing and re-costs what is
 * present. A rebuild from scratch would quietly undo that editing.
 */
export async function pullDocuments(orgId: string, settlementId: string, actor: Actor = {}) {
  const s = await getSettlement(orgId, settlementId);
  if (!s) throw new PostingError('Unknown settlement.');
  if (s.state !== 'draft') throw new PostingError('Only a draft settlement can be refilled.');

  const candidates = await all<{ id: string; doc_type: string; total: number; residual: number }>(
    `SELECT id, doc_type, total, residual FROM documents
      WHERE org_id=? AND partner_id=? AND state='posted' AND residual > 0
        AND doc_date >= ? AND doc_date <= ?
        AND doc_type IN ('out_invoice','out_refund')
      ORDER BY doc_date, number`,
    orgId, s.partner_id, s.cycle_from, s.cycle_to,
  );

  const present = new Set((await all<{ document_id: string }>(
    'SELECT document_id FROM settlement_documents WHERE settlement_id=?', settlementId,
  )).map((r) => r.document_id));

  for (const d of candidates) {
    if (present.has(d.id)) continue;
    await run(
      `INSERT INTO settlement_documents (id, org_id, settlement_id, document_id, kind, status)
       VALUES (?,?,?,?,?,?)`,
      id('sd'), orgId, settlementId, d.id,
      d.doc_type === 'out_refund' ? 'return' : 'forward',
      s.utr ? 'SUCCESS' : 'PENDING',
    );
  }
  await recompute(orgId, settlementId);
  if (actor.id) await audit(orgId, actor, 'modified', 'settlement', settlementId,
    `${candidates.length} document(s) in the cycle`);
}

export async function addDocument(orgId: string, settlementId: string, documentId: string, actor: Actor = {}) {
  return await tx(async () => {
    const s = await getSettlement(orgId, settlementId);
    if (!s) throw new PostingError('Unknown settlement.');
    if (s.state !== 'draft') throw new PostingError('Only a draft settlement can be changed.');
    const doc = await one<{ id: string; doc_type: string; partner_id: string; state: string; residual: number; number: string | null }>(
      'SELECT id, doc_type, partner_id, state, residual, number FROM documents WHERE id=? AND org_id=?',
      documentId, orgId,
    );
    if (!doc) throw new PostingError('Unknown document.');
    if (doc.state !== 'posted') throw new PostingError('Only a posted document can be settled.');
    if (doc.partner_id !== s.partner_id) {
      throw new PostingError('That document belongs to a different customer than this settlement.');
    }
    if (doc.residual <= 0) throw new PostingError(`${doc.number} is already settled in full.`);
    await run(
      `INSERT INTO settlement_documents (id, org_id, settlement_id, document_id, kind, status)
       VALUES (?,?,?,?,?,'PENDING') ON CONFLICT (settlement_id, document_id) DO NOTHING`,
      id('sd'), orgId, settlementId, documentId,
      doc.doc_type === 'out_refund' ? 'return' : 'forward',
    );
    await recompute(orgId, settlementId);
  });
}

export async function removeDocument(orgId: string, settlementId: string, rowId: string, actor: Actor = {}) {
  return await tx(async () => {
    const s = await getSettlement(orgId, settlementId);
    if (!s) throw new PostingError('Unknown settlement.');
    if (s.state !== 'draft') throw new PostingError('Only a draft settlement can be changed.');
    await run('DELETE FROM settlement_documents WHERE id=? AND settlement_id=?', rowId, settlementId);
    await recompute(orgId, settlementId);
    await audit(orgId, actor, 'modified', 'settlement', settlementId, 'Order removed from the cycle');
  });
}

export async function saveCharge(orgId: string, settlementId: string, c: {
  id?: string | null; code: string; amount: number; gstAmount?: number | null;
  accountId?: string | null; note?: string | null;
}, actor: Actor = {}) {
  return await tx(async () => {
    const s = await getSettlement(orgId, settlementId);
    if (!s) throw new PostingError('Unknown settlement.');
    if (s.state !== 'draft') throw new PostingError('Only a draft settlement can be changed.');

    const kind = chargeKind(c.code);
    if (!kind) throw new PostingError(`"${c.code}" is not a settlement charge this product knows.`);

    /*
     * THE GST IS DERIVED UNLESS THE STATEMENT SAYS OTHERWISE.
     *
     * A channel computes it at its own rate and rounds per line, so the figure
     * on the statement is the figure that has to be booked — otherwise the
     * input credit claimed differs from the credit the channel reported and the
     * GSTR-2B reconciliation fails by a few rupees every month. `null` means
     * "work it out for me" (the common case, typing one number); a value, even
     * zero, is taken as stated.
     */
    const gst = c.gstAmount ?? (kind.gst ? pct(c.amount, s.charge_gst_bps) : 0);

    if (c.id) {
      await run(
        `UPDATE settlement_charges SET code=?, label=?, section=?, amount=?, gst_amount=?,
                account_id=?, note=? WHERE id=? AND settlement_id=?`,
        kind.code, kind.label, kind.section, c.amount, gst,
        c.accountId ?? null, c.note ?? null, c.id, settlementId,
      );
    } else {
      const seq = CHARGE_KINDS.findIndex((k) => k.code === kind.code);
      await run(
        `INSERT INTO settlement_charges
           (id, org_id, settlement_id, seq, code, label, section, amount, gst_amount, account_id, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id('sc'), orgId, settlementId, seq, kind.code, kind.label, kind.section,
        c.amount, gst, c.accountId ?? null, c.note ?? null,
      );
    }
    await recompute(orgId, settlementId);
    await audit(orgId, actor, 'modified', 'settlement', settlementId, `${kind.label} set`);
  });
}

export async function removeCharge(orgId: string, settlementId: string, chargeId: string, actor: Actor = {}) {
  return await tx(async () => {
    const s = await getSettlement(orgId, settlementId);
    if (!s) throw new PostingError('Unknown settlement.');
    if (s.state !== 'draft') throw new PostingError('Only a draft settlement can be changed.');
    await run('DELETE FROM settlement_charges WHERE id=? AND settlement_id=?', chargeId, settlementId);
    await recompute(orgId, settlementId);
    await audit(orgId, actor, 'modified', 'settlement', settlementId, 'Charge removed');
  });
}

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

/**
 * Re-cost every order in the cycle and roll the header up.
 *
 * ORDER-LEVEL CHARGES ARE COMPUTED PER ORDER AND SUMMED, never computed on the
 * cycle total. It is the same rule the tax engine follows for the same reason:
 * the channel's statement shows a figure per order, the agency checks the
 * column it can see, and a commission taken on the cycle total differs from the
 * sum of the per-order commissions by a rupee or two every time rounding falls
 * the wrong way. The books have to agree with the paper.
 *
 * A RETURN IS THE SAME ARITHMETIC WITH THE SIGN TURNED OVER. The channel claws
 * the fare back and charges a return fee on top, so its gross contribution is
 * negative while its fee is still a deduction. Writing that as a second code
 * path is how the two drift; one `sign` is enough.
 */
export async function recompute(orgId: string, settlementId: string) {
  const s = await one<SettlementRow>('SELECT * FROM settlements WHERE id=? AND org_id=?', settlementId, orgId);
  if (!s) return;

  const rows = await all<{ id: string; document_id: string; kind: string; total: number; residual: number }>(
    `SELECT sd.id, sd.document_id, sd.kind, d.total, d.residual
       FROM settlement_documents sd JOIN documents d ON d.id = sd.document_id
      WHERE sd.settlement_id = ?`, settlementId,
  );

  let payable = 0;
  let deductions = 0;
  let additions = 0;

  for (const r of rows) {
    const isReturn = r.kind === 'return';
    // The order's face value is always positive; the direction lives in `isReturn`.
    const gross = Math.abs(r.total);

    /*
     * A RETURNED ORDER CARRIES THE RETURN FEE AND NOTHING ELSE.
     *
     * No commission, no shipping, no TCS, no TDS — which is what the channels'
     * own statements show, and it is right rather than merely conventional:
     *
     *   - COMMISSION is earned on a sale. The sale was undone, so there is
     *     nothing to be paid a percentage of. Charging it on the way out as
     *     well as the way in would have the channel earning twice on one order
     *     that ultimately produced no revenue for anybody.
     *   - TCS AND TDS are tax on a payment that is being reversed. Withholding
     *     again on the reversal would put tax credit on the ledger against
     *     income the agency never received, and the credit would not appear in
     *     the agency's 26AS — so it could never be claimed, only explained.
     *   - SHIPPING was charged on the outbound movement already. The return
     *     movement has its own fee, which is what `return_charge` is.
     *
     * The forward order's own commission stays charged, exactly as the channel
     * statements leave it: a cancellation usually lands in a later cycle than
     * the sale, and reversing it here would make this cycle disagree with the
     * one the sale was settled in.
     */
    const commission = isReturn ? 0 : pct(gross, s.commission_bps);
    const commissionGst = pct(commission, s.charge_gst_bps);
    const shipping = isReturn ? 0 : s.shipping_charge;
    const shippingGst = pct(shipping, s.charge_gst_bps);
    const returnFee = isReturn ? s.return_charge : 0;
    const returnGst = pct(returnFee, s.charge_gst_bps);
    const tcs = isReturn ? 0 : pct(gross, s.tcs_bps);
    const tds = isReturn ? 0 : pct(gross, s.tds_bps);

    const rowDeductions = commission + commissionGst + shipping + shippingGst
      + returnFee + returnGst + tcs + tds;
    const payout = (isReturn ? -gross : gross) - rowDeductions;

    await run(
      `UPDATE settlement_documents SET gross=?, commission=?, commission_gst=?, shipping=?,
              shipping_gst=?, return_fee=?, return_gst=?, tcs=?, tds=?, deductions=?,
              additions=0, payout=? WHERE id=?`,
      isReturn ? -gross : gross, commission, commissionGst, shipping, shippingGst,
      returnFee, returnGst, tcs, tds, rowDeductions, payout, r.id,
    );

    payable += isReturn ? -gross : gross;
    deductions += rowDeductions;
  }

  for (const c of await all<{ section: string; amount: number; gst_amount: number }>(
    'SELECT section, amount, gst_amount FROM settlement_charges WHERE settlement_id=?', settlementId,
  )) {
    const total = c.amount + c.gst_amount;
    if (c.section === 'addition') additions += total;
    else deductions += total;
  }

  const net = payable + additions - deductions;
  await run(
    `UPDATE settlements SET customer_payable=?, deductions=?, additions=?, net_payout=? WHERE id=?`,
    payable, deductions, additions, net, settlementId,
  );
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/**
 * The account a charge lands on: the row's override, else the catalogue's
 * setting. An agency that wants advertising under Marketing rather than under
 * channel charges sets it on the row and nothing else changes.
 */
async function chargeAccount(orgId: string, code: string, override: string | null): Promise<string> {
  if (override) return override;
  const kind = chargeKind(code);
  return await requireSetting(orgId, kind?.account ?? 'account.channel_charges');
}

export async function postSettlement(orgId: string, settlementId: string, actor: Actor = {}): Promise<string> {
  return await tx(async () => {
    const s = await getSettlement(orgId, settlementId);
    if (!s) throw new PostingError('Unknown settlement.');
    if (s.state === 'posted') throw new PostingError('This settlement is already posted.');
    if (s.state === 'cancelled') throw new PostingError('A cancelled settlement cannot be posted.');
    if (!s.pay_date) throw new PostingError('Give the settlement the date the money arrived before posting it.');

    // Recomputed rather than trusted: the rows are a cache and the figures that
    // reach the ledger must come from the current ones, not from whatever the
    // header held when the screen was last rendered.
    await recompute(orgId, settlementId);
    const settlement = (await getSettlement(orgId, settlementId))!;
    const payDate = settlement.pay_date;
    if (!payDate) throw new PostingError('Give the settlement the date the money arrived before posting it.');

    const docs = await settlementDocuments(orgId, settlementId);
    const charges = await settlementCharges(orgId, settlementId);
    if (!docs.length && !charges.length) {
      throw new PostingError('There is nothing in this cycle to post.');
    }

    const bank = await bankGlAccount(orgId, settlement);
    const journalId = settlement.journal_id
      ?? await journalOfBank(orgId, settlement.bank_account_id)
      ?? await requireSetting(orgId, 'journal.bank');
    const arAccount = await receivableAccount(orgId, settlement.partner_id);
    const inputTax = await requireSetting(orgId, 'account.input_tax');

    const lines: PostingLine[] = [];
    const base = { partnerId: settlement.partner_id };

    // --- the net that actually arrived -------------------------------------
    /*
     * A NEGATIVE NET IS A REAL CYCLE, not an error. A month of returns and
     * storage charges with few sales leaves the agency owing the channel, and
     * the channel takes it by bank debit. The side of the bank line therefore
     * follows the sign rather than being assumed.
     */
    if (settlement.net_payout !== 0) {
      lines.push({
        ...base,
        accountId: bank,
        label: `${settlement.number ?? 'Settlement'}${settlement.utr ? ` · ${settlement.utr}` : ''}`,
        ...(settlement.net_payout > 0
          ? { debit: settlement.net_payout }
          : { credit: -settlement.net_payout }),
      });
    }

    // --- order-level charges, one line each, summed across the cycle -------
    const commission = docs.reduce((t, d) => t + d.commission, 0);
    const shipping = docs.reduce((t, d) => t + d.shipping + d.return_fee, 0);
    const tcs = docs.reduce((t, d) => t + d.tcs, 0);
    const tds = docs.reduce((t, d) => t + d.tds, 0);
    // One input-tax line for the whole cycle: a dozen GST lines on one entry
    // make the ledger unreadable and the figure claimed is the total anyway.
    let gstOnCharges = docs.reduce((t, d) => t + d.commission_gst + d.shipping_gst + d.return_gst, 0);

    if (commission) {
      lines.push({
        ...base,
        accountId: await requireSetting(orgId, 'account.channel_commission'),
        label: `Commission ${(settlement.commission_bps / 100).toFixed(2)}% · ${docs.length} order(s)`,
        debit: commission,
      });
    }
    if (shipping) {
      lines.push({
        ...base,
        accountId: await requireSetting(orgId, 'account.channel_shipping'),
        label: 'Shipping and return charges',
        debit: shipping,
      });
    }
    if (tcs) {
      lines.push({
        ...base,
        accountId: await requireSetting(orgId, 'account.tcs_receivable'),
        label: 'TCS collected by the channel',
        debit: tcs,
      });
    }
    if (tds) {
      lines.push({
        ...base,
        accountId: await requireSetting(orgId, 'account.tds_receivable'),
        label: 'TDS withheld (194-O / 194-Q)',
        debit: tds,
      });
    }

    // --- cycle-level charges ----------------------------------------------
    for (const c of charges) {
      if (!c.amount && !c.gst_amount) continue;
      const accountId = await chargeAccount(orgId, c.code, c.account_id);
      if (c.amount) {
        lines.push({
          ...base,
          accountId,
          label: c.label,
          ...(c.section === 'addition' ? { credit: c.amount } : { debit: c.amount }),
        });
      }
      /*
       * GST ON AN ADDITION REDUCES THE INPUT CREDIT RATHER THAN BECOMING AN
       * OUTPUT LIABILITY. A credit note the channel raises in the agency's
       * favour is a reversal of its own earlier charge, so the tax on it
       * reverses the credit that charge created. Treating it as output GST
       * would overstate both sides of the return by the same amount and leave
       * the agency filing a liability it does not owe.
       */
      gstOnCharges += c.section === 'addition' ? -c.gst_amount : c.gst_amount;
    }

    if (gstOnCharges !== 0) {
      lines.push({
        ...base,
        accountId: inputTax,
        label: 'Input GST on channel charges',
        ...(gstOnCharges > 0 ? { debit: gstOnCharges } : { credit: -gstOnCharges }),
      });
    }

    // --- the receivable the channel collected ------------------------------
    if (settlement.customer_payable !== 0) {
      lines.push({
        ...base,
        accountId: arAccount,
        label: `${docs.length} order(s) settled`,
        ...(settlement.customer_payable > 0
          ? { credit: settlement.customer_payable }
          : { debit: -settlement.customer_payable }),
      });
    }

    const number = settlement.number ?? await nextNumber(orgId, 'settlement', 'STL');
    const entryId = await postEntry({
      orgId,
      journalId,
      date: payDate,
      reference: settlement.utr ?? number,
      narration: `Channel settlement ${number} · ${settlement.partner_name ?? ''}`.trim(),
      sourceModel: 'settlement',
      sourceId: settlementId,
      lines,
    }, actor);

    /*
     * DISCHARGE THE DOCUMENTS FOR THE GROSS.
     *
     * Capped at the residual, per document, because the residual is the honest
     * limit: an invoice part-paid by an advance before the channel remitted
     * owes less than its face value, and allocating the face value would take
     * it negative. Whatever is left over stays owing and shows up in the next
     * cycle's pull, which is exactly where the channel's own "unsettled"
     * column puts it.
     */
    for (const d of docs) {
      const amount = Math.min(Math.abs(d.gross), d.residual);
      if (amount <= 0) continue;
      await run(
        `INSERT INTO payment_allocations (org_id, settlement_id, document_id, amount, at, by_user)
         VALUES (?,?,?,?,?,?)`,
        orgId, settlementId, d.document_id, amount, nowIso(), actor.id ?? null,
      );
      await refreshResidual(orgId, d.document_id);
    }

    await run(
      `UPDATE settlements SET state='posted', number=?, entry_id=?, posted_by=?, posted_at=?
         WHERE id=? AND org_id=?`,
      number, entryId, actor.id ?? null, nowIso(), settlementId, orgId,
    );
    await run(
      `UPDATE settlement_documents SET status='SUCCESS' WHERE settlement_id=?`, settlementId,
    );
    await audit(orgId, actor, 'posted', 'settlement', settlementId,
      `${number} posted · net ${(settlement.net_payout / 100).toFixed(2)}`);
    return entryId;
  });
}

/**
 * Reverse a posted settlement.
 *
 * The allocations go first and the entry second, in that order: an allocation
 * left behind would keep an invoice reading as paid against a cycle that no
 * longer exists, and the ageing report would disagree with the receivable it
 * is supposed to summarise.
 */
export async function reverseSettlement(
  orgId: string, settlementId: string, date: string, actor: Actor = {}, reason?: string,
) {
  return await tx(async () => {
    const s = await getSettlement(orgId, settlementId);
    if (!s) throw new PostingError('Unknown settlement.');
    if (s.state !== 'posted') throw new PostingError('Only a posted settlement can be reversed.');

    const allocations = await all<{ id: number; document_id: string }>(
      'SELECT id, document_id FROM payment_allocations WHERE settlement_id=?', settlementId,
    );
    for (const a of allocations) {
      await run('DELETE FROM payment_allocations WHERE id=?', a.id);
      await refreshResidual(orgId, a.document_id);
    }
    if (s.entry_id) await reverseEntry(orgId, s.entry_id, date, actor, reason);
    await run(`UPDATE settlements SET state='cancelled' WHERE id=? AND org_id=?`, settlementId, orgId);
    await audit(orgId, actor, 'reversed', 'settlement', settlementId, reason ?? 'Settlement reversed');
  });
}

async function bankGlAccount(orgId: string, s: SettlementRow): Promise<string> {
  if (s.bank_account_id) {
    const ba = await one<{ account_id: string }>(
      'SELECT account_id FROM bank_accounts WHERE id=? AND org_id=?', s.bank_account_id, orgId,
    );
    if (ba) return ba.account_id;
  }
  const fallback = await one<{ account_id: string }>(
    'SELECT account_id FROM bank_accounts WHERE org_id=? AND active=1 ORDER BY is_default DESC, is_cash LIMIT 1',
    orgId,
  );
  if (!fallback) {
    throw new PostingError(
      'This settlement has no bank account, and the agency has none configured. ' +
      'Add one under Settings → Bank & Cash.',
    );
  }
  return fallback.account_id;
}

async function journalOfBank(orgId: string, bankAccountId: string | null): Promise<string | null> {
  if (!bankAccountId) return null;
  return (await one<{ journal_id: string | null }>(
    'SELECT journal_id FROM bank_accounts WHERE id=? AND org_id=?', bankAccountId, orgId,
  ))?.journal_id ?? null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getSettlement(orgId: string, settlementId: string): Promise<SettlementRow | null> {
  return await one<SettlementRow>(
    `SELECT s.*, p.name AS partner_name, b.name AS bank_account_name,
            (SELECT COUNT(*) FROM settlement_documents sd WHERE sd.settlement_id = s.id) AS orders
       FROM settlements s
       LEFT JOIN partners p ON p.id = s.partner_id
       LEFT JOIN bank_accounts b ON b.id = s.bank_account_id
      WHERE s.id=? AND s.org_id=?`, settlementId, orgId,
  );
}

export async function listSettlements(orgId: string, f: {
  partnerId?: string; state?: string; from?: string; to?: string; limit?: number;
} = {}): Promise<SettlementRow[]> {
  const clauses = ['s.org_id = ?'];
  const params: Array<string | number> = [orgId];
  if (f.partnerId) { clauses.push('s.partner_id = ?'); params.push(f.partnerId); }
  if (f.state) { clauses.push('s.state = ?'); params.push(f.state); }
  if (f.from) { clauses.push('s.cycle_to >= ?'); params.push(f.from); }
  if (f.to) { clauses.push('s.cycle_from <= ?'); params.push(f.to); }
  return await all<SettlementRow>(
    `SELECT s.*, p.name AS partner_name, b.name AS bank_account_name,
            (SELECT COUNT(*) FROM settlement_documents sd WHERE sd.settlement_id = s.id) AS orders
       FROM settlements s
       LEFT JOIN partners p ON p.id = s.partner_id
       LEFT JOIN bank_accounts b ON b.id = s.bank_account_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY s.cycle_to DESC, s.created_at DESC
      LIMIT ${f.limit ?? 100}`,
    ...params,
  );
}

export async function settlementDocuments(orgId: string, settlementId: string): Promise<SettlementDocRow[]> {
  return await all<SettlementDocRow>(
    `SELECT sd.*, d.number, d.doc_type, d.doc_date, d.order_ref, d.order_date,
            d.place_of_supply, d.irn, d.residual, d.untaxed, d.tax_total, d.total
       FROM settlement_documents sd JOIN documents d ON d.id = sd.document_id
      WHERE sd.settlement_id=? AND sd.org_id=?
      ORDER BY sd.kind DESC, d.doc_date, d.number`, settlementId, orgId,
  );
}

/**
 * A settlement's manual charges.
 *
 * `orgId` is not needed to FIND the rows — a settlement id identifies them on
 * its own. It is there so that asking for another agency's settlement returns
 * nothing instead of returning what the channel deducted from it, which is the
 * same reasoning as `settlementDocuments` above and as `documentLines` in
 * accounting/documents.ts. Every caller today proves ownership first by way of
 * `getSettlement(orgId, ...)`; the filter is what makes that a property of the
 * function rather than a habit of its callers, now that one database holds
 * several agencies' books and the id arrives from `/settlements/<id>`.
 */
export async function settlementCharges(orgId: string, settlementId: string): Promise<SettlementChargeRow[]> {
  return await all<SettlementChargeRow>(
    'SELECT * FROM settlement_charges WHERE org_id=? AND settlement_id=? ORDER BY seq, label',
    orgId, settlementId,
  );
}

/**
 * What the channel still owes after this cycle, from the ledger rather than
 * from the statement it sent.
 *
 * This is the figure the statement calls "unsettled from previous cycle", and
 * reading it off the receivable is the only way it can be trusted: the channel
 * computes it from its own records, and when the two disagree the ledger is
 * what the agency has to defend.
 */
export async function unsettledFor(orgId: string, partnerId: string, onOrBefore: string): Promise<number> {
  const row = await one<{ residual: number }>(
    `SELECT COALESCE(SUM(CASE WHEN doc_type='out_invoice' THEN residual ELSE -residual END),0) AS residual
       FROM documents
      WHERE org_id=? AND partner_id=? AND state='posted' AND doc_date <= ?
        AND doc_type IN ('out_invoice','out_refund')`,
    orgId, partnerId, onOrBefore,
  );
  return row?.residual ?? 0;
}

/** Whether the settlement accounts are configured, for the readiness screen. */
export async function settlementAccountsReady(orgId: string): Promise<boolean> {
  for (const key of [
    'account.channel_commission', 'account.channel_shipping', 'account.channel_charges',
    'account.channel_recovery', 'account.tcs_receivable', 'account.tds_receivable',
  ] as const) {
    if (!await getSetting(orgId, key)) return false;
  }
  return true;
}
