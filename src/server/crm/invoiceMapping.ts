import 'server-only';
import { all, one } from '../db';
import { getOrganisation } from '../accounting/organisation';
import type { DocLineInput } from '../accounting/documents';

/**
 * THE MAP BETWEEN A TRIPZOCRM INVOICE AND A LEDGER DOCUMENT.
 *
 * ===========================================================================
 * WHY THIS IS ITS OWN MODULE
 * ===========================================================================
 * The CRM's invoice and the ledger's document describe the same sale and are
 * NOT the same shape, and the difference is not cosmetic — it is the whole
 * reason an accounting app exists beside a CRM at all:
 *
 *   THE CRM records WHAT WAS SOLD AND FOR HOW MUCH. One `tax_amount` for the
 *   invoice, one `discount_amount` for the invoice, a line per thing sold with
 *   a human title and a loose `item_type`. That is everything an agent raising
 *   an invoice on a phone needs, and nothing more.
 *
 *   THE LEDGER records WHICH ACCOUNT EVERY RUPEE LANDED IN. Tax split per line
 *   and per component, because CGST goes to the centre and SGST to the state
 *   and they are two liabilities; revenue split per account, because "we made
 *   ₹40 lakh" and "₹22 lakh of it was hotels at a 9% margin and ₹18 lakh was
 *   packages at 31%" are different facts; an HSN per line, because Rule 46
 *   requires one.
 *
 * Translating between the two is a dozen small decisions, every one of which
 * is wrong in an interesting way if nobody writes down why it was made. They
 * used to be made implicitly inside `syncInvoices`, mostly by omission: tax
 * was dropped, discount was dropped, every line went to whichever income
 * account happened to sort first. The books balanced and were wrong, which is
 * the worst combination available.
 *
 * ===========================================================================
 * WHAT IS DROPPED, DELIBERATELY, AND WHAT IS NEVER DROPPED
 * ===========================================================================
 * DROPPED: a draft and a cancelled invoice (decided in `sync.ts`, not here) —
 * a draft is a proposal and a cancelled invoice never happened, and neither is
 * a fact the ledger should carry.
 *
 * NEVER DROPPED: money. If this module cannot work out where a figure belongs
 * it says so, by name and with the number in the message, and `sync.ts` turns
 * that into a warning on the sync report. A rupee of GST silently not posted
 * is a shortfall in a return that nobody finds until the return is rejected.
 */

// ---------------------------------------------------------------------------
// What was sold → which revenue account
// ---------------------------------------------------------------------------

/**
 * `item_type` → the chart code the line's revenue belongs on.
 *
 * -------------------------------------------------------------------------
 * WHY NOT ONE REVENUE ACCOUNT
 * -------------------------------------------------------------------------
 * This is the mapping the importer did not have, and its absence was the
 * single most expensive thing about it: `pickAccount(['income'])` returned the
 * lowest-coded income account and EVERY line went there, so a year of hotel
 * bookings, flight tickets, visa fees and tour packages all landed in Package
 * Revenue. The trial balance was right, the P&L was one line, and the question
 * an agency actually asks its books — which part of what we sell makes money —
 * had no answer in them.
 *
 * The left-hand side is TripzoCRM's own `ITEM_TYPES` (src/lib/invoices.ts
 * there, and `CRM_ITEM_TYPES` in this app's `crm/invoices.ts`), in its order.
 * The right-hand side is this ledger's chart, from `provision.ts`. Both are
 * closed lists, so a line arriving with an `item_type` in neither is reported
 * rather than guessed at.
 *
 *   package    → 400000 Package Revenue     the agency's own tour product
 *   hotel      → 401000 Hotel Revenue       accommodation resold
 *   flight     → 402000 Flight Revenue      air ticketing
 *   transport  → 404000 Transport Revenue   transfers, car hire
 *   activity   → 405000 Sightseeing Revenue excursions, entry tickets
 *   other      → 406000 Service Fees        the catch-all, and a FEE account
 *                                           rather than "other income": a
 *                                           charge raised on an invoice is
 *                                           revenue from operations, and
 *                                           parking it in other income keeps
 *                                           it out of the turnover every
 *                                           margin is measured against.
 *
 * TWO LISTS, BECAUSE TRIPZOCRM HAS TWO. Its web invoice form offers
 * service / package / extra; its mobile app offers the six above and calls them
 * "the line kinds the web form offers", which is no longer true. Both reach
 * this ledger through the same `item_type` string, so both are mapped here
 * rather than one of them being treated as a typo:
 *
 *   service    → 406000 Service Fees        a charge for the agency's own work
 *   extra      → 406000 Service Fees        an add-on sold beside the package.
 *                                           NOT guessable beyond this: the two
 *                                           real ones on INV-000015 were a
 *                                           houseboat upgrade (accommodation)
 *                                           and an airport transfer (ground
 *                                           transport), and nothing in the word
 *                                           "extra" says which. The fee account
 *                                           is the honest answer and the line is
 *                                           one click from the right one on the
 *                                           draft.
 */
