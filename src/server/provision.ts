import 'server-only';
import { run, one, id, nowIso } from './db';
import { isoDate, fiscalYearOf } from '@/lib/accounting';
import { setSetting } from './accounting/settings';
import { createFiscalYear } from './accounting/periods';
import { upsertAccount, upsertJournal, upsertProduct } from './accounting/masters';

/**
 * ONE AGENCY'S OPENING SET OF BOOKS.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT seed.ts ANY MORE
 * ---------------------------------------------------------------------------
 * There used to be one function that did two unrelated jobs: write the
 * CONFIGURATION a travel agency's ledger cannot start without — a chart of
 * accounts, journals, Indian GST and TDS, the analytic plans, the default
 * account for every posting routine — and then post a season of sample trading
 * on top of it so the reports had something to show.
 *
 * That was fine while the product had exactly one set of books. It stopped
 * being fine the moment a SECOND agency could sign in, because the two halves
 * have opposite audiences:
 *
 *   THE CONFIGURATION is what every agency needs, every time, and it must be
 *   created automatically the first time somebody from that agency opens the
 *   books. Asking an accountant to build a seventy-line chart of accounts
 *   before they can raise their first invoice is not an onboarding step, it is
 *   a reason to stop evaluating the product.
 *
 *   THE SAMPLE TRADING is a demonstration, and it must NEVER reach a real
 *   agency's ledger. Wander Travels' invoices in Himalaya Holidays' trial
 *   balance is not a cosmetic problem: it is a wrong set of books, and every
 *   report, every GST figure and every receivable total is wrong with it.
 *
 * So this module is the first half, callable per organisation, with nothing
 * agency-specific hard-coded in it. `seed.ts` is now only the second half, and
 * it calls this one to stand its demo up.
 *
 * ---------------------------------------------------------------------------
 * EVERY ID IS GENERATED
 * ---------------------------------------------------------------------------
 * The old seed wrote `usr_admin`, `bnk_hdfc`, `pt_imm` and `org_wander` as
 * literals, which is harmless with one tenant and a primary-key collision with
 * two. Ids are generated here and handed back in `ProvisionedBooks`, so a
 * caller that needs to refer to "the bank account" names it through the handle
 * rather than guessing a string.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY LEFT BLANK
 * ---------------------------------------------------------------------------
 * A new agency's GSTIN, PAN and state code are NOT invented. They are the
 * agency's own legal identity, they decide CGST+SGST against IGST on every
 * invoice it raises, and a plausible-looking placeholder is worse than an empty
 * field: an empty field is a prompt in Settings → Organisation, and a wrong
 * GSTIN is a wrong tax invoice that nobody notices until a return is rejected.
 * The same goes for bank account numbers and IFSC codes.
 */

/** A bank or cash account to open the books with. */
export interface BankSpec {
  /** The key this account is addressed by in `ProvisionedBooks.banks`. */
  key: string;
  name: string;
  bankName?: string | null;
  accountNo?: string | null;
  ifsc?: string | null;
  isCash?: boolean;
  /** The journal code money through this account posts to. */
  journalCode: string;
  journalName: string;
  /** The chart code of the control account it maps to. */
  accountCode: string;
}

/** A product the ledger's own document form can pick. */
export interface ProductSpec {
  name: string;
  category: string;
  /** Minor units. Zero means "priced per sale", which most travel services are. */
  salePrice?: number;
  costPrice?: number;
  mrp?: number;
  incomeAccountCode: string;
  expenseAccountCode: string;
  hsnCode: string;
  variant?: string | null;
}

