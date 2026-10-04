import 'server-only';
import { all } from './db';
import { listAccounts, listJournals, listPartners, listPaymentTerms, listProducts } from './accounting/masters';
import { listTaxes, listWithholdingTaxes } from './accounting/tax';
import { listAnalyticAccounts, listBookings } from './accounting/analytics';
import { livePackages, packagePrice } from './crm/live';
import { mirroredPackages } from './crm/mirror';
import { packageTaxMap, saleTaxOptions, defaultTaxOf, splitInclusive } from './crm/packageTax';
import { GST_STATES, getOrganisation } from './accounting/organisation';
import type { DocFormProps } from '@/components/DocumentForm';
import { isDocumentLineKind, type DocType } from '@/lib/accounting';

/**
 * The dropdown contents every form needs, assembled in one place.
 *
 * A form is only as good as what it offers: a vendor-bill screen that lists
 * revenue accounts invites a posting nobody notices for a month. The account
 * and tax lists are therefore filtered BY WHAT THE DOCUMENT IS, here, rather
 * than left to each page to remember.
 */
export async function documentFormOptions(orgId: string, docType: DocType, canPost: boolean): Promise<DocFormProps> {
  const isBill = docType.startsWith('in_');

  /*
   * PRIMARY kinds first, and that ordering is the point rather than a nicety.
   * The list is sorted by account code, so offering assets alongside expenses
   * on a bill puts "120000 Customer Advances" at the top — which is what the
   * first line silently defaults to. The accounts a travel agency actually
   * bills to lead; the rest are still reachable, just not the default.
   */
  const primaryKinds = isBill ? ['expense_direct', 'expense_operating'] : ['income', 'income_other'];
  const secondaryKinds = isBill
    ? ['asset_current', 'asset_fixed', 'asset_prepaid']
    : ['liability_current'];
  // The two lists together are `DOCUMENT_LINE_KINDS`, which the Chart of
  // Accounts reads to decide which rows get a default-HSN box. Asserted rather
  // than derived, because the ORDER here is the point — see the comment above —
  // and a kind added to one place and not the other is an account the form
  // offers with no way to classify it, or a box that can never be used.
  if (process.env.NODE_ENV !== 'production') {
    const offered = new Set([...primaryKinds, ...secondaryKinds]);
    for (const k of offered) {
      if (!isDocumentLineKind(k)) {
        throw new Error(`Account kind "${k}" is offered on a document line but missing from DOCUMENT_LINE_KINDS.`);
      }
    }
  }

  return {
    docType,
    canPost,
    // `hint` carries the partner's GSTIN, so typing a name that already exists
    // fills the registration beside it instead of asking for fifteen characters
    // the system is already holding. Same idiom as the bookings list below.
    partners: (await listPartners(orgId, { side: isBill ? 'supplier' : 'customer' }))
      .map((p) => ({ id: p.id, label: p.name, hint: p.gstin ?? '' })),
    journals: (await listJournals(orgId, isBill ? 'purchase' : 'sale'))
      .map((j) => ({ id: j.id, label: `${j.code} — ${j.name}` })),
    // `hint` is the account's default HSN/SAC — the middle step of the chain the
    // form applies to a blank HSN cell (line → account → agency). Carried with
    // the option so changing the account fills the code with no round trip.
    accounts: [...await listAccounts(orgId, { kinds: primaryKinds }), ...await listAccounts(orgId, { kinds: secondaryKinds })]
      .map((a) => ({ id: a.id, label: `${a.code} ${a.name}`, hint: a.default_hsn_code ?? '' })),
    taxes: (await listTaxes(orgId, isBill ? 'purchase' : 'sale'))
      .map((t) => ({ id: t.id, label: t.name, rateBps: t.rate_bps, priceIncluded: !!t.price_included })),
    withholdingTaxes: (await listWithholdingTaxes(orgId))
      .map((t) => ({ id: t.id, label: t.name, rateBps: t.rate_bps, priceIncluded: false })),
    analytics: (await listAnalyticAccounts(orgId))
      .map((a) => ({ id: a.id, label: `${a.plan_name}: ${a.name}` })),
    // `hint` carries the booking's analytic account, so picking a trip on the
    // form tags the lines without a second round trip.
    bookings: (await listBookings(orgId, { limit: 100 }))
      .map((b) => ({ id: b.id, label: `${b.ref} — ${b.title}`, hint: b.analytic_id ?? '' })),
    paymentTerms: (await listPaymentTerms(orgId)).map((t) => ({ id: t.id, label: t.name })),
    products: await lineCatalogue(orgId, isBill),
    /*
     * THE LEDGER'S FORM IS MINOR UNITS, AND THE CATALOGUE IS NOT.
     *
     * `packageOptions` answers in the CRM's own unit — whole rupees — because
     * that is what the CRM stores and converting at the source would mean
     * converting twice for the screens that show the catalogue as the CRM
     * prices it. This form is the book of account and every money field in it
     * is paise, so the conversion happens here, once, at the one edge that
     * needs it. (It did not, and a ₹45,000 package filled the price box with
     * ₹450.)
     *
     * AND THE PRICE IS THE TAXABLE VALUE. A package is quoted inclusive of GST;
     * a document line's `unit_price` is what the tax is then computed ON.
     * Backing the tax out here makes subtotal + tax come back to the figure in
     * the catalogue instead of billing it a second time.
     */
    packages: isBill ? [] : (await packageOptions(orgId)).map((p) => ({
      id: p.id,
      name: p.name,
      price: splitInclusive(Math.round(p.price * 100), p.taxRateBps).net,
      code: p.code,
      duration: p.duration,
      currency: p.currency,
      taxId: p.taxId,
      taxName: p.taxName,
      taxRateBps: p.taxRateBps,
      /** The inclusive figure, for the dropdown label the agent recognises. */
      grossPrice: Math.round(p.price * 100),
    })),
    // The closed list of GST state codes, from the one place that holds it.
    states: GST_STATES,
    // The last step of the HSN chain: the agency's own principal service code,
    // for a line on an account nobody has classified yet.
    defaultHsn: (await getOrganisation(orgId))?.default_hsn_code ?? '',
  };
}