export const REVENUE_ACCOUNT_OF_ITEM: Record<string, string> = {
  package: '400000',
  hotel: '401000',
  flight: '402000',
  transport: '404000',
  activity: '405000',
  other: '406000',
  // TripzoCRM's web invoice form. See the note above.
  service: '406000',
  extra: '406000',
};

/**
 * The SAC a line falls back to when the CRM carries none, by what was sold.
 *
 * SECOND IN A CHAIN OF FOUR, not a replacement for any of them. The invoice
 * line's own `hsn_sac` wins, because an agent who typed one meant it; then
 * this, because the kind of thing sold implies its classification; then the
 * revenue account's `default_hsn_code`; then the agency's own. `createDocument`
 * already walks the last two (see the HSN resolution in `documents.ts`), so
 * what this adds is the middle rung — and it matters because the CRM's own
 * invoice form leaves `hsn_sac` blank on most lines.
 */
export const SAC_OF_ITEM: Record<string, string> = {
  package: '998555',   // tour operator services
  hotel: '996311',     // accommodation
  flight: '998551',    // air transport / ticketing
  transport: '996412', // road transport of passengers
  activity: '998555',  // bundled with the tour operator service
  other: '998599',     // other support services
  service: '998599',   // other support services
  extra: '998555',     // sold as part of the tour operator's package
};

// ---------------------------------------------------------------------------
// The accounts and taxes this agency has, resolved once per sync
// ---------------------------------------------------------------------------

/**
 * Everything the mapping needs out of ONE agency's configuration.
 *
 * Loaded once per sync rather than per invoice: a sync walks hundreds of
 * invoices and this is the same answer every time. SCOPED TO `orgId` on every
 * query, like everything else in this product — an importer that resolved a
 * revenue account from the wrong agency's chart would post one agency's
 * revenue into another's books, which is the failure this whole release exists
 * to make impossible.
 */
export interface MappingContext {
  orgId: string;
  /** Chart code → account id, for the codes this mapping names. */
  accountOfCode: Map<string, string>;
  /** The account a line falls back to when its code is missing from the chart. */
  fallbackRevenue: string | null;
  /** The agency's own GST state, which decides CGST+SGST against IGST. */
  sellerStateCode: string | null;
  /** Active sale taxes that can carry a rate, by rate in basis points. */
  saleTaxOfRate: Map<number, { intra: string | null; inter: string | null }>;
}