export interface ProvisionInput {
  /** What the books are called. For a real agency this is the CRM's own name. */
  name: string;
  /** The TripzoCRM organisation these books belong to, when there is one. */
  crmOrgId?: string | null;
  /** Forced id, for the demo so a reset reproduces the same books. */
  orgId?: string;
  currency?: string;
  fyStartMonth?: number;
  /** Set on the demo org so no real agency can ever adopt it. See `auth.ts`. */
  demoData?: boolean;
  /**
   * The legal identity, when the caller knows it. A CRM-provisioned agency
   * does not — see the note at the top of this file.
   */
  identity?: {
    legalName?: string | null;
    gstin?: string | null;
    pan?: string | null;
    stateCode?: string | null;
    address?: string | null;
    city?: string | null;
    email?: string | null;
    phone?: string | null;
    website?: string | null;
    invoiceTerms?: string | null;
    invoiceFooter?: string | null;
  };
  /** Overrides the two generic accounts a fresh ledger opens with. */
  banks?: BankSpec[];
  /** Overrides the generic, unpriced service list. */
  products?: ProductSpec[];
  /** Extra analytic members per plan code, beyond the generic departments. */
  analyticMembers?: Record<string, string[]>;
  /** Opening FX rates, for the demo. A real agency enters its own. */
  fxRates?: Array<[string, number]>;
}

/** Everything a caller needs to post into the books this just created. */
export interface ProvisionedBooks {
  orgId: string;
  /** Chart code → account id. */
  accounts: Record<string, string>;
  /** Journal code → journal id. */
  journals: Record<string, string>;
  /** `BankSpec.key` → bank_accounts id. */
  banks: Record<string, string>;
  /** 'imm' | 'd7' | 'd15' | 'd30' | 'd45' → payment_terms id. */
  terms: Record<string, string>;
  /** 'sale_1800', 'purchase_500', 'igst_sale', 'tds_500'… → taxes id. */
  taxes: Record<string, string>;
  /** Analytic plan code → plan id. */
  plans: Record<string, string>;
}

// ---------------------------------------------------------------------------
// The chart of accounts
// ---------------------------------------------------------------------------

/**
 * THE CHART, AND IT IS NOT A SUGGESTION — the posting routines resolve their
 * accounts out of `org_settings`, and every key they can ask for is written at
 * the bottom of this file from a code in this list. Removing a row here
 * without removing the setting that points at it turns a posting into a loud
 * failure at the moment somebody tries to use it.
 *
 * `reconcilable` marks a control account whose balance is made up of individual
 * open items — a receivable is the sum of unpaid invoices, not a number — and
 * is what lets a payment be allocated against a document at all.
 */
