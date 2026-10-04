import 'server-only';
import { all, one, run, scalar, tx, id, nowIso } from '../db';
import { DOC_TYPES, type DocType, addDays, formatDocNumber } from '@/lib/accounting';
import { computeLine, computeWithholding, getTax, taxChildren, type LineAmounts, type TaxSplit } from './tax';
import { postEntry, reverseEntry, replacePostedEntry, PostingError, type Actor, type PostingLine } from './engine';
import { receivableAccount, payableAccount, requireSetting } from './settings';
import { audit } from './audit';
import { searchTokens } from '@/lib/search';
import { pct, roundHalfUp } from '@/lib/money';
import { parseGstin, parseHsn, getOrganisation } from './organisation';

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
  /**
   * HSN or SAC — required on a GST tax invoice by Rule 46 of the CGST Rules,
   * and snapshotted onto the line rather than read off the product at print
   * time: a product reclassified next year must not change what this invoice
   * said it was selling.
   */
  hsnCode?: string | null;
  /**
   * What KIND of line this is, in TripzoCRM's own vocabulary — `package`,
   * `service`, `extra`, and the others its mobile app offers.
   *
   * A snapshot, like the HSN beside it: it decided which revenue account the
   * import chose, so an invoice has to keep saying what it was raised as even
   * after the CRM's list of kinds changes. Null on a line typed here that
   * nobody classified, which is an ordinary state and not a defect.
   */
  itemType?: string | null;
  /**
   * The list price the discount comes off, for the MRP column. It is
   * PRESENTATION ONLY — the tax and the total are computed from `unitPrice`,
   * never from this — but a statement that shows a selling price with no MRP
   * beside it cannot be checked against the channel's own.
   */
  mrp?: number;
}

export interface DocInput {
  orgId: string;
  docType: DocType;
  partnerId: string;
  journalId: string;
  bookingId?: string | null;
  analyticId?: string | null;
  /**
   * VENDOR BILLS: THE CUSTOMER INVOICE THIS COST WAS INCURRED FOR.
   *
   * A travel agency's costs are bought AGAINST a sale — the hotel is booked
   * because somebody bought the package — and the margin on that sale is the
   * invoice less every bill raised for it. The bill form used to ask for the
   * TRIP instead, which is the same idea one step removed and in practice
   * unanswerable: a trip is a CRM booking, most invoices are raised against
   * travellers with no booking row at all, so the field stayed blank and the
   * cost reached no trip. The invoice always exists, by definition, because
   * the agency raised it.
   *
   * IT IS NOT A SECOND WAY OF TAGGING A TRIP. `deriveTripFromInvoice` copies
   * the invoice's own booking and analytic account onto the bill when the bill
   * does not state them itself, and from there everything downstream is
   * unchanged: it is still the analytic tag on the GL line that makes a cost
   * part of a trip's margin. What changed is that the tag now gets set,
   * because the question the form asks is one the user can answer.
   *
   * WHAT THE BILL STATES ITSELF STILL WINS. Someone who picks an invoice AND a
   * trip has said something deliberate, and a derivation that overrode it
   * would be the system disagreeing with the person typing.
   */
  linkedInvoiceId?: string | null;
  docDate: string;
  dueDate?: string | null;
  paymentTermsId?: string | null;
  supplierRef?: string | null;
  currency?: string;
  rateE6?: number;
  /** Vendor bills only: the TDS section to withhold under. */
  withholdingTaxId?: string | null;
  note?: string | null;
  /**
   * The GST state code the supply is made to.
   *
   * A POSTING INPUT, not a label: compared against the agency's own state it is
   * what makes a supply intra-state (CGST+SGST) or inter-state (IGST), and it
   * is the one field on a tax invoice that a customer's accountant checks
   * first. Left unset it falls back to the partner's own state — see
   * `derivePlaceOfSupply` — and is then SNAPSHOTTED, so a customer who moves
   * states does not retrospectively change the tax on invoices already raised.
   */
  placeOfSupply?: string | null;
  /**
   * The counterparty's GSTIN as this document states it.
   *
   * SNAPSHOTTED, for the same reason the place of supply is. A customer typed
   * straight into the form has no partner record carrying a registration yet,
   * and a partner who re-registers must not change what an invoice already
   * issued says. Left unset it falls back to the partner's own — see
   * `derivePartyGstin` — and a registration given here back-fills a partner that
   * has none, so it is typed once rather than once per invoice.
   */
  partyGstin?: string | null;
  /**
   * Whether this is a supply to a registered business or to a consumer.
   *
   * IT IS WHAT MAKES THE GSTIN CONDITIONAL rather than merely optional. Blank
   * on its own says nothing: an unregistered traveller has no registration to
   * state, and a corporate booking whose registration nobody typed looks
   * identical. Said explicitly, 'b2b' REQUIRES the GSTIN (see
   * `resolveSupplyType`) and 'b2c' does not — which is also the split GSTR-1
   * reports on, invoice-wise in Table 4A against aggregate in Tables 5 and 7.
   *
   * Defaults from the registration if it is not stated, so nothing that
   * reaches `createDocument` without it — the CRM importer, a credit note
   * generated from an invoice — changes meaning.
   */
  supplyType?: 'b2b' | 'b2c' | null;
  /** Recorded from the Invoice Registration Portal, never generated here. */
  irn?: string | null;
  irnAckNo?: string | null;
  irnAckDate?: string | null;
  /** The customer's or channel's own order reference, and when it was placed. */
  orderRef?: string | null;
  orderDate?: string | null;
  /**
   * WHAT THE SOURCE DOCUMENT STATED, CARRIED ACROSS RATHER THAN DERIVED.
   *
   * A TripzoCRM invoice holds one discount, one tax figure and one amount
   * already collected, for the whole invoice. The importer used to turn the
   * first into a per-line percentage and the second into a rate divided back
   * out of an amount — two inferences, both of which MOVE THE TOTAL, so the
   * ledger stated a figure the customer was never sent.
   *
   * `statedDiscount` and `statedAdvance` are RECORDED AND NOT POSTED: the item
   * prices already account for the discount, and an advance is money, which
   * reaches the books as a receipt rather than as part of an invoice.
   *
   * `statedTax` IS posted, and it is the one figure that changes how the lines
   * are computed: it is carved OUT of the line amounts rather than added on top
   * of them, so the document total stays exactly the sum of what was sold.
   * Choosing a GST slab on a line then decides which tax rows that figure is
   * split across, never how large it is. See `replaceLines`.
   */
  statedDiscount?: number;
  statedTax?: number;
  statedAdvance?: number;
  lines: DocLineInput[];
}