export async function loadMappingContext(orgId: string): Promise<MappingContext> {
  const codes = [
    ...new Set([...Object.values(REVENUE_ACCOUNT_OF_ITEM), '406000', '409000']),
  ];
  const accounts = await all<{ id: string; code: string }>(
    `SELECT id, code FROM accounts
      WHERE org_id = ? AND active = 1 AND code IN (${codes.map(() => '?').join(',')})`,
    orgId, ...codes,
  );
  const accountOfCode = new Map(accounts.map((a) => [a.code, a.id]));

  /*
   * THE FALLBACK IS AN ACCOUNT, NOT A THROW.
   *
   * An agency that has renumbered its chart — which it is entitled to do, the
   * chart is configuration — may have no `400000`. Refusing to import its
   * invoices over that would mean its books had no revenue in them at all,
   * which is a far worse answer than "all of it went to one income account and
   * the report said so". So a line that cannot be classified lands on the
   * lowest-coded income account and raises a warning naming the item type, and
   * the agency fixes it by adding the code or by editing the drafted document
   * before posting it.
   */
  const fallbackRevenue = (await one<{ id: string }>(
    `SELECT id FROM accounts
      WHERE org_id = ? AND active = 1 AND kind IN ('income','income_other')
      ORDER BY code LIMIT 1`,
    orgId,
  ))?.id ?? null;

  const org = await getOrganisation(orgId);

  /*
   * ONE ENTRY PER RATE, HOLDING BOTH WAYS OF CHARGING IT.
   *
   * 18% is one rate and two tax rows: the CGST+SGST parent for a supply within
   * the agency's own state, and the IGST row for one outside it. Which applies
   * is not a property of the rate — it is a property of WHERE the customer is,
   * decided per invoice in `resolveSaleTax`. Indexing by rate and keeping both
   * is what lets that decision be made there rather than here.
   *
   * CHILDREN ARE EXCLUDED. A CGST 9% row is half of a tax, never a tax, and
   * attaching one to a line would charge the customer half the GST due.
   */
  const taxRows = await all<{ id: string; rate_bps: number; tax_group: string }>(
    `SELECT id, rate_bps, tax_group FROM taxes
      WHERE org_id = ? AND active = 1 AND computation = 'percent'
        AND scope IN ('sale','none') AND tax_group <> 'tds'
        AND NOT EXISTS (SELECT 1 FROM tax_children c WHERE c.child_id = taxes.id)
      ORDER BY rate_bps`,
    orgId,
  );
  const saleTaxOfRate = new Map<number, { intra: string | null; inter: string | null }>();
  for (const t of taxRows) {
    const slot = saleTaxOfRate.get(t.rate_bps) ?? { intra: null, inter: null };
    if (t.tax_group === 'igst') slot.inter ??= t.id;
    else slot.intra ??= t.id;
    saleTaxOfRate.set(t.rate_bps, slot);
  }

  return {
    orgId,
    accountOfCode,
    fallbackRevenue,
    sellerStateCode: org?.state_code ?? null,
    saleTaxOfRate,
  };
}

// ---------------------------------------------------------------------------
// The GST rate a CRM invoice was raised at
// ---------------------------------------------------------------------------

/**
 * How far a derived rate may sit from a configured one and still be it.
 *
 * 10 basis points — a tenth of a percent. The CRM stores `tax_amount` rounded
 * to whole rupees, so an 18% invoice of ₹47,163 taxable comes back as ₹8,489
 * and divides out at 17.998%, not 18%. A tolerance is therefore necessary; a
 * LOOSE one would be dangerous, because the real rates an agency uses are 5%,
 * 12% and 18% and the gaps between them are hundreds of basis points. Anything
 * that does not land within a tenth of a percent of a configured rate is not a
 * rounding artefact, it is a rate this ledger does not have — and it is
 * reported rather than snapped to the nearest thing.
 */
const RATE_TOLERANCE_BPS = 10;

export interface DerivedTax {
  /** Null when the invoice carried no tax at all, which is legitimate. */
  taxId: string | null;
  rateBps: number;
  /** Set when the figures could not be reconciled. `sync.ts` reports it. */
  warning: string | null;
}