const CHART: Array<[code: string, name: string, kind: string, reconcilable?: boolean]> = [
  // --- Assets -------------------------------------------------------------
  ['100000', 'Cash on Hand', 'asset_cash'],
  ['101000', 'Bank — Primary', 'asset_cash'],
  ['101100', 'Bank — Collections', 'asset_cash'],
  ['110000', 'Accounts Receivable', 'asset_receivable', true],
  ['120000', 'Customer Advances (Asset Contra)', 'asset_current', true],
  ['130000', 'Supplier Advances', 'asset_prepaid', true],
  ['135000', 'Employee Advances', 'asset_prepaid', true],
  ['140000', 'Prepaid Expenses', 'asset_prepaid'],
  ['150000', 'Office Equipment', 'asset_fixed'],
  ['151000', 'Furniture & Fixtures', 'asset_fixed'],
  ['155000', 'Accumulated Depreciation', 'asset_fixed'],
  ['160000', 'Security Deposits', 'asset_current'],
  ['170000', 'Input CGST', 'asset_current'],
  ['170100', 'Input SGST', 'asset_current'],
  ['170200', 'Input IGST', 'asset_current'],
  /*
   * TAX ALREADY PAID ON THE AGENCY'S BEHALF, AND IT IS AN ASSET.
   *
   * A marketplace that remits a payout has already collected TCS and withheld
   * TDS out of it. Both are income tax the agency has effectively paid in
   * advance and will set off at assessment — so booking them as expenses (the
   * easy mistake, because they arrive looking like deductions) understates the
   * profit AND loses the set-off, and the agency pays the same tax twice.
   */
  ['171000', 'TCS Receivable', 'asset_current'],
  ['171100', 'TDS Receivable (Income Tax)', 'asset_current'],
  // --- Liabilities --------------------------------------------------------
  ['200000', 'Accounts Payable', 'liability_payable', true],
  ['210000', 'Output CGST', 'liability_tax'],
  ['210100', 'Output SGST', 'liability_tax'],
  ['210200', 'Output IGST', 'liability_tax'],
  ['220000', 'TDS Payable', 'liability_tax'],
  ['230000', 'Customer Refunds Payable', 'liability_current'],
  ['240000', 'Customer Advances', 'liability_current', true],
  ['245000', 'Commission Payable', 'liability_current'],
  ['246000', 'Deferred Revenue', 'liability_current'],
  ['250000', 'Bank Loan', 'liability_noncurrent'],
  // --- Equity -------------------------------------------------------------
  ['300000', 'Owner Capital', 'equity'],
  ['310000', 'Retained Earnings', 'equity_unaffected'],
  // --- Revenue ------------------------------------------------------------
  ['400000', 'Package Revenue', 'income'],
  ['401000', 'Hotel Revenue', 'income'],
  ['402000', 'Flight Revenue', 'income'],
  ['403000', 'Visa Service Revenue', 'income'],
  ['404000', 'Transport Revenue', 'income'],
  ['405000', 'Sightseeing Revenue', 'income'],
  ['406000', 'Service Fees', 'income'],
  ['407000', 'Cancellation Fees', 'income'],
  ['408000', 'Commission Income', 'income'],
  ['409000', 'Other Travel Revenue', 'income_other'],
  ['410000', 'Foreign Exchange Gain', 'income_other'],
  // What a channel pays BACK: a reimbursement for inventory it lost, a credit
  // note reversing its own charge. Not revenue from a traveller, so it is kept
  // out of the trip revenue accounts the margin is read from.
  ['411000', 'Channel Recoveries', 'income_other'],
  // --- Direct trip costs --------------------------------------------------
  ['500000', 'Hotel Cost', 'expense_direct'],
  ['501000', 'Flight Cost', 'expense_direct'],
  ['502000', 'Transport Cost', 'expense_direct'],
  ['503000', 'Visa Cost', 'expense_direct'],
  ['504000', 'Sightseeing Cost', 'expense_direct'],
  ['505000', 'Supplier Charges', 'expense_direct'],
  ['506000', 'Tour Guide Cost', 'expense_direct'],
  ['507000', 'Package Direct Cost', 'expense_direct'],
  // --- Operating expenses -------------------------------------------------
  ['600000', 'Salaries', 'expense_operating'],
  ['601000', 'Rent', 'expense_operating'],
  ['602000', 'Marketing', 'expense_operating'],
  ['603000', 'Software Subscriptions', 'expense_operating'],
  ['604000', 'Internet & Telephone', 'expense_operating'],
  ['605000', 'Office Expenses', 'expense_operating'],
  ['606000', 'Bank Charges', 'expense_operating'],
  ['607000', 'Staff Travel', 'expense_operating'],
  ['608000', 'Professional Fees', 'expense_operating'],
  ['610000', 'Agent Commission', 'expense_operating'],
  ['611000', 'Foreign Exchange Loss', 'expense_operating'],
  /*
   * WHAT A SALES CHANNEL KEEPS, in three accounts rather than one.
   *
   * They are read differently. Commission scales with what was sold and
   * belongs beside the gross margin; shipping and return fees are logistics
   * and scale with order COUNT; storage and advertising are neither — they are
   * what the channel charges whether anything sold or not. One bucket hides
   * exactly the comparison an agency makes when it decides whether a channel
   * is worth selling through.
   */
  ['612000', 'Channel Commission', 'expense_operating'],
  ['612100', 'Channel Shipping & Returns', 'expense_operating'],
  ['612200', 'Channel Charges — Storage, Ads & Other', 'expense_operating'],
  ['609000', 'Depreciation', 'expense_depreciation'],
];

