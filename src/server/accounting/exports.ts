import 'server-only';
import { all, one } from '../db';
import { fmtDate, titleise, taxGroupLabel, DOC_TYPES, type DocType } from '@/lib/accounting';
import { qtyFromMilli } from '@/lib/money';
import {
  getDocument, documentLines, documentLineTaxes, taxByGroup, listDocuments,
  type DocRow, type DocLineRow, type LineTaxRow, type DocFilter,
} from './documents';
import { getOrganisation, stateName } from './organisation';
import { taxReport, type TaxLine } from './reports';
import {
  tripDossier,
  type TripDossier, type TripDocItemRow, type TripExpenseRow,
  type TripCommissionRow, type TripPaymentRow, type TripLedgerRow,
} from './analytics';
import {
  getSettlement, settlementDocuments, settlementCharges, CHARGE_KINDS,
  type SettlementRow, type SettlementDocRow, type SettlementChargeRow,
} from './settlements';
import {
  buildXlsx, money, moneyOrDash, rate, text, type Cell, type CellInput, type Sheet,
} from '../xlsx';

/**
 * The workbooks this product prints.
 *
 * ---------------------------------------------------------------------------
 * THE LAYOUT IS A CONTRACT, NOT A CHOICE
 * ---------------------------------------------------------------------------
 * The payout statement below reproduces the shape every Indian marketplace and
 * OTA sends: a Payout Breakup, a Forward Orders sheet and a Cancelled or
 * Returned Orders sheet, with the columns in the order those sheets print them.
 * That is deliberate and it is the whole point of the feature. The agency's
 * accountant does not read this file — they put it beside the one the channel
 * sent and look for the row that disagrees. A tidier layout of our own would
 * make that comparison a manual re-keying exercise, which is the work the
 * feature exists to remove.
 *
 * So the column headings here are the channels' own wording, down to
 * "GST Name (where buyer has given gst)". Where this product models something
 * the channels do not, the column is still written and filled from what we
 * have; where a channel models something we do not, the column is still
 * written and reads "-", because a missing COLUMN shifts every heading after
 * it and breaks the comparison outright, while a missing VALUE is visible and
 * fixable.
 *
 * ---------------------------------------------------------------------------
 * ONE ROW PER ITEM, NOT PER INVOICE
 * ---------------------------------------------------------------------------
 * These statements are item-level: an invoice with three lines is three rows,
 * each carrying its own HSN, its own tax split and its share of the charges.
 * The charges themselves are levied per ORDER, so they are apportioned across
 * the lines PRO RATA BY GROSS, and the apportionment is forced to add back to
 * the order's own figure (see `apportion`). Sharing by rounding each line
 * independently loses a paisa per order, and a statement whose item rows do not
 * total its own summary is worse than no statement.
 */

// ---------------------------------------------------------------------------
// Apportionment
// ---------------------------------------------------------------------------

/**
 * Split `amount` across `weights` so the parts sum to exactly `amount`.
 *
 * The last non-zero share absorbs the rounding difference. That is arbitrary
 * and it is also the only honest option: a charge of ₹50 over three equal lines
 * is 16.67 + 16.67 + 16.66, and any scheme that keeps all three identical
 * leaves a paisa unallocated. Putting the remainder somewhere definite means
 * the column adds up, which is what the reader checks.
 *
 * Every weight zero (a fully discounted order) spreads nothing rather than
 * dividing by zero — the charge then shows on the summary and on no item row,
 * which is true: there was no item for it to belong to.
 */