/**
 * Which of the agency's tax rows this invoice was raised under.
 *
 * ===========================================================================
 * THE CRM HOLDS AN AMOUNT; THE LEDGER NEEDS A RATE. THIS IS THE DIVISION.
 * ===========================================================================
 * An invoice in TripzoCRM carries `tax_amount` — one figure, for the whole
 * invoice, in whole rupees. A ledger line carries a TAX ID, from which the
 * engine computes the amount and splits it across the component accounts the
 * return is filed from. Going from the first to the second means recovering the
 * rate that produced the amount, and then finding the agency's row for it.
 *
 * `tax_amount / taxable` is that rate. It is derived rather than assumed,
 * because an agency legitimately raises 5% invoices (a tour operator that has
 * NOT taken input credit) and 18% ones (one that has), sometimes in the same
 * month, and defaulting to either would mis-state the other.
 *
 * ---------------------------------------------------------------------------
 * AND THEN: CGST+SGST OR IGST, WHICH IS NOT A PROPERTY OF THE RATE
 * ---------------------------------------------------------------------------
 * The same 18% is charged two ways. A supply to a customer in the agency's own
 * state is intra-state and splits into CGST 9% and SGST 9%, which are two
 * liabilities to two governments. A supply to any other state, or abroad, is
 * inter-state and is one IGST line. Getting this wrong does not change what the
 * customer pays by a single rupee, and it makes the agency's GSTR-1 wrong in
 * every row — tax paid to the wrong government, which is corrected by paying
 * again and claiming a refund.
 *
 * So the comparison is made here, from the invoice's place of supply against
 * the agency's own state code, and NOT from the rate. Where the place of supply
 * is unknown the supply is treated as INTRA-state, because that is the
 * commoner case for a domestic agency and because the alternative — guessing
 * inter-state — splits a liability that should not be split. Either way the
 * document carries the place of supply it was decided from, so an accountant
 * reviewing the draft can see the basis.
 */
export function resolveSaleTax(
  ctx: MappingContext,
  opts: { taxable: number; taxAmount: number; placeOfSupply: string | null; invoiceNumber: string },
): DerivedTax {
  const { taxable, taxAmount } = opts;

  // No tax is an ordinary, legitimate state: an exempt supply, a zero-rated
  // export, an agency not registered under GST. It is not a mapping failure
  // and must not produce a warning.
  if (taxAmount <= 0) return { taxId: null, rateBps: 0, warning: null };

  if (taxable <= 0) {
    return {
      taxId: null,
      rateBps: 0,
      warning:
        `Invoice ${opts.invoiceNumber} carries ${(taxAmount / 100).toFixed(2)} of tax on a taxable `
        + 'value of zero, so no slab can be derived. The figure is recorded on the draft and is '
        + 'posted to no tax account — add the line it belongs to before posting.',
    };
  }

  const derived = Math.round((taxAmount * 10000) / taxable);
  let bestRate = -1;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const rate of ctx.saleTaxOfRate.keys()) {
    const gap = Math.abs(rate - derived);
    if (gap < bestGap) { bestGap = gap; bestRate = rate; }
  }

  if (bestRate < 0 || bestGap > RATE_TOLERANCE_BPS) {
    return {
      taxId: null,
      rateBps: 0,
      warning:
        `Invoice ${opts.invoiceNumber} works out at ${(derived / 100).toFixed(2)}% GST `
        + `(${(taxAmount / 100).toFixed(2)} on ${(taxable / 100).toFixed(2)}), which matches no slab `
        + 'this agency has configured. The draft carries the CRM’s lines and its tax figure '
        + 'unchanged; choose the GST slab on the lines before posting, which decides which tax '
        + 'accounts that figure is split across and changes no amount on the invoice.',
    };
  }

  /*
   * INTER-STATE WHEN BOTH STATES ARE KNOWN AND THEY DIFFER. Not "when they
   * differ": an unknown place of supply is not a different state, and treating
   * it as one would turn every invoice whose customer has no state on record
   * into an IGST supply.
   */
  const interState = Boolean(
    ctx.sellerStateCode && opts.placeOfSupply && opts.placeOfSupply !== ctx.sellerStateCode,
  );
  const slot = ctx.saleTaxOfRate.get(bestRate)!;
  const taxId = interState ? (slot.inter ?? slot.intra) : (slot.intra ?? slot.inter);

  if (!taxId) {
    return {
      taxId: null, rateBps: bestRate,
      warning:
        `Invoice ${opts.invoiceNumber} is a ${interState ? 'inter' : 'intra'}-state supply at `
        + `${bestRate / 100}%, and this agency has no ${interState ? 'IGST' : 'CGST+SGST'} row at `
        + 'that rate. The drafted document carries no tax.',
    };
  }

  // The agency has the rate but only one of the two ways of charging it. The
  // document still gets a tax — better a posted liability in the wrong column
  // than an unposted one — but the report says so, by name.
  const wanted = interState ? slot.inter : slot.intra;
  const warning = wanted ? null
    : `Invoice ${opts.invoiceNumber} is a ${interState ? 'inter' : 'intra'}-state supply, but only `
      + `the ${interState ? 'CGST+SGST' : 'IGST'} row exists at ${bestRate / 100}%, so that is what `
      + 'the draft carries. Check the split before posting — it decides which government is paid.';

  return { taxId, rateBps: bestRate, warning };
}