/**
 * THE SAC EACH REVENUE AND COST ACCOUNT IMPLIES.
 *
 * The middle step of the chain that fills an invoice line's HSN — product,
 * then account, then the agency's own default. Separate from `CHART` rather
 * than a fifth column on seventy rows, because only these dozen carry one: an
 * account like Rent or Retained Earnings never appears on a tax invoice line
 * and a code against it would be noise.
 *
 * These are the Chapter 99 service codes a travel agency actually invoices
 * under: 998551 air ticketing, 996311 accommodation, 996412/996423 passenger
 * transport, 998555 tour operator, 998599 other support services. They are
 * DEFAULTS and the agency is answerable for them, which is why each is editable
 * on the account — it is a starting chart, not advice.
 */
const SAC_OF_ACCOUNT: Record<string, string> = {
  '400000': '998555', '401000': '996311', '402000': '998551', '403000': '998599',
  '404000': '996412', '405000': '998555', '406000': '998599', '407000': '998599',
  '408000': '998551', '409000': '998555',
  '500000': '996311', '501000': '998551', '502000': '996412', '503000': '998599',
  '504000': '998555', '505000': '998599', '506000': '998555', '507000': '998555',
};

/**
 * The two accounts a fresh ledger opens with, and why only two.
 *
 * A bank journal with no bank account behind it cannot take a receipt, so the
 * books cannot start with none. Equally, this module does not know the agency's
 * banks: inventing "HDFC — Current" for an agency that banks with Axis is a
 * figure somebody has to notice and correct, and one they might not. So the
 * names are GENERIC and renameable in Settings → Bank Accounts, and the account
 * number and IFSC are left empty rather than filled with something plausible.
 */
const DEFAULT_BANKS: BankSpec[] = [
  {
    key: 'bank', name: 'Bank — Primary', journalCode: 'BNK', journalName: 'Bank',
    accountCode: '101000',
  },
  {
    key: 'cash', name: 'Petty Cash', isCash: true, journalCode: 'CSH', journalName: 'Cash',
    accountCode: '100000',
  },
];

/**
 * The services a travel agency bills for, UNPRICED.
 *
 * Every one carries its SAC, because a GST tax invoice must state an HSN
 * (goods) or SAC (services) per line under CGST Rule 46 — and the product is
 * the FIRST link in the chain that fills that column, ahead of the account's
 * default and the agency's own. Seeding them means an agency's very first
 * invoice is compliant rather than one that looks right until an auditor reads
 * it.
 *
 * PRICES ARE ZERO AND THAT IS THE POINT. What a package costs is TripzoCRM's
 * answer and changes per departure; a price written here would be a second,
 * staler copy of it. The catalogue lives in the CRM (see `crm/live.ts`) and
 * these rows exist so a LEDGER-side document — a manual invoice, a vendor bill
 * — lands on the right revenue and cost account with the right SAC.
 */
const DEFAULT_PRODUCTS: ProductSpec[] = [
  { name: 'Tour Package', category: 'package', incomeAccountCode: '400000', expenseAccountCode: '507000', hsnCode: '998555', variant: 'Priced per departure' },
  { name: 'Hotel Booking', category: 'hotel', incomeAccountCode: '401000', expenseAccountCode: '500000', hsnCode: '996311', variant: 'Per room, per night' },
  { name: 'Flight Ticket', category: 'flight', incomeAccountCode: '402000', expenseAccountCode: '501000', hsnCode: '998551', variant: 'Per sector, per pax' },
  { name: 'Visa Processing', category: 'visa', incomeAccountCode: '403000', expenseAccountCode: '503000', hsnCode: '998599', variant: 'Per applicant' },
  { name: 'Airport Transfer', category: 'transport', incomeAccountCode: '404000', expenseAccountCode: '502000', hsnCode: '996412', variant: 'Per vehicle' },
  { name: 'Sightseeing Tour', category: 'sightseeing', incomeAccountCode: '405000', expenseAccountCode: '504000', hsnCode: '998555', variant: 'Per pax' },
  { name: 'Service Fee', category: 'fee', incomeAccountCode: '406000', expenseAccountCode: '505000', hsnCode: '998599' },
];

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/**
 * Create a complete, usable, EMPTY set of books.
 *
 * Empty of TRADING, not of configuration: there is a chart of accounts, there
 * are journals, GST and TDS are set up, every posting routine can resolve the
 * account it needs, and the current fiscal year is open. What there is not is a
 * single journal entry, because nothing has happened yet.
 *
 * NOT WRAPPED IN A TRANSACTION HERE. The caller wraps it — `seed()` does, and
 * so does `resolveBooks` in auth.ts — because the interesting atomicity is
 * "these books exist and are claimed by this agency, or they do not exist at
 * all", and that boundary belongs to whoever decided to create them.
 */
