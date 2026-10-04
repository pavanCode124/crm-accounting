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
import { allocationsFor, pendingReceiptsFor } from './payments';
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
  const lines = await documentLines(orgId, documentId);
  const taxes = await documentLineTaxes(orgId, documentId);

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
    /*
     * UTGST HAS ITS OWN PAIR OF COLUMNS, beside SGST rather than inside it.
     *
     * The channels' own sheets carry IGST/CGST/SGST/CESS and stop, because a
     * marketplace selling goods across the mainland rarely meets one — but a
     * travel agency does: a Chandigarh, Andamans, Lakshadweep or Ladakh
     * operator's entire intra-territory book is CGST+UTGST, and folding it
     * into the SGST column reports every rupee of it against a state
     * government that is not party to the supply. The column is added rather
     * than substituted, so the sheet still lines up with a channel statement
     * for every other column, and it reads "-" for the agencies that never
     * make one.
     */
    rate(r.tax.utgstBps),
    rate(r.tax.cessBps),
    moneyOrDash(r.tax.igst),
    moneyOrDash(r.tax.cgst),
    moneyOrDash(r.tax.sgst),
    moneyOrDash(r.tax.utgst),
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
  'IGST %', 'CGST %', 'SGST %', 'UTGST %', 'CESS %',
  'IGST Value', 'CGST Value', 'SGST Value', 'UTGST Value', 'CESS Value',
  'Total Tax', 'Total Gross Bill Amount',
  'Commission %', 'Commission Charge (Rs)', 'Commission GST (Rs)',
  'Shipping Charge (Rs)', 'Shipping GST (Rs)',
  'TCS Amount', 'TDS 194O Amount', 'TDS 194Q Amount',
  'Net Deductions', 'Net Additions', 'Item Level Payout',
  'Bank UTR', 'Settlement Date', 'Settlement Status', 'Unsettled Amount',
];

/**
 * `title` is what the sheet's first cell says and `name` is what the TAB says,
 * and they are deliberately allowed to differ.
 *
 * The tab is part of the contract described at the top of this file: a payout
 * workbook has a Payout Breakup, a Forward Orders and a Cancelled or Returned
 * Orders, in that order, and anything reading these files by sheet name —
 * including the person who has the channel's own workbook open beside it —
 * must find them where they always are. The TITLE is free to carry what this
 * particular export is of ("Customer Invoices", "Orders", a date range), which
 * is the context the tab cannot hold without breaking the contract.
 */