// ---------------------------------------------------------------------------
// The lines
// ---------------------------------------------------------------------------

export interface CrmItemLike {
  id?: string;
  title: string;
  description: string | null;
  qty: number | string | null;
  rate: number | string | null;
  amount?: number | string | null;
  item_type: string;
  hsn_sac?: string | null;
}

export interface MappedLines {
  lines: DocLineInput[];
  warnings: string[];
}

/**
 * CRM invoice items → ledger document lines.
 *
 * ---------------------------------------------------------------------------
 * NO DISCOUNT IS SPREAD ACROSS THE LINES ANY MORE, AND THAT IS THE FIX
 * ---------------------------------------------------------------------------
 * The CRM holds ONE `discount_amount` for the invoice, and this used to turn it
 * into a per-line percentage — a ₹1,500 discount on a ₹44,998 invoice became
 * 3.33% off every line. The reasoning was that tax is computed per line and a
 * discount changes the taxable value. The result was an invoice that read
 * ₹43,499.57 in the books against ₹44,998 on the customer's copy: three
 * rounded percentages of three different line values do not add back to the
 * amount they came from, and nothing else in the product could tell the
 * accountant which of the two figures was the sale.
 *
 * So the lines now carry EXACTLY what the CRM's lines carry, and the invoice's
 * own discount is recorded on the document as `statedDiscount` — stated,
 * because the prices already account for it. One number, one place, and the
 * ledger's total is the sum of the line amounts the customer was sent.
 *
 * `qty` AND `rate` ARE USED, NOT `amount`. The CRM stores all three and the
 * ledger recomputes the third from the first two, so sending the stored
 * `amount` would be sending a figure this app then ignores. Where the three
 * disagree in the CRM — a rounded `amount` against a fractional qty — the
 * recomputation is reported against the invoice total at the end of the import
 * rather than papered over here.
 */
