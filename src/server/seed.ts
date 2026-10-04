import 'server-only';
import { exec, all, one, run, scalar, tx, id } from './db';
import { isoDate, addDays, fiscalYearOf } from '@/lib/accounting';
import { provisionOrg, type ProvisionedBooks } from './provision';
import { CRM_CONFIGURED as AUTH_REQUIRED } from './crm/client';
import { postOpeningBalances } from './accounting/periods';
import { upsertPartner, createBooking, createBudget } from './accounting/masters';
import { createDocument, postDocument, createCreditNote } from './accounting/documents';
import { createPayment, applyCreditNote } from './accounting/payments';
import { createExpense, approveExpense, createCommission, postCommission } from './accounting/expenses';
import { createAsset, confirmAsset, runDepreciation, createDeferral, runDeferrals } from './accounting/assets';
import { importStatement } from './accounting/banking';
import { postEntry } from './accounting/engine';
import { allocate } from './accounting/payments';
import {
  createSettlement, postSettlement, saveCharge as saveSettlementCharge,
} from './accounting/settlements';

/**
 * The opening set of books, and a worked example on top of it.
 *
 * TWO JOBS, deliberately in one file. The first half is the CONFIGURATION a
 * real travel agency would keep — the chart of accounts from plan section 7,
 * the journals from section 8, Indian GST and TDS, the four analytic plans. The
 * second half posts a season of demo trading through the same services the UI
 * uses, so the reports have something to show and, more usefully, so the
 * guarantees in section 56 are exercised on every fresh install: if the seed
 * runs, debits equal credits and the balance sheet balances.
 *
 * Nothing here writes to journal_entry_lines directly. Every rupee below is
 * posted through the engine, which is the same reason the demo data is
 * trustworthy as an example of how to use it.
 */

const DEMO = process.env.TRIPZO_SEED_DEMO !== '0';

export async function isSeeded(): Promise<boolean> {
  return await scalar('SELECT COUNT(*) FROM organizations') > 0;
}

declare global {
  // eslint-disable-next-line no-var
  var __tripzoSeeding: Promise<void> | undefined;
}

/**
 * Seed the DEMO books once, however many callers ask at once.
 *
 * ONE REQUEST ASKS TWICE. The root layout resolves `ctx()` for the masthead and
 * the page resolves it for its own data, and React renders them concurrently —
 * so on a cold start both reached `isSeeded()` before either had written
 * anything, both saw an empty ledger, and the second `seed()` died on a
 * duplicate `organizations` row. The whole first page load 500s, and only the
 * first one, which is exactly the kind of failure that gets waved off as a
 * fluke. Memoising the PROMISE — not the result — makes the second caller wait
 * for the first instead of repeating it.
 *
 * This covers concurrency inside one process, which is where the bug was. Two
 * server instances cold-starting against the same empty schema would still
 * race; the loser fails its first request and succeeds on the retry, because
 * the insert conflicts rather than duplicating. A shared advisory lock is the
 * fix if that ever stops being acceptable.
 */
export async function ensureDemoBooks() {
  /*
   * ============================================================
   * NEVER ON A CRM-CONNECTED DEPLOYMENT. THIS GUARD IS THE POINT.
   * ============================================================
   * `AUTH_REQUIRED` is true exactly when there is a TripzoCRM to authenticate
   * against, and in that case the books are per-agency and arrive from
   * `provisionOrg` on first sign-in. Seeding here as well would write a
   * fictional agency into the agency's own Postgres, which is both a privacy
   * problem — Wander Travels' customer names, phone numbers and invoices in a
   * production database — and an accounting one, because those postings land
   * in whichever ledger adopts them.
   *
   * CHECKED HERE RATHER THAN AT THE CALL SITE so there is no second caller
   * that can forget. `scripts/reset.mjs` and the Reset button go through
   * `resetAndSeed`, which is a deliberate act by someone looking at a demo.
   */
  if (AUTH_REQUIRED) return;
  return (globalThis.__tripzoSeeding ??= (async () => {
    if (!await isSeeded()) await seed();
  })().catch((err) => {
    // A failed seed must not be remembered as done, or every later request in
    // this process reports missing data instead of the real cause.
    globalThis.__tripzoSeeding = undefined;
    throw err;
  }));
}