/**
 * WHAT AN INVOICE LINE CAN BE SOLD FROM: the local product list, and the
 * agency's live TripzoCRM package catalogue.
 *
 * -------------------------------------------------------------------------
 * WHY THE PACKAGES ARE FETCHED RATHER THAN SYNCED
 * -------------------------------------------------------------------------
 * A package is not a ledger fact. It is what the CRM says the agency is selling
 * TODAY, and the figure that matters on an invoice is the one the agent quoted
 * this morning — not the one that was true at the last import. Syncing the
 * catalogue into a local table would mean a package re-priced on Monday went on
 * Tuesday's invoice at Friday's price, and nobody would see it happen.
 *
 * The same reasoning does NOT apply to what the line ends up carrying. Once the
 * package is chosen, its name, price, HSN and tax are COPIED onto the document
 * line exactly as a local product's are, and the invoice is answerable for
 * those figures from then on. The CRM is consulted to fill the form; it is
 * never consulted to decide what an issued invoice said.
 *
 * ON A VENDOR BILL THERE ARE NO PACKAGES. A package is what the agency sells,
 * and offering the catalogue when recording what a hotel charged would put
 * revenue descriptions on a cost line.
 *
 * NEVER FATAL. `livePackages` returns its error rather than throwing, so a CRM
 * that is down or a visitor who is not signed in leaves the local products
 * exactly as they were — raising an invoice by hand has to keep working when
 * the CRM does not.
 */