export async function provisionOrg(input: ProvisionInput): Promise<ProvisionedBooks> {
  const orgId = input.orgId ?? id('org');
  const today = isoDate();
  const currency = input.currency ?? 'INR';
  const fyStartMonth = input.fyStartMonth ?? 4;
  const idn = input.identity ?? {};

  // ----------------------------------------------------------- the agency
  await run(
    `INSERT INTO organizations (id, name, legal_name, currency, country, gstin, pan, state_code,
                                fy_start_month, address, city, email, phone, website,
                                invoice_terms, invoice_footer, default_hsn_code,
                                crm_org_id, demo_data, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    orgId, input.name, idn.legalName ?? null, currency, 'IN',
    idn.gstin ?? null, idn.pan ?? null,
    // The state code is one half of the comparison that decides CGST+SGST
    // against IGST. Derived from the GSTIN when one was given, because the
    // GSTIN's first two digits ARE the state and the two disagreeing is a
    // wrong tax on every invoice.
    idn.stateCode ?? (idn.gstin ? idn.gstin.slice(0, 2) : null),
    fyStartMonth, idn.address ?? null, idn.city ?? null,
    idn.email ?? null, idn.phone ?? null, idn.website ?? null,
    idn.invoiceTerms ?? null, idn.invoiceFooter ?? null,
    // 998555 is "tour operator services", which is what most of a travel
    // agency's book is. The last resort in the HSN chain, so a line that is
    // neither a catalogued product nor on a classified account still reaches
    // the invoice with a code on it rather than with a blank Rule 46 column.
    '998555',
    input.crmOrgId ?? null, input.demoData ? 1 : 0, nowIso(),
  );

  // ------------------------------------------------------------ currencies
  // GLOBAL, not per-agency: the rupee is the rupee. The RATE is per-agency and
  // dated, which is the part that actually differs.
  for (const [code, name, symbol] of [
    ['INR', 'Indian Rupee', '₹'], ['USD', 'US Dollar', '$'],
    ['AED', 'UAE Dirham', 'د.إ'], ['EUR', 'Euro', '€'], ['THB', 'Thai Baht', '฿'],
  ]) {
    await run(
      'INSERT INTO currencies (code, name, symbol, decimals) VALUES (?,?,?,2) ON CONFLICT DO NOTHING',
      code, name, symbol,
    );
  }
  for (const [code, rate] of input.fxRates ?? []) {
    await run(
      'INSERT INTO exchange_rates (org_id, code, on_date, rate_e6) VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
      orgId, code, today, Math.round(rate * 1_000_000),
    );
  }

  // ------------------------------------------------------ chart of accounts
  const accounts: Record<string, string> = {};
  for (const [code, name, kind, reconcilable] of CHART) {
    accounts[code] = await upsertAccount(orgId, {
      code, name, kind, reconcilable, defaultHsnCode: SAC_OF_ACCOUNT[code] ?? null,
    });
  }

  // ---------------------------------------------------------- journals
  const journals: Record<string, string> = {};
  const coreJournals: Array<[string, string, string]> = [
    ['SAL', 'Customer Invoices', 'sale'],
    ['SCN', 'Customer Credit Notes', 'sale'],
    ['PUR', 'Vendor Bills', 'purchase'],
    ['PCN', 'Vendor Credit Notes', 'purchase'],
    ['EXP', 'Employee Expenses', 'general'],
    ['MSC', 'Miscellaneous', 'general'],
  ];
  for (const [code, name, type] of coreJournals) {
    journals[code] = await upsertJournal(orgId, { code, name, type, defaultAccountId: null });
  }

  // ------------------------------------------------- bank and cash accounts
  const bankSpecs = input.banks ?? DEFAULT_BANKS;
  const banks: Record<string, string> = {};
  for (const spec of bankSpecs) {
    const accountId = accounts[spec.accountCode];
    if (!accountId) {
      throw new Error(`Bank account "${spec.name}" maps to chart code ${spec.accountCode}, which is not in the chart.`);
    }
    // A journal PER account, because the journal is what a receipt is posted
    // through and the day book is read by. Two accounts sharing one journal
    // makes "what came into the collections account today" unanswerable.
    journals[spec.journalCode] ??= await upsertJournal(orgId, {
      code: spec.journalCode, name: spec.journalName,
      type: spec.isCash ? 'cash' : 'bank', defaultAccountId: accountId,
    });
    const bankId = id('bnk');
    await run(
      `INSERT INTO bank_accounts (id, org_id, name, bank_name, account_no, ifsc, currency,
                                  is_cash, account_id, journal_id, active)
       VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
      bankId, orgId, spec.name, spec.bankName ?? null, spec.accountNo ?? null,
      spec.ifsc ?? null, currency, spec.isCash ? 1 : 0, accountId, journals[spec.journalCode],
    );
    await run('UPDATE journals SET bank_account_id=? WHERE id=? AND org_id=?',
      bankId, journals[spec.journalCode], orgId);
    banks[spec.key] = bankId;
  }
  /*
   * THE DEFAULT IS WHAT EVERY MONEY FORM OPENS ON, so one is chosen rather
   * than left to fall out of an ORDER BY. The first non-cash account, because
   * a receipt against an invoice goes to a bank far more often than to the
   * petty cash tin — and an agency that works the other way round changes it
   * in one click.
   */
  const defaultBank = bankSpecs.find((b) => !b.isCash) ?? bankSpecs[0];
  if (defaultBank) {
    await run('UPDATE bank_accounts SET is_default=1 WHERE id=? AND org_id=?',
      banks[defaultBank.key], orgId);
  }

  // ------------------------------------------------------- payment terms
  const terms: Record<string, string> = {};
  for (const [key, name, days] of [
    ['imm', 'Immediate', 0], ['d7', '7 days', 7], ['d15', '15 days', 15],
    ['d30', '30 days', 30], ['d45', '45 days', 45],
  ] as Array<[string, string, number]>) {
    terms[key] = id('pt');
    await run('INSERT INTO payment_terms (id, org_id, name, days) VALUES (?,?,?,?)',
      terms[key], orgId, name, days);
  }

  // --------------------------------------------------------------- taxes
  const taxes = await provisionTaxes(orgId, accounts);

  // ------------------------------------------------------- analytic plans
  const plans: Record<string, string> = {};
  const planSpecs: Array<[string, string, string[]]> = [
    // TRIPS has no members by design: one analytic account per BOOKING, created
    // when the booking is, which is what makes profit-per-departure a query
    // rather than a spreadsheet.
    ['TRIPS', 'Trips', []],
    ['DEPT', 'Departments', ['Sales', 'Operations', 'Marketing', 'Administration']],
    ['BRANCH', 'Branches', []],
    ['AGENT', 'Agents', []],
  ];
  for (const [code, name, members] of planSpecs) {
    const planId = id('plan');
    await run('INSERT INTO analytic_plans (id, org_id, name, code) VALUES (?,?,?,?)',
      planId, orgId, name, code);
    plans[code] = planId;
    const all = [...members, ...(input.analyticMembers?.[code] ?? [])];
    for (const [i, m] of all.entries()) {
      await run(
        'INSERT INTO analytic_accounts (id, org_id, plan_id, code, name, active) VALUES (?,?,?,?,?,1)',
        id('ana'), orgId, planId, `${code}-${i + 1}`, m,
      );
    }
  }

  // ---------------------------------------------------- default accounts
  /*
   * THE CONTRACT BETWEEN THE CHART AND THE POSTING ROUTINES.
   *
   * The engine never names an account. When a receipt needs "the customer
   * advance account" it asks `org_settings`, and this is what answers. Every
   * key in `SettingKey` is written here — a missing one is a loud failure at
   * posting time, which is the right outcome and a far better one than a
   * silent posting to whatever came first alphabetically.
   */
  const bankJournal = defaultBank ? journals[defaultBank.journalCode] : journals.MSC;
  const cashSpec = bankSpecs.find((b) => b.isCash);
  const cashJournal = cashSpec ? journals[cashSpec.journalCode] : bankJournal;
  // Where customer receipts land. The dedicated collections journal when the
  // agency was provisioned with one, otherwise the main bank — never a
  // journal that does not exist, which is what a hard-coded 'COL' would be.
  const collectionsJournal = journals.COL ?? bankJournal;

  const settings: Array<[Parameters<typeof setSetting>[1], string]> = [
    ['account.receivable', accounts['110000']],
    ['account.payable', accounts['200000']],
    ['account.customer_advance', accounts['240000']],
    ['account.supplier_advance', accounts['130000']],
    ['account.customer_refund_payable', accounts['230000']],
    ['account.input_tax', accounts['170000']],
    ['account.output_tax', accounts['210000']],
    ['account.tds_payable', accounts['220000']],
    ['account.retained_earnings', accounts['310000']],
    ['account.current_year', accounts['310000']],
    ['account.fx_gain', accounts['410000']],
    ['account.fx_loss', accounts['611000']],
    ['account.bank_charges', accounts['606000']],
    ['account.commission_expense', accounts['610000']],
    ['account.commission_payable', accounts['245000']],
    ['account.channel_commission', accounts['612000']],
    ['account.channel_shipping', accounts['612100']],
    ['account.channel_charges', accounts['612200']],
    ['account.channel_recovery', accounts['411000']],
    ['account.tcs_receivable', accounts['171000']],
    ['account.tds_receivable', accounts['171100']],
    ['account.cancellation_charges', accounts['407000']],
    ['account.employee_advance', accounts['135000']],
    ['account.rounding', accounts['409000']],
    ['account.opening_balance', accounts['300000']],
    ['journal.sale', journals.SAL],
    ['journal.sale_refund', journals.SCN],
    ['journal.purchase', journals.PUR],
    ['journal.purchase_refund', journals.PCN],
    ['journal.bank', bankJournal],
    ['journal.cash', cashJournal],
    ['journal.customer_payment', collectionsJournal],
    ['journal.vendor_payment', bankJournal],
    ['journal.general', journals.MSC],
    ['journal.expense', journals.EXP],
    ['journal.asset', journals.MSC],
  ];
  for (const [key, value] of settings) await setSetting(orgId, key, value);

  // ------------------------------------------------------------ products
  for (const p of input.products ?? DEFAULT_PRODUCTS) {
    await upsertProduct(orgId, {
      name: p.name, category: p.category,
      salePrice: p.salePrice ?? 0, costPrice: p.costPrice ?? 0,
      incomeAccountId: accounts[p.incomeAccountCode],
      expenseAccountId: accounts[p.expenseAccountCode],
      // The 18% sale rate and the 18% purchase rate, which is what a tour
      // operator taking input credit charges and pays. Resolved out of the
      // rows just created rather than written as a number — plan section 20.
      saleTaxId: taxes.sale_1800 ?? null,
      purchaseTaxId: taxes.purchase_1800 ?? null,
      hsnCode: p.hsnCode, mrp: p.mrp ?? 0, variant: p.variant ?? null,
    });
  }

  // ------------------------------------------------------- fiscal periods
  // The CURRENT year, opened. A ledger with no open period refuses every
  // posting, so a freshly provisioned agency that cannot raise an invoice
  // would be indistinguishable from a broken one.
  await createFiscalYear(orgId, fiscalYearOf(today, fyStartMonth).from);

  return { orgId, accounts, journals, banks, terms, taxes, plans };
}