function apportion(amount: number, weights: number[]): number[] {
  const total = weights.reduce((t, w) => t + Math.abs(w), 0);
  if (!total || !amount) return weights.map(() => 0);
  const parts = weights.map((w) => Math.round((amount * Math.abs(w)) / total));
  const drift = amount - parts.reduce((t, p) => t + p, 0);
  if (drift !== 0) {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (weights[i] !== 0) { parts[i] += drift; break; }
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// One item row, assembled
// ---------------------------------------------------------------------------

interface OrderContext {
  doc: DocRow;
  lines: DocLineRow[];
  taxes: Map<string, LineTaxRow[]>;
  booking: { destination: string | null; package_name: string | null; status: string } | null;
  forward: { number: string | null; doc_date: string } | null;
  /** The settlement row, when the order is being printed as part of a cycle. */
  sd: SettlementDocRow | null;
}

/** Everything one item row needs, after the per-order figures are shared out. */
interface ItemRow {
  ctx: OrderContext;
  line: DocLineRow;
  tax: ReturnType<typeof taxByGroup>;
  commission: number;
  commissionGst: number;
  shipping: number;
  shippingGst: number;
  returnFee: number;
  returnGst: number;
  tcs: number;
  tds: number;
  deductions: number;
  additions: number;
  payout: number;
  unsettled: number;
}

async function loadOrder(orgId: string, documentId: string, sd: SettlementDocRow | null): Promise<OrderContext | null> {
  const doc = await getDocument(orgId, documentId);
  if (!doc) return null;
  const lines = await documentLines(documentId);
  const taxes = await documentLineTaxes(documentId);

  const booking = doc.booking_id
    ? await one<{ destination: string | null; package_name: string | null; status: string }>(
      'SELECT destination, package_name, status FROM bookings WHERE id = ?', doc.booking_id,
    )
    : null;

  /*
   * A RETURN ROW HAS TO NAME THE INVOICE IT REVERSES. The statement's first two
   * columns are the forward invoice's number and date, and they are the only
   * way a credit note on this sheet can be tied to the sale it cancels.
   * `reversal_of` already records it — the credit-note routine sets it on both
   * halves — so nothing has to be guessed from amounts or dates.
   */
  const forward = doc.reversal_of
    ? await one<{ number: string | null; doc_date: string }>(
      'SELECT number, doc_date FROM documents WHERE id = ?', doc.reversal_of,
    )
    : null;

  return { doc, lines, taxes, booking, forward, sd };
}

/**
 * Turn one order into its item rows, sharing the order-level charges out.
 *
 * Called with `sd` null for the plain invoice export, where there are no
 * charges to share and every one of those columns is nil. The same function
 * serves both so the two exports cannot drift in how they read a line.
 */
function itemRows(ctx: OrderContext): ItemRow[] {
  const weights = ctx.lines.map((l) => l.total);
  const sd = ctx.sd;
  const share = (amount: number) => apportion(amount ?? 0, weights);

  const commission = share(sd?.commission ?? 0);
  const commissionGst = share(sd?.commission_gst ?? 0);
  const shipping = share(sd?.shipping ?? 0);
  const shippingGst = share(sd?.shipping_gst ?? 0);
  const returnFee = share(sd?.return_fee ?? 0);
  const returnGst = share(sd?.return_gst ?? 0);
  const tcs = share(sd?.tcs ?? 0);
  const tds = share(sd?.tds ?? 0);
  const additions = share(sd?.additions ?? 0);
  const unsettled = share(ctx.doc.residual);

  return ctx.lines.map((line, i) => {
    const deductions = commission[i] + commissionGst[i] + shipping[i] + shippingGst[i]
      + returnFee[i] + returnGst[i] + tcs[i] + tds[i];
    // A return's gross works against the payout, exactly as it does on the
    // summary sheet: the channel is taking the fare back and charging a fee on
    // top of it, so both move the same way.
    const isReturn = sd?.kind === 'return' || ctx.doc.doc_type === 'out_refund';
    const gross = isReturn ? -line.total : line.total;
    return {
      ctx,
      line,
      tax: taxByGroup(ctx.taxes.get(line.id)),
      commission: commission[i],
      commissionGst: commissionGst[i],
      shipping: shipping[i],
      shippingGst: shippingGst[i],
      returnFee: returnFee[i],
      returnGst: returnGst[i],
      tcs: tcs[i],
      tds: tds[i],
      deductions,
      additions: additions[i],
      payout: gross - deductions + additions[i],
      unsettled: unsettled[i],
    };
  });
}

// ---------------------------------------------------------------------------
// Shared column pieces
// ---------------------------------------------------------------------------

interface Seller {
  name: string;
  gstin: string | null;
  stateCode: string | null;
  city: string | null;
}

/**
 * The item identifier the statement calls "Item ID".
 *
 * The product's own code when it has one, because that is the number the agency
 * recognises; the internal id otherwise, so the column is never blank on a row
 * that does have a product; and a dash for a free-typed line, which genuinely
 * has no item behind it.
 */
function itemId(line: DocLineRow): string {
  return line.product_id ? (line.product_id.startsWith('prd_') ? line.product_id.slice(4) : line.product_id) : '-';
}

/**
 * The three category columns a channel sheet carries.
 *
 * Channels run a taxonomy this product does not have and should not invent, so
 * the columns are filled with the travel equivalents that genuinely exist here:
 * what kind of thing was sold, where it was sold to, and which package it was
 * part of. That is the hierarchy an agency actually analyses on, and it is read
 * off records that are already maintained rather than from a taxonomy nobody
 * would keep up to date.
 */
function categories(ctx: OrderContext, line: DocLineRow): [string, string, string, string] {
  const business = line.product_category ? titleise(line.product_category) : '-';
  return [
    business,
    business,
    ctx.booking?.destination ?? '-',
    ctx.booking?.package_name ?? '-',
  ];
}

/**
 * What the statement calls "Order Status".
 *
 * The TRIP's status when the sale is tied to one, because that is the
 * fulfilment fact the column is asking about — a channel's DELIVERED is our
 * COMPLETED. With no booking behind it, the document's own payment state is the
 * nearest honest answer, and saying PAID is better than saying DELIVERED about
 * something that may not have happened.
 */
function orderStatus(ctx: OrderContext): string {
  if (ctx.doc.state === 'cancelled') return 'CANCELLED';
  // A credit note IS the return, so its status is not the trip's and not its
  // own payment state: a refund that has been paid out would otherwise read
  // "PAID" in a column whose whole purpose is to say the order came back.
  if (ctx.doc.doc_type === 'out_refund' || ctx.doc.doc_type === 'in_refund') return 'RETURNED';
  if (ctx.booking) return ctx.booking.status.toUpperCase();
  return ctx.doc.payment_state.replace(/_/g, ' ').toUpperCase();
}

/** The tax, quantity and value block shared by both order sheets. */
function valueColumns(r: ItemRow): CellInput[] {
  return [
    text(r.line.hsn_code),
    { v: qtyFromMilli(r.line.qty_milli), s: 'int' },
    /*
     * THE MRP IS SHOWN FOR THE LINE, NOT PER UNIT.
     *
     * It is STORED per unit, because that is what a list price is. But the
     * column beside it — "Selling Price" — is the line's gross, and the only
     * reason both columns exist is so the reader can see the discount. A
     * per-unit MRP of 37,760 against a line selling price of 67,200 reads as a
     * price INCREASE on a two-unit line, which is the opposite of the truth.
     */
    moneyOrDash(Math.round((r.line.mrp * r.line.qty_milli) / 1000)),
    money(r.line.total),
    rate(r.tax.igstBps),
    rate(r.tax.cgstBps),
    rate(r.tax.sgstBps),
    rate(r.tax.cessBps),
    moneyOrDash(r.tax.igst),
    moneyOrDash(r.tax.cgst),
    moneyOrDash(r.tax.sgst),
    moneyOrDash(r.tax.cess),
    money(r.line.tax_amount),
    money(r.line.total),
  ];
}

/** The charge block, in the order both sheets print it. */
function chargeColumns(r: ItemRow, commissionBps: number): CellInput[] {
  return [
    rate(commissionBps),
    moneyOrDash(r.commission),
    moneyOrDash(r.commissionGst),
    moneyOrDash(r.shipping + r.returnFee),
    moneyOrDash(r.shippingGst + r.returnGst),
    moneyOrDash(r.tcs),
    /*
     * TDS SITS IN THE 194-O COLUMN, and 194-Q is left nil.
     *
     * They are different sections and only one of them can apply here. 194-O
     * is what an e-commerce operator deducts when it remits a seller's
     * proceeds, which is exactly the transaction this statement describes;
     * 194-Q is what a BUYER deducts on a purchase of goods above the annual
     * threshold, and a channel paying us out is not buying from us. Splitting
     * the figure across both columns, or guessing which, would put a number
     * under a section the agency cannot claim it under.
     */
    moneyOrDash(r.tds),
    { v: '-' },
    money(r.deductions),
  ];
}

// ---------------------------------------------------------------------------
// Sheet 2 — Forward Orders
// ---------------------------------------------------------------------------

const FORWARD_HEADERS = [
  'S.No.', 'Invoice ID', 'Order ID', 'Order Type', 'Order Date', 'Customer Name',
  'GST Name (where buyer has given gst)', 'GST Number (where buyer has given gst)',
  'Supply State', 'State GST', 'Customer City', 'Customer State', 'IRN',
  'Item ID', 'Product Name', 'Variant Description', 'Business Category',
  'L0 Category', 'L1 Category', 'L2 Category', 'Order Status', 'HSN Code',
  'Quantity', 'MRP (Rs)', 'Selling Price (Rs)',
  'IGST %', 'CGST %', 'SGST %', 'CESS %',
  'IGST Value', 'CGST Value', 'SGST Value', 'CESS Value',
  'Total Tax', 'Total Gross Bill Amount',
  'Commission %', 'Commission Charge (Rs)', 'Commission GST (Rs)',
  'Shipping Charge (Rs)', 'Shipping GST (Rs)',
  'TCS Amount', 'TDS 194O Amount', 'TDS 194Q Amount',
  'Net Deductions', 'Net Additions', 'Item Level Payout',
  'Bank UTR', 'Settlement Date', 'Settlement Status', 'Unsettled Amount',
];

function forwardSheet(
  rows: ItemRow[], seller: Seller, settlement: SettlementRow | null, title = 'Forward Orders',
): Sheet {
  const body: CellInput[][] = [
    [text(title, 'title')],
    [],
    [],
    [],
    FORWARD_HEADERS.map((h) => text(h, 'header')),
    [],
  ];

  rows.forEach((r, i) => {
    const [business, l0, l1, l2] = categories(r.ctx, r.line);
    body.push([
      { v: i + 1, s: 'int' },
      text(r.ctx.doc.number),
      text(r.ctx.doc.order_ref),
      'forward',
      text(fmtDate(r.ctx.doc.order_date ?? r.ctx.doc.doc_date)),
      text(r.ctx.doc.partner_name),
      text(r.ctx.doc.partner_gst_name),
      text(r.ctx.doc.partner_gstin),
      text(stateName(seller.stateCode)),
      text(seller.gstin),
      text(r.ctx.doc.partner_city),
      text(stateName(r.ctx.doc.place_of_supply ?? r.ctx.doc.partner_state_code ?? null)),
      text(r.ctx.doc.irn),
      itemId(r.line),
      r.line.name,
      text(r.line.variant),
      business, l0, l1, l2,
      orderStatus(r.ctx),
      ...valueColumns(r),
      ...chargeColumns(r, settlement?.commission_bps ?? 0),
      moneyOrDash(r.additions),
      money(r.payout, 'moneyBold'),
      text(settlement?.utr),
      text(settlement?.pay_date ? fmtDate(settlement.pay_date) : null),
      text(r.ctx.sd?.status ?? r.ctx.doc.payment_state.toUpperCase()),
      moneyOrDash(r.unsettled),
    ]);
  });

  return {
    name: title,
    rows: body,
    // Measured against the headings, which are long: a column narrower than its
    // own heading shows "########" for money and clips the heading, and the
    // reader cannot tell which column they are looking at.
    cols: [7, 20, 16, 11, 13, 22, 26, 22, 16, 20, 16, 16, 20, 11, 30, 26, 20,
      18, 18, 18, 14, 11, 10, 12, 14, 9, 9, 9, 9, 12, 12, 12, 12, 12, 16,
      13, 15, 15, 14, 14, 12, 14, 14, 14, 13, 15, 18, 15, 16, 15],
    // The header row stays put and so do the first two columns: a 50-column
    // sheet scrolled to the charges has otherwise lost both the heading and the
    // invoice number, which is every figure's only label.
    freezeRows: 5,
    freezeCols: 2,
  };
}

// ---------------------------------------------------------------------------
// Sheet 3 — Cancelled or Returned Orders
// ---------------------------------------------------------------------------

const RETURN_HEADERS = [
  'S.No.', 'Forward Invoice ID', 'Forward Invoice Date', 'Return Invoice ID',
  'Return Order ID', 'Return Order Date', 'Customer Name',
  'GST Number (where buyer has given gst)', 'GST Name (where buyer has given gst)',
  'Supply City', 'Supply State', 'State GST', 'Customer City', 'Customer State', 'IRN',
  'Item ID', 'Product Name', 'Variant Description', 'Business Category',
  'L0 Category', 'L1 Category', 'L2 Category', 'Order Status', 'HSN Code',
  'Quantity', 'MRP (Rs)', 'Selling Price (Rs)',
  'IGST (%)', 'CGST (%)', 'SGST (%)', 'Cess (%)',
  'IGST Value', 'CGST Value', 'SGST Value', 'CESS Value',
  'Total Tax', 'Total Gross Bill Amount',
  'Commission %', 'Commission Charge (Rs)', 'Commission GST (Rs)',
  'Shipping Charge (Rs)', 'Shipping GST (Rs)',
  'TCS Amount', 'TDS 194O Amount', 'TDS 194Q Amount',
  'Net Deductions', 'Item Level Payout',
  'Settlement Status', 'Settlement Date', 'Bank UTR', 'Unsettled Amount',
];

function returnSheet(rows: ItemRow[], seller: Seller, settlement: SettlementRow | null): Sheet {
  const body: CellInput[][] = [
    [text('Return Orders', 'title')],
    [],
    [],
    [],
    RETURN_HEADERS.map((h) => text(h, 'header')),
    [],
  ];

  rows.forEach((r, i) => {
    const [business, l0, l1, l2] = categories(r.ctx, r.line);
    body.push([
      { v: i + 1, s: 'int' },
      text(r.ctx.forward?.number),
      text(r.ctx.forward ? fmtDate(r.ctx.forward.doc_date) : null),
      text(r.ctx.doc.number),
      text(r.ctx.doc.order_ref),
      /*
       * THE RETURN'S OWN DATE, not the order's.
       *
       * A credit note inherits `order_date` from the invoice it reverses — the
       * order was placed once and that fact does not change. But this column
       * asks when the order came BACK, and printing the original order date
       * under it had returns dated before the invoices they reverse.
       */
      text(fmtDate(r.ctx.doc.doc_date)),
      text(r.ctx.doc.partner_name),
      text(r.ctx.doc.partner_gstin),
      text(r.ctx.doc.partner_gst_name),
      text(seller.city),
      text(stateName(seller.stateCode)),
      text(seller.gstin),
      text(r.ctx.doc.partner_city),
      text(stateName(r.ctx.doc.place_of_supply ?? r.ctx.doc.partner_state_code ?? null)),
      text(r.ctx.doc.irn),
      itemId(r.line),
      r.line.name,
      text(r.line.variant),
      business, l0, l1, l2,
      orderStatus(r.ctx),
      ...valueColumns(r),
      ...chargeColumns(r, settlement?.commission_bps ?? 0),
      money(r.payout, 'moneyBold'),
      text(r.ctx.sd?.status ?? r.ctx.doc.payment_state.toUpperCase()),
      text(settlement?.pay_date ? fmtDate(settlement.pay_date) : null),
      text(settlement?.utr),
      moneyOrDash(r.unsettled),
    ]);
  });

  return {
    name: 'Cancelled or Returned Orders',
    rows: body,
    cols: [7, 20, 20, 20, 16, 18, 22, 22, 26, 16, 16, 20, 16, 16, 20, 11, 30,
      26, 20, 18, 18, 18, 14, 11, 10, 12, 14, 10, 10, 10, 10, 12, 12, 12, 12,
      12, 16, 13, 15, 15, 14, 14, 12, 14, 14, 14, 18, 16, 16, 15, 15],
    freezeRows: 5,
    freezeCols: 2,
  };
}

// ---------------------------------------------------------------------------
// Sheet 1 — Payout Breakup
// ---------------------------------------------------------------------------

/**
 * One line of the breakup: its serial number if it carries one, what it is, and
 * the figure split between delivered and returned orders.
 *
 * `sNo` is null for the GST sub-rows, exactly as the channels print them — the
 * GST on a commission is not a charge in its own right, it is part of charge
 * number 2, and numbering it separately makes a twenty-item statement look like
 * a forty-item one.
 */
interface BreakupLine {
  sNo: number | null;
  label: string;
  forward: number;
  returned: number;
  /**
   * Which way the figure moves the payout, carried on the row rather than
   * re-derived from its wording at the bottom of the sheet. The label is for a
   * person to read and the section is for the arithmetic; parsing "GST on CN"
   * back into "this is an addition" is a string match that breaks the first
   * time a label is reworded.
   */
  section: 'deduction' | 'addition';
}

function breakupRow(l: BreakupLine): CellInput[] {
  return [
    null,
    l.sNo === null ? null : { v: l.sNo, s: 'int' as const },
    l.label,
    moneyOrDash(l.forward),
    moneyOrDash(l.returned),
    moneyOrDash(l.forward + l.returned),
  ];
}

function sectionRow(label: string): CellInput[] {
  return [null, null, text(label, 'section'), text('', 'section'), text('', 'section'), text('', 'section')];
}

function totalRow(label: string, forward: number | null, returned: number | null, total: number): CellInput[] {
  // Nil reads as a dash on these rows too, the way the channels print them: a
  // cycle with nothing carried forward says "-", not "0.00", and the dash is
  // what makes the one row that DOES carry a balance visible at a glance.
  return [
    null, null, text(label, 'section'),
    forward === null ? text('', 'section') : moneyOrDash(forward, 'sectionMoney'),
    returned === null ? text('', 'section') : moneyOrDash(returned, 'sectionMoney'),
    moneyOrDash(total, 'sectionMoney'),
  ];
}

function payoutBreakupSheet(
  s: SettlementRow, docs: SettlementDocRow[], charges: SettlementChargeRow[],
): Sheet {
  const fwd = docs.filter((d) => d.kind !== 'return');
  const ret = docs.filter((d) => d.kind === 'return');
  const sum = (rows: SettlementDocRow[], f: (d: SettlementDocRow) => number) =>
    rows.reduce((t, d) => t + f(d), 0);

  /*
   * A CHARGE WITH NO ROW IS STILL PRINTED, AT NIL.
   *
   * The catalogue is walked rather than the rows that exist, so every line the
   * channels can charge appears in the same place in every cycle. That is what
   * makes two months comparable side by side, and it is why a nil row is worth
   * a line of its own: "Recall Charge  -" says the charge did not arise, while
   * an absent row leaves the reader wondering whether it was simply missed.
   */
  const charged = (code: string, part: 'amount' | 'gst') => {
    const row = charges.find((c) => c.code === code);
    if (!row) return 0;
    const value = part === 'amount' ? row.amount : row.gst_amount;
    // A deduction prints positive in its own block and subtracts in the total,
    // which is how the channels write it; the sign lives in the arithmetic at
    // the bottom of the sheet, not in the cell.
    return value;
  };

  const orderLine = (
    sNo: number | null, label: string, f: (d: SettlementDocRow) => number,
  ): BreakupLine => ({
    sNo, label, forward: sum(fwd, f), returned: sum(ret, f), section: 'deduction',
  });

  const orderDeductions: BreakupLine[] = [
    orderLine(2, '  Commission Charge (Rs)', (d) => d.commission),
    orderLine(null, '  GST on Commission (Rs)', (d) => d.commission_gst),
    orderLine(3, '  Shipping Charge (Rs)', (d) => d.shipping),
    orderLine(null, '  GST on Shipping (Rs)', (d) => d.shipping_gst),
    orderLine(4, '  Return Charge (Rs)', (d) => d.return_fee),
    orderLine(null, '  GST on Return Charges (Rs)', (d) => d.return_gst),
    orderLine(5, '  TCS Charge (Rs)', (d) => d.tcs),
    orderLine(6, '  TDS Charge (194O & Q)(Rs)', (d) => d.tds),
  ];

  // The cycle-level blocks, numbered on from the order-level ones so the serial
  // column runs 1..n down the whole sheet as the channels print it.
  let sNo = 6;
  const block = (which: 'additions' | 'deductions' | 'one_time'): BreakupLine[] => {
    const out: BreakupLine[] = [];
    for (const k of CHARGE_KINDS.filter((c) => c.block === which)) {
      out.push({
        sNo: ++sNo,
        label: `  ${k.label} (Rs)`,
        forward: charged(k.code, 'amount'),
        returned: 0,
        section: k.section,
      });
      if (k.gst) {
        out.push({
          sNo: null,
          // The channels abbreviate these two and nothing else, so the
          // abbreviation lives where the label is written rather than being
          // reconstructed somewhere downstream.
          label: `  GST on ${k.code === 'credit_note' ? 'CN' : k.code === 'debit_note' ? 'DN' : k.label} (Rs)`,
          forward: charged(k.code, 'gst'),
          returned: 0,
          section: k.section,
        });
      }
    }
    return out;
  };

  const additions = block('additions');
  const deductions = block('deductions');
  const oneTime = block('one_time');

  // Deductions subtract and additions add. The cycle-level rows all sit in the
  // delivered column, which is where the channels put them: they belong to the
  // cycle rather than to either half of it, and inventing a split would be
  // arithmetic the statement it is checked against does not do.
  const cycleRows = [...additions, ...deductions, ...oneTime];
  const cycleDeductions = cycleRows.filter((l) => l.section === 'deduction')
    .reduce((t, l) => t + l.forward, 0);
  const cycleAdditions = cycleRows.filter((l) => l.section === 'addition')
    .reduce((t, l) => t + l.forward, 0);
  const fwdDeductions = sum(fwd, (d) => d.deductions) + cycleDeductions;
  const fwdAdditions = cycleAdditions;
  const forwardGross = sum(fwd, (d) => d.gross);
  const returnGross = sum(ret, (d) => d.gross);
  const forwardTotal = forwardGross - fwdDeductions + fwdAdditions;
  const returnTotal = returnGross - sum(ret, (d) => d.deductions);
  const cycleTotal = forwardTotal + returnTotal;
  const tillDate = cycleTotal + s.previous_unsettled;

  const rows: CellInput[][] = [
    [],
    [null, text('Payout Breakup', 'title')],
    [null, text('S. No.', 'header'), text('Particular', 'header'), text('Delivered Orders', 'header'),
      text('Cancelled/Returned', 'header'), text('Total', 'header')],
    [],
    breakupRow({
      sNo: 1, label: 'Customer Payable (Rs)', section: 'addition',
      forward: forwardGross, returned: returnGross,
    }),
    [],
    sectionRow('Order Level Deductions (Rs)'),
    ...orderDeductions.map(breakupRow),
    [],
    sectionRow('Other Additions (Rs)'),
    ...additions.map(breakupRow),
    [],
    sectionRow('Other Deductions (Rs)'),
    ...deductions.map(breakupRow),
    [],
    sectionRow('One-Timer Adjustments (Rs)'),
    ...oneTime.map(breakupRow),
    [],
    totalRow('Amount calculated from present cycle', forwardTotal, returnTotal, cycleTotal),
    [],
    totalRow('Unsettled from previous cycle', null, null, s.previous_unsettled),
    [],
    totalRow('Amount calculated till date', null, null, tillDate),
    [],
    totalRow('Net Payout in this Cycle', null, null, s.net_payout),
  ];

  return {
    name: 'Payout Breakup',
    rows,
    cols: [3, 9, 42, 20, 22, 20],
    merges: ['B2:F2'],
  };
}

// ---------------------------------------------------------------------------
// The workbooks
// ---------------------------------------------------------------------------

async function seller(orgId: string): Promise<Seller> {
  const org = await getOrganisation(orgId);
  return {
    name: org?.legal_name || org?.name || 'This agency',
    gstin: org?.gstin ?? null,
    stateCode: org?.state_code ?? null,
    city: org?.city ?? null,
  };
}

export interface PayoutWorkbook {
  buffer: Buffer;
  settlement: SettlementRow;
}

/**
 * The tax report, as the three things it is filed from.
 *
 * ONE SHEET PER RETURN, not one sheet of everything. GST goes to GSTR-3B by the
 * 20th and TDS to a challan by the 7th, to two departments; a single blended
 * sheet is how a figure ends up on the wrong form. The GST sheets carry the
 * gross → notes → net breakdown the screen shows, because the number an officer
 * queries is never the net — it is the credit note that produced it.
 */
export async function taxWorkbook(
  orgId: string, p: { from: string; to: string },
): Promise<Buffer> {
  const t = await taxReport(orgId, p);
  const s = await seller(orgId);

  const head = (title: string): CellInput[][] => [
    [text(s.name, 'title')],
    [text(`GSTIN ${s.gstin ?? '—'}`, 'muted')],
    [text(`${title} · ${fmtDate(p.from)} to ${fmtDate(p.to)}`, 'muted')],
    [],
  ];

  const gstSheet = (
    name: string, title: string, rows: TaxLine[],
    total: number, base: number, notes: number, notesBase: number,
    grossLabel: string, notesLabel: string,
  ): Sheet => ({
    name,
    cols: [26, 14, 18, 18],
    freezeRows: 5,
    rows: [
      ...head(title),
      [text('Tax', 'header'), text('Group', 'header'),
        text('Taxable value', 'header'), text('Tax', 'header')],
      ...rows.map((r) => [
        text(r.name), text(taxGroupLabel(r.tax_group)), money(r.base), money(r.amount),
      ]),
      [],
      [text(grossLabel, 'bold'), null, money(base - notesBase), money(total - notes)],
      [text(notesLabel, 'bold'), null, money(notesBase), money(notes)],
      [text('Net', 'section'), { v: null, s: 'section' },
        money(base, 'sectionMoney'), money(total, 'sectionMoney')],
    ],
  });

  const summary: Sheet = {
    name: 'Summary',
    cols: [34, 20],
    rows: [
      ...head('Tax summary'),
      [text('Output GST (collected)', 'bold'), money(t.outputTotal)],
      [text('Input GST (credit)', 'bold'), money(t.inputTotal)],
      [text('Net GST payable', 'section'), money(t.netPayable, 'sectionMoney')],
      [],
      [text('TDS withheld this period', 'bold'), money(t.withheldTotal)],
      [text('TDS Payable outstanding', 'bold'), money(t.withheldUnpaid)],
      [],
      [text('GST is filed in GSTR-3B by the 20th; TDS is deposited by challan by the 7th.', 'muted')],
      [text('The two are never set off against each other.', 'muted')],
    ],
  };

  const withholding: Sheet = {
    name: 'TDS',
    cols: [30, 12, 10, 18, 18],
    freezeRows: 5,
    rows: [
      ...head('Tax withheld from suppliers'),
      [text('Section', 'header'), text('Type', 'header'), text('Rate', 'header'),
        text('Amount paid', 'header'), text('Tax withheld', 'header')],
      ...t.withheld.map((r) => [
        text(r.name), text(taxGroupLabel(r.tax_group)), rate(r.rate_bps),
        money(r.base), money(r.amount),
      ]),
      [],
      [text('Total deducted', 'section'), { v: null, s: 'section' }, { v: null, s: 'section' },
        { v: null, s: 'section' }, money(t.withheldTotal, 'sectionMoney')],
    ],
  };

  return buildXlsx([
    summary,
    gstSheet('Output GST', 'Output GST', t.output, t.outputTotal, t.outputBase,
      t.outputNotes, t.outputNotesBase, 'Invoices', 'Less credit notes'),
    gstSheet('Input GST', 'Input GST', t.input, t.inputTotal, t.inputBase,
      t.inputNotes, t.inputNotesBase, 'Bills', 'Less debit notes'),
    withholding,
  ]);
}

/**
 * THE statement: a channel payout cycle, in the three sheets the channels send.
 */
export async function payoutWorkbook(orgId: string, settlementId: string): Promise<PayoutWorkbook | null> {
  const settlement = await getSettlement(orgId, settlementId);
  if (!settlement) return null;

  const docs = await settlementDocuments(orgId, settlementId);
  const charges = await settlementCharges(settlementId);

  const forward: ItemRow[] = [];
  const returned: ItemRow[] = [];
  for (const sd of docs) {
    const ctx = await loadOrder(orgId, sd.document_id, sd);
    if (!ctx) continue;
    (sd.kind === 'return' ? returned : forward).push(...itemRows(ctx));
  }

  const s = await seller(orgId);
  const buffer = buildXlsx([
    payoutBreakupSheet(settlement, docs, charges),
    forwardSheet(forward, s, settlement),
    returnSheet(returned, s, settlement),
  ]);
  return { buffer, settlement };
}

/**
 * The same item-level sheet, for a set of invoices with no settlement behind
 * them.
 *
 * WHY IT EXISTS SEPARATELY. The statement format is useful long before a cycle
 * is reconciled — it is how an agency hands its sales to an auditor, to a
 * channel that has asked for a reconciliation, or to its own accountant at
 * quarter end. Demanding that a settlement be drafted first would make the
 * export a feature of settlements rather than of the sales ledger. The charge
 * columns are written and read nil, which is accurate: nothing has been
 * deducted from these sales yet.
 */
export async function documentListWorkbook(
  orgId: string, filter: DocFilter, label: string,
): Promise<Buffer> {
  const docs = await listDocuments(orgId, { ...filter, limit: filter.limit ?? 2000 });
  const forward: ItemRow[] = [];
  const returned: ItemRow[] = [];
  for (const d of docs) {
    const ctx = await loadOrder(orgId, d.id, null);
    if (!ctx) continue;
    (d.doc_type === 'out_refund' || d.doc_type === 'in_refund' ? returned : forward)
      .push(...itemRows(ctx));
  }
  const s = await seller(orgId);
  const sheets: Sheet[] = [forwardSheet(forward, s, null, label)];
  // Only when there is something in it: an empty third sheet in a workbook of
  // invoices is a question ("why is this blank?") rather than information.
  if (returned.length) sheets.push(returnSheet(returned, s, null));
  return buildXlsx(sheets);
}

/**
 * One document, as the tax invoice it is.
 *
 * A DIFFERENT SHAPE FROM THE STATEMENT, deliberately. The statement is a grid
 * for reconciling many orders; this is one document, and what its reader wants
 * is the header block they would see on the printed invoice — who supplied whom,
 * under which GSTINs, to which place of supply — with the lines and the
 * rate-wise tax summary under it. Forcing it into fifty columns would hide
 * every one of those facts behind a horizontal scrollbar.
 */
export async function documentWorkbook(orgId: string, docId: string): Promise<{ buffer: Buffer; doc: DocRow } | null> {
  const doc = await getDocument(orgId, docId);
  if (!doc) return null;
  const lines = await documentLines(docId);
  const taxes = await documentLineTaxes(docId);
  const org = await seller(orgId);
  const meta = DOC_TYPES[doc.doc_type as DocType];
  const isBill = meta.side === 'supplier';

  const kv = (k: string, v: string | null | undefined): CellInput[] =>
    [null, text(k, 'bold'), text(v ?? '-')];

  const rows: CellInput[][] = [
    [],
    [null, text(`${meta.label} ${doc.number ?? '(draft)'}`, 'title')],
    [],
    // The seller and the buyer, both with their registration: an invoice that
    // does not carry both GSTINs is not a tax invoice, whatever else is on it.
    [null, text(isBill ? 'Supplier' : 'Supplier (this agency)', 'section'), text('', 'section'), text('', 'section')],
    ...(isBill
      ? [kv('Name', doc.partner_name), kv('GSTIN', doc.partner_gstin), kv('Address', doc.partner_address)]
      : [kv('Name', org.name), kv('GSTIN', org.gstin), kv('State', stateName(org.stateCode))]),
    [],
    [null, text(isBill ? 'Billed to (this agency)' : 'Billed to', 'section'), text('', 'section'), text('', 'section')],
    ...(isBill
      ? [kv('Name', org.name), kv('GSTIN', org.gstin), kv('State', stateName(org.stateCode))]
      : [
        kv('Name', doc.partner_name),
        kv('Registered name', doc.partner_gst_name),
        kv('GSTIN', doc.partner_gstin),
        kv('City', doc.partner_city),
        kv('Address', doc.partner_address),
      ]),
    [],
    [null, text('Document', 'section'), text('', 'section'), text('', 'section')],
    kv('Date', fmtDate(doc.doc_date)),
    kv('Due', fmtDate(doc.due_date)),
    kv('Place of supply', stateName(doc.place_of_supply)),
    kv('Order reference', doc.order_ref),
    kv('Order date', doc.order_date ? fmtDate(doc.order_date) : null),
    kv('Supplier reference', doc.supplier_ref),
    kv('IRN', doc.irn),
    kv('IRN acknowledgement', doc.irn_ack_no),
    kv('Currency', doc.currency),
    kv('Status', `${titleise(doc.state)} · ${titleise(doc.payment_state)}`),
    [],
    [
      text('#', 'header'), text('Description', 'header'), text('HSN / SAC', 'header'),
      text('Qty', 'header'), text('MRP', 'header'), text('Rate', 'header'),
      text('Disc %', 'header'), text('Taxable', 'header'),
      text('IGST %', 'header'), text('IGST', 'header'),
      text('CGST %', 'header'), text('CGST', 'header'),
      text('SGST %', 'header'), text('SGST', 'header'),
      text('Cess', 'header'), text('Total', 'header'),
    ],
  ];

  lines.forEach((l, i) => {
    const t = taxByGroup(taxes.get(l.id));
    rows.push([
      { v: i + 1, s: 'int' },
      l.name,
      text(l.hsn_code),
      { v: qtyFromMilli(l.qty_milli), s: 'int' },
      moneyOrDash(l.mrp),
      money(l.unit_price),
      rate(l.discount_bps),
      money(l.subtotal),
      rate(t.igstBps), moneyOrDash(t.igst),
      rate(t.cgstBps), moneyOrDash(t.cgst),
      rate(t.sgstBps), moneyOrDash(t.sgst),
      moneyOrDash(t.cess),
      money(l.total, 'moneyBold'),
    ]);
  });

  const blank = (n: number) => Array.from({ length: n }, () => null as CellInput);
  rows.push([]);
  rows.push([...blank(6), text('Taxable', 'section'), money(doc.untaxed, 'sectionMoney')]);
  rows.push([...blank(6), text('Tax', 'section'), money(doc.tax_total, 'sectionMoney')]);
  rows.push([...blank(6), text('Total', 'section'), money(doc.total, 'sectionMoney')]);
  if (doc.withheld_tax) {
    rows.push([...blank(6), text('TDS withheld', 'section'), money(-doc.withheld_tax, 'sectionMoney')]);
  }
  rows.push([...blank(6), text('Still owed', 'section'), money(doc.residual, 'sectionMoney')]);

  if (doc.note) {
    rows.push([]);
    rows.push([null, text('Note', 'bold'), text(doc.note, 'wrap')]);
  }

  const buffer = buildXlsx([{
    name: meta.short,
    rows,
    cols: [5, 38, 12, 8, 12, 13, 8, 14, 9, 12, 9, 12, 9, 12, 12, 14],
  }]);
  return { buffer, doc };
}

// ---------------------------------------------------------------------------
// The trip dossier workbook (plan sections 23 and 42)
// ---------------------------------------------------------------------------

/**
 * ONE TRIP, DOWN TO THE RUPEE.
 *
 * The Trip Profitability report answers "what did this trip make". This
 * workbook answers the question that always follows it — "where did it go" —
 * and it is built in the same shape as the payout statement above, because
 * that shape is what the agency's accountant already reads: a BREAKUP sheet
 * that reconciles top to bottom, with the detail sheets behind it holding one
 * row per line.
 *
 * THE LAST SHEET IS THE PROOF. `Ledger` is every posted analytic distribution
 * on the trip, and its signed total is the trip's profit with the sign turned
 * over — the engine writes cost positive and revenue negative. So a reader who
 * distrusts the summary can add up the last column and arrive at the same
 * figure, which is the only kind of management report worth handing to an
 * auditor. Nothing on any sheet is computed twice from two sources.
 *
 * MIXED DOCUMENTS PRINT IN FULL. A supplier bill that covers two trips appears
 * with all of its lines and an "On this trip" column saying which of them this
 * trip carries. Printing only the tagged lines would make the document's own
 * total unverifiable against the paper the supplier sent.
 */

const ITEM_HEADERS = [
  'S.No.', 'Date', 'Document', 'Type', 'Party', 'GSTIN', 'Description', 'HSN / SAC',
  'Account', 'Qty', 'Rate (Rs)', 'Disc %', 'Taxable (Rs)',
  'IGST %', 'IGST (Rs)', 'CGST %', 'CGST (Rs)', 'SGST %', 'SGST (Rs)', 'Cess (Rs)',
  'Total Tax (Rs)', 'Total (Rs)', 'On this trip',
];

const ITEM_COLS = [7, 12, 18, 14, 26, 18, 38, 12, 24, 8, 13, 8, 14, 8, 13, 8, 13, 8, 13, 11, 14, 14, 12];

function itemSheet(
  name: string, title: string, subtitle: string, rows: TripDocItemRow[],
): Sheet {
  const body: CellInput[][] = [
    [text(title, 'title')],
    [text(subtitle, 'muted')],
    [],
    ITEM_HEADERS.map((h) => text(h, 'header')),
  ];

  rows.forEach((r, i) => {
    body.push([
      { v: i + 1, s: 'int' },
      text(fmtDate(r.doc_date)),
      text(r.number),
      text(DOC_TYPES[r.doc_type as DocType]?.short ?? r.doc_type),
      text(r.partner_name),
      text(r.partner_gstin),
      text(r.name),
      text(r.hsn_code),
      text(r.account_code ? `${r.account_code} ${r.account_name}` : null),
      { v: qtyFromMilli(r.qty_milli), s: 'int' },
      money(r.unit_price),
      rate(r.discount_bps),
      money(r.taxable),
      rate(r.igst_bps), moneyOrDash(r.igst),
      rate(r.cgst_bps), moneyOrDash(r.cgst),
      rate(r.sgst_bps), moneyOrDash(r.sgst),
      moneyOrDash(r.cess),
      money(r.tax_total),
      money(r.total, 'moneyBold'),
      text(r.on_trip ? 'Yes' : 'No'),
    ]);
  });

  const sum = (f: (r: TripDocItemRow) => number) => rows.reduce((t, r) => t + f(r), 0);
  const blank = (n: number) => Array.from({ length: n }, () => ({ v: null, s: 'section' as const }));
  body.push([]);
  body.push([
    text('Total', 'section'), ...blank(11),
    money(sum((r) => r.taxable), 'sectionMoney'),
    { v: null, s: 'section' }, money(sum((r) => r.igst), 'sectionMoney'),
    { v: null, s: 'section' }, money(sum((r) => r.cgst), 'sectionMoney'),
    { v: null, s: 'section' }, money(sum((r) => r.sgst), 'sectionMoney'),
    money(sum((r) => r.cess), 'sectionMoney'),
    money(sum((r) => r.tax_total), 'sectionMoney'),
    money(sum((r) => r.total), 'sectionMoney'),
    { v: null, s: 'section' },
  ]);

  return { name, rows: body, cols: ITEM_COLS, freezeRows: 4, freezeCols: 3 };
}

function tripExpenseSheet(rows: TripExpenseRow[]): Sheet {
  const headers = [
    'S.No.', 'Claim', 'Date', 'Who', 'What', 'Account', 'Paid by',
    'Amount (Rs)', 'Tax', 'Tax rate %', 'GST (Rs)', 'Claim total (Rs)',
    'State', 'Still owed (Rs)', 'Journal entry', 'Approved by', 'Approved on', 'Receipt',
  ];
  const body: CellInput[][] = [
    [text('Staff Expenses on this trip', 'title')],
    [text('What people paid for themselves, and what the agency still owes them back.', 'muted')],
    [],
    headers.map((h) => text(h, 'header')),
  ];

  rows.forEach((e, i) => {
    // Owed means POSTED and paid for by the employee: a draft claim is not a
    // liability, and one the agency's own card paid was never owed to anyone.
    const owed = e.state === 'posted' && e.paid_by === 'employee' ? e.amount + e.tax_amount : 0;
    body.push([
      { v: i + 1, s: 'int' },
      text(e.number),
      text(fmtDate(e.expense_date)),
      text(e.employee_name),
      text(e.description),
      text(e.account_code ? `${e.account_code} ${e.account_name}` : null),
      text(e.paid_by === 'employee' ? 'Employee (reimbursable)' : 'Company'),
      money(e.amount),
      text(e.tax_name),
      rate(e.tax_rate_bps),
      moneyOrDash(e.tax_amount),
      money(e.amount + e.tax_amount, 'moneyBold'),
      text(titleise(e.state)),
      moneyOrDash(owed),
      text(e.entry_no),
      text(e.approved_by),
      text(e.approved_at ? fmtDate(e.approved_at.slice(0, 10)) : null),
      text(e.receipt),
    ]);
  });

  const sum = (f: (e: TripExpenseRow) => number) => rows.reduce((t, e) => t + f(e), 0);
  const live = rows.filter((e) => e.state !== 'refused' && e.state !== 'draft');
  const blank = (n: number) => Array.from({ length: n }, () => ({ v: null, s: 'section' as const }));
  body.push([]);
  body.push([
    text('Total claimed (excluding draft and refused)', 'section'), ...blank(6),
    money(live.reduce((t, e) => t + e.amount, 0), 'sectionMoney'),
    { v: null, s: 'section' }, { v: null, s: 'section' },
    money(live.reduce((t, e) => t + e.tax_amount, 0), 'sectionMoney'),
    money(live.reduce((t, e) => t + e.amount + e.tax_amount, 0), 'sectionMoney'),
    { v: null, s: 'section' },
    money(sum((e) => (e.state === 'posted' && e.paid_by === 'employee' ? e.amount + e.tax_amount : 0)), 'sectionMoney'),
    ...blank(4),
  ]);

  return {
    name: 'Staff Expenses',
    rows: body,
    cols: [7, 12, 12, 20, 40, 26, 22, 14, 18, 11, 13, 16, 12, 15, 15, 16, 14, 24],
    freezeRows: 4,
  };
}

function tripCommissionSheet(rows: TripCommissionRow[]): Sheet {
  const headers = [
    'S.No.', 'Agent', 'Calculated on', 'Rate %', 'Fixed (Rs)', 'Base (Rs)',
    'Commission (Rs)', 'Payable on', 'State', 'Journal entry', 'Calculated on (date)',
  ];
  const body: CellInput[][] = [
    [text('Agent Commission on this trip', 'title')],
    [text('A commission on PROFIT is a share of the figure the Summary sheet arrives at — '
      + 'so a cost booked after it was calculated does not change what was already posted.', 'muted')],
    [],
    headers.map((h) => text(h, 'header')),
  ];

  rows.forEach((c, i) => {
    body.push([
      { v: i + 1, s: 'int' },
      text(c.agent_name),
      text(c.basis === 'revenue' ? 'Revenue from the trip' : 'Profit from the trip'),
      c.rate_bps ? rate(c.rate_bps) : text('fixed'),
      moneyOrDash(c.fixed_amount),
      money(c.base_amount),
      money(c.amount, 'moneyBold'),
      text(c.due_date ? fmtDate(c.due_date) : null),
      text(titleise(c.state)),
      text(c.entry_no),
      text(fmtDate(c.created_at.slice(0, 10))),
    ]);
  });

  const blank = (n: number) => Array.from({ length: n }, () => ({ v: null, s: 'section' as const }));
  const posted = rows.filter((c) => c.state === 'posted' || c.state === 'paid')
    .reduce((t, c) => t + c.amount, 0);
  const draft = rows.filter((c) => c.state === 'draft').reduce((t, c) => t + c.amount, 0);
  body.push([]);
  body.push([text('On the books (posted and paid)', 'section'), ...blank(5),
    money(posted, 'sectionMoney'), ...blank(4)]);
  body.push([text('Calculated, not yet posted', 'section'), ...blank(5),
    money(draft, 'sectionMoney'), ...blank(4)]);

  return {
    name: 'Commissions',
    rows: body,
    cols: [7, 26, 24, 10, 14, 16, 18, 14, 12, 15, 18],
    freezeRows: 4,
  };
}

function tripPaymentSheet(rows: TripPaymentRow[]): Sheet {
  const headers = [
    'S.No.', 'Payment', 'Date', 'In / Out', 'Against', 'Party', 'Account used',
    'Method', 'Reference', 'Amount (Rs)', 'Unallocated (Rs)', 'Advance', 'State', 'Note',
  ];
  const body: CellInput[][] = [
    [text('Money Movement', 'title')],
    [text('Cash actually in and out against this trip, which is not the same as what was '
      + 'invoiced or billed — a trip can be profitable and still unpaid.', 'muted')],
    [],
    headers.map((h) => text(h, 'header')),
  ];

  rows.forEach((p, i) => {
    body.push([
      { v: i + 1, s: 'int' },
      text(p.number),
      text(fmtDate(p.pay_date)),
      text(p.direction === 'inbound' ? 'In' : 'Out'),
      text(p.side === 'customer' ? 'Customer' : 'Supplier'),
      text(p.partner_name),
      text(p.journal_name),
      text(titleise(p.method)),
      text(p.reference),
      money(p.amount, 'moneyBold'),
      moneyOrDash(p.unallocated),
      text(p.is_advance ? 'Yes' : 'No'),
      text(titleise(p.state)),
      text(p.note, 'wrap'),
    ]);
  });

  const blank = (n: number) => Array.from({ length: n }, () => ({ v: null, s: 'section' as const }));
  const inbound = rows.filter((p) => p.direction === 'inbound').reduce((t, p) => t + p.amount, 0);
  const outbound = rows.filter((p) => p.direction === 'outbound').reduce((t, p) => t + p.amount, 0);
  body.push([]);
  body.push([text('Money in', 'section'), ...blank(8), money(inbound, 'sectionMoney'), ...blank(4)]);
  body.push([text('Money out', 'section'), ...blank(8), money(outbound, 'sectionMoney'), ...blank(4)]);
  body.push([text('Net cash on this trip', 'section'), ...blank(8),
    money(inbound - outbound, 'sectionMoney'), ...blank(4)]);

  return {
    name: 'Money Movement',
    rows: body,
    cols: [7, 14, 12, 10, 12, 26, 22, 12, 20, 15, 16, 10, 12, 36],
    freezeRows: 4,
  };
}

function tripLedgerSheet(rows: TripLedgerRow[]): Sheet {
  const headers = [
    'S.No.', 'Date', 'Entry No.', 'Journal', 'Account code', 'Account', 'Type',
    'Narration', 'Line label', 'Party', 'Raised from', 'Document',
    'Line debit (Rs)', 'Line credit (Rs)', 'Share %', 'Charged to this trip (Rs)',
  ];
  const body: CellInput[][] = [
    [text('Ledger — every posted line tagged to this trip', 'title')],
    [text('Cost is positive and revenue negative, as the engine writes it. The last column '
      + 'adds up to the trip’s profit with the sign reversed: that is the check.', 'muted')],
    [],
    headers.map((h) => text(h, 'header')),
  ];

  rows.forEach((l, i) => {
    body.push([
      { v: i + 1, s: 'int' },
      text(fmtDate(l.entry_date)),
      text(l.entry_no),
      text(l.journal_code ? `${l.journal_code} ${l.journal_name}` : l.journal_name),
      text(l.account_code),
      text(l.account_name),
      text(titleise(l.account_kind)),
      text(l.narration),
      text(l.label),
      text(l.partner_name),
      text(l.source_model ? titleise(l.source_model) : 'Manual'),
      text(l.doc_number ?? l.reference),
      moneyOrDash(l.debit),
      moneyOrDash(l.credit),
      rate(l.bps),
      money(l.amount, 'moneyBold'),
    ]);
  });

  const net = rows.reduce((t, l) => t + l.amount, 0);
  const blank = (n: number) => Array.from({ length: n }, () => ({ v: null, s: 'section' as const }));
  body.push([]);
  body.push([text('Net charged to the trip', 'section'), ...blank(14), money(net, 'sectionMoney')]);
  body.push([text('Trip profit (the same figure, sign reversed)', 'section'), ...blank(14),
    money(-net, 'sectionMoney')]);

  return {
    name: 'Ledger',
    rows: body,
    cols: [7, 12, 14, 22, 13, 28, 14, 34, 34, 24, 14, 18, 16, 16, 9, 20],
    freezeRows: 4,
    freezeCols: 3,
  };
}

/** A label/value pair on the summary sheet's header block. */
function tripKv(k: string, v: string | number | null | undefined): CellInput[] {
  return [null, null, text(k, 'bold'), typeof v === 'number' ? { v, s: 'int' as const } : text(v)];
}

function tripLine(
  sNo: number | null, label: string, amount: number, note?: string,
): CellInput[] {
  return [
    null,
    sNo === null ? null : { v: sNo, s: 'int' as const },
    label,
    moneyOrDash(amount),
    note ? text(note, 'muted') : null,
  ];
}

function tripSection(label: string): CellInput[] {
  return [null, null, text(label, 'section'), text('', 'section'), text('', 'section')];
}

function tripTotal(label: string, amount: number, note?: string): CellInput[] {
  return [
    null, null, text(label, 'section'), moneyOrDash(amount, 'sectionMoney'),
    note ? text(note, 'section') : text('', 'section'),
  ];
}

function tripSummarySheet(d: TripDossier, orgName: string): Sheet {
  const b = d.booking;
  const t = d.totals;
  const pax = b?.pax ?? 0;

  const rows: CellInput[][] = [
    [],
    [null, text(`${d.analytic.name} — Trip Profitability`, 'title')],
    [null, null, text(orgName, 'muted')],
    [],
    tripSection('The trip'),
    tripKv('Trip account', `${d.analytic.code} · ${d.analytic.name}`),
    tripKv('Analytic plan', `${d.analytic.plan_code} · ${d.analytic.plan_name}`),
    ...(b ? [
      tripKv('Booking', `${b.ref} — ${b.title}`),
      tripKv('Customer', b.customer_name ?? b.partner_name),
      tripKv('Destination', b.destination),
      tripKv('Package', b.package_name),
      tripKv('Agent who closed it', b.agent_name),
      tripKv('Travellers (pax)', pax),
      tripKv('Travel dates', b.start_date
        ? `${fmtDate(b.start_date)} to ${fmtDate(b.end_date ?? b.start_date)}`
        : null),
      tripKv('Quoted sell value', `Rs ${(b.sell_value / 100).toFixed(2)}`),
      tripKv('Booking status', titleise(b.status)),
    ] : [
      // A trip analytic with no booking is legitimate — a cost centre someone
      // tagged bills to before the CRM record existed. Saying so is better
      // than printing an empty customer block.
      tripKv('Booking', 'Not linked to a CRM booking'),
    ]),
    tripKv('Ledger activity', t.firstEntry
      ? `${fmtDate(t.firstEntry)} to ${fmtDate(t.lastEntry)}` : 'Nothing posted yet'),
    tripKv('Posted ledger lines', d.ledger.length),
    [],
    [null, text('S. No.', 'header'), text('Particular', 'header'),
      text('Amount (Rs)', 'header'), text('Where it comes from', 'header')],
    [],

    tripSection('What the trip earned'),
    tripLine(1, '  Customer invoices (incl. GST)', t.invoiced, 'Sheet: Revenue'),
    tripLine(null, '  Less credit notes (incl. GST)', -t.creditNotes, 'Sheet: Revenue'),
    tripLine(null, '  Output GST on the above', -t.outputTax, 'Not income — collected for the department'),
    ...d.revenueLines.map((r) => tripLine(null, `  ${r.code} ${r.name}`, r.amount, 'Ledger')),
    tripTotal('Revenue recognised (net of GST)', t.revenue, 'Ledger'),
    [],

    tripSection('What the trip cost'),
    tripLine(2, '  Supplier bills (incl. GST)', t.billed, 'Sheet: Costs'),
    tripLine(null, '  Less debit notes (incl. GST)', -t.debitNotes, 'Sheet: Costs'),
    tripLine(3, '  Staff expense claims (excl. GST)', t.expenseClaims, 'Sheet: Staff Expenses'),
    tripLine(null, '  GST on staff expense claims', t.expenseTax, 'Input credit, not a cost'),
    tripLine(4, '  Agent commission posted', t.commissionPosted, 'Sheet: Commissions'),
    tripLine(null, '  Agent commission calculated, not posted', t.commissionDraft,
      'Not in the cost below until it is posted'),
    [],
    tripSection('Cost by account, as the ledger carries it'),
    ...d.costLines.map((r) => tripLine(null, `  ${r.code} ${r.name}`, r.amount, 'Ledger')),
    tripTotal('Total cost', t.cost, 'Ledger'),
    [],

    tripTotal('Gross profit', t.profit, 'Revenue less every cost tagged to the trip'),
    [
      null, null, text('Margin', 'section'),
      { v: Number(t.margin.toFixed(2)), s: 'rate' }, text('% of revenue', 'section'),
    ],
    ...(pax > 0 ? [
      tripTotal('Revenue per traveller', Math.round(t.revenue / pax)),
      tripTotal('Cost per traveller', Math.round(t.cost / pax)),
      tripTotal('Profit per traveller', Math.round(t.profit / pax)),
    ] : []),
    [],

    tripSection('Tax on this trip'),
    tripLine(null, '  Output GST charged to the customer', t.outputTax, 'Payable to the department'),
    tripLine(null, '  Input GST on bills and staff claims', t.inputTax, 'Claimable as credit'),
    tripLine(null, '  TDS withheld from suppliers', t.withheldTax, 'Deposited by challan'),
    tripTotal('Net GST effect of this trip', t.outputTax - t.inputTax),
    [],

    tripSection('Money, as against profit'),
    tripLine(null, '  Received from the customer', t.received, 'Sheet: Money Movement'),
    tripLine(null, '  Still to collect', t.outstanding, 'Unpaid on posted invoices'),
    tripLine(null, '  Customer advance still unapplied', t.advances),
    tripLine(null, '  Paid out against this trip', t.paidOut, 'Sheet: Money Movement'),
    tripTotal('Still owed back to staff', t.expenseOwed,
      'Approved claims the employee paid for and has not been reimbursed'),
  ];

  return {
    name: 'Trip Summary',
    rows,
    cols: [3, 9, 46, 20, 52],
    merges: ['B2:E2'],
  };
}

export interface TripWorkbook {
  buffer: Buffer;
  dossier: TripDossier;
}

export async function tripWorkbook(orgId: string, analyticId: string): Promise<TripWorkbook | null> {
  const dossier = await tripDossier(orgId, analyticId);
  if (!dossier) return null;
  const org = await seller(orgId);

  const sales = new Set(['out_invoice', 'out_refund']);
  const revenueItems = dossier.items.filter((i) => sales.has(i.doc_type));
  const costItems = dossier.items.filter((i) => !sales.has(i.doc_type));

  // Every sheet is written even when it is empty, unlike the payout workbook.
  // There the third sheet is a question; here it is an ANSWER — "no commission
  // was paid on this trip" is exactly what a reader checking where the money
  // went needs to be told, and an absent sheet reads as an export that failed.
  const sheets: Sheet[] = [
    tripSummarySheet(dossier, org.name),
    itemSheet('Revenue', 'Revenue — what was invoiced to the customer',
      'Customer invoices and credit notes tagged to this trip, line by line, with the GST on each.',
      revenueItems),
    itemSheet('Costs', 'Costs — what suppliers billed',
      'Vendor bills and debit notes tagged to this trip, line by line, with the input GST on each.',
      costItems),
    tripExpenseSheet(dossier.expenses),
    tripCommissionSheet(dossier.commissions),
    tripPaymentSheet(dossier.payments),
    tripLedgerSheet(dossier.ledger),
  ];

  return { buffer: buildXlsx(sheets), dossier };
}