function forwardSheet(
  rows: ItemRow[], seller: Seller, settlement: SettlementRow | null,
  title = 'Forward Orders', name = 'Forward Orders',
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
    name,
    rows: body,
    // Measured against the headings, which are long: a column narrower than its
    // own heading shows "########" for money and clips the heading, and the
    // reader cannot tell which column they are looking at.
    cols: [7, 20, 16, 11, 13, 22, 26, 22, 16, 20, 16, 16, 20, 11, 30, 26, 20,
      18, 18, 18, 14, 11, 10, 12, 14, 9, 9, 9, 10, 9, 12, 12, 12, 13, 12, 12, 16,
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
  'IGST (%)', 'CGST (%)', 'SGST (%)', 'UTGST (%)', 'Cess (%)',
  'IGST Value', 'CGST Value', 'SGST Value', 'UTGST Value', 'CESS Value',
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
      26, 20, 18, 18, 18, 14, 11, 10, 12, 14, 10, 10, 10, 11, 10, 12, 12, 12, 13,
      12, 12, 16, 13, 15, 15, 14, 14, 12, 14, 14, 14, 18, 16, 16, 15, 15],
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

  /*
   * THE COMPONENT BLOCK, AND IT IS THE PART THAT GETS FILED.
   *
   * GSTR-3B Table 3.1 has a box for IGST, a box for CGST, a box for SGST/UTGST
   * and a box for cess. It has no box for "GST 18% (Sales)", which is what
   * every other table in this workbook is keyed on — so without this the
   * person filing has to add the rate rows up by component themselves, by
   * reading the names, which is exactly the re-keying these exports exist to
   * remove.
   *
   * IGST AND UTGST ARE WRITTEN EVEN AT NIL, and `taxReport` is what guarantees
   * it — the four statutory components always come back, in the order the
   * return prints them, so this is a plain map rather than a merge against a
   * list of its own. The rate tables drop what did not arise because a
   * configured rate nobody used is noise; a RETURN BOX is the opposite, and an
   * empty IGST box is the statement that no inter-state supply was made.
   */
  const componentRows = (
    rows: Array<{ tax_group: string; base: number; amount: number }>,
  ): CellInput[][] => rows.map(
    (r) => [text(taxGroupLabel(r.tax_group)), moneyOrDash(r.base), moneyOrDash(r.amount)],
  );

  const componentSheet = (name: string, title: string, rows: Array<{
    tax_group: string; base: number; amount: number;
  }>, netBase: number, total: number): Sheet => ({
    name,
    cols: [22, 20, 20],
    freezeRows: 5,
    rows: [
      ...head(title),
      [text('Component', 'header'), text('Taxable value', 'header'), text('Tax', 'header')],
      ...componentRows(rows),
      [],
      // The taxable value is per component and does not add down — both halves
      // of an intra-state supply bear the whole of it. The footer carries the
      // figure that IS the period's turnover, taken once per tax family, so
      // nobody adds the column above and files the double.
      [text('Taxable value for the period', 'section'), money(netBase, 'sectionMoney'),
        money(total, 'sectionMoney')],
      [],
      [text('Stated per component: an intra-state supply bears CGST and SGST on the whole of its', 'muted')],
      [text('value, so the column above repeats it. The total is taken once per supply.', 'muted')],
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
      // Component-wise on the summary too, because this is the sheet somebody
      // opens with the return form beside them.
      [text('Output GST by component', 'section'), text('', 'section')],
      ...componentRows(t.outputByGroup).map((r) => [r[0], r[2]]),
      [],
      [text('Input GST by component', 'section'), text('', 'section')],
      ...componentRows(t.inputByGroup).map((r) => [r[0], r[2]]),
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
    componentSheet('Output by component', 'Output GST by component',
      t.outputByGroup, t.outputBase, t.outputTotal),
    componentSheet('Input by component', 'Input GST by component',
      t.inputByGroup, t.inputBase, t.inputTotal),
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
  const charges = await settlementCharges(orgId, settlementId);

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

// ---------------------------------------------------------------------------
// Sheet 1 — Payout Breakup, built from the ledger rather than from a cycle
// ---------------------------------------------------------------------------

/**
 * ===========================================================================
 * THE SAME BREAKUP, FOR AN AGENCY THAT IS NOT BEING PAID BY A CHANNEL.
 * ===========================================================================
 * `payoutBreakupSheet` above reconciles a CYCLE: the channel collected the
 * fare, kept its charges, and remitted one net amount, and the sheet proves
 * the arithmetic the channel did. That is the right sheet when there is a
 * statement to check against, and it is useless when there is not — which is
 * most of a travel agency's trading, where the agency collects from the
 * traveller itself and pays its own suppliers.
 *
 * So this is the same sheet asking the question that version of the business
 * has: of everything invoiced in this period, how much is actually the
 * agency's? And it is answered from the ledger, not from a statement:
 *
 *   Customer Payable      what was invoiced, gross — the figure the traveller
 *                         was sent, which is where any reconciliation starts.
 *   Output GST            collected FOR the government and owed to it in this
 *                         month's 3B. It was never the agency's money, and
 *                         leaving it in is the single most common way a
 *                         travel agency overstates what it earned.
 *   Supplier Cost         every vendor bill recorded against those invoices,
 *                         NET of tax, because the input GST is reclaimed. It
 *                         is the link made on the bill form that makes this
 *                         row possible at all — see `linked_invoice_id`.
 *   Agent Commission      what the selling agent earns on those sales, with
 *                         its GST. Both are deducted: the agency pays them.
 *   TCS / TDS             tax collected or withheld on the sale. An ASSET,
 *                         set off at assessment — but it does not arrive in
 *                         the bank, so it comes off the payout and the sheet
 *                         says why rather than losing it.
 *
 * THE CHANNEL'S OWN ROWS ARE STILL PRINTED, AT NIL. Storage, ads, recall,
 * credit and debit notes: the whole `CHARGE_KINDS` catalogue, exactly as the
 * cycle version walks it. An agency that sells through a channel SOME of the
 * time needs the two sheets to line up row for row, and a sheet that silently
 * drops what did not arise cannot be put beside one that does.
 *
 * THE RETURNED COLUMN IS CREDIT NOTES, and every figure in it is negative,
 * because every figure in it is a reversal: the fare goes back, the GST on it
 * goes back, and the cost goes back if the supplier credited us.
 */
interface LedgerBreakup {
  /** Gross invoiced and gross credited, both as positive magnitudes. */
  forwardGross: number;
  returnGross: number;
  forwardTax: number;
  returnTax: number;
  /** Vendor bills linked to these sales, net of reclaimable tax. */
  supplierCost: number;
  supplierTax: number;
  returnSupplierCost: number;
  commission: number;
  commissionGst: number;
  tcs: number;
  tds: number;
  /** What has actually been collected against these sales, and what has not. */
  received: number;
  outstanding: number;
}

async function ledgerBreakup(
  orgId: string, docIds: string[], returnIds: string[],
): Promise<LedgerBreakup> {
  const out: LedgerBreakup = {
    forwardGross: 0, returnGross: 0, forwardTax: 0, returnTax: 0,
    supplierCost: 0, supplierTax: 0, returnSupplierCost: 0,
    commission: 0, commissionGst: 0, tcs: 0, tds: 0, received: 0, outstanding: 0,
  };
  const every = [...docIds, ...returnIds];
  if (!every.length) return out;
  const marks = (xs: string[]) => xs.map(() => '?').join(',');

  const totals = await all<{ doc_type: string; total: number; tax_total: number; residual: number }>(
    `SELECT doc_type, COALESCE(SUM(total),0) AS total, COALESCE(SUM(tax_total),0) AS tax_total,
            COALESCE(SUM(residual),0) AS residual
       FROM documents WHERE id IN (${marks(every)}) GROUP BY doc_type`,
    ...every,
  );
  for (const t of totals) {
    if (t.doc_type === 'out_refund' || t.doc_type === 'in_refund') {
      out.returnGross += t.total;
      out.returnTax += t.tax_total;
    } else {
      out.forwardGross += t.total;
      out.forwardTax += t.tax_total;
      out.outstanding += t.residual;
    }
  }
  out.received = out.forwardGross - out.outstanding;

  if (docIds.length) {
    /*
     * THE COSTS BOUGHT AGAINST THESE SALES.
     *
     * Posted only — a drafted bill is an intention, and a payout figure that
     * moved when somebody opened a form would be unusable. A supplier's own
     * credit note comes back out, because that is what it is: cost reversed.
     */
    const bills = await all<{ doc_type: string; untaxed: number; tax_total: number }>(
      `SELECT doc_type, COALESCE(SUM(untaxed),0) AS untaxed, COALESCE(SUM(tax_total),0) AS tax_total
         FROM documents
        WHERE linked_invoice_id IN (${marks(docIds)})
          AND doc_type IN ('in_invoice','in_refund') AND state = 'posted'
        GROUP BY doc_type`,
      ...docIds,
    );
    for (const b of bills) {
      if (b.doc_type === 'in_refund') out.returnSupplierCost += b.untaxed;
      else { out.supplierCost += b.untaxed; out.supplierTax += b.tax_total; }
    }

    /*
     * AGENT COMMISSION ON THE TRIPS THESE SALES BELONG TO.
     *
     * Reached through the booking, because that is what a commission is
     * recorded against: an agent earns on the trip, not on the piece of paper
     * it was invoiced on. A sale with no booking behind it contributes no
     * commission, which is exact rather than approximate — there is no
     * commission row to find.
     *
     * DISTINCT ON THE BOOKING, not on the invoice. Two invoices raised against
     * one trip must not count the agent's commission twice, which is precisely
     * what a plain join through `documents` does.
     */
    const commission = await one<{ amount: number }>(
      `SELECT COALESCE(SUM(c.amount),0) AS amount
         FROM commissions c
        WHERE c.org_id = ? AND c.state IN ('posted','paid')
          AND c.booking_id IN (
            SELECT DISTINCT booking_id FROM documents
             WHERE id IN (${marks(docIds)}) AND booking_id IS NOT NULL
          )`,
      orgId, ...docIds,
    );
    out.commission = commission?.amount ?? 0;
  }

  /*
   * TCS AND TDS ON THESE SALES, FROM THE LEDGER'S OWN TAX LINES.
   *
   * Not a rate applied to a total. What matters is what was actually posted,
   * because that is what a 26AS reconciliation is done against — so it is read
   * off the journal entries the documents produced, and a deduction somebody
   * adjusted by hand is the one that appears.
   */
  const withheld = await all<{ tax_group: string; amount: number }>(
    `SELECT t.tax_group, COALESCE(SUM(l.credit - l.debit),0) AS amount
       FROM journal_entry_lines l
       JOIN taxes t ON t.id = l.tax_id
       JOIN journal_entries e ON e.id = l.entry_id AND e.source_model = 'document'
      WHERE l.org_id = ? AND l.state = 'posted' AND e.source_id IN (${marks(every)})
        AND t.tax_group IN ('tcs','tds')
      GROUP BY t.tax_group`,
    orgId, ...every,
  );
  for (const w of withheld) {
    if (w.tax_group === 'tcs') out.tcs += Math.abs(w.amount);
    else out.tds += Math.abs(w.amount);
  }
  return out;
}

function ledgerBreakupSheet(b: LedgerBreakup, label: string, period: string | null): Sheet {
  /*
   * EVERY CHANNEL ROW, AT NIL, so this sheet and a cycle's can be read side by
   * side. Same reasoning `payoutBreakupSheet` gives for walking the catalogue:
   * a printed "-" says the charge did not arise, while an absent row leaves
   * the reader wondering whether it was missed.
   */
  const nilBlock = (which: 'additions' | 'deductions' | 'one_time', from: number): BreakupLine[] => {
    const rows: BreakupLine[] = [];
    let n = from;
    for (const k of CHARGE_KINDS.filter((c) => c.block === which)) {
      rows.push({ sNo: ++n, label: `  ${k.label} (Rs)`, forward: 0, returned: 0, section: k.section });
      if (k.gst) {
        rows.push({
          sNo: null,
          label: `  GST on ${k.code === 'credit_note' ? 'CN' : k.code === 'debit_note' ? 'DN' : k.label} (Rs)`,
          forward: 0, returned: 0, section: k.section,
        });
      }
    }
    return rows;
  };

  /*
   * THE INPUT-GST ROW IS AN ADDITION PRINTED INSIDE A DEDUCTIONS BLOCK, and
   * that is deliberate rather than untidy. The supplier's bill was paid gross;
   * the cost of the trip is the net; the difference is a receivable from the
   * government. Showing the cost net and NOT showing the tax would leave this
   * sheet unable to reconcile against the bills it was built from, and showing
   * the cost gross would overstate it. So both appear, and `section` on each
   * row — not the block it prints under — decides the arithmetic.
   */
  const orderDeductions: BreakupLine[] = [
    {
      sNo: 2, section: 'deduction',
      label: '  Output GST on the supply (Rs)',
      forward: b.forwardTax, returned: -b.returnTax,
    },
    {
      sNo: 3, section: 'deduction',
      label: '  Supplier Cost, net of GST (Rs)',
      forward: b.supplierCost, returned: -b.returnSupplierCost,
    },
    {
      sNo: null, section: 'addition',
      label: '  Input GST on supplier bills (reclaimed, not a cost) (Rs)',
      forward: b.supplierTax, returned: 0,
    },
    { sNo: 4, label: '  Agent Commission (Rs)', forward: b.commission, returned: 0, section: 'deduction' },
    { sNo: null, label: '  GST on Commission (Rs)', forward: b.commissionGst, returned: 0, section: 'deduction' },
    { sNo: 5, label: '  TCS Charge (Rs)', forward: b.tcs, returned: 0, section: 'deduction' },
    { sNo: 6, label: '  TDS Charge (194O & Q)(Rs)', forward: b.tds, returned: 0, section: 'deduction' },
  ];

  const numbered = (rows: BreakupLine[]) => rows.filter((l) => l.sNo !== null).length;
  const additions = nilBlock('additions', 6);
  const deductions = nilBlock('deductions', 6 + numbered(additions));
  const oneTime = nilBlock('one_time', 6 + numbered(additions) + numbered(deductions));

  const signedForward = (rows: BreakupLine[]) =>
    rows.reduce((t, l) => t + (l.section === 'deduction' ? -l.forward : l.forward), 0);
  const signedReturned = (rows: BreakupLine[]) =>
    rows.reduce((t, l) => t + (l.section === 'deduction' ? -l.returned : l.returned), 0);

  const cycleRows = [...additions, ...deductions, ...oneTime];
  const forwardTotal = b.forwardGross + signedForward(orderDeductions) + signedForward(cycleRows);
  const returnTotal = -b.returnGross + signedReturned(orderDeductions) + signedReturned(cycleRows);
  const cycleTotal = forwardTotal + returnTotal;

  return {
    name: 'Payout Breakup',
    cols: [3, 9, 52, 20, 22, 20],
    merges: ['B2:F2'],
    rows: [
      [],
      [null, text('Payout Breakup', 'title')],
      [null, text('S. No.', 'header'), text('Particular', 'header'), text('Delivered Orders', 'header'),
        text('Cancelled/Returned', 'header'), text('Total', 'header')],
      [],
      breakupRow({
        sNo: 1, label: 'Customer Payable (Rs)', section: 'addition',
        forward: b.forwardGross, returned: -b.returnGross,
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
      /*
       * WHAT THE AGENCY HAS, AGAINST WHAT IT IS STILL OWED.
       *
       * On a channel cycle the two closing rows are the remittance and the
       * carry-forward. Books that collect their own money have the same
       * question in a different shape — receipts posted against these sales,
       * and the receivable still standing — so those are the rows, and they
       * are kept apart from the earnings figure above because they answer
       * about CASH rather than about trading. A profitable month with nothing
       * collected is a real and important state, and one line cannot say it.
       */
      totalRow('Received against these orders', null, null, b.received),
      [],
      totalRow('Still to collect', null, null, b.outstanding),
      [],
      totalRow('Net earned in this period', null, null, cycleTotal),
      [],
      [null, text(label, 'muted')],
      ...(period ? [[null, text(period, 'muted')]] : []),
      [null, text(
        'Built from the ledger rather than from a channel statement: output GST is collected for '
        + 'the government and is not earnings, supplier cost is every bill recorded against these '
        + 'sales net of reclaimable input GST, and the channel rows above print at nil so this '
        + 'sheet can be read beside one that has them.',
        'muted',
      )],
    ],
  };
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
  const forwardIds: string[] = [];
  const returnIds: string[] = [];
  for (const d of docs) {
    const ctx = await loadOrder(orgId, d.id, null);
    if (!ctx) continue;
    const isReturn = d.doc_type === 'out_refund' || d.doc_type === 'in_refund';
    (isReturn ? returned : forward).push(...itemRows(ctx));
    (isReturn ? returnIds : forwardIds).push(d.id);
  }
  const s = await seller(orgId);

  /*
   * ALL THREE SHEETS, ALWAYS, AND THE BREAKUP FIRST.
   *
   * This export used to be the item grid alone, on the reasoning that a set of
   * orders with no settlement behind them had nothing to summarise. That was
   * wrong twice over. The person opening a payout workbook reads the breakup
   * first and the item rows only when a figure on it needs explaining, so
   * leading with four hundred rows of detail puts the answer at the bottom.
   * And the ledger does know the figures: what was invoiced, the GST inside it
   * that belongs to the government, the supplier bills recorded against those
   * sales, the commission, the withholding. That IS the breakup — it simply
   * was not being asked for.
   *
   * THE THIRD SHEET IS WRITTEN EVEN WHEN IT IS EMPTY, which is a change. A
   * workbook whose tabs vary with whether anything happened to be cancelled
   * cannot be dropped into the same process twice, and "Cancelled or Returned
   * Orders, and there were none" is information where a missing tab is a
   * question about the export itself.
   */
  const breakup = await ledgerBreakup(orgId, forwardIds, returnIds);
  const period = filter.from && filter.to ? `${fmtDate(filter.from)} to ${fmtDate(filter.to)}` : null;
  return buildXlsx([
    ledgerBreakupSheet(breakup, label, period),
    forwardSheet(forward, s, null, label),
    returnSheet(returned, s, null),
  ]);
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
  const lines = await documentLines(orgId, docId);
  const taxes = await documentLineTaxes(orgId, docId);
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
      text('UTGST %', 'header'), text('UTGST', 'header'),
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
      // Printed on every invoice, nil on most of them. A tax invoice that
      // omits the component it was actually charged under is not a tax
      // invoice, and which component that is depends on where the agency is
      // registered — so the column is always there rather than conditional on
      // this one document having used it.
      rate(t.utgstBps), moneyOrDash(t.utgst),
      moneyOrDash(t.cess),
      money(l.total, 'moneyBold'),
    ]);
  });

  /*
   * ===========================================================================
   * WHAT HAS BEEN SETTLED, AND BY WHAT
   * ===========================================================================
   * The footer used to run Taxable → Tax → Total → Still owed, which asks the
   * reader to do the subtraction and then tells them nothing about where the
   * difference came from. On an invoice half-paid by a receipt and half
   * cancelled by a credit note those are two completely different facts, and
   * the single figure they produce is the one that cannot be checked against
   * anything.
   *
   * SETTLED IS SPLIT THE WAY THE SCREEN SPLITS IT — cash apart from credit —
   * for the same reason it is split there: a cancelled trip is settled in
   * both, and the first question anyone asks is how much of it actually
   * arrived. And the allocations themselves are listed under it, so every
   * rupee of the settled figure names the receipt or the note it came from.
   * Reconciling a customer's statement against this file is then reading,
   * not arithmetic.
   *
   * TDS IS DEDUCTED BEFORE SETTLED, not after, because that is the order it
   * happens in: the supplier is never going to pay the withheld amount — it
   * goes to the department — so what the document can be settled against is
   * the total less the deduction. `residual` is computed the same way.
   */
  const allocations = await allocationsFor(orgId, docId);
  const credited = allocations.reduce((t, a) => t + (a.credit_doc_id ? a.amount : 0), 0);
  const settled = doc.total - doc.withheld_tax - doc.residual;
  const received = settled - credited;
  const isCredit = meta.sign === -1;

  const blank = (n: number) => Array.from({ length: n }, () => null as CellInput);
  const footer = (label: string, amount: number) =>
    rows.push([...blank(6), text(label, 'section'), money(amount, 'sectionMoney')]);

  rows.push([]);
  footer('Taxable', doc.untaxed);
  footer('Tax', doc.tax_total);
  footer('Total', doc.total);
  if (doc.withheld_tax) footer('TDS withheld', -doc.withheld_tax);
  if (credited) {
    footer(isBill ? 'Paid in cash' : 'Received in cash', received);
    footer(isBill ? 'Debit notes applied' : 'Credit notes applied', credited);
  }
  footer('Settled', settled);
  footer(doc.residual > 0 ? 'Still owed' : 'Cleared', doc.residual);

  if (allocations.length) {
    rows.push([]);
    rows.push([null, text(isCredit ? 'Applied against' : 'Settled by', 'section'),
      text('', 'section'), text('', 'section'), text('', 'section')]);
    rows.push([null, text('Date', 'header'), text('Reference', 'header'),
      text('Kind', 'header'), text('Amount', 'header')]);
    for (const a of allocations) {
      rows.push([
        null,
        text(a.pay_date ? fmtDate(a.pay_date) : fmtDate(a.at.slice(0, 10))),
        text(a.credit_number ?? a.payment_number),
        // What cleared the debt, named rather than implied by a blank column:
        // a credit note and a receipt both reduce the residual and only one of
        // them is money.
        text(a.credit_doc_id ? (isBill ? 'Debit note' : 'Credit note') : titleise(a.method ?? 'Payment')),
        money(a.amount),
      ]);
    }
    rows.push([null, text('Total settled', 'section'), text('', 'section'), text('', 'section'),
      money(settled, 'sectionMoney')]);
  }

  /*
   * AND THE MONEY THAT HAS NOT REACHED THE LEDGER YET, STATED AS SUCH.
   *
   * A receipt fetched from TripzoCRM is drafted, not posted, so it is in
   * neither the settled figure nor the residual — correctly, because nothing
   * has been posted. But an export that simply omits it is how a workbook
   * showing "Still owed 26,999.00" is sent to a customer who paid ₹8,500 three
   * weeks ago. It is printed BELOW the settled block, under its own heading,
   * as a figure that is pending rather than one that has been taken.
   */
  const pending = await pendingReceiptsFor(orgId, docId);
  if (pending.length) {
    const pendingTotal = pending.reduce((t, r) => t + r.amount, 0);
    rows.push([]);
    rows.push([null, text('Collected in TripzoCRM, not yet posted', 'section'),
      text('', 'section'), text('', 'section'), text('', 'section')]);
    rows.push([null, text('Date', 'header'), text('Reference', 'header'),
      text('Kind', 'header'), text('Amount', 'header')]);
    for (const r of pending) {
      rows.push([
        null,
        text(fmtDate(r.pay_date)),
        text(r.number ?? r.reference),
        text(r.is_advance ? 'Advance' : titleise(r.method)),
        money(r.amount),
      ]);
    }
    rows.push([null, text('Pending', 'section'), text('', 'section'), text('', 'section'),
      money(pendingTotal, 'sectionMoney')]);
    rows.push([null, text(
      'Drafted from TripzoCRM and not posted, so it is in neither Settled nor Still owed above.',
      'muted',
    )]);
  }

  if (doc.note) {
    rows.push([]);
    rows.push([null, text('Note', 'bold'), text(doc.note, 'wrap')]);
  }

  const buffer = buildXlsx([{
    name: meta.short,
    rows,
    cols: [5, 38, 12, 8, 12, 13, 8, 14, 9, 12, 9, 12, 9, 12, 10, 12, 12, 14],
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
  'IGST %', 'IGST (Rs)', 'CGST %', 'CGST (Rs)', 'SGST %', 'SGST (Rs)',
  'UTGST %', 'UTGST (Rs)', 'Cess (Rs)',
  'Total Tax (Rs)', 'Total (Rs)', 'On this trip',
];

const ITEM_COLS = [7, 12, 18, 14, 26, 18, 38, 12, 24, 8, 13, 8, 14, 8, 13, 8, 13, 8, 13, 9, 13, 11, 14, 14, 12];

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
      rate(r.utgst_bps), moneyOrDash(r.utgst),
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
    { v: null, s: 'section' }, money(sum((r) => r.utgst), 'sectionMoney'),
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