/**
 * Indian GST and TDS, as configuration rows.
 *
 * -------------------------------------------------------------------------
 * A CGST+SGST PAIR IS ONE TAX ON SCREEN AND TWO IN THE LEDGER
 * -------------------------------------------------------------------------
 * The PARENT carries the rate the customer sees — "GST 18%" — and is the only
 * thing offered in a dropdown. The CHILDREN carry half each and the accounts
 * the return is actually filed from, because CGST goes to the centre and SGST
 * to the state and they are two different liabilities. Offering the 9% halves
 * separately would let somebody invoice a package at half the rate it is due
 * at, which is why `saleTaxOptions` filters children out.
 *
 * IGST IS NOT A PAIR. An interstate or overseas supply is one 18% line with no
 * split, and a ledger that modelled it as a pair would file two liabilities
 * where the law has one.
 *
 * TDS is a PURCHASE-side tax and never appears in the sale dropdown: it is
 * withheld from what the agency pays a vendor, not charged to a customer. Its
 * `threshold` is the section's annual limit and is a ROW, not a constant —
 * when a Finance Act moves it, somebody edits the tax, not this file.
 */
async function provisionTaxes(
  orgId: string, acc: Record<string, string>,
): Promise<Record<string, string>> {
  const taxes: Record<string, string> = {};

  for (const scope of ['sale', 'purchase'] as const) {
    const sale = scope === 'sale';
    for (const bps of [500, 1200, 1800]) {
      const parentId = id('tax');
      const label = `GST ${bps / 100}%`;
      await run(
        `INSERT INTO taxes (id, org_id, name, computation, rate_bps, scope, tax_group,
                            price_included, account_id, active)
         VALUES (?,?,?,'percent',?,?,'cgst_sgst',0,NULL,1)`,
        parentId, orgId, `${label} (${sale ? 'Sales' : 'Purchase'})`, bps, scope,
      );
      for (const [half, account] of [
        ['CGST', sale ? acc['210000'] : acc['170000']],
        ['SGST', sale ? acc['210100'] : acc['170100']],
      ] as const) {
        const childId = id('tax');
        await run(
          `INSERT INTO taxes (id, org_id, name, computation, rate_bps, scope, tax_group,
                              price_included, account_id, active)
           VALUES (?,?,?,'percent',?,?,'gst',0,?,1)`,
          childId, orgId, `${half} ${(bps / 200).toFixed(bps % 200 ? 1 : 0)}%`, bps / 2, scope, account,
        );
        await run('INSERT INTO tax_children (parent_id, child_id) VALUES (?,?)', parentId, childId);
      }
      taxes[`${scope}_${bps}`] = parentId;
    }

    const igstId = id('tax');
    await run(
      `INSERT INTO taxes (id, org_id, name, computation, rate_bps, scope, tax_group,
                          price_included, account_id, active)
       VALUES (?,?,?,'percent',1800,?,'igst',0,?,1)`,
      igstId, orgId, `IGST 18% (${sale ? 'Sales' : 'Purchase'})`, scope,
      sale ? acc['210200'] : acc['170200'],
    );
    taxes[`igst_${scope}`] = igstId;
  }

  for (const [name, bps, threshold] of [
    ['TDS 194C — Contractors 2%', 200, 10_000_00],
    ['TDS 194H — Commission 5%', 500, 2_000_00],
    ['TDS 194J — Professional 10%', 1000, 5_000_00],
  ] as Array<[string, number, number]>) {
    const tid = id('tax');
    await run(
      `INSERT INTO taxes (id, org_id, name, computation, rate_bps, scope, tax_group,
                          price_included, account_id, threshold, active)
       VALUES (?,?,?,'percent',?,'purchase','tds',0,?,?,1)`,
      tid, orgId, name, bps, acc['220000'], threshold,
    );
    taxes[`tds_${bps}`] = tid;
  }

  return taxes;
}

/**
 * The books belonging to a TripzoCRM organisation, or null.
 *
 * One line, its own function, because it is the definition of tenancy in this
 * product and `auth.ts` is not the only thing that will ever need to ask.
 */
export async function booksOfCrmOrg(crmOrgId: string) {
  return await one<{ id: string; name: string; currency: string; fy_start_month: number }>(
    'SELECT id, name, currency, fy_start_month FROM organizations WHERE crm_org_id = ?',
    crmOrgId,
  );
}