async function lineCatalogue(orgId: string, isBill: boolean) {
  const local = (await listProducts(orgId)).map((p) => ({
    id: p.id, name: p.name, price: p.sale_price,
    accountId: p.income_account_id, taxId: p.sale_tax_id,
    // Carried so choosing a product fills the HSN and the MRP along with the
    // price. The HSN is mandatory on the invoice and nobody remembers it per
    // line; a product that knows its own is the only way the column gets
    // filled in practice rather than in principle.
    hsnCode: p.hsn_code, mrp: p.mrp,
  }));
  if (isBill) return local;

  const packages = await packageOptions(orgId);
  /*
   * The CRM's entries go in the SAME list the datalist already reads, so typing
   * a package name completes it and fills the price exactly as typing a product
   * name does. A second mechanism for "the other kind of thing you can sell"
   * would be a second set of rules about which one wins.
   *
   * LOCAL PRODUCTS WIN A NAME CLASH. A product is the agency's own decision
   * about which revenue account and which tax a line belongs to; a package
   * carries neither, so letting it displace a product of the same name would
   * silently un-classify the line.
   */
  const taken = new Set(local.map((p) => p.name.trim().toLowerCase()));
  return [
    ...local,
    ...packages
      .filter((p) => !taken.has(p.name.trim().toLowerCase()))
      .map((p) => ({
        id: `crm:${p.id}`,
        name: p.name,
        // THE CONVERSION HAPPENS HERE, not at the source: `DocumentForm` is the
        // ledger's form and every money field in it is minor units. The CRM
        // prices in whole rupees, so a package crosses the boundary exactly
        // once, on its way into this one form.
        //
        // AND IT IS THE NET, not the catalogue figure. A package price is
        // quoted INCLUSIVE of GST — one number the traveller is told and pays —
        // while a document line's `unit_price` is the taxable value the tax is
        // then computed ON. Putting ₹47,200 in the price box beside an 18% tax
        // would raise an invoice for ₹55,696 nobody quoted. Backing the tax out
        // first makes subtotal + tax come back to exactly the price in the
        // catalogue, which is the figure the customer agreed.
        price: splitInclusive(Math.round(p.price * 100), p.taxRateBps).net,
        // THE TAX IS NOT GUESSED FROM THE PACKAGE — it is the rate the agency
        // itself put that package on, under Packages → GST. The ACCOUNT still
        // is not: nothing in a package name says where the money belongs in the
        // books, so the line keeps whatever the account column already implies.
        accountId: null,
        taxId: p.taxId,
        hsnCode: null,
        mrp: 0,
      })),
  ];
}

/**
 * The live catalogue, each entry carrying the GST RATE THE AGENCY SELLS IT AT.
 *
 * TWO SOURCES, JOINED HERE AND NOWHERE ELSE. The package — its name, its code,
 * its price — is live from TripzoCRM and belongs to the CRM. The rate is a row
 * in this ledger's own `crm_package_tax`, because a tax rate is the agency's
 * classification of its own supply and is answered for under the agency's own
 * registration. `crm_package_id` is the join, and this function is the only
 * place the two meet.
 *
 * THE PRICE IS INCLUSIVE OF THAT RATE. A traveller is quoted one figure and
 * pays it; the tax is inside it. Every consumer of this list — the invoice
 * form's dropdown, the Packages screen — backs the tax out with
 * `splitInclusive` rather than adding it on top.
 *
 * A package nobody has classified falls to the agency's own 18% row rather than
 * to no tax at all: an untaxed package line would quietly raise an invoice
 * charging no GST on a supply that owes it, which is the one default worth
 * avoiding.
 *
 * -------------------------------------------------------------------------
 * LIVE FIRST, THE SNAPSHOT SECOND, AND NEVER BOTH
 * -------------------------------------------------------------------------
 * The CRM is asked first because a package re-priced this morning has to be the
 * price that reaches this afternoon's invoice. When it does not answer — a cold
 * start, an expired token, a deploy in progress — the dropdown falls back to
 * `crm_packages`, the snapshot this app took on its last fetch.
 *
 * THE FALLBACK IS ONLY FOR AN EMPTY LIVE READ, not a merge of the two. Merging
 * would mean a package deliberately hidden or deleted in the CRM reappearing
 * from the snapshot for ever, on a form that raises statutory documents. An
 * empty answer from a reachable CRM is also legitimately empty — an agency with
 * no packages — and falling back then costs nothing, because the snapshot of a
 * catalogue that has never had anything in it is empty too.
 */