export interface DocRow {
  id: string; org_id: string; doc_type: DocType; number: string | null;
  partner_id: string; partner_name?: string; journal_id: string;
  booking_id: string | null; booking_ref?: string | null; analytic_id: string | null;
  /** Vendor bills: the customer invoice this cost was incurred for. */
  linked_invoice_id: string | null;
  /** Joined for display — the invoice's own number and what it was raised for. */
  linked_invoice_number?: string | null;
  linked_invoice_date?: string | null;
  linked_invoice_total?: number | null;
  linked_invoice_partner?: string | null;
  doc_date: string; due_date: string | null; supplier_ref: string | null;
  currency: string; rate_e6: number; state: string; payment_state: string;
  untaxed: number; tax_total: number; total: number; residual: number;
  withheld_tax: number; withholding_tax_id: string | null;
  payment_terms_id: string | null; entry_id: string | null; reversal_of: string | null;
  reversed_by: string | null; note: string | null;
  place_of_supply: string | null; party_gstin: string | null; supply_type: string | null; irn: string | null;
  irn_ack_no: string | null; irn_ack_date: string | null;
  order_ref: string | null; order_date: string | null;
  /** What the source document stated — see `DocInput`. Paise, never negative. */
  stated_discount: number; stated_tax: number; stated_advance: number;
  created_by: string | null; created_at: string; posted_by: string | null; posted_at: string | null;
  /** Joined from the partner, for the printed header and the export. */
  partner_gstin?: string | null; partner_gst_name?: string | null;
  partner_city?: string | null; partner_state_code?: string | null;
  partner_address?: string | null;
  /**
   * The TripzoCRM invoice number this document was drafted from, when it came
   * from the CRM rather than being typed here. Null for a document raised in
   * this app, which is a fact worth showing rather than hiding.
   */
  crm_invoice_number?: string | null;
}

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export async function createDocument(input: DocInput, actor: Actor = {}): Promise<string> {
  return await tx(async () => {
    const docId = id('doc');
    const due = input.dueDate ?? await deriveDueDate(input);
    // Resolved together, because the two answers constrain each other: a
    // B2B supply is not allowed to reach the ledger without a registration.
    const gstin = await derivePartyGstin(input);
    const supplyType = resolveSupplyType(input, gstin);
    // A bill records what was spent AGAINST a sale, and the trip comes off
    // that sale rather than being asked for twice. See `deriveTripFromInvoice`.
    const trip = await deriveTripFromInvoice(input);
    await run(
      `INSERT INTO documents
         (id, org_id, doc_type, partner_id, journal_id, booking_id, analytic_id, linked_invoice_id,
          doc_date, due_date, payment_terms_id, supplier_ref, currency, rate_e6,
          state, payment_state, withholding_tax_id, note,
          place_of_supply, party_gstin, supply_type, irn, irn_ack_no, irn_ack_date, order_ref, order_date,
          stated_discount, stated_tax, stated_advance,
          created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft','not_paid',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      docId, input.orgId, input.docType, input.partnerId, input.journalId,
      trip.bookingId, trip.analyticId, trip.linkedInvoiceId, input.docDate, due,
      input.paymentTermsId ?? null, input.supplierRef ?? null,
      input.currency ?? 'INR', input.rateE6 ?? 1_000_000,
      input.withholdingTaxId ?? null, input.note ?? null,
      await derivePlaceOfSupply(input), gstin, supplyType,
      input.irn ?? null, input.irnAckNo ?? null,
      input.irnAckDate ?? null, input.orderRef ?? null, input.orderDate ?? null,
      nonNegative(input.statedDiscount), nonNegative(input.statedTax), nonNegative(input.statedAdvance),
      actor.id ?? null, nowIso(),
    );
    // THE DERIVED analytic, not the input's: a bill whose trip came off its
    // invoice has to tag its LINES with it, because the analytic distribution
    // the margin is built from is written per line. Passing the raw input here
    // was the difference between a bill that says which trip it is for and a
    // trip that knows what it cost.
    await replaceLines(input.orgId, docId, input.lines, trip.analyticId,
      nonNegative(input.statedTax));
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
    if (doc.state !== 'draft') throw new PostingError('A posted document cannot be edited here. Use "Amend" on the document, which rewrites its ledger entry in place.');
    const gstin = await derivePartyGstin(input);
    const supplyType = resolveSupplyType(input, gstin);
    const trip = await deriveTripFromInvoice(input);
    await run(
      `UPDATE documents SET partner_id=?, journal_id=?, booking_id=?, analytic_id=?,
              linked_invoice_id=?,
              doc_date=?, due_date=?, payment_terms_id=?, supplier_ref=?, currency=?, rate_e6=?,
              withholding_tax_id=?, note=?, place_of_supply=?, party_gstin=?, supply_type=?,
              irn=?, irn_ack_no=?, irn_ack_date=?, order_ref=?, order_date=?,
              stated_discount=?, stated_tax=?, stated_advance=?
         WHERE id=? AND org_id=?`,
      input.partnerId, input.journalId, trip.bookingId, trip.analyticId, trip.linkedInvoiceId,
      input.docDate, input.dueDate ?? await deriveDueDate(input), input.paymentTermsId ?? null,
      input.supplierRef ?? null, input.currency ?? 'INR', input.rateE6 ?? 1_000_000,
      input.withholdingTaxId ?? null, input.note ?? null,
      await derivePlaceOfSupply(input), gstin, supplyType,
      input.irn ?? null, input.irnAckNo ?? null,
      input.irnAckDate ?? null, input.orderRef ?? null, input.orderDate ?? null,
      nonNegative(input.statedDiscount), nonNegative(input.statedTax), nonNegative(input.statedAdvance),
      docId, input.orgId,
    );
    await replaceLines(input.orgId, docId, input.lines, trip.analyticId,
      nonNegative(input.statedTax));
    // '' rather than null: null means "leave the withheld amount alone", and an
    // edit that clears the TDS dropdown has to clear the deduction with it.
    await recomputeTotals(input.orgId, docId, input.withholdingTaxId ?? '');
    await audit(input.orgId, actor, 'modified', 'document', docId, 'Draft edited');
  });
}

/**
 * THE TRIP A VENDOR BILL BELONGS TO, TAKEN FROM THE SALE IT WAS BOUGHT FOR.
 *
 * ===========================================================================
 * WHY THE BILL ASKS FOR AN INVOICE AND NOT FOR A TRIP
 * ===========================================================================
 * Trip profitability is the analytic tag on the GL line — that has not changed
 * and must not: it is what makes a trip's margin reconcile to the P&L instead
 * of merely resembling it. What changed is where the tag comes from.
 *
 * The bill form used to ask for the TRIP directly, and the honest answer is
 * that nobody filled it in. A trip here is a `bookings` row, which exists only
 * for sales that came through the CRM with a lead behind them; the invoices an
 * agency raises by typing a traveller's name have none. So the purchase clerk
 * recording what the hotel charged was shown a dropdown that frequently did
 * not contain the trip they meant, left it blank, and the cost landed in the
 * P&L tagged to nothing. The margin report then showed revenue with no cost
 * against it — which does not read as a missing tag, it reads as a very
 * profitable trip.
 *
 * THE INVOICE IS ALWAYS THERE. The agency raised it; that is why the cost is
 * being incurred. And the invoice already carries the booking and the analytic
 * account when there is one, so naming the invoice names the trip transitively
 * and names the sale directly — which is the better answer anyway, because
 * "what did we spend against this sale" is the question an agency asks about a
 * one-off package that never became a booking record.
 *
 * WHAT THE BILL SAYS ITSELF IS LEFT ALONE. This only ever fills a blank. A
 * purchase clerk who picked an invoice AND a different trip has said something
 * deliberate — a shared coach across two departures, say — and a derivation
 * that overrode it would be the system disagreeing with the person typing.
 *
 * AND IT IS ONLY READ ON THE PURCHASE SIDE. An `out_invoice` pointing at
 * another `out_invoice` is not a cost against a sale, it is a mapping fault,
 * and copying a trip across it would move one sale's revenue onto another's
 * margin.
 */
async function deriveTripFromInvoice(
  input: DocInput,
): Promise<{ bookingId: string | null; analyticId: string | null; linkedInvoiceId: string | null }> {
  const bookingId = input.bookingId ?? null;
  const analyticId = input.analyticId ?? null;
  const linkedInvoiceId = (input.linkedInvoiceId ?? '').trim() || null;
  if (!linkedInvoiceId || !input.docType.startsWith('in_')) {
    return { bookingId, analyticId, linkedInvoiceId: input.docType.startsWith('in_') ? linkedInvoiceId : null };
  }

  const inv = await one<{ id: string; doc_type: string; booking_id: string | null; analytic_id: string | null; number: string | null }>(
    'SELECT id, doc_type, booking_id, analytic_id, number FROM documents WHERE id = ? AND org_id = ?',
    linkedInvoiceId, input.orgId,
  );
  /*
   * A LINK TO SOMETHING THAT IS NOT A SALE IS REFUSED RATHER THAN IGNORED.
   *
   * Silently dropping it would leave the bill looking linked on the form the
   * user submitted and unlinked in the books, and the margin they were trying
   * to build would be short by this cost with nothing on screen to say why.
   */
  if (!inv) throw new PostingError('The invoice this bill is against no longer exists.');
  if (!inv.doc_type.startsWith('out_')) {
    throw new PostingError(
      'A vendor bill is recorded against a CUSTOMER INVOICE — the sale the cost was incurred for. '
      + `${inv.number ?? 'That document'} is not one.`,
    );
  }

  return {
    bookingId: bookingId ?? inv.booking_id,
    analyticId: analyticId ?? inv.analytic_id,
    linkedInvoiceId,
  };
}

/**
 * The place of supply, from the form if it was given and from the partner if
 * it was not.
 *
 * WHY A FALLBACK AT ALL. The field is new, and every partner synced from the
 * CRM or created by typing a name into an invoice has a state only if someone
 * filled one in. Requiring it on the form would have blocked the one path that
 * matters most — raising the first invoice against a traveller who does not
 * exist as a master record yet — so the partner's own state is read instead,
 * and the result is stored on the document either way. Nothing is derived at
 * READ time: the snapshot is the point.
 */
async function derivePlaceOfSupply(input: DocInput): Promise<string | null> {
  const given = (input.placeOfSupply ?? '').trim();
  if (given) return given;
  /*
   * A GSTIN TYPED ON THIS DOCUMENT IS CONSULTED BEFORE THE PARTNER RECORD.
   *
   * Its first two digits ARE the state, and they are the freshest statement of
   * it on the page: someone who typed a Maharashtra registration into the form
   * said Maharashtra, whatever a partner record created months ago still says.
   * Without this the two new fields disagreed in the one case they most matter
   * — a first invoice against a customer who exists only as a name — leaving an
   * invoice printing a 27 GSTIN and taxed as if it were intra-state Delhi.
   */
  const typed = (input.partyGstin ?? '').trim().toUpperCase();
  if (typed.length >= 2 && /^[0-9]{2}/.test(typed)) return typed.slice(0, 2);
  const p = await one<{ state_code: string | null; gstin: string | null }>(
    'SELECT state_code, gstin FROM partners WHERE id = ? AND org_id = ?',
    input.partnerId, input.orgId,
  );
  return p?.state_code ?? (p?.gstin ? p.gstin.slice(0, 2) : null);
}

/**
 * The counterparty's GSTIN, from the form if it was given and from the partner
 * if it was not.
 *
 * The same shape as `derivePlaceOfSupply`, and for the same reason: the field is
 * new, the form cannot require it — an unregistered traveller has none, and B2C
 * is most of a travel agency's book — and what is stored has to be the
 * registration this document was raised against rather than whatever the
 * partner's record happens to say the day it is printed.
 *
 * Validated, not merely trimmed. A malformed GSTIN on a tax invoice is the
 * failure the buyer discovers when their credit does not appear, which is a
 * quarter later and no longer correctable by editing a draft.
 */
async function derivePartyGstin(input: DocInput): Promise<string | null> {
  const given = parseGstin(input.partyGstin);
  if (given) return given;
  const p = await one<{ gstin: string | null }>(
    'SELECT gstin FROM partners WHERE id = ? AND org_id = ?', input.partnerId, input.orgId,
  );
  return p?.gstin ?? null;
}

/**
 * B2B or B2C, and the one rule that follows from saying so.
 *
 * A B2B SUPPLY WITHOUT A GSTIN IS REFUSED, HERE, at the service rather than in
 * the form. The form marks the box required and that is a courtesy; a server
 * action is a public endpoint, the CRM importer does not fill forms at all, and
 * the cost of the omission is not the agency's — it is the customer's input
 * credit, discovered a quarter later when their GSTR-2B is short and no longer
 * correctable by editing anything.
 *
 * NOT STATED, SO INFERRED. Everything that reached this file before the field
 * existed still reaches it: a credit note generated from an invoice, a document
 * synced from the CRM, a draft saved by an older form. A registration is the
 * thing that distinguishes a business from a traveller, so its presence decides
 * — which is the same rule `resolvePartnerByName` already applies when it
 * stamps `partner_type` on a partner minted by typing a name.
 */
function resolveSupplyType(input: DocInput, gstin: string | null): 'b2b' | 'b2c' {
  const stated = (input.supplyType ?? '').trim().toLowerCase();
  if (stated === 'b2b') {
    if (!gstin) {
      throw new PostingError(
        'A B2B supply has to carry the counterparty\u2019s GSTIN — it is what the invoice is reported ' +
        'against in GSTR-1 Table 4A and the only way their input credit can reach them. ' +
        'Type the registration, or mark this a B2C supply.',
      );
    }
    return 'b2b';
  }
  if (stated === 'b2c') return 'b2c';
  return gstin ? 'b2b' : 'b2c';
}

async function deriveDueDate(input: DocInput): Promise<string> {
  if (input.dueDate) return input.dueDate;
  if (input.paymentTermsId) {
    const t = await one<{ days: number }>('SELECT days FROM payment_terms WHERE id = ?', input.paymentTermsId);
    if (t) return addDays(input.docDate, t.days);
  }
  return input.docDate;
}

/**
 * The HSN/SAC a line ends up carrying, and where it comes from when the line
 * does not state one.
 *
 * NO SYSTEM CAN DERIVE AN HSN. It is a classification the taxpayer assigns and
 * answers for under Rule 46, and nothing in "Bali 5D/4N — 2 pax" determines it;
 * a product that guessed would be putting a number the agency is liable for
 * onto a statutory document. What a system can do is stop asking for the same
 * code twice, which is the whole of what this does:
 *
 *   the line's own  →  the account it is posted to  →  the agency's default
 *
 * Most specific first, and every step is something a person set deliberately.
 * The form applies the same chain as you type so the column is visibly filled
 * before anything is saved; this is the server's copy of it, which is what makes
 * it true for the no-JavaScript path, for a credit note generated from an
 * invoice, and for anything else that reaches `createDocument` directly.
 *
 * ONE QUERY FOR THE WHOLE DOCUMENT, not one per line: a twelve-line invoice on
 * three accounts is two round trips, not twenty-four.
 */
async function resolveLineHsns(orgId: string, lines: DocLineInput[]): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  const needy = lines.map((l, i) => [i, l] as const)
    .filter(([, l]) => !(l.hsnCode ?? '').trim());
  for (const [i, l] of lines.entries()) {
    // Named by line, because a bounced form shows one message and a ten-line
    // invoice gives no clue which row carried the bad code.
    const own = parseHsn(l.hsnCode, `HSN / SAC code on line ${i + 1} (${l.name})`);
    if (own) out.set(i, own);
  }
  if (!needy.length) return out;

  const accountIds = [...new Set(needy.map(([, l]) => l.accountId).filter(Boolean))];
  const byAccount = new Map<string, string | null>();
  if (accountIds.length) {
    const rows = await all<{ id: string; default_hsn_code: string | null }>(
      `SELECT id, default_hsn_code FROM accounts
        WHERE org_id = ? AND id IN (${accountIds.map(() => '?').join(',')})`,
      orgId, ...accountIds,
    );
    for (const r of rows) byAccount.set(r.id, r.default_hsn_code);
  }
  const orgDefault = (await getOrganisation(orgId))?.default_hsn_code ?? null;

  for (const [i, l] of needy) {
    out.set(i, byAccount.get(l.accountId) || orgDefault || null);
  }
  return out;
}

/** Negative money is never a stated figure; a missing one is zero. */
function nonNegative(v: number | null | undefined): number {
  return Math.max(0, Math.round(Number(v ?? 0)) || 0);
}

/**
 * The amount a line is worth before any tax is taken out of it or added to it.
 *
 * The same arithmetic `computeLine` opens with, lifted out so the pinned path
 * below can work from it without asking the tax engine a question whose answer
 * it is about to discard.
 */
function lineGross(l: DocLineInput): number {
  const gross = roundHalfUp((l.qtyMilli * l.unitPrice) / 1000);
  return gross - pct(gross, l.discountBps ?? 0);
}

/**
 * ===========================================================================
 * THE TAX THE SOURCE DOCUMENT STATED, SPLIT THE WAY THE SLAB SAYS — AND NOT
 * RECOMPUTED.
 * ===========================================================================
 * An ordinary line computes its tax FROM its rate: ₹35,998 at 18% adds
 * ₹6,479.64 and the customer owes ₹42,477.64. That is right when the ledger is
 * where the invoice was raised, and wrong when it is not — a TripzoCRM invoice
 * arrives with the tax already decided, as ONE figure for the whole invoice,
 * and the customer has already been sent a total computed from it.
 *
 * So when a document carries a stated tax, the arithmetic is inverted:
 *
 *   THE LINE TOTALS ARE FIXED. Each line is worth exactly what was sold for,
 *   and the document total is their sum. Choosing a slab moves nothing on
 *   screen, which is the whole requirement — an accountant classifying an
 *   invoice must not restate it.
 *
 *   THE STATED FIGURE IS THE TAX. It is apportioned across the lines that
 *   carry a slab, pro rata to their value, and carved OUT of them: a line of
 *   ₹35,998 bearing ₹1,919.89 of it posts ₹34,078.11 of revenue. The last
 *   bearer takes the remainder, so the parts add back to the stated figure
 *   EXACTLY — a rounding difference here would be a penny of GST that no
 *   account holds and the entry would not balance.
 *
 *   THE SLAB DECIDES THE COMPONENTS. CGST+SGST at 9% each splits the line's
 *   share in half; a single IGST row takes all of it. That is what GSTR-1, the
 *   general ledger and the journal entry need from the choice — which
 *   government is owed, and on which document — and it is all the choice is
 *   allowed to decide.
 *
 * A LINE WITH NO SLAB BEARS NO TAX, and if NO line carries one the stated tax
 * is recorded on the document and posted nowhere: the books then say the sale
 * is untaxed, which is visible, correctable and honest. Inventing an account to
 * put it in would not be.
 */
async function pinStatedTax(
  orgId: string, lines: DocLineInput[], statedTax: number,
): Promise<LineAmounts[]> {
  const gross = lines.map(lineGross);
  const bearers = lines
    .map((l, i) => i)
    .filter((i) => lines[i].taxId && gross[i] > 0);

  const plain = (i: number): LineAmounts =>
    ({ subtotal: gross[i], taxAmount: 0, total: gross[i], splits: [] });
  if (!bearers.length) return lines.map((_, i) => plain(i));

  const bearerTotal = bearers.reduce((t, i) => t + gross[i], 0);
  const out = lines.map((_, i) => plain(i));
  let left = Math.min(statedTax, bearerTotal);

  for (const [k, i] of bearers.entries()) {
    const last = k === bearers.length - 1;
    const share = Math.min(
      left,
      last ? left : Math.round((Math.min(statedTax, bearerTotal) * gross[i]) / bearerTotal),
    );
    left -= share;

    const tax = await getTax(orgId, lines[i].taxId!);
    if (!tax) continue;
    const children = await taxChildren(orgId, tax.id);
    const components = children.length ? children : [tax];
    const subtotal = gross[i] - share;

    /*
     * BY RATE, NOT BY COUNT. CGST 9 + SGST 9 is half each either way, but a
     * cess riding beside an 18% GST is not a third of the tax, and splitting
     * evenly would credit the cess account with money that is the state's.
     */
    const weight = components.reduce((t, c) => t + (c.computation === 'fixed' ? 0 : c.rate_bps), 0);
    let componentLeft = share;
    const splits: TaxSplit[] = components.map((c, j) => {
      const isLast = j === components.length - 1;
      const amount = isLast || weight <= 0
        ? componentLeft
        : Math.min(componentLeft, Math.round((share * c.rate_bps) / weight));
      componentLeft -= amount;
      return {
        taxId: c.id,
        name: c.name,
        accountId: c.account_id,
        base: subtotal,
        amount,
        rateBps: c.computation === 'fixed' ? 0 : c.rate_bps,
        group: c.tax_group,
      };
    });

    out[i] = { subtotal, taxAmount: share, total: gross[i], splits };
  }
  return out;
}

async function replaceLines(
  orgId: string, docId: string, lines: DocLineInput[], docAnalytic: string | null,
  statedTax = 0,
) {
  // The split table hangs off the lines, so it goes first: deleting the lines
  // cascades it away anyway, but the order makes that independent of the
  // cascade being configured, which is the sort of thing a schema edit breaks
  // silently.
  await run('DELETE FROM document_line_taxes WHERE document_id = ?', docId);
  await run('DELETE FROM document_lines WHERE document_id = ?', docId);
  const hsns = await resolveLineHsns(orgId, lines);
  /*
   * ONE OF TWO ARITHMETICS, AND THE DOCUMENT DECIDES WHICH.
   *
   * No stated tax — an invoice typed here — and every line computes its own tax
   * from its own rate, as it always has. A stated tax, and the figure the
   * source document gave is split across the lines instead of being derived
   * from them; see `pinStatedTax`.
   */
  const pinned = statedTax > 0 ? await pinStatedTax(orgId, lines, statedTax) : null;
  // Sequential, not Promise.all: these inserts share the posting transaction's
  // one connection, and `seq` must land in the order the accountant typed.
  for (const [i, l] of lines.entries()) {
    const amounts = pinned ? pinned[i] : await computeLine(orgId, l);
    const lineId = l.id ?? id('dl');
    await run(
      `INSERT INTO document_lines
         (id, org_id, document_id, seq, product_id, name, qty_milli, unit_price,
          discount_bps, tax_id, account_id, analytic_id, subtotal, tax_amount, total,
          hsn_code, mrp, item_type)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      lineId, orgId, docId, i, l.productId ?? null, l.name,
      l.qtyMilli, l.unitPrice, l.discountBps ?? 0, l.taxId ?? null, l.accountId,
      l.analyticId ?? docAnalytic, amounts.subtotal, amounts.taxAmount, amounts.total,
      hsns.get(i) ?? null, l.mrp ?? 0, (l.itemType ?? '').trim().toLowerCase() || null,
    );

    /*
     * KEEP THE SPLIT, DO NOT RECOMPUTE IT LATER.
     *
     * `computeLine` already worked out what each tax component comes to in
     * order to decide what to post; this writes it down. Deriving it again at
     * report time would read TODAY's tax rows, so a GST rate changed in
     * October would silently restate every invoice raised in September — and
     * the restated figures would not match the returns already filed.
     *
     * `tax_group` is denormalised for the same reason: a column headed CGST on
     * a statement has to stay CGST even after that tax row is retired.
     */
    for (const split of amounts.splits) {
      await run(
        `INSERT INTO document_line_taxes
           (id, org_id, document_id, line_id, tax_id, tax_name, tax_group, rate_bps,
            base, amount, account_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id('dlt'), orgId, docId, lineId, split.taxId, split.name,
        normaliseTaxGroup(split.name, split.group), split.rateBps,
        split.base, split.amount, split.accountId,
      );
    }
  }
}

/**
 * Which statement column a tax component belongs in.
 *
 * The `taxes` table's own `tax_group` now says which component a child is —
 * `cgst`, `sgst`, `utgst` — and that is the answer whenever it is there. It was
 * not always: a CGST+SGST pair used to be one parent of group `cgst_sgst` with
 * two children BOTH marked plain `gst`, because what the ledger needed to know
 * was "this is GST and here is its account". A statement needs the opposite,
 * and on rows written under the old shape the group cannot give it.
 *
 * So the group is consulted first and the NAME is the fallback, which is the
 * right way round and used to be the wrong one. The seed names them "CGST 9%"
 * and "UTGST 9%" precisely because that is what the invoice prints, so a
 * document raised before the groups were split still reports component-wise.
 *
 * UTGST IS NOT FOLDED INTO SGST, and that is a correction rather than a
 * refinement. It used to be, and the two are different statutes owed to
 * different governments with a column each in GSTR-3B: a Chandigarh supply
 * reported under SGST credits a state that was never party to it.
 */
function normaliseTaxGroup(name: string, group: string | null | undefined): string {
  if (group && ['igst', 'cgst', 'sgst', 'utgst', 'cess', 'tcs', 'tds'].includes(group)) {
    return group;
  }
  const n = name.toUpperCase();
  if (n.includes('CESS')) return 'cess';
  if (n.includes('IGST')) return 'igst';
  if (n.includes('UTGST')) return 'utgst';
  if (n.includes('CGST')) return 'cgst';
  if (n.includes('SGST')) return 'sgst';
  return group ?? 'other';
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

/**
 * The journal lines a document produces, built once and used twice.
 *
 * `postDocument` writes them for the first time; `amendDocument` writes them
 * over the top of what the document used to say. ONE builder, because two
 * copies of the debit/credit rules would be two copies that drift, and the
 * drift would show up as an amended invoice whose ledger entry no longer has
 * the same shape as an unamended one.
 *
 * The number is passed in rather than taken here: posting ASSIGNS one, amending
 * keeps the one already assigned, and the receivable line is labelled with it
 * either way.
 */
async function documentPostings(orgId: string, doc: DocRow, number: string): Promise<PostingLine[]> {
  const lines = await all<{
    id: string; name: string; account_id: string; analytic_id: string | null;
    subtotal: number; tax_amount: number; tax_id: string | null;
    // Scoped by org for the same reason `documentLines` is, even though `doc`
    // was already read org-scoped by every caller: the invariant belongs to the
    // query, not to the path that reached it.
  }>(`SELECT id, name, account_id, analytic_id, subtotal, tax_amount, tax_id
        FROM document_lines WHERE org_id = ? AND document_id = ? ORDER BY seq`, orgId, doc.id);
  if (!lines.length) throw new PostingError('A document with no lines cannot be posted.');

  const meta = DOC_TYPES[doc.doc_type];
  const isSale = meta.side === 'customer';
  // A credit note is the same entry with the sides swapped. One flag, not a
  // second code path.
  const flip = meta.sign === -1;

  const postings: PostingLine[] = [];

  /*
   * THE SPLIT IS READ, NOT RECOMPUTED.
   *
   * It used to be derived again here, by running the tax engine over each
   * line's stored subtotal. That was two bugs waiting in one line of code: a
   * tax-INCLUSIVE rate backed the base out of a figure the base had already
   * been backed out of, and a document whose tax was STATED rather than
   * computed — every invoice imported from TripzoCRM — would have posted the
   * slab's percentage instead of the amount the customer was actually charged.
   *
   * `replaceLines` already wrote what each component comes to, deliberately
   * ("KEEP THE SPLIT, DO NOT RECOMPUTE IT LATER"), for the same reason the
   * reports read it rather than today's tax table. The ledger now reads the
   * same row the GST return does, so the entry and the return cannot disagree.
   */
  const splitRows = await all<{
    line_id: string; tax_id: string; tax_name: string;
    base: number; amount: number; account_id: string | null;
  }>(`SELECT line_id, tax_id, tax_name, base, amount, account_id
        FROM document_line_taxes WHERE org_id = ? AND document_id = ?`, orgId, doc.id);
  const splitsOfLine = new Map<string, typeof splitRows>();
  for (const r of splitRows) {
    const list = splitsOfLine.get(r.line_id) ?? [];
    list.push(r);
    splitsOfLine.set(r.line_id, list);
  }

  // --- the income or expense side, one line per document line -------------
  for (const l of lines) {
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

    for (const split of splitsOfLine.get(l.id) ?? []) {
      if (!split.amount) continue;
      if (!split.account_id) throw new PostingError(`Tax "${split.tax_name}" has no account configured.`);
      const taxLine: PostingLine = {
        accountId: split.account_id,
        label: split.tax_name,
        partnerId: doc.partner_id,
        // Tagged to the trip like every other line of this entry, so a
        // booking-filtered ledger still balances. No analytic tag, though:
        // GST is collected for the government, and putting it through the
        // analytic account would inflate the trip's margin.
        bookingId: doc.booking_id,
        taxId: split.tax_id,
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
  //
  // Tagged with `taxId`/`taxBase` exactly like a GST split. Without the tag
  // the line is invisible to the tax report — the money sat correctly in TDS
  // Payable, but nothing told the agency what to deposit by the 7th, and a
  // 26Q return had to be assembled by reading the ledger by hand. The base is
  // the UNTAXED value, which is what `computeWithholding` deducted on: the
  // government does not withhold tax on its own GST.
  if (doc.withheld_tax > 0 && !isSale) {
    postings.push({
      accountId: await requireSetting(orgId, 'account.tds_payable'),
      partnerId: doc.partner_id,
      bookingId: doc.booking_id,
      label: 'TDS withheld',
      taxId: doc.withholding_tax_id,
      taxBase: doc.untaxed,
      ...(flip ? { debit: doc.withheld_tax } : { credit: doc.withheld_tax }),
    });
  }
  return postings;
}

export async function postDocument(orgId: string, docId: string, actor: Actor = {}): Promise<string> {
  return await tx(async () => {
    const doc = await getDocument(orgId, docId);
    if (!doc) throw new PostingError('Unknown document.');
    if (doc.state === 'posted') throw new PostingError('This document is already posted.');
    if (doc.state === 'cancelled') throw new PostingError('A cancelled document cannot be posted.');

    const meta = DOC_TYPES[doc.doc_type];
    // Take the number BEFORE the lines are built: the partner line is labelled
    // with it, and assigning it afterwards left every posted invoice's
    // receivable line reading "Customer Invoice" instead of "INV-0006".
    const number = doc.number ?? await takeDocumentNumber(orgId, doc);
    const postings = await documentPostings(orgId, doc, number);

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

    /*
     * MONEY ALREADY RECEIVED AGAINST THIS DOCUMENT IS PUT AGAINST IT NOW.
     *
     * A receipt fetched from TripzoCRM carries the invoice it was taken for,
     * and it may well have been posted weeks before the invoice it belongs to
     * reached the books. `settleTargetedForDocument` is the other half of the
     * hook in `postPayment`: whichever side posts last performs the match, so
     * the invoice never stands at its full residual with its own receipt
     * sitting beside it in "Unallocated money".
     *
     * IMPORTED WHERE IT IS USED, not at the top of the file. `payments.ts`
     * imports this module for `getDocument`, so a static import here would
     * close a cycle between the two; deferring it to the call keeps the module
     * graph acyclic and costs one resolved promise per posting.
     */
    const { settleTargetedForDocument } = await import('./payments');
    await settleTargetedForDocument(orgId, docId, actor);
    return entryId;
  });
}

/**
 * AMEND A POSTED DOCUMENT: change what it says, and make the ledger say the
 * same thing — in place, with nothing left over.
 *
 * WHY THIS EXISTS BESIDE THE CREDIT NOTE, which is not going away. The two
 * answer different questions, and using one for the other's job is what makes a
 * ledger unreadable:
 *
 *   The facts changed     — the trip was cancelled, the customer is getting
 *                           part of it back. That is a CREDIT NOTE. Both the
 *                           original supply and the cancellation are real
 *                           events, both belong in GSTR-1, and erasing the
 *                           first would be erasing a supply that happened.
 *
 *   The document was wrong — the rate was keyed as 95,000 instead of 59,000,
 *                           the GSTIN had a typo, a line went to the wrong
 *                           account. Nothing happened in the world. A credit
 *                           note here invents a cancellation that never took
 *                           place, and the customer's GSTR-2B then shows a
 *                           supply and a credit against it that neither party
 *                           can explain. This is an AMENDMENT.
 *
 * WHAT IT DOES. The document is rewritten exactly as a draft is — same header
 * update, same `replaceLines`, same `recomputeTotals`, so there is no second
 * copy of those rules — and then its journal entry is REWRITTEN IN PLACE by
 * `replacePostedEntry`. Everything downstream reads the ledger rather than
 * caching it (Rule 2), so the general ledger, the day book, the trial balance,
 * the P&L, the balance sheet, the ageing, the tax report and trip profitability
 * all show the new figures the moment this returns. The document number does
 * not change, the entry number does not change, and nothing is left pointing at
 * a row that is no longer there.
 *
 * WHAT IT REFUSES, and each of these is a case where "replace it" is the wrong
 * answer rather than a hard one:
 *
 *   - a cancelled document, or one a credit note has already been raised
 *     against: the note was computed as a percentage of THESE figures, and
 *     moving them underneath it leaves two documents that no longer tie
 *   - a locked or closed period, in either direction (`replacePostedEntry`)
 *   - a reconciled bank line (`replacePostedEntry`)
 *   - a new total below what has already been settled against it — the
 *     allocations would exceed the document, and which of them to unwind is
 *     the accountant's decision, not this function's
 *
 * STATUTORILY, AN AMENDMENT IS NOT INVISIBLE. A tax invoice already issued and
 * reported is amended in GSTR-1 through Table 9A, in the return period the
 * correction is made, and only up to the deadline in section 39(9) — the
 * earlier of 30 November following the end of that financial year, or the date
 * the annual return is filed. That is a filing act outside this product; what
 * this gives it is one set of books saying what the corrected invoice says,
 * plus the audit record of what it used to say.
 */
export async function amendDocument(docId: string, input: DocInput, actor: Actor = {}) {
  return await tx(async () => {
    const doc = await getDocument(input.orgId, docId);
    if (!doc) throw new PostingError('Unknown document.');
    if (doc.state === 'draft') throw new PostingError('This document is still a draft — edit it directly.');
    if (doc.state === 'cancelled') {
      throw new PostingError('A reversed document cannot be amended. Raise a fresh one.');
    }
    if (!doc.entry_id) throw new PostingError('This document has no ledger entry to amend.');
    if (doc.reversed_by) {
      const note = await one<{ number: string | null }>('SELECT number FROM documents WHERE id = ?', doc.reversed_by);
      throw new PostingError(
        `${note?.number ?? 'A credit note'} has been raised against this document for a percentage of ` +
        'its figures, so changing them would leave the two disagreeing. Reverse the note first, or ' +
        'correct the note instead.',
      );
    }

    const settled = await scalar(
      'SELECT COALESCE(SUM(amount),0) FROM payment_allocations WHERE document_id = ?', docId,
    );

    const gstin = await derivePartyGstin(input);
    const supplyType = resolveSupplyType(input, gstin);
    const trip = await deriveTripFromInvoice(input);

    await run(
      `UPDATE documents SET partner_id=?, journal_id=?, booking_id=?, analytic_id=?,
              linked_invoice_id=?,
              doc_date=?, due_date=?, payment_terms_id=?, supplier_ref=?, currency=?, rate_e6=?,
              withholding_tax_id=?, note=?, place_of_supply=?, party_gstin=?, supply_type=?,
              irn=?, irn_ack_no=?, irn_ack_date=?, order_ref=?, order_date=?,
              stated_discount=?, stated_tax=?, stated_advance=?
         WHERE id=? AND org_id=?`,
      input.partnerId, input.journalId, trip.bookingId, trip.analyticId, trip.linkedInvoiceId,
      input.docDate, input.dueDate ?? await deriveDueDate(input), input.paymentTermsId ?? null,
      input.supplierRef ?? null, input.currency ?? 'INR', input.rateE6 ?? 1_000_000,
      input.withholdingTaxId ?? null, input.note ?? null,
      await derivePlaceOfSupply(input), gstin, supplyType,
      input.irn ?? null, input.irnAckNo ?? null,
      input.irnAckDate ?? null, input.orderRef ?? null, input.orderDate ?? null,
      nonNegative(input.statedDiscount), nonNegative(input.statedTax), nonNegative(input.statedAdvance),
      docId, input.orgId,
    );
    await replaceLines(input.orgId, docId, input.lines, trip.analyticId,
      nonNegative(input.statedTax));
    await recomputeTotals(input.orgId, docId, input.withholdingTaxId ?? '');

    const after = (await getDocument(input.orgId, docId))!;
    const payable = after.total - (after.doc_type.startsWith('in_') ? after.withheld_tax : 0);
    /*
     * CHECKED AFTER THE REWRITE AND BEFORE THE LEDGER, inside the transaction.
     *
     * The new total is only known once the lines have been recomputed, and the
     * transaction is what makes testing it here safe rather than reckless: the
     * document rows roll back with everything else when this throws, so a
     * refused amendment leaves the invoice exactly as it was instead of reduced
     * with its old journal entry still sitting behind it.
     */
    if (settled > payable) {
      throw new PostingError(
        `${(settled / 100).toFixed(2)} has already been settled against this document, which the new ` +
        `total of ${(payable / 100).toFixed(2)} no longer covers. Undo the settlement first — the ` +
        'money may be a refund, or may belong against another document, and only you know which.',
      );
    }

    const meta = DOC_TYPES[after.doc_type];
    const number = after.number ?? await takeDocumentNumber(input.orgId, after);
    const postings = await documentPostings(input.orgId, after, number);
    await replacePostedEntry(doc.entry_id, {
      orgId: input.orgId,
      journalId: after.journal_id,
      date: after.doc_date,
      reference: number,
      narration: `${meta.label} ${number}`,
      sourceModel: 'document',
      sourceId: docId,
      currency: after.currency,
      lines: postings,
    }, actor);

    await refreshResidual(input.orgId, docId);
    await audit(input.orgId, actor, 'amended', 'document', docId,
      `${meta.label} ${number} amended — ${(doc.total / 100).toFixed(2)} to ${(after.total / 100).toFixed(2)}`,
      {
        was: { date: doc.doc_date, untaxed: doc.untaxed, tax: doc.tax_total, total: doc.total },
        now: { date: after.doc_date, untaxed: after.untaxed, tax: after.tax_total, total: after.total },
      });
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
  /*
   * The PREFIX AND PADDING COME OFF THE ROW, not off the constant above.
   *
   * The constant is only the seed for a series that does not exist yet. Once
   * the row is there, Settings → Numbering owns it — an agency migrating in at
   * INV-04417, or filing under "TRZ/25-26/", changes it there and the next
   * document issued honours it. Reading the constant here instead is what made
   * that screen decorative.
   */
  const existing = await one<{ prefix: string; padding: number; next_no: number }>(
    'SELECT prefix, padding, next_no FROM sequences WHERE org_id = ? AND code = ? FOR UPDATE', orgId, seqCode,
  );
  if (!existing) {
    await run('INSERT INTO sequences (org_id, code, prefix, padding, next_no) VALUES (?,?,?,?,?)',
      orgId, seqCode, prefix, 4, 2);
    return formatDocNumber(prefix, 4, 1);
  }
  await run('UPDATE sequences SET next_no = next_no + 1 WHERE org_id = ? AND code = ?', orgId, seqCode);
  return formatDocNumber(existing.prefix, existing.padding, existing.next_no);
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

    /*
     * NOT WHILE MONEY IS STILL POINTING AT IT.
     *
     * A reversal mirrors the document's own entry and nothing else — the
     * payments that settled it are separate entries this never touches. So
     * reversing a SETTLED document used to leave the control account holding
     * the payment's debit with no credit against it: a bill paid in full and
     * then reversed put Accounts Payable into a debit balance, while the
     * allocation row went on tying a live payment to a cancelled document, and
     * the supplier statement and the ageing report stopped agreeing with the
     * ledger.
     *
     * The settlement has to be undone first, deliberately, because only the
     * person doing it knows which it was: money that is coming back (reverse
     * the payment) or money that stays with the partner (unallocate it and
     * leave it on account). A document that has been paid and is genuinely
     * wrong is a credit note, not a reversal.
     */
    const settled = await all<{ number: string | null; amount: number }>(
      `SELECT COALESCE(p.number, c.number) AS number, a.amount
         FROM payment_allocations a
         LEFT JOIN payments p ON p.id = a.payment_id
         LEFT JOIN documents c ON c.id = a.credit_doc_id
        WHERE a.document_id = ? ORDER BY a.id`, docId,
    );
    if (settled.length) {
      const total = settled.reduce((t, x) => t + x.amount, 0);
      const names = settled.map((x) => x.number ?? '?').join(', ');
      throw new PostingError(
        `${(total / 100).toFixed(2)} is still allocated to this document from ${names}. ` +
        'Unallocate it first — or reverse the payment if the money is coming back — ' +
        'then reverse this document. To cancel a document that has genuinely been paid, raise a credit note instead.',
      );
    }

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
      subtotal: number; total: number; tax_id: string | null; product_id: string | null;
      hsn_code: string | null; mrp: number; item_type: string | null;
    }>(`SELECT name, account_id, analytic_id, subtotal, total, tax_id, product_id, hsn_code, mrp,
               item_type
          FROM document_lines WHERE org_id = ? AND document_id = ? ORDER BY seq`,
        orgId, sourceDocId);

    /*
     * WHICH FIGURE A CREDIT LINE IS PRICED FROM, AND WHY IT DEPENDS ON THE
     * INVOICE IT REVERSES.
     *
     * On an ordinary invoice the line's `subtotal` is its taxable value and the
     * tax is computed ON it, so the note is priced from the subtotal and
     * recomputes the same tax. On an invoice whose tax was STATED, the tax was
     * carved OUT of the line instead — `subtotal` is already net of it — so
     * pricing from the subtotal would raise a note for less than the invoice it
     * cancels, by exactly the tax. The line's own total is the figure that
     * survives both, and the note carries a proportional share of the stated
     * tax so the same tax is reversed as was charged.
     */
    const stated = doc.stated_tax > 0;

    const creditType: DocType = doc.doc_type === 'out_invoice' ? 'out_refund' : 'in_refund';
    const noteId = await createDocument({
      orgId,
      docType: creditType,
      partnerId: doc.partner_id,
      journalId: opts.journalId ?? doc.journal_id,
      bookingId: doc.booking_id,
      analyticId: doc.analytic_id,
      /*
       * AND THE SALE THE ORIGINAL WAS BOUGHT FOR, on a DEBIT NOTE.
       *
       * A supplier's credit for a room the trip never used is a reversal of a
       * cost against that sale, and it has to reach the same place the cost
       * did or the margin keeps a cost the agency was refunded. Carried across
       * rather than asked for again: the note reverses a specific bill, and
       * that bill already says which sale it was for.
       *
       * Null on a CUSTOMER credit note, where `deriveTripFromInvoice` drops it
       * anyway — a credit note against a sale is not a cost of that sale.
       */
      linkedInvoiceId: doc.linked_invoice_id,
      docDate: opts.date,
      dueDate: opts.date,
      currency: doc.currency,
      rateE6: doc.rate_e6,
      /*
       * THE CREDIT NOTE INHERITS THE INVOICE'S STATUTORY DETAIL.
       *
       * A credit note is a tax document in its own right and has to carry the
       * same place of supply and the same HSN per line as the invoice it
       * reverses — the place of supply because it decides the tax being
       * reversed, which must be the tax that was charged, and the HSN because
       * the return nets the two against each other line for line. Taking them
       * from the partner's record instead would silently get both wrong for
       * any customer whose details have changed since.
       */
      placeOfSupply: doc.place_of_supply,
      // And its GSTIN, for the same reason: the credit note has to report
      // against the registration the invoice was raised against, which is not
      // necessarily the one on the partner's record today.
      partyGstin: doc.party_gstin,
      orderRef: doc.order_ref,
      orderDate: doc.order_date,
      // A proportional share of what the invoice stated, so the note reverses
      // the tax that was actually charged rather than the slab's percentage of
      // a value the invoice never had. The advance is not inherited: money
      // already collected is not cancelled by crediting the invoice.
      statedTax: Math.round((doc.stated_tax * bps) / 10000),
      statedDiscount: Math.round((doc.stated_discount * bps) / 10000),
      note: `${opts.reason ?? 'Credit note'} — against ${doc.number}`,
      lines: lines.map((l) => ({
        name: l.name,
        productId: l.product_id,
        qtyMilli: 1000,
        unitPrice: Math.round(((stated ? l.total : l.subtotal) * bps) / 10000),
        taxId: l.tax_id,
        accountId: l.account_id,
        analyticId: l.analytic_id,
        hsnCode: l.hsn_code,
        // The kind travels with the line, for the same reason the HSN does: a
        // credit note is netted against its invoice line for line, and a note
        // that reversed a `package` as nothing at all would leave the two
        // disagreeing about what was cancelled.
        itemType: l.item_type,
        mrp: Math.round((l.mrp * bps) / 10000),
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
  /*
   * SETTLED IS NOT THE SAME AS PAID, AND AN AGENCY CANNOT AFFORD THE CONFUSION.
   *
   * An allocation carrying `credit_doc_id` is a credit note applied, not money
   * received. Counting the two together and calling the result "Paid" told the
   * reader that a cancelled ₹1,36,500 trip had been collected in full when
   * ₹60,000 had actually arrived and ₹76,500 had been cancelled — the invoice
   * that is most important to read correctly, reading exactly backwards.
   *
   * The residual is unaffected (a credit note genuinely discharges the debt);
   * only what the state is CALLED changes. Notes themselves keep "Paid",
   * where it means the note has been used up rather than money collected.
   */
  const sums = await one<{ allocated: number; credited: number }>(
    `SELECT COALESCE(SUM(amount),0) AS allocated,
            COALESCE(SUM(CASE WHEN credit_doc_id IS NOT NULL THEN amount ELSE 0 END),0) AS credited
       FROM payment_allocations WHERE document_id = ?`, docId,
  );
  const allocated = sums?.allocated ?? 0;
  const credited = sums?.credited ?? 0;
  const payable = doc.total - (doc.doc_type.startsWith('in_') ? doc.withheld_tax : 0);
  const residual = Math.max(payable - allocated, 0);
  const isNote = doc.doc_type === 'out_refund' || doc.doc_type === 'in_refund';

  let state = 'not_paid';
  if (doc.state === 'cancelled') state = 'reversed';
  else if (residual === 0 && payable !== 0) state = credited > 0 && !isNote ? 'credited' : 'paid';
  else if (allocated > 0) state = 'partial';

  await run('UPDATE documents SET residual=?, payment_state=? WHERE id=?', residual, state, docId);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getDocument(orgId: string, docId: string): Promise<DocRow | null> {
  return await one<DocRow>(
    `SELECT d.*, p.name AS partner_name, b.ref AS booking_ref,
            COALESCE(d.party_gstin, p.gstin) AS partner_gstin, p.gst_name AS partner_gst_name,
            p.city AS partner_city, p.state_code AS partner_state_code,
            p.address AS partner_address,
            c.invoice_number AS crm_invoice_number,
            -- The sale a vendor bill was bought for, named rather than left as
            -- an id: the screen, the export and the margin report all want the
            -- invoice's own number, and joining it once here is cheaper than
            -- three separate reads of the same row.
            li.number AS linked_invoice_number, li.doc_date AS linked_invoice_date,
            li.total AS linked_invoice_total, lp.name AS linked_invoice_partner
       FROM documents d
       LEFT JOIN partners p ON p.id = d.partner_id
       LEFT JOIN bookings b ON b.id = d.booking_id
       LEFT JOIN documents li ON li.id = d.linked_invoice_id AND li.org_id = d.org_id
       LEFT JOIN partners lp ON lp.id = li.partner_id
       /*
        * The CRM invoice this document was drafted from, if any.
        *
        * A LATERAL rather than a plain LEFT JOIN because crm_invoices is not
        * guaranteed one row per document -- a refund mirrored against the same
        * document would silently DUPLICATE the row here, and a list that shows
        * one invoice twice is worse than one that omits the number. The limit
        * makes the cardinality structural rather than a hope about the data.
        */
       LEFT JOIN LATERAL (
         SELECT ci.invoice_number
           FROM crm_invoices ci
          WHERE ci.org_id = d.org_id AND ci.document_id = d.id
          ORDER BY ci.fetched_at DESC
          LIMIT 1
       ) c ON TRUE
      WHERE d.id = ? AND d.org_id = ?`, docId, orgId,
  );
}

export interface DocLineRow {
  id: string; seq: number; name: string; product_id: string | null;
  qty_milli: number; unit_price: number; discount_bps: number;
  tax_id: string | null; tax_name: string | null; account_id: string;
  account_code: string; account_name: string; analytic_id: string | null;
  analytic_name: string | null; subtotal: number; tax_amount: number; total: number;
  hsn_code: string | null; mrp: number;
  /** TripzoCRM's own kind for this line: package, service, extra, hotel... */
  item_type: string | null;
  /** The product's variant description, for the line as it prints. */
  variant: string | null;
  product_category: string | null;
}

/**
 * A document's lines.
 *
 * -------------------------------------------------------------------------
 * WHY `orgId` IS A PARAMETER WHEN THE DOCUMENT ID IS ALREADY UNIQUE
 * -------------------------------------------------------------------------
 * It is not needed to FIND the rows — a document id identifies them on its own.
 * It is there so that asking for a document belonging to another agency returns
 * nothing instead of returning its lines.
 *
 * Every caller today proves ownership first: the detail screen, the edit screen
 * and both exports call `getDocument(orgId, docId)` and give up when it answers
 * null. That makes the call sites safe and leaves the FUNCTION unsafe, and the
 * difference matters now that one database holds several agencies' books. A
 * document id arrives from a URL — `/sales/invoices/<id>` — so the next caller
 * who reads the lines before the header, or who adds a screen that only needs
 * the lines, would be one forgotten check away from printing one agency's
 * invoice to another's. The filter costs nothing (`document_lines.org_id` is
 * indexed and on every row) and turns a convention into an invariant.
 *
 * The same reasoning applies to `documentLineTaxes`, `allocationsFor`,
 * `allocationsOfPayment`, `paymentTaxes` and `taxChildren`.
 */
export async function documentLines(orgId: string, docId: string): Promise<DocLineRow[]> {
  return await all<DocLineRow>(
    `SELECT dl.*, t.name AS tax_name, a.code AS account_code, a.name AS account_name,
            an.name AS analytic_name, pr.variant, pr.category AS product_category
       FROM document_lines dl
       LEFT JOIN taxes t ON t.id = dl.tax_id
       LEFT JOIN accounts a ON a.id = dl.account_id
       LEFT JOIN analytic_accounts an ON an.id = dl.analytic_id
       LEFT JOIN products pr ON pr.id = dl.product_id
      WHERE dl.org_id = ? AND dl.document_id = ? ORDER BY dl.seq`, orgId, docId,
  );
}

export interface LineTaxRow {
  id: string; line_id: string; tax_id: string | null; tax_name: string;
  tax_group: string; rate_bps: number; base: number; amount: number;
}

/**
 * The stored per-component tax split for a document, keyed by line.
 *
 * A Map rather than a flat list because every caller wants it that way — the
 * printed invoice, the GST column of a settlement statement and the tax report
 * all walk the lines and ask "what tax did THIS one carry".
 */
export async function documentLineTaxes(orgId: string, docId: string): Promise<Map<string, LineTaxRow[]>> {
  const rows = await all<LineTaxRow>(
    `SELECT id, line_id, tax_id, tax_name, tax_group, rate_bps, base, amount
       FROM document_line_taxes WHERE org_id = ? AND document_id = ? ORDER BY line_id, tax_group`,
    orgId, docId,
  );
  const byLine = new Map<string, LineTaxRow[]>();
  for (const r of rows) {
    const list = byLine.get(r.line_id);
    if (list) list.push(r);
    else byLine.set(r.line_id, [r]);
  }
  return byLine;
}

/**
 * Sum one line's tax by component group — the IGST / CGST / SGST / CESS columns
 * a statement and a GSTR-1 both want, with the rate that produced each.
 *
 * A group can legitimately appear twice on one line (two cess components, say),
 * so the amounts add and the rate is the sum of the rates: 2.5% CGST twice is
 * 5% of CGST, which is what the column has to read for the value beside it to
 * make sense.
 */
export function taxByGroup(taxes: LineTaxRow[] | undefined) {
  const out = {
    igst: 0, cgst: 0, sgst: 0, utgst: 0, cess: 0, other: 0,
    igstBps: 0, cgstBps: 0, sgstBps: 0, utgstBps: 0, cessBps: 0,
  };
  for (const t of taxes ?? []) {
    switch (t.tax_group) {
      case 'igst': out.igst += t.amount; out.igstBps += t.rate_bps; break;
      case 'cgst': out.cgst += t.amount; out.cgstBps += t.rate_bps; break;
      case 'sgst': out.sgst += t.amount; out.sgstBps += t.rate_bps; break;
      /*
       * ITS OWN COLUMN, NOT THE SGST ONE. A union territory without a
       * legislature levies UTGST under its own Act and GSTR-3B asks for it
       * separately; adding it into SGST reports the right rupees against the
       * wrong government, and leaves the UTGST box of the return at nil on a
       * month the agency plainly owed it.
       */
      case 'utgst': out.utgst += t.amount; out.utgstBps += t.rate_bps; break;
      case 'cess': out.cess += t.amount; out.cessBps += t.rate_bps; break;
      default: out.other += t.amount;
    }
  }
  return out;
}

/**
 * ===========================================================================
 * WHAT WAS SPENT AGAINST ONE SALE — THE MARGIN ON A PACKAGE, DOCUMENT BY
 * DOCUMENT.
 * ===========================================================================
 * The other end of `linked_invoice_id`. Trip Profitability answers this for a
 * TRIP, out of the analytic distributions, and that remains the authoritative
 * answer because it is the general ledger sliced rather than a second set of
 * figures. This answers it for a SALE, which is the question an agency
 * actually asks about a one-off package: "we invoiced him ₹27,000 — what did
 * it cost us?"
 *
 * THE TWO DO NOT COMPETE. Every bill counted here is tagged to the trip as
 * well — the server copies the invoice's analytic account onto it, which is
 * what makes the cost reach the trip at all — so a sale that belongs to a trip
 * contributes to both and the figures agree. A sale with no trip behind it
 * contributes only here, and before this feature it contributed nowhere.
 *
 * COST IS NET OF TAX, AND THAT IS THE WHOLE OF WHY `untaxed` IS SUMMED RATHER
 * THAN `total`. Input GST is reclaimed; it is a receivable from the
 * government, not a cost of the trip. Taking the gross would overstate the
 * cost of every bill by its GST and understate the margin by the same, which
 * on an 18% book is the difference between a profitable package and a
 * loss-making one. The same reasoning applies on the sale side, which is why
 * the caller compares this against the invoice's own `untaxed`.
 *
 * A DEBIT NOTE SUBTRACTS. `in_refund` is a credit from the supplier — the
 * hotel refunding a room that was not used — and it reduces what the trip
 * cost. Counting it as another cost would double the error.
 *
 * POSTED ONLY. A drafted bill is not a cost; it is an intention. Including
 * drafts would make a margin that moves when somebody opens a form.
 */
export interface LinkedCostRow {
  id: string;
  doc_type: string;
  number: string | null;
  doc_date: string;
  partner_name: string | null;
  supplier_ref: string | null;
  state: string;
  untaxed: number;
  tax_total: number;
  total: number;
  residual: number;
}

export async function costsAgainstInvoice(
  orgId: string, invoiceId: string,
): Promise<LinkedCostRow[]> {
  return await all<LinkedCostRow>(
    `SELECT d.id, d.doc_type, d.number, d.doc_date, p.name AS partner_name,
            d.supplier_ref, d.state, d.untaxed, d.tax_total, d.total, d.residual
       FROM documents d
       LEFT JOIN partners p ON p.id = d.partner_id
      WHERE d.org_id = ? AND d.linked_invoice_id = ?
        AND d.doc_type IN ('in_invoice','in_refund')
        AND d.state <> 'cancelled'
      ORDER BY d.doc_date, d.number`,
    orgId, invoiceId,
  );
}

/**
 * The cost of a sale as one figure: net of input tax, net of supplier credits,
 * posted bills only.
 *
 * Shared between the screen and the payout statement so the two cannot differ
 * about what a package cost — which they would, written twice, the first time
 * anybody changed their mind about debit notes.
 */
export function costOfLinked(rows: LinkedCostRow[]): number {
  return rows
    .filter((r) => r.state === 'posted')
    .reduce((t, r) => t + (r.doc_type === 'in_refund' ? -r.untaxed : r.untaxed), 0);
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
    // The ORDER REFERENCE is searchable too, and it is the field people
    // actually have in hand: a traveller or a channel quotes the order number
    // they placed, not the invoice number this system assigned afterwards.
    //
    // So is the GSTIN, and for the same reason: a GST notice, a GSTR-2B
    // mismatch and a supplier's own query all arrive quoting a registration
    // number, and finding every document raised under one is the whole of what
    // answering them takes. Matched against the DOCUMENT's copy and the
    // partner's both, so a document saved before the column existed is still
    // found by it.
    for (const token of searchTokens(f.search)) {
      clauses.push(
        '(d.number ILIKE ? OR p.name ILIKE ? OR d.supplier_ref ILIKE ? OR d.order_ref ILIKE ?'
        + ' OR d.irn ILIKE ? OR d.party_gstin ILIKE ? OR p.gstin ILIKE ?'
        // The CRM's own number is the one an agent quotes -- they raised
        // INV-000015 on their phone and have never seen the ledger number this
        // app assigned on posting. Searchable here for the same reason the
        // order reference is: it is the number the person asking has in hand.
        + ' OR c.invoice_number ILIKE ?)',
      );
      const like = `%${token}%`;
      params.push(like, like, like, like, like, like, like, like);
    }
  }

  const limit = f.limit ?? 200;
  return await all<DocRow>(
    `SELECT d.*, p.name AS partner_name, b.ref AS booking_ref,
            COALESCE(d.party_gstin, p.gstin) AS partner_gstin, p.gst_name AS partner_gst_name,
            p.city AS partner_city, p.state_code AS partner_state_code,
            p.address AS partner_address,
            c.invoice_number AS crm_invoice_number,
            -- The sale a vendor bill was bought for, named rather than left as
            -- an id: the screen, the export and the margin report all want the
            -- invoice's own number, and joining it once here is cheaper than
            -- three separate reads of the same row.
            li.number AS linked_invoice_number, li.doc_date AS linked_invoice_date,
            li.total AS linked_invoice_total, lp.name AS linked_invoice_partner
       FROM documents d
       LEFT JOIN partners p ON p.id = d.partner_id
       LEFT JOIN bookings b ON b.id = d.booking_id
       LEFT JOIN documents li ON li.id = d.linked_invoice_id AND li.org_id = d.org_id
       LEFT JOIN partners lp ON lp.id = li.partner_id
       /*
        * The CRM invoice this document was drafted from, if any.
        *
        * A LATERAL rather than a plain LEFT JOIN because crm_invoices is not
        * guaranteed one row per document -- a refund mirrored against the same
        * document would silently DUPLICATE the row here, and a list that shows
        * one invoice twice is worse than one that omits the number. The limit
        * makes the cardinality structural rather than a hope about the data.
        */
       LEFT JOIN LATERAL (
         SELECT ci.invoice_number
           FROM crm_invoices ci
          WHERE ci.org_id = d.org_id AND ci.document_id = d.id
          ORDER BY ci.fetched_at DESC
          LIMIT 1
       ) c ON TRUE
      WHERE ${clauses.join(' AND ')}
      ORDER BY d.doc_date DESC, d.created_at DESC
      LIMIT ${limit}`,
    ...params,
  );
}