export function mapInvoiceLines(
  ctx: MappingContext,
  items: CrmItemLike[],
  opts: { taxId: string | null; invoiceNumber: string },
): MappedLines {
  const warnings: string[] = [];
  const unmapped = new Set<string>();

  const lines = items.map((it): DocLineInput => {
    const kind = (it.item_type ?? '').trim().toLowerCase();
    const code = REVENUE_ACCOUNT_OF_ITEM[kind];
    const accountId = (code ? ctx.accountOfCode.get(code) : null) ?? ctx.fallbackRevenue;
    if (!code || !ctx.accountOfCode.get(code)) unmapped.add(kind || '(blank)');

    return {
      // The CRM's title and description are two fields and a ledger line has
      // one name. Joined rather than truncated, because the description is
      // often the half that identifies the departure ("Bali 5D/4N — 12 Mar,
      // 2 pax") and the title alone reads the same on every line.
      name: [it.title, it.description].filter(Boolean).join(' — ') || `Invoice ${opts.invoiceNumber}`,
      qtyMilli: Math.round(Number(it.qty ?? 1) * 1000) || 1000,
      unitPrice: toMinor(it.rate),
      // Nothing is taken off a line that the CRM did not take off it. The
      // invoice's own discount lives on the document, as the one figure it is.
      discountBps: 0,
      taxId: opts.taxId,
      accountId: accountId ?? '',
      hsnCode: (it.hsn_sac ?? '').trim() || SAC_OF_ITEM[kind] || null,
      // KEPT AS THE CRM SPELT IT, lower-cased and nothing else. It is what the
      // agent chose on the invoice, it is the column the edit screen shows back
      // to them, and a ledger that normalised it into its own vocabulary would
      // be answering a question about TripzoCRM with a word TripzoCRM does not
      // use.
      itemType: kind || null,
    };
  });

  if (unmapped.size) {
    warnings.push(
      `Invoice ${opts.invoiceNumber}: item type ${[...unmapped].map((k) => `"${k}"`).join(', ')} `
      + 'has no revenue account in this chart, so those lines went to the first income account. '
      + 'Add the account code, or move the lines on the draft before posting.',
    );
  }

  return { lines: lines.filter((l) => l.accountId), warnings };
}

/** Whole-currency decimal → minor units, tolerating nulls and junk. */
function toMinor(v: number | string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * Does the ledger's copy add up to what the CRM said?
 *
 * ===========================================================================
 * THE SINGLE MOST USEFUL THING IN THIS FILE
 * ===========================================================================
 * Everything above is a judgement about where a figure belongs, and any of
 * them can be wrong — a rate that did not divide out, a line whose qty and
 * amount disagree in the CRM, a discount that was an amount rather than a
 * percentage. A wrong judgement produces a document that POSTS CLEANLY and
 * states a different total from the invoice the customer was actually sent.
 * Debits equal credits, the balance sheet balances, every guarantee the engine
 * offers holds, and the books are wrong.
 *
 * Nothing in the posting machinery can catch that, because the machinery has
 * no idea what the CRM said. This comparison is the only place the two numbers
 * meet, so it is made explicitly, on every imported invoice, and a discrepancy
 * is reported with BOTH FIGURES IN THE MESSAGE — not "a rounding difference",
 * which tells an accountant nothing they can act on.
 *
 * ONE RUPEE OF TOLERANCE, and it is not arbitrary: the CRM stores its totals
 * rounded to whole rupees while the ledger works in paise, so a legitimate
 * import can differ by up to half a rupee per rounded figure. Anything beyond
 * that is a mapping difference, not a representation one.
 *
 * WHICH CRM FIGURE IT IS CHECKED AGAINST changed with the mapping. The ledger
 * document is now worth the SUM OF THE CRM'S LINE AMOUNTS — its discount is
 * recorded rather than deducted and its tax is carved out of that sum rather
 * than added to it — so the figure it must equal is the CRM's subtotal, and
 * `sync.ts` passes that. Comparing against the CRM's grand total would report a
 * difference on every single invoice that carries a discount or a tax.
 */
export function reconcileTotal(
  opts: { invoiceNumber: string; crmTotal: number; ledgerTotal: number },
): string | null {
  const diff = opts.ledgerTotal - opts.crmTotal;
  if (Math.abs(diff) <= 100) return null;
  return (
    `Invoice ${opts.invoiceNumber} imported as ${(opts.ledgerTotal / 100).toFixed(2)} but its `
    + `TripzoCRM lines come to ${(opts.crmTotal / 100).toFixed(2)} — a difference of `
    + `${(diff / 100).toFixed(2)}. `
    + 'The document is a DRAFT and has not been posted. Compare its lines against the invoice in '
    + 'the CRM before posting it, because the ledger would otherwise state a figure the customer '
    + 'was never sent.'
  );
}