export async function resetAndSeed() {
  /*
   * =======================================================================
   * A DEMO-ONLY BUTTON, AND IT HAS TO BE SAID IN CODE RATHER THAN IN THE UI
   * =======================================================================
   * What follows TRUNCATES every table in this schema. That was the right
   * shape of operation while the schema held one set of demo books. It is
   * catastrophic once it holds several agencies': one agency's administrator
   * pressing "Reset and re-seed" would destroy EVERY OTHER AGENCY'S LEDGER on
   * the deployment — their invoices, their receipts, their posted entries,
   * their filed GST figures — from a button that reads like it belongs to them.
   *
   * Hiding the button on the screen is a courtesy; a server action is a public
   * endpoint and anyone can POST to it. So the refusal lives here, at the only
   * place that cannot be bypassed.
   *
   * A per-agency reset is a legitimate feature and is NOT this function: it
   * would delete `WHERE org_id = ?` across the tables in dependency order,
   * leave every other tenant untouched, and re-provision rather than re-seed.
   * Until that exists, a connected deployment has no reset, which is the
   * correct answer for a production ledger anyway.
   */
  if (AUTH_REQUIRED) {
    throw new Error(
      'Resetting the books is only available on a demo deployment. This one is connected to '
      + 'TripzoCRM and holds real agencies’ ledgers, which a reset would destroy — '
      + 'including other agencies’. Delete the individual records you meant to remove, or '
      + 'ask for a separate demo deployment.',
    );
  }
  /*
   * One TRUNCATE over every table at once.
   *
   * The tables come back from the catalog in no particular order, which is
   * almost never a valid topological order — clearing `accounts` while
   * `journal_entry_lines` still references it fails the constraint and leaves
   * the database half-wiped. Naming them all in a single statement makes the
   * order irrelevant, and CASCADE covers anything reached from them; RESTART
   * IDENTITY resets the audit log's sequence so a reset set of books does not
   * start at row 4,000.
   *
   * SCOPED TO OUR SCHEMA, deliberately and non-negotiably. This database also
   * holds the CRM's own tables, and a wipe that reached them would destroy the
   * agency's leads and invoices. `table_schema = current_schema()` is what
   * keeps this button survivable — see the schema note in db.ts.
   */
  const tables = await all<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
  );
  if (tables.length) {
    const list = tables.map((t) => `"${t.table_name.replace(/"/g, '""')}"`).join(', ');
    await exec(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
  await seed();
}

/**
 * The DEMONSTRATION books.
 *
 * -------------------------------------------------------------------------
 * ONLY THE DEMONSTRATION, NOW. THE CONFIGURATION MOVED.
 * -------------------------------------------------------------------------
 * This used to build a chart of accounts, journals, GST, TDS, analytic plans
 * and every default account, and then post a season of trading on top. The
 * first half is what EVERY agency needs and is now `provisionOrg` in
 * server/provision.ts, called per organisation the first time somebody from it
 * signs in. What is left here is the second half: Wander Travels, a fictional
 * Hyderabad agency, and one season of its trading.
 *
 * Wander Travels is a DEMO and is marked as one (`demo_data = 1`), which is
 * load-bearing rather than documentation: `resolveBooks` refuses to let a real
 * CRM agency adopt books carrying that flag. Before it existed, the first
 * agency to sign in to a deployment that had ever been seeded inherited these
 * invoices — and inherited them into its trial balance, its receivables and
 * its GST summary.
 */
export async function seed() {
  const books = await tx(async () => {
    /*
     * WANDER TRAVELS' OWN IDENTITY, which a provisioned agency does not get.
     *
     * 36 is Telangana, and it is the GSTIN's own first two digits — the pair
     * has to agree or `updateOrganisation` refuses the save. It is also what
     * decides CGST+SGST against IGST on every invoice this agency raises,
     * which is why the demo has one at all: without it the sample invoices
     * would carry no place of supply and the GST reports nothing to show.
     */
    const provisioned = await provisionOrg({
      orgId: 'org_wander',
      name: 'Wander Travels',
      demoData: true,
      identity: {
        legalName: 'Wander Travels Private Limited',
        gstin: '36AABCW1234F1Z5',
        pan: 'AABCW1234F',
        stateCode: '36',
        address: 'Road No. 12, Banjara Hills, Hyderabad 500034',
        city: 'Hyderabad',
        email: 'accounts@wandertravels.in',
        phone: '+91 40 4000 1234',
        website: 'https://wandertravels.in',
        invoiceTerms:
          'Cancellation within 15 days of departure attracts 50% of the package value. '
          + 'Visa fees and airline penalties are non-refundable.',
        invoiceFooter: 'Subject to Hyderabad jurisdiction',
      },
      /*
       * The agency's real banks, rather than the generic pair a fresh ledger
       * opens with. The second one is load-bearing for the demo: receipts land
       * in collections and supplier payments leave the current account, which
       * is what makes the two bank books tell different stories and gives the
       * reconciliation screen something to reconcile.
       */
      banks: [
        {
          key: 'hdfc', name: 'HDFC Bank — Current', bankName: 'HDFC Bank',
          accountNo: '50100234561234', ifsc: 'HDFC0000123',
          journalCode: 'BNK', journalName: 'HDFC Bank', accountCode: '101000',
        },
        {
          key: 'icici', name: 'ICICI Collections', bankName: 'ICICI Bank',
          accountNo: '002105001234', ifsc: 'ICIC0000021',
          journalCode: 'COL', journalName: 'ICICI Collections', accountCode: '101100',
        },
        {
          key: 'cash', name: 'Petty Cash', isCash: true,
          journalCode: 'CSH', journalName: 'Cash', accountCode: '100000',
        },
      ],
      analyticMembers: {
        BRANCH: ['Hyderabad', 'Chennai', 'Mumbai'],
        AGENT: ['Sai Kiran', 'Meera Rao', 'Arjun Das'],
      },
      // Rates as at today. A real deployment refreshes these daily; what
      // matters architecturally is that a rate is a DATED row, not a constant.
      fxRates: [['USD', 84.25], ['AED', 22.94], ['EUR', 91.10], ['THB', 2.42]],
      /*
       * PRICED, unlike the generic list a real agency is provisioned with,
       * because the demo's whole job is to produce invoices with figures on
       * them. The MRP is the published price the sale price discounts from,
       * which is what the exported statement's "MRP" column wants beside the
       * selling price.
       */
      products: [
        { name: 'Bali 5D/4N Package', category: 'package', salePrice: 150_000_00, costPrice: 112_000_00, incomeAccountCode: '400000', expenseAccountCode: '507000', hsnCode: '998555', mrp: 169_000_00, variant: 'Deluxe · twin sharing' },
        { name: 'Dubai 4D/3N Package', category: 'package', salePrice: 95_000_00, costPrice: 71_000_00, incomeAccountCode: '400000', expenseAccountCode: '507000', hsnCode: '998555', mrp: 109_000_00, variant: 'Standard · twin sharing' },
        { name: 'Goa Weekend Package', category: 'package', salePrice: 32_000_00, costPrice: 22_000_00, incomeAccountCode: '400000', expenseAccountCode: '507000', hsnCode: '998555', mrp: 38_000_00, variant: 'Beach resort · twin sharing' },
        { name: 'Hotel Booking', category: 'hotel', incomeAccountCode: '401000', expenseAccountCode: '500000', hsnCode: '996311', variant: 'Per room, per night' },
        { name: 'Flight Ticket', category: 'flight', incomeAccountCode: '402000', expenseAccountCode: '501000', hsnCode: '996425', variant: 'Economy' },
        { name: 'Visa Processing', category: 'visa', salePrice: 10_000_00, costPrice: 6_500_00, incomeAccountCode: '403000', expenseAccountCode: '503000', hsnCode: '998599', mrp: 12_000_00, variant: 'Tourist, single entry' },
        { name: 'Airport Transfer', category: 'transport', salePrice: 5_000_00, costPrice: 3_200_00, incomeAccountCode: '404000', expenseAccountCode: '502000', hsnCode: '996412', mrp: 6_000_00, variant: 'Sedan · up to 3 pax' },
        { name: 'Sightseeing Tour', category: 'sightseeing', salePrice: 8_000_00, costPrice: 5_000_00, incomeAccountCode: '405000', expenseAccountCode: '504000', hsnCode: '998555', mrp: 9_500_00, variant: 'Full day · guided' },
        { name: 'Service Fee', category: 'fee', salePrice: 2_500_00, incomeAccountCode: '406000', expenseAccountCode: '505000', hsnCode: '998599' },
      ],
    });

    /*
     * THE DEMO'S STAFF, and the only place in the product that invents a user.
     *
     * A real agency's people arrive from the CRM — `mirrorUser` in auth.ts
     * gives each one a local row on first sign-in, so every audit entry and
     * every posted entry names somebody who exists. A demo has no CRM to ask,
     * and a ledger whose entries were all posted by "System" tells a worse
     * story about the audit trail than one where they are not.
     */
    const users: Array<[string, string, string, string]> = [
      ['usr_admin', 'Admin User', 'admin@wandertravels.in', 'admin'],
      ['usr_priya', 'Priya Nair', 'priya@wandertravels.in', 'accountant'],
      ['usr_sai', 'Sai Kiran', 'sai@wandertravels.in', 'member'],
      ['usr_dev', 'Dev', 'dev@tripzo.cloud', 'developer'],
    ];
    for (const [uid, name, email, role] of users) {
      await run('INSERT INTO users (id, org_id, name, email, role, active) VALUES (?,?,?,?,?,1)',
        uid, provisioned.orgId, name, email, role);
    }

    return provisioned;
  });

  if (DEMO) await seedDemo(books);
}

/**
 * A season of trading.
 *
 * Every figure below goes through the same services the screens call, so this
 * doubles as the worked example for the 30 scenarios in plan section 51:
 * advance, invoice, partial payment, supplier bill with TDS, cancellation and
 * credit note, employee expense, depreciation, commission, FX purchase.
 */
async function seedDemo(books: ProvisionedBooks) {
  /*
   * THE HANDLE, NOT A STRING. `provisionOrg` generates every id it writes —
   * which is what lets two agencies be provisioned into one database at all —
   * so the demo addresses the bank accounts and payment terms it needs through
   * `books` rather than through the `bnk_hdfc` and `pt_30` literals it used to
   * hard-code. Accounts, journals and taxes are still looked up BY CODE below,
   * because a code is a stable business identifier and reads better here than
   * a map lookup.
   */
  const orgId = books.orgId;
  const actor = { id: 'usr_admin', name: 'Admin User', role: 'admin' };
  const today = isoDate();
  const acc = async (code: string) =>
    (await one<{ id: string }>('SELECT id FROM accounts WHERE org_id=? AND code=?', orgId, code))!.id;
  const jrn = async (code: string) =>
    (await one<{ id: string }>('SELECT id FROM journals WHERE org_id=? AND code=?', orgId, code))!.id;
  // Taxes are looked up by the name the seed gave them. Matching on the name
  // rather than on a hard-coded id keeps the demo readable and survives an
  // agency renaming its own tax rows.
  const taxId = async (name: string) =>
    (await one<{ id: string }>(
      `SELECT id FROM taxes WHERE org_id=? AND name LIKE ?
         AND id NOT IN (SELECT child_id FROM tax_children)`,
      orgId, name,
    ))?.id ?? null;
  const fy = fiscalYearOf(today, 4);
  const d = (offset: number) => addDays(today, offset);

  // ------------------------------------------------------- opening balances
  await postOpeningBalances(orgId, {
    date: fy.from,
    lines: [
      { accountId: await acc('101000'), debit: 18_50_000_00, credit: 0, label: 'HDFC opening' },
      { accountId: await acc('100000'), debit: 45_000_00, credit: 0, label: 'Cash opening' },
      { accountId: await acc('150000'), debit: 4_20_000_00, credit: 0, label: 'Office equipment' },
      { accountId: await acc('300000'), debit: 0, credit: 20_00_000_00, label: 'Owner capital' },
      { accountId: await acc('310000'), debit: 0, credit: 3_15_000_00, label: 'Retained earnings' },
    ],
  }, actor);

  // -------------------------------------------------------------- partners
  /*
   * EVERY DEMO CUSTOMER HAS A CITY AND A STATE, and that is load-bearing rather
   * than set dressing. The state is the PLACE OF SUPPLY: against the agency's
   * own it decides CGST+SGST versus IGST, and it is what the exported statement
   * prints in its "Customer State" column. Seeded books whose customers had no
   * state produced invoices with no place of supply, which looked complete and
   * were not — and gave the export an empty column to show for the feature.
   */
  const customers: Array<[string, string, string, string, number, string, string]> = [
    ['Rahul Mehta', 'b2c', 'rahul.mehta@gmail.com', '+91 98490 11223', 0, 'Hyderabad', '36'],
    ['Sneha Reddy', 'b2c', 'sneha.reddy@gmail.com', '+91 99590 44556', 0, 'Secunderabad', '36'],
    ['Infosys Travel Desk', 'b2b', 'travel@infosys-demo.in', '+91 80 4000 1111', 10_00_000_00, 'Bengaluru', '29'],
    ['Skyline Holidays (Reseller)', 'reseller', 'ops@skylineholidays.in', '+91 44 2233 4455', 5_00_000_00, 'Chennai', '33'],
    ['Arun Prakash', 'b2c', 'arun.p@outlook.com', '+91 97000 77889', 0, 'Pune', '27'],
  ];
  const cust: Record<string, string> = {};
  for (const [name, type, email, phone, limit, city, state] of customers) {
    cust[name] = await upsertPartner(orgId, {
      name, isCustomer: true, partnerType: type, email, phone,
      creditLimit: limit, paymentTermsId: limit ? books.terms.d30 : books.terms.imm,
      gstin: type === 'b2b' ? '29AAACI1681G1ZR' : null,
      gstName: type === 'b2b' ? 'INFOSYS LIMITED' : null,
      city, stateCode: state,
    }, actor);
  }

  const suppliers: Array<[string, string, string | null]> = [
    ['Taj Resorts Bali', 'hotel supplier', null],
    ['SkyWings Air Consolidator', 'flight supplier', '194C'],
    ['Dubai DMC Services', 'ground handler', '194C'],
    ['VisaExpress Pvt Ltd', 'visa agent', '194J'],
    ['Coastal Cabs Goa', 'transport', '194C'],
    ['Bright Media Agency', 'marketing', '194J'],
  ];
  const supp: Record<string, string> = {};
  for (const [name, note, tds] of suppliers) {
    supp[name] = await upsertPartner(orgId, {
      name, isSupplier: true, partnerType: 'b2b', address: note,
      tdsSection: tds, paymentTermsId: books.terms.d15,
    }, actor);
  }

  // -------------------------------------------------------------- bookings
  const bookings: Array<[string, string, string, string, string, string, number, number, number]> = [
    ['BK-1023', 'Bali 5D/4N — Rahul Mehta', 'Bali', 'Bali 5D/4N Package', 'Rahul Mehta', 'Sai Kiran', 2, -140, 2_00_000_00],
    ['BK-1024', 'Goa Weekend — Sneha Reddy', 'Goa', 'Goa Weekend Package', 'Sneha Reddy', 'Meera Rao', 4, -95, 1_28_000_00],
    ['BK-1025', 'Dubai 4D/3N — Infosys Offsite', 'Dubai', 'Dubai 4D/3N Package', 'Infosys Travel Desk', 'Sai Kiran', 12, -60, 11_40_000_00],
    ['BK-1026', 'Singapore 6D — Arun Prakash', 'Singapore', 'Custom', 'Arun Prakash', 'Arjun Das', 3, -25, 3_30_000_00],
    ['BK-1027', 'Bali 5D/4N — Skyline (B2B)', 'Bali', 'Bali 5D/4N Package', 'Skyline Holidays (Reseller)', 'Meera Rao', 6, 15, 7_80_000_00],
  ];
  const bkg: Record<string, string> = {};
  for (const [ref, title, dest, pkg, customer, agent, pax, offset, value] of bookings) {
    bkg[ref] = await createBooking(orgId, {
      ref, title, destination: dest, packageName: pkg,
      partnerId: cust[customer], customerName: customer, agentName: agent, branch: 'Hyderabad',
      pax, startDate: d(offset), endDate: d(offset + 5), sellValue: value,
    }, actor);
  }
  const analyticOf = async (bookingId: string) =>
    (await one<{ analytic_id: string }>('SELECT analytic_id FROM bookings WHERE id=?', bookingId))!.analytic_id;

  const gstSale5 = await taxId('GST 5% (Sales)');
  const gstSale18 = await taxId('GST 18% (Sales)');
  const gstPur18 = await taxId('GST 18% (Purchase)');
  const gstPur5 = await taxId('GST 5% (Purchase)');
  const tds194c = await taxId('TDS 194C%');

  // ------------------------------------------------ BK-1023: the full cycle
  // Advance first, as travel actually works: money before the invoice exists.
  const advance = await createPayment({
    orgId, direction: 'inbound', partnerId: cust['Rahul Mehta'],
    journalId: await jrn('COL'), bankAccountId: books.banks.icici, bookingId: bkg['BK-1023'],
    payDate: d(-160), amount: 50_000_00, method: 'upi', reference: 'UPI/4412093',
    isAdvance: true,
  }, actor);

  const inv1023 = await createDocument({
    orgId, docType: 'out_invoice', partnerId: cust['Rahul Mehta'],
    journalId: await jrn('SAL'), bookingId: bkg['BK-1023'], analyticId: await analyticOf(bkg['BK-1023']),
    docDate: d(-150), paymentTermsId: books.terms.d15,
    lines: [
      { name: 'Bali 5D/4N Package — 2 pax', qtyMilli: 1000, unitPrice: 1_50_000_00, accountId: await acc('400000'), taxId: gstSale5 },
      { name: 'Visa Services', qtyMilli: 2000, unitPrice: 5_000_00, accountId: await acc('403000'), taxId: gstSale18 },
      { name: 'Airport Transfer', qtyMilli: 1000, unitPrice: 5_000_00, accountId: await acc('404000'), taxId: gstSale5 },
    ],
  }, actor);
  await postDocument(orgId, inv1023, actor);

  // The advance is applied, then the balance arrives in two instalments.
  const invTotal = (await one<{ total: number }>('SELECT total FROM documents WHERE id=?', inv1023))!.total;
  await applyAdvance(orgId, advance, inv1023, 50_000_00, actor);
  await createPayment({
    orgId, direction: 'inbound', partnerId: cust['Rahul Mehta'], journalId: await jrn('BNK'),
    bankAccountId: books.banks.hdfc, bookingId: bkg['BK-1023'], payDate: d(-140),
    amount: 90_000_00, method: 'neft', reference: 'NEFT/HDFC/88231',
    allocations: [{ documentId: inv1023, amount: 90_000_00 }],
  }, actor);
  await createPayment({
    orgId, direction: 'inbound', partnerId: cust['Rahul Mehta'], journalId: await jrn('BNK'),
    bankAccountId: books.banks.hdfc, bookingId: bkg['BK-1023'], payDate: d(-132),
    amount: Math.min(40_000_00, invTotal - 1_40_000_00), method: 'upi', reference: 'UPI/5590231',
    allocations: [{ documentId: inv1023, amount: Math.min(40_000_00, invTotal - 1_40_000_00) }],
  }, actor);

  // Supplier side of the same trip.
  const billHotel = await createDocument({
    orgId, docType: 'in_invoice', partnerId: supp['Taj Resorts Bali'],
    journalId: await jrn('PUR'), bookingId: bkg['BK-1023'], analyticId: await analyticOf(bkg['BK-1023']),
    docDate: d(-148), supplierRef: 'TRB/2026/4471', paymentTermsId: books.terms.d15,
    lines: [{ name: 'Bali — 4 nights, deluxe twin', qtyMilli: 1000, unitPrice: 80_000_00, accountId: await acc('500000') }],
  }, actor);
  await postDocument(orgId, billHotel, actor);

  const billFlight = await createDocument({
    orgId, docType: 'in_invoice', partnerId: supp['SkyWings Air Consolidator'],
    journalId: await jrn('PUR'), bookingId: bkg['BK-1023'], analyticId: await analyticOf(bkg['BK-1023']),
    docDate: d(-147), supplierRef: 'SW-99211', paymentTermsId: books.terms.d7,
    withholdingTaxId: tds194c,
    lines: [{ name: 'HYD–DPS return, 2 pax', qtyMilli: 1000, unitPrice: 60_000_00, accountId: await acc('501000') }],
  }, actor);
  await postDocument(orgId, billFlight, actor);

  for (const [billId, amount, date] of [[billHotel, 80_000_00, d(-135)], [billFlight, 58_800_00, d(-140)]] as const) {
    const residual = (await one<{ residual: number }>('SELECT residual FROM documents WHERE id=?', billId))!.residual;
    const partner = (await one<{ partner_id: string }>('SELECT partner_id FROM documents WHERE id=?', billId))!.partner_id;
    await createPayment({
      orgId, direction: 'outbound', partnerId: partner, journalId: await jrn('BNK'),
      bankAccountId: books.banks.hdfc, bookingId: bkg['BK-1023'], payDate: date,
      amount: Math.min(amount, residual), method: 'neft',
      allocations: [{ documentId: billId, amount: Math.min(amount, residual) }],
    }, actor);
  }

  // Trip extras that never see a vendor bill: a guide paid in cash.
  const guideExpense = await createExpense({
    orgId, employeeName: 'Sai Kiran', description: 'Local guide — Bali day 3',
    expenseDate: d(-138), amount: 10_000_00, accountId: await acc('506000'),
    analyticId: await analyticOf(bkg['BK-1023']), bookingId: bkg['BK-1023'],
    paidBy: 'employee', journalId: await jrn('EXP'),
  }, actor);
  await approveExpense(orgId, guideExpense, actor);

  // ---------------------------------------------- BK-1024: Goa, cancelled
  const inv1024 = await createDocument({
    orgId, docType: 'out_invoice', partnerId: cust['Sneha Reddy'],
    journalId: await jrn('SAL'), bookingId: bkg['BK-1024'], analyticId: await analyticOf(bkg['BK-1024']),
    docDate: d(-100), paymentTermsId: books.terms.imm,
    lines: [
      { name: 'Goa Weekend — 4 pax', qtyMilli: 4000, unitPrice: 32_000_00, accountId: await acc('400000'), taxId: gstSale5 },
    ],
  }, actor);
  await postDocument(orgId, inv1024, actor);
  await createPayment({
    orgId, direction: 'inbound', partnerId: cust['Sneha Reddy'], journalId: await jrn('COL'),
    bankAccountId: books.banks.icici, bookingId: bkg['BK-1024'], payDate: d(-99),
    amount: 1_34_400_00, method: 'card', reference: 'CARD/4411',
    allocations: [{ documentId: inv1024, amount: 1_34_400_00 }],
  }, actor);
  const billCabs = await createDocument({
    orgId, docType: 'in_invoice', partnerId: supp['Coastal Cabs Goa'],
    journalId: await jrn('PUR'), bookingId: bkg['BK-1024'], analyticId: await analyticOf(bkg['BK-1024']),
    docDate: d(-98), supplierRef: 'CC-3321',
    lines: [{ name: 'Airport transfers + sightseeing', qtyMilli: 1000, unitPrice: 18_000_00, accountId: await acc('502000'), taxId: gstPur5 }],
  }, actor);
  await postDocument(orgId, billCabs, actor);

  // Cancelled trip: 70% retained as a cancellation charge, 30% credited back.
  const cn = await createCreditNote(orgId, inv1024, {
    date: d(-90), bps: 3000, reason: 'Customer cancellation — 70% retained',
  }, actor);
  await postDocument(orgId, cn, actor);
  const cnResidual = (await one<{ residual: number }>('SELECT residual FROM documents WHERE id=?', cn))!.residual;
  const invResidual = (await one<{ residual: number }>('SELECT residual FROM documents WHERE id=?', inv1024))!.residual;
  if (cnResidual > 0 && invResidual > 0) {
    await applyCreditNote(orgId, cn, inv1024, Math.min(cnResidual, invResidual), actor);
  } else if (cnResidual > 0) {
    // Already fully paid, so the credit is refunded rather than netted off.
    await createPayment({
      orgId, direction: 'outbound', side: 'customer',
      partnerId: cust['Sneha Reddy'], journalId: await jrn('COL'),
      bankAccountId: books.banks.icici, bookingId: bkg['BK-1024'], payDate: d(-88),
      amount: cnResidual, method: 'neft', reference: 'Refund — cancellation',
      allocations: [{ documentId: cn, amount: cnResidual }],
    }, actor);
  }
  await run("UPDATE bookings SET status='cancelled' WHERE id=?", bkg['BK-1024']);

  // ------------------------------------- BK-1025: corporate, part paid, FX
  const inv1025 = await createDocument({
    orgId, docType: 'out_invoice', partnerId: cust['Infosys Travel Desk'],
    journalId: await jrn('SAL'), bookingId: bkg['BK-1025'], analyticId: await analyticOf(bkg['BK-1025']),
    docDate: d(-58), paymentTermsId: books.terms.d30,
    lines: [
      { name: 'Dubai 4D/3N — 12 pax', qtyMilli: 12000, unitPrice: 95_000_00, accountId: await acc('400000'), taxId: gstSale5 },
      { name: 'Corporate service fee', qtyMilli: 1000, unitPrice: 25_000_00, accountId: await acc('406000'), taxId: gstSale18 },
    ],
  }, actor);
  await postDocument(orgId, inv1025, actor);
  await createPayment({
    orgId, direction: 'inbound', partnerId: cust['Infosys Travel Desk'], journalId: await jrn('BNK'),
    bankAccountId: books.banks.hdfc, bookingId: bkg['BK-1025'], payDate: d(-40),
    amount: 8_00_000_00, method: 'neft', reference: 'INFY/PO/88213',
    allocations: [{ documentId: inv1025, amount: 8_00_000_00 }],
  }, actor);

  // A foreign-currency purchase: AED 30,000 for the ground handler, booked in
  // rupees at the day's rate with the face value kept for the audit trail.
  const billDmc = await createDocument({
    orgId, docType: 'in_invoice', partnerId: supp['Dubai DMC Services'],
    journalId: await jrn('PUR'), bookingId: bkg['BK-1025'], analyticId: await analyticOf(bkg['BK-1025']),
    docDate: d(-55), supplierRef: 'DMC/26/1187', currency: 'AED', rateE6: 22_940_000,
    lines: [{ name: 'Dubai ground handling — 12 pax (AED 30,000)', qtyMilli: 1000, unitPrice: 6_88_200_00, accountId: await acc('505000') }],
  }, actor);
  await postDocument(orgId, billDmc, actor);
  await createPayment({
    orgId, direction: 'outbound', partnerId: supp['Dubai DMC Services'], journalId: await jrn('BNK'),
    bankAccountId: books.banks.hdfc, bookingId: bkg['BK-1025'], payDate: d(-45),
    amount: 4_00_000_00, method: 'neft', reference: 'SWIFT/AED',
    allocations: [{ documentId: billDmc, amount: 4_00_000_00 }],
  }, actor);

  // --------------------------------------------- BK-1026: awaiting payment
  const inv1026 = await createDocument({
    orgId, docType: 'out_invoice', partnerId: cust['Arun Prakash'],
    journalId: await jrn('SAL'), bookingId: bkg['BK-1026'], analyticId: await analyticOf(bkg['BK-1026']),
    docDate: d(-30), paymentTermsId: books.terms.d15,
    lines: [
      { name: 'Singapore 6D — 3 pax', qtyMilli: 3000, unitPrice: 1_05_000_00, accountId: await acc('400000'), taxId: gstSale5 },
      { name: 'Visa Processing — 3 pax', qtyMilli: 3000, unitPrice: 5_000_00, accountId: await acc('403000'), taxId: gstSale18 },
    ],
  }, actor);
  await postDocument(orgId, inv1026, actor);
  const billVisa = await createDocument({
    orgId, docType: 'in_invoice', partnerId: supp['VisaExpress Pvt Ltd'],
    journalId: await jrn('PUR'), bookingId: bkg['BK-1026'], analyticId: await analyticOf(bkg['BK-1026']),
    docDate: d(-28), supplierRef: 'VE-7781', withholdingTaxId: await taxId('TDS 194J%'),
    lines: [{ name: 'Singapore visas — 3 pax', qtyMilli: 3000, unitPrice: 3_500_00, accountId: await acc('503000'), taxId: gstPur18 }],
  }, actor);
  await postDocument(orgId, billVisa, actor);

  // ------------------------------------------- BK-1027: upcoming, advance
  await createPayment({
    orgId, direction: 'inbound', partnerId: cust['Skyline Holidays (Reseller)'],
    journalId: await jrn('BNK'), bankAccountId: books.banks.hdfc, bookingId: bkg['BK-1027'],
    payDate: d(-10), amount: 3_00_000_00, method: 'neft', reference: 'SKY/ADV/2211',
    isAdvance: true,
  }, actor);
  await createPayment({
    orgId, direction: 'outbound', partnerId: supp['Taj Resorts Bali'], journalId: await jrn('BNK'),
    bankAccountId: books.banks.hdfc, bookingId: bkg['BK-1027'], payDate: d(-8),
    amount: 1_50_000_00, method: 'neft', reference: 'Advance — Bali Oct block',
    isAdvance: true,
  }, actor);

  // ------------------------------------------- a channel settlement cycle
  /*
   * WHY THE DEMO SHIPS A WORKED PAYOUT CYCLE.
   *
   * The settlement screen and the three-sheet export are the hardest part of
   * this product to understand from an empty state: a cycle with no orders in
   * it looks identical whether the feature works or the dates are wrong. One
   * posted cycle, with its commission, its GST, its storage charge, its TCS and
   * TDS and one returned order, makes the whole thing legible in a single
   * screen — and it is the fixture the exported workbook is checked against.
   *
   * Every figure below goes through the same services the screens call, so if
   * the arithmetic here is wrong the seed fails rather than the demo quietly
   * showing a statement that does not balance.
   */
  const channel = await upsertPartner(orgId, {
    name: 'Wanderly Marketplace',
    isCustomer: true,
    partnerType: 'agency',
    email: 'seller.payouts@wanderly-demo.in',
    gstin: '29AAFCG9846E1Z7',
    gstName: 'WANDERLY TECHNOLOGIES PRIVATE LIMITED',
    city: 'Bengaluru',
    stateCode: '29',
    paymentTermsId: books.terms.d15,
  }, actor);

  /*
   * Three sales and one cancellation, all through the channel and all inside
   * one fortnight — which is the cycle length most channels remit on. Each
   * carries the order reference the channel identifies it by, because that
   * reference is the only field common to both documents when the agency's
   * statement and the channel's are put side by side.
   */
  /*
   * EACH LINE NAMES A REAL PRODUCT, and that is not tidiness.
   *
   * The statement's Item ID, Variant Description and three category columns are
   * all read off the product behind the line. A free-typed line fills none of
   * them, so a seed that typed its descriptions would leave five columns of the
   * exported workbook empty and the feature looking broken rather than unused.
   * The HSN and the MRP come from the product too — the line snapshots them,
   * which is the behaviour worth demonstrating.
   */
  const product = async (name: string) =>
    (await one<{ id: string; hsn_code: string | null; mrp: number; income_account_id: string | null }>(
      'SELECT id, hsn_code, mrp, income_account_id FROM products WHERE org_id=? AND name=?',
      orgId, name,
    ))!;

  const channelOrders: Array<[string, string, string, number, number]> = [
    ['WDL-1917427960', 'Goa Weekend Package', 'Goa Weekend — 2 pax', 2000, 32_000_00],
    ['WDL-1920736750', 'Bali 5D/4N Package', 'Bali 5D/4N — 2 pax', 2000, 1_50_000_00],
    ['WDL-1921044112', 'Airport Transfer', 'Airport Transfer — Goa', 1000, 5_000_00],
  ];
  const channelDocs: string[] = [];
  for (const [[orderRef, productName, label, qty, price], i]
    of channelOrders.map((o, i) => [o, i] as const)) {
    const p = await product(productName);
    const docId = await createDocument({
      orgId, docType: 'out_invoice', partnerId: channel,
      journalId: await jrn('SAL'), docDate: d(-18 + i), paymentTermsId: books.terms.d15,
      // The channel is in Karnataka and the agency in Telangana, so this is an
      // inter-state supply — which is exactly the case the place-of-supply
      // field exists to decide.
      placeOfSupply: '29',
      orderRef, orderDate: d(-19 + i),
      lines: [{
        name: label, productId: p.id, hsnCode: p.hsn_code, mrp: p.mrp,
        qtyMilli: qty, unitPrice: price,
        accountId: p.income_account_id ?? await acc('400000'),
        taxId: gstSale5,
      }],
    }, actor);
    await postDocument(orgId, docId, actor);
    channelDocs.push(docId);
  }

  // One of them is cancelled, so the cycle has something on its returns sheet.
  const channelReturn = await createCreditNote(orgId, channelDocs[2], {
    date: d(-12), bps: 10000, reason: 'Traveller cancelled — transfer not used',
  }, actor);
  await postDocument(orgId, channelReturn, actor);

  const cycle = await createSettlement({
    orgId,
    partnerId: channel,
    cycleFrom: d(-20),
    cycleTo: d(-6),
    // The terms a mid-sized marketplace actually settles on: six per cent of
    // the fare, GST at 18% on its own fee, a flat shipping charge per order,
    // and 1% TDS under 194-O.
    commissionBps: 600,
    chargeGstBps: 1800,
    shippingCharge: 50_00,
    returnCharge: 50_00,
    tcsBps: 0,
    tdsBps: 100,
    previousUnsettled: 0,
    payDate: d(-4),
    utr: 'CMS5643191908',
    bankAccountId: books.banks.icici,
    note: 'Wanderly payout cycle — statement WDL/PAY/2026/0417',
  }, actor);

  // The cycle-level charges: what the channel bills whether anything sold or
  // not. Entered as the statement shows them, GST left to the cycle's rate.
  for (const [code, amount] of [['storage', 2_556_00], ['ads', 1_200_00]] as const) {
    await saveSettlementCharge(orgId, cycle, { code, amount }, actor);
  }
  await postSettlement(orgId, cycle, actor);

  // ------------------------------------------------- running the agency
  // Sized so the demo agency runs at a realistic small profit rather than a
  // loss: an eight-person shop in Hyderabad, not a head office.
  const overheads: Array<[string, string, number, number, string | null]> = [
    ['601000', 'Office rent — Banjara Hills', 55_000_00, -120, null],
    ['601000', 'Office rent — Banjara Hills', 55_000_00, -90, null],
    ['601000', 'Office rent — Banjara Hills', 55_000_00, -60, null],
    ['601000', 'Office rent — Banjara Hills', 55_000_00, -30, null],
    ['600000', 'Salaries — August', 2_20_000_00, -40, null],
    ['600000', 'Salaries — September', 2_20_000_00, -10, null],
    ['603000', 'TripzoCRM subscription', 12_000_00, -20, null],
    ['604000', 'Internet & phones', 6_500_00, -20, null],
    ['606000', 'Bank charges', 2_360_00, -15, null],
  ];
  for (const [code, label, amount, offset] of overheads) {
    await postSimple(orgId, {
      journalId: await jrn('BNK'), date: d(offset), label,
      debitAccount: await acc(code), creditAccount: await acc('101000'), amount,
    }, actor);
  }
  const marketingBill = await createDocument({
    orgId, docType: 'in_invoice', partnerId: supp['Bright Media Agency'],
    journalId: await jrn('PUR'), docDate: d(-35), supplierRef: 'BM-2211',
    withholdingTaxId: await taxId('TDS 194J%'),
    lines: [{ name: 'Instagram campaign — September', qtyMilli: 1000, unitPrice: 1_20_000_00, accountId: await acc('602000'), taxId: gstPur18 }],
  }, actor);
  await postDocument(orgId, marketingBill, actor);

  // --------------------------------------------- assets and deferrals
  const laptops = await createAsset({
    orgId, name: 'MacBook Air M4 × 3',
    assetAccountId: await acc('150000'), depreciationAccountId: await acc('155000'),
    expenseAccountId: await acc('609000'), journalId: await jrn('MSC'),
    purchaseDate: fy.from, purchaseValue: 3_60_000_00, salvageValue: 30_000_00,
    method: 'straight_line', lifeMonths: 36,
  }, actor);
  await confirmAsset(orgId, laptops, actor);
  await runDepreciation(orgId, today, actor);

  const insurance = await createDeferral({
    orgId, name: 'Office & travel insurance — annual',
    kind: 'expense', balanceAccountId: await acc('140000'), recognitionAccountId: await acc('605000'),
    journalId: await jrn('MSC'), amount: 1_20_000_00, dateFrom: fy.from, months: 12,
  }, actor);
  // The premium was paid up front, which is what puts it on the prepaid account
  // in the first place.
  await postSimple(orgId, {
    journalId: await jrn('BNK'), date: fy.from, label: 'Annual insurance premium',
    debitAccount: await acc('140000'), creditAccount: await acc('101000'), amount: 1_20_000_00,
  }, actor);
  await runDeferrals(orgId, today, actor);
  void insurance;

  // ------------------------------------------------------- commissions
  for (const [ref, agent, bps] of [['BK-1023', 'Sai Kiran', 500], ['BK-1025', 'Sai Kiran', 300], ['BK-1026', 'Arjun Das', 500]] as const) {
    const commissionId = await createCommission(orgId, {
      agentName: agent, bookingId: bkg[ref], basis: 'revenue', rateBps: bps,
    }, actor);
    const amount = (await one<{ amount: number }>('SELECT amount FROM commissions WHERE id=?', commissionId))!.amount;
    if (amount > 0) await postCommission(orgId, commissionId, d(-5), actor);
  }

  // ------------------------------------------------------------ budgets
  await createBudget(orgId, {
    name: 'FY operating budget', owner: 'Priya Nair',
    dateFrom: fy.from, dateTo: fy.to,
    lines: [
      { accountId: await acc('600000'), planned: 28_00_000_00 },
      { accountId: await acc('601000'), planned: 6_60_000_00 },
      { accountId: await acc('602000'), planned: 8_00_000_00 },
      { accountId: await acc('603000'), planned: 1_80_000_00 },
      { accountId: await acc('607000'), planned: 2_40_000_00 },
    ],
  }, actor);

  // ------------------------------------------- an unreconciled statement
  // Left deliberately unmatched, so the Reconciliation screen has real work in
  // it on a fresh install — including one line that is not a customer receipt.
  await importStatement(orgId, books.banks.hdfc, [
    { date: d(-4), description: 'UPI/ARUN PRAKASH/SINGAPORE TRIP', reference: 'UPI/77120', amount: 1_00_000_00 },
    { date: d(-3), description: 'NEFT INFOSYS LTD BALANCE PO 88213', reference: 'NEFT/99120', amount: 2_00_000_00 },
    { date: d(-3), description: 'BANK CHARGES QTR', reference: 'CHG/0926', amount: -1_180_00 },
    { date: d(-2), description: 'RTGS SKYWINGS AIR CONSOLIDATOR', reference: 'RTGS/44021', amount: -1_20_000_00 },
    { date: d(-1), description: 'IMPS/SNEHA REDDY/REFUND RETURNED', reference: 'IMPS/33110', amount: 12_000_00 },
  ], actor);
}

/**
 * Two-line helper for the many "paid X from the bank" entries the demo needs.
 * Kept private to the seed: real screens route through a service, never here.
 */
async function postSimple(orgId: string, o: {
  journalId: string; date: string; label: string;
  debitAccount: string; creditAccount: string; amount: number;
}, actor: { id?: string; name?: string }) {
  return await postEntry({
    orgId, journalId: o.journalId, date: o.date, reference: o.label, narration: o.label,
    sourceModel: 'manual',
    lines: [
      { accountId: o.debitAccount, debit: o.amount, label: o.label },
      { accountId: o.creditAccount, credit: o.amount, label: o.label },
    ],
  }, actor);
}

/** Apply a posted advance to a posted invoice. Thin wrapper for readability. */
async function applyAdvance(orgId: string, paymentId: string, documentId: string, amount: number, actor: { id?: string; name?: string }) {
  await allocate(orgId, paymentId, documentId, amount, actor);
}