async function packageOptions(orgId: string) {
  const [live, snapshot, mapped, taxes] = await Promise.all([
    livePackages(), mirroredPackages(orgId), packageTaxMap(orgId), saleTaxOptions(orgId),
  ]);
  const fallback = defaultTaxOf(taxes);
  const byId = new Map(taxes.map((t) => [t.id, t]));

  /** One shape out of two sources, so the mapping below is written once. */
  const catalogue: Array<{
    id: string; name: string; price: number; code: string | null;
    days: number; nights: number; currency: string; visible: boolean;
  }> = live.rows.length
    ? live.rows.map((p) => ({
      id: p.id,
      name: p.package_name,
      /** Whole rupees, exactly as the CRM prices it — INCLUSIVE of the tax. */
      price: packagePrice(p),
      code: p.package_code ?? p.package_number ?? null,
      days: Number(p.days ?? 0) || 0,
      nights: Number(p.nights ?? 0) || 0,
      currency: p.currency ?? 'INR',
      visible: p.is_visible !== false,
    }))
    : snapshot.map((p) => ({
      id: p.crm_id,
      name: p.package_name ?? 'Unnamed package',
      // The snapshot stores paise, like every other money column in this
      // database. This list is in the CRM's whole rupees, so it converts back
      // here — once, at the one place the two meet.
      price: p.price / 100,
      code: p.package_code ?? p.package_number ?? null,
      days: p.days,
      nights: p.nights,
      currency: p.currency,
      visible: p.is_visible !== 0,
    }));

  return catalogue
    .filter((p) => p.visible)
    .map((p) => {
      const tax = byId.get(mapped.get(p.id) ?? '') ?? fallback;
      return {
        id: p.id,
        name: p.name,
        /** Whole rupees, exactly as the CRM prices it — INCLUSIVE of the tax below. */
        price: p.price,
        code: p.code,
        duration: p.days ? `${p.days}D / ${p.nights || Math.max(p.days - 1, 0)}N` : '',
        currency: p.currency,
        taxId: tax?.id ?? null,
        taxName: tax?.name ?? null,
        taxRateBps: tax?.rateBps ?? 0,
        /** True when a rate was chosen for this package rather than defaulted. */
        taxChosen: mapped.has(p.id),
      };
    });
}

/**
 * The accounts a money form offers, DEFAULT FIRST.
 *
 * `journal_id` comes back with each one because the journal is not the form's
 * to choose: a receipt into petty cash belongs in the cash journal, and the
 * form that sent one fixed journal for every account put cash receipts in the
 * bank book under a bank entry number. The account decides; the form passes
 * the account; the action looks the journal up. See `journalOfBankAccount`.
 */
export async function bankAccountOptions(orgId: string) {
  return await all<{
    id: string; name: string; journal_id: string | null; is_cash: number;
    is_default: number; currency: string; bank_name: string | null; account_no: string | null;
  }>(
    `SELECT id, name, journal_id, is_cash, is_default, currency, bank_name, account_no
       FROM bank_accounts WHERE org_id=? AND active=1
      ORDER BY is_default DESC, is_cash, name`, orgId,
  );
}

/**
 * The journal a bank account posts through, resolved on the server.
 *
 * Falls back to the org's default bank/cash journal only when an account has
 * none — which `upsertBankAccount` makes impossible for anything created since
 * this screen existed, and which the seeded accounts all satisfy. The fallback
 * is there so a hand-inserted row degrades to a posting in the right kind of
 * book rather than to an exception at the moment someone receives money.
 */
export async function journalOfBankAccount(orgId: string, bankAccountId: string | null): Promise<string | null> {
  if (!bankAccountId) return null;
  const rows = await all<{ journal_id: string | null; is_cash: number }>(
    'SELECT journal_id, is_cash FROM bank_accounts WHERE id=? AND org_id=?', bankAccountId, orgId,
  );
  const row = rows[0];
  if (!row) return null;
  if (row.journal_id) return row.journal_id;
  const fallback = await all<{ id: string }>(
    `SELECT id FROM journals WHERE org_id=? AND active=1 AND type=? ORDER BY code LIMIT 1`,
    orgId, row.is_cash ? 'cash' : 'bank',
  );
  return fallback[0]?.id ?? null;
}

export async function journalOptions(orgId: string, types?: string[]) {
  const rows = await listJournals(orgId);
  return (types ? rows.filter((j) => types.includes(j.type)) : rows)
    .map((j) => ({ id: j.id, label: `${j.code} — ${j.name}`, type: j.type }));
}

export async function accountOptions(orgId: string, kinds?: string[]) {
  return (await listAccounts(orgId, { kinds })).map((a) => ({ id: a.id, label: `${a.code} ${a.name}`, kind: a.kind }));
}

export async function analyticOptions(orgId: string, planCode?: string) {
  return (await listAnalyticAccounts(orgId, planCode))
    .map((a) => ({ id: a.id, label: `${a.plan_name}: ${a.name}` }));
}

export async function bookingOptions(orgId: string) {
  return (await listBookings(orgId, { limit: 200 }))
    .map((b) => ({ id: b.id, label: `${b.ref} — ${b.title}`, analyticId: b.analytic_id }));
}

export async function partnerOptions(orgId: string, side?: 'customer' | 'supplier') {
  return (await listPartners(orgId, { side })).map((p) => ({ id: p.id, label: p.name }));
}
