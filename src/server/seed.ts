import 'server-only';
import { db, all, one, run, scalar, tx, id, nowIso } from './db';
import { isoDate, addDays, fiscalYearOf } from '@/lib/accounting';
import { setSetting } from './accounting/settings';
import { createFiscalYear, postOpeningBalances } from './accounting/periods';
import { upsertAccount, upsertJournal, upsertPartner, createBooking, upsertProduct, createBudget } from './accounting/masters';
import { createDocument, postDocument, createCreditNote } from './accounting/documents';
import { createPayment, applyCreditNote } from './accounting/payments';
import { createExpense, approveExpense, createCommission, postCommission } from './accounting/expenses';
import { createAsset, confirmAsset, runDepreciation, createDeferral, runDeferrals } from './accounting/assets';
import { importStatement } from './accounting/banking';
import { postEntry } from './accounting/engine';
import { allocate } from './accounting/payments';

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

export function isSeeded(): boolean {
  return scalar('SELECT COUNT(*) FROM organizations') > 0;
}

export function ensureSeeded() {
  if (!isSeeded()) seed();
}

export function resetAndSeed() {
  /*
   * Foreign keys are turned OFF for the wipe and back on straight afterwards.
   *
   * The tables are deleted in whatever order sqlite_master lists them, which
   * is almost never a valid topological order — clearing `accounts` while
   * `journal_entry_lines` still references it fails the constraint and leaves
   * the database half-wiped. Ordering the deletes by hand would be a second
   * copy of the schema's dependency graph to keep in step, so the constraint
   * is suspended for the one operation whose whole point is to leave nothing
   * behind for it to protect.
   *
   * The pragma cannot change inside a transaction, hence the toggle outside it.
   */
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    tx(() => {
      for (const t of all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )) {
        db.exec(`DELETE FROM ${t.name}`);
      }
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  seed();
}

export function seed() {
  const orgId = 'org_wander';
  const today = isoDate();

  tx(() => {
    // ----------------------------------------------------------- the agency
    run(
      `INSERT INTO organizations (id, name, currency, country, gstin, pan, fy_start_month, address, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      orgId, 'Wander Travels', 'INR', 'IN', '36AABCW1234F1Z5', 'AABCW1234F', 4,
      'Road No. 12, Banjara Hills, Hyderabad 500034', nowIso(),
    );

    const users: Array<[string, string, string, string]> = [
      ['usr_admin', 'Admin User', 'admin@wandertravels.in', 'admin'],
      ['usr_priya', 'Priya Nair', 'priya@wandertravels.in', 'accountant'],
      ['usr_sai', 'Sai Kiran', 'sai@wandertravels.in', 'member'],
      ['usr_dev', 'Dev', 'dev@tripzo.cloud', 'developer'],
    ];
    for (const [uid, name, email, role] of users) {
      run('INSERT INTO users (id, org_id, name, email, role, active) VALUES (?,?,?,?,?,1)',
        uid, orgId, name, email, role);
    }

    for (const [code, name, symbol] of [
      ['INR', 'Indian Rupee', '₹'], ['USD', 'US Dollar', '$'],
      ['AED', 'UAE Dirham', 'د.إ'], ['EUR', 'Euro', '€'], ['THB', 'Thai Baht', '฿'],
    ]) {
      run('INSERT OR IGNORE INTO currencies (code, name, symbol, decimals) VALUES (?,?,?,2)', code, name, symbol);
    }
    // Rates as at today. A real deployment refreshes these daily; what matters
    // architecturally is that a rate is a DATED row, not a constant.
    for (const [code, rate] of [['USD', 84.25], ['AED', 22.94], ['EUR', 91.10], ['THB', 2.42]] as const) {
      run('INSERT OR IGNORE INTO exchange_rates (org_id, code, on_date, rate_e6) VALUES (?,?,?,?)',
        orgId, code, today, Math.round(rate * 1_000_000));
    }

    // -------------------------------------------------- chart of accounts
    const acc: Record<string, string> = {};
    const chart: Array<[string, string, string, boolean?]> = [
      // Assets
      ['100000', 'Cash on Hand', 'asset_cash'],
      ['101000', 'HDFC Bank — Current', 'asset_cash'],
      ['101100', 'ICICI Bank — Collections', 'asset_cash'],
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
      // Liabilities
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
      // Equity
      ['300000', 'Owner Capital', 'equity'],
      ['310000', 'Retained Earnings', 'equity_unaffected'],
      // Revenue
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
      // Direct trip costs
      ['500000', 'Hotel Cost', 'expense_direct'],
      ['501000', 'Flight Cost', 'expense_direct'],
      ['502000', 'Transport Cost', 'expense_direct'],
      ['503000', 'Visa Cost', 'expense_direct'],
      ['504000', 'Sightseeing Cost', 'expense_direct'],
      ['505000', 'Supplier Charges', 'expense_direct'],
      ['506000', 'Tour Guide Cost', 'expense_direct'],
      ['507000', 'Package Direct Cost', 'expense_direct'],
      // Operating expenses
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
      ['609000', 'Depreciation', 'expense_depreciation'],
    ];
    for (const [code, name, kind, reconcilable] of chart) {
      acc[code] = upsertAccount(orgId, { code, name, kind, reconcilable });
    }

    // ---------------------------------------------------------- journals
    const jrn: Record<string, string> = {};
    const journals: Array<[string, string, string, string | null]> = [
      ['SAL', 'Customer Invoices', 'sale', null],
      ['SCN', 'Customer Credit Notes', 'sale', null],
      ['PUR', 'Vendor Bills', 'purchase', null],
      ['PCN', 'Vendor Credit Notes', 'purchase', null],
      ['BNK', 'HDFC Bank', 'bank', acc['101000']],
      ['COL', 'ICICI Collections', 'bank', acc['101100']],
      ['CSH', 'Cash', 'cash', acc['100000']],
      ['EXP', 'Employee Expenses', 'general', null],
      ['MSC', 'Miscellaneous', 'general', null],
    ];
    for (const [code, name, type, account] of journals) {
      jrn[code] = upsertJournal(orgId, { code, name, type, defaultAccountId: account });
    }

    // Bank accounts, which are what the Banking screen actually lists.
    const bankAccounts: Array<[string, string, string, string, string, number]> = [
      ['bnk_hdfc', 'HDFC Bank — Current', 'HDFC Bank', '50100234561234', acc['101000'], 0],
      ['bnk_icici', 'ICICI Collections', 'ICICI Bank', '002105001234', acc['101100'], 0],
      ['bnk_cash', 'Petty Cash', '', '', acc['100000'], 1],
    ];
    for (const [bid, name, bank, no, accountId, isCash] of bankAccounts) {
      run(
        `INSERT INTO bank_accounts (id, org_id, name, bank_name, account_no, ifsc, currency, is_cash, account_id, journal_id, active)
         VALUES (?,?,?,?,?,?, 'INR', ?,?,?,1)`,
        bid, orgId, name, bank || null, no || null, bank ? 'HDFC0000123' : null,
        isCash, accountId, isCash ? jrn.CSH : bid === 'bnk_hdfc' ? jrn.BNK : jrn.COL,
      );
    }
    run('UPDATE journals SET bank_account_id=? WHERE id=?', 'bnk_hdfc', jrn.BNK);
    run('UPDATE journals SET bank_account_id=? WHERE id=?', 'bnk_icici', jrn.COL);
    run('UPDATE journals SET bank_account_id=? WHERE id=?', 'bnk_cash', jrn.CSH);

    // ------------------------------------------------------- payment terms
    const terms: Array<[string, string, number]> = [
      ['pt_imm', 'Immediate', 0],
      ['pt_7', '7 days', 7],
      ['pt_15', '15 days', 15],
      ['pt_30', '30 days', 30],
      ['pt_45', '45 days', 45],
    ];
    for (const [tid, name, days] of terms) {
      run('INSERT INTO payment_terms (id, org_id, name, days) VALUES (?,?,?,?)', tid, orgId, name, days);
    }

    // --------------------------------------------------------------- taxes
    // A CGST+SGST pair is one tax on screen and two in the ledger. The parent
    // carries the rate the customer sees; the children carry half each and the
    // accounts the return is filed from.
    const tax: Record<string, string> = {};
    const gstPairs: Array<[string, number, 'sale' | 'purchase']> = [
      ['GST 5%', 500, 'sale'], ['GST 12%', 1200, 'sale'], ['GST 18%', 1800, 'sale'],
      ['GST 5%', 500, 'purchase'], ['GST 12%', 1200, 'purchase'], ['GST 18%', 1800, 'purchase'],
    ];
    for (const [name, bps, scope] of gstPairs) {
      const parentId = id('tax');
      const sale = scope === 'sale';
      run(
        `INSERT INTO taxes (id, org_id, name, computation, rate_bps, scope, tax_group,
                            price_included, account_id, active)
         VALUES (?,?,?,'percent',?,?,'cgst_sgst',0,NULL,1)`,
        parentId, orgId, `${name} (${sale ? 'Sales' : 'Purchase'})`, bps, scope,
      );
      for (const [half, account] of [
        ['CGST', sale ? acc['210000'] : acc['170000']],
        ['SGST', sale ? acc['210100'] : acc['170100']],
      ] as const) {
        const childId = id('tax');
        run(
          `INSERT INTO taxes (id, org_id, name, computation, rate_bps, scope, tax_group,
                              price_included, account_id, active)
           VALUES (?,?,?,'percent',?,?,'gst',0,?,1)`,
          childId, orgId, `${half} ${(bps / 200).toFixed(bps % 200 ? 1 : 0)}%`, bps / 2, scope, account,
        );
        run('INSERT INTO tax_children (parent_id, child_id) VALUES (?,?)', parentId, childId);
      }
      tax[`${scope}_${bps}`] = parentId;
    }
    // Interstate and overseas supply: one 18% IGST line, no split.
    for (const scope of ['sale', 'purchase'] as const) {
      const igstId = id('tax');
      run(
        `INSERT INTO taxes (id, org_id, name, computation, rate_bps, scope, tax_group,
                            price_included, account_id, active)
         VALUES (?,?,?,'percent',1800,?,'igst',0,?,1)`,
        igstId, orgId, `IGST 18% (${scope === 'sale' ? 'Sales' : 'Purchase'})`, scope,
        scope === 'sale' ? acc['210200'] : acc['170200'],
      );
      tax[`igst_${scope}`] = igstId;
    }
    // Withholding. Thresholds are annual limits under the relevant section and
    // are configuration, not code: change the row, not this file.
    const tdsRows: Array<[string, number, number]> = [
      ['TDS 194C — Contractors 2%', 200, 10_000_00],
      ['TDS 194H — Commission 5%', 500, 2_000_00],
      ['TDS 194J — Professional 10%', 1000, 5_000_00],
    ];
    for (const [name, bps, threshold] of tdsRows) {
      const tid = id('tax');
      run(
        `INSERT INTO taxes (id, org_id, name, computation, rate_bps, scope, tax_group,
                            price_included, account_id, threshold, active)
         VALUES (?,?,?,'percent',?,'purchase','tds',0,?,?,1)`,
        tid, orgId, name, bps, acc['220000'], threshold,
      );
      tax[`tds_${bps}`] = tid;
    }

    // ----------------------------------------------- analytic plans (§24–25)
    const plans: Array<[string, string, string[]]> = [
      ['TRIPS', 'Trips', []],
      ['DEPT', 'Departments', ['Sales', 'Operations', 'Marketing', 'Administration']],
      ['BRANCH', 'Branches', ['Hyderabad', 'Chennai', 'Mumbai']],
      ['AGENT', 'Agents', ['Sai Kiran', 'Meera Rao', 'Arjun Das']],
    ];
    for (const [code, name, members] of plans) {
      const planId = id('plan');
      run('INSERT INTO analytic_plans (id, org_id, name, code) VALUES (?,?,?,?)', planId, orgId, name, code);
      members.forEach((m, i) => {
        run(
          'INSERT INTO analytic_accounts (id, org_id, plan_id, code, name, active) VALUES (?,?,?,?,?,1)',
          id('ana'), orgId, planId, `${code}-${i + 1}`, m,
        );
      });
    }

    // ---------------------------------------------------- default accounts
    const settings: Array<[Parameters<typeof setSetting>[1], string]> = [
      ['account.receivable', acc['110000']],
      ['account.payable', acc['200000']],
      ['account.customer_advance', acc['240000']],
      ['account.supplier_advance', acc['130000']],
      ['account.customer_refund_payable', acc['230000']],
      ['account.input_tax', acc['170000']],
      ['account.output_tax', acc['210000']],
      ['account.tds_payable', acc['220000']],
      ['account.retained_earnings', acc['310000']],
      ['account.current_year', acc['310000']],
      ['account.fx_gain', acc['410000']],
      ['account.fx_loss', acc['611000']],
      ['account.bank_charges', acc['606000']],
      ['account.commission_expense', acc['610000']],
      ['account.commission_payable', acc['245000']],
      ['account.employee_advance', acc['135000']],
      ['account.rounding', acc['409000']],
      ['account.opening_balance', acc['300000']],
      ['journal.sale', jrn.SAL],
      ['journal.sale_refund', jrn.SCN],
      ['journal.purchase', jrn.PUR],
      ['journal.purchase_refund', jrn.PCN],
      ['journal.bank', jrn.BNK],
      ['journal.cash', jrn.CSH],
      ['journal.customer_payment', jrn.COL],
      ['journal.vendor_payment', jrn.BNK],
      ['journal.general', jrn.MSC],
      ['journal.expense', jrn.EXP],
      ['journal.asset', jrn.MSC],
    ];
    for (const [key, value] of settings) setSetting(orgId, key, value);

    // ------------------------------------------------------------ products
    const products: Array<[string, string, number, number, string, string]> = [
      ['Bali 5D/4N Package', 'package', 150_000_00, 112_000_00, acc['400000'], acc['507000']],
      ['Dubai 4D/3N Package', 'package', 95_000_00, 71_000_00, acc['400000'], acc['507000']],
      ['Goa Weekend Package', 'package', 32_000_00, 22_000_00, acc['400000'], acc['507000']],
      ['Hotel Booking', 'hotel', 0, 0, acc['401000'], acc['500000']],
      ['Flight Ticket', 'flight', 0, 0, acc['402000'], acc['501000']],
      ['Visa Processing', 'visa', 10_000_00, 6_500_00, acc['403000'], acc['503000']],
      ['Airport Transfer', 'transport', 5_000_00, 3_200_00, acc['404000'], acc['502000']],
      ['Sightseeing Tour', 'sightseeing', 8_000_00, 5_000_00, acc['405000'], acc['504000']],
      ['Service Fee', 'fee', 2_500_00, 0, acc['406000'], acc['505000']],
    ];
    for (const [name, category, sale, cost, income, expense] of products) {
      upsertProduct(orgId, {
        name, category, salePrice: sale, costPrice: cost,
        incomeAccountId: income, expenseAccountId: expense,
        saleTaxId: tax.sale_500, purchaseTaxId: tax.purchase_1800,
      });
    }

    // ------------------------------------------------------- fiscal periods
    const fy = fiscalYearOf(today, 4);
    createFiscalYear(orgId, fy.from);
  });

  if (DEMO) seedDemo(orgId);
}

/**
 * A season of trading.
 *
 * Every figure below goes through the same services the screens call, so this
 * doubles as the worked example for the 30 scenarios in plan section 51:
 * advance, invoice, partial payment, supplier bill with TDS, cancellation and
 * credit note, employee expense, depreciation, commission, FX purchase.
 */
function seedDemo(orgId: string) {
  const actor = { id: 'usr_admin', name: 'Admin User', role: 'admin' };
  const today = isoDate();
  const acc = (code: string) =>
    one<{ id: string }>('SELECT id FROM accounts WHERE org_id=? AND code=?', orgId, code)!.id;
  const jrn = (code: string) =>
    one<{ id: string }>('SELECT id FROM journals WHERE org_id=? AND code=?', orgId, code)!.id;
  // Taxes are looked up by the name the seed gave them. Matching on the name
  // rather than on a hard-coded id keeps the demo readable and survives an
  // agency renaming its own tax rows.
  const taxId = (name: string) =>
    one<{ id: string }>(
      `SELECT id FROM taxes WHERE org_id=? AND name LIKE ?
         AND id NOT IN (SELECT child_id FROM tax_children)`,
      orgId, name,
    )?.id ?? null;
  const fy = fiscalYearOf(today, 4);
  const d = (offset: number) => addDays(today, offset);

  // ------------------------------------------------------- opening balances
  postOpeningBalances(orgId, {
    date: fy.from,
    lines: [
      { accountId: acc('101000'), debit: 18_50_000_00, credit: 0, label: 'HDFC opening' },
      { accountId: acc('100000'), debit: 45_000_00, credit: 0, label: 'Cash opening' },
      { accountId: acc('150000'), debit: 4_20_000_00, credit: 0, label: 'Office equipment' },
      { accountId: acc('300000'), debit: 0, credit: 20_00_000_00, label: 'Owner capital' },
      { accountId: acc('310000'), debit: 0, credit: 3_15_000_00, label: 'Retained earnings' },
    ],
  }, actor);

  // -------------------------------------------------------------- partners
  const customers: Array<[string, string, string, string, number]> = [
    ['Rahul Mehta', 'b2c', 'rahul.mehta@gmail.com', '+91 98490 11223', 0],
    ['Sneha Reddy', 'b2c', 'sneha.reddy@gmail.com', '+91 99590 44556', 0],
    ['Infosys Travel Desk', 'b2b', 'travel@infosys-demo.in', '+91 80 4000 1111', 10_00_000_00],
    ['Skyline Holidays (Reseller)', 'reseller', 'ops@skylineholidays.in', '+91 44 2233 4455', 5_00_000_00],
    ['Arun Prakash', 'b2c', 'arun.p@outlook.com', '+91 97000 77889', 0],
  ];
  const cust: Record<string, string> = {};
  for (const [name, type, email, phone, limit] of customers) {
    cust[name] = upsertPartner(orgId, {
      name, isCustomer: true, partnerType: type, email, phone,
      creditLimit: limit, paymentTermsId: limit ? 'pt_30' : 'pt_imm',
      gstin: type === 'b2b' ? '29AAACI1681G1ZR' : null,
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
    supp[name] = upsertPartner(orgId, {
      name, isSupplier: true, partnerType: 'b2b', address: note,
      tdsSection: tds, paymentTermsId: 'pt_15',
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
    bkg[ref] = createBooking(orgId, {
      ref, title, destination: dest, packageName: pkg,
      partnerId: cust[customer], agentName: agent, branch: 'Hyderabad',
      pax, startDate: d(offset), endDate: d(offset + 5), sellValue: value,
    }, actor);
  }
  const analyticOf = (bookingId: string) =>
    one<{ analytic_id: string }>('SELECT analytic_id FROM bookings WHERE id=?', bookingId)!.analytic_id;

  const gstSale5 = taxId('GST 5% (Sales)');
  const gstSale18 = taxId('GST 18% (Sales)');
  const gstPur18 = taxId('GST 18% (Purchase)');
  const gstPur5 = taxId('GST 5% (Purchase)');
  const tds194c = taxId('TDS 194C%');

  // ------------------------------------------------ BK-1023: the full cycle
  // Advance first, as travel actually works: money before the invoice exists.
  const advance = createPayment({
    orgId, direction: 'inbound', partnerId: cust['Rahul Mehta'],
    journalId: jrn('COL'), bankAccountId: 'bnk_icici', bookingId: bkg['BK-1023'],
    payDate: d(-160), amount: 50_000_00, method: 'upi', reference: 'UPI/4412093',
    isAdvance: true,
  }, actor);

  const inv1023 = createDocument({
    orgId, docType: 'out_invoice', partnerId: cust['Rahul Mehta'],
    journalId: jrn('SAL'), bookingId: bkg['BK-1023'], analyticId: analyticOf(bkg['BK-1023']),
    docDate: d(-150), paymentTermsId: 'pt_15',
    lines: [
      { name: 'Bali 5D/4N Package — 2 pax', qtyMilli: 1000, unitPrice: 1_50_000_00, accountId: acc('400000'), taxId: gstSale5 },
      { name: 'Visa Services', qtyMilli: 2000, unitPrice: 5_000_00, accountId: acc('403000'), taxId: gstSale18 },
      { name: 'Airport Transfer', qtyMilli: 1000, unitPrice: 5_000_00, accountId: acc('404000'), taxId: gstSale5 },
    ],
  }, actor);
  postDocument(orgId, inv1023, actor);

  // The advance is applied, then the balance arrives in two instalments.
  const invTotal = one<{ total: number }>('SELECT total FROM documents WHERE id=?', inv1023)!.total;
  applyAdvance(orgId, advance, inv1023, 50_000_00, actor);
  createPayment({
    orgId, direction: 'inbound', partnerId: cust['Rahul Mehta'], journalId: jrn('BNK'),
    bankAccountId: 'bnk_hdfc', bookingId: bkg['BK-1023'], payDate: d(-140),
    amount: 90_000_00, method: 'neft', reference: 'NEFT/HDFC/88231',
    allocations: [{ documentId: inv1023, amount: 90_000_00 }],
  }, actor);
  createPayment({
    orgId, direction: 'inbound', partnerId: cust['Rahul Mehta'], journalId: jrn('BNK'),
    bankAccountId: 'bnk_hdfc', bookingId: bkg['BK-1023'], payDate: d(-132),
    amount: Math.min(40_000_00, invTotal - 1_40_000_00), method: 'upi', reference: 'UPI/5590231',
    allocations: [{ documentId: inv1023, amount: Math.min(40_000_00, invTotal - 1_40_000_00) }],
  }, actor);

  // Supplier side of the same trip.
  const billHotel = createDocument({
    orgId, docType: 'in_invoice', partnerId: supp['Taj Resorts Bali'],
    journalId: jrn('PUR'), bookingId: bkg['BK-1023'], analyticId: analyticOf(bkg['BK-1023']),
    docDate: d(-148), supplierRef: 'TRB/2026/4471', paymentTermsId: 'pt_15',
    lines: [{ name: 'Bali — 4 nights, deluxe twin', qtyMilli: 1000, unitPrice: 80_000_00, accountId: acc('500000') }],
  }, actor);
  postDocument(orgId, billHotel, actor);

  const billFlight = createDocument({
    orgId, docType: 'in_invoice', partnerId: supp['SkyWings Air Consolidator'],
    journalId: jrn('PUR'), bookingId: bkg['BK-1023'], analyticId: analyticOf(bkg['BK-1023']),
    docDate: d(-147), supplierRef: 'SW-99211', paymentTermsId: 'pt_7',
    withholdingTaxId: tds194c,
    lines: [{ name: 'HYD–DPS return, 2 pax', qtyMilli: 1000, unitPrice: 60_000_00, accountId: acc('501000') }],
  }, actor);
  postDocument(orgId, billFlight, actor);

  for (const [billId, amount, date] of [[billHotel, 80_000_00, d(-135)], [billFlight, 58_800_00, d(-140)]] as const) {
    const residual = one<{ residual: number }>('SELECT residual FROM documents WHERE id=?', billId)!.residual;
    const partner = one<{ partner_id: string }>('SELECT partner_id FROM documents WHERE id=?', billId)!.partner_id;
    createPayment({
      orgId, direction: 'outbound', partnerId: partner, journalId: jrn('BNK'),
      bankAccountId: 'bnk_hdfc', bookingId: bkg['BK-1023'], payDate: date,
      amount: Math.min(amount, residual), method: 'neft',
      allocations: [{ documentId: billId, amount: Math.min(amount, residual) }],
    }, actor);
  }

  // Trip extras that never see a vendor bill: a guide paid in cash.
  const guideExpense = createExpense({
    orgId, employeeName: 'Sai Kiran', description: 'Local guide — Bali day 3',
    expenseDate: d(-138), amount: 10_000_00, accountId: acc('506000'),
    analyticId: analyticOf(bkg['BK-1023']), bookingId: bkg['BK-1023'],
    paidBy: 'employee', journalId: jrn('EXP'),
  }, actor);
  approveExpense(orgId, guideExpense, actor);

  // ---------------------------------------------- BK-1024: Goa, cancelled
  const inv1024 = createDocument({
    orgId, docType: 'out_invoice', partnerId: cust['Sneha Reddy'],
    journalId: jrn('SAL'), bookingId: bkg['BK-1024'], analyticId: analyticOf(bkg['BK-1024']),
    docDate: d(-100), paymentTermsId: 'pt_imm',
    lines: [
      { name: 'Goa Weekend — 4 pax', qtyMilli: 4000, unitPrice: 32_000_00, accountId: acc('400000'), taxId: gstSale5 },
    ],
  }, actor);
  postDocument(orgId, inv1024, actor);
  createPayment({
    orgId, direction: 'inbound', partnerId: cust['Sneha Reddy'], journalId: jrn('COL'),
    bankAccountId: 'bnk_icici', bookingId: bkg['BK-1024'], payDate: d(-99),
    amount: 1_34_400_00, method: 'card', reference: 'CARD/4411',
    allocations: [{ documentId: inv1024, amount: 1_34_400_00 }],
  }, actor);
  const billCabs = createDocument({
    orgId, docType: 'in_invoice', partnerId: supp['Coastal Cabs Goa'],
    journalId: jrn('PUR'), bookingId: bkg['BK-1024'], analyticId: analyticOf(bkg['BK-1024']),
    docDate: d(-98), supplierRef: 'CC-3321',
    lines: [{ name: 'Airport transfers + sightseeing', qtyMilli: 1000, unitPrice: 18_000_00, accountId: acc('502000'), taxId: gstPur5 }],
  }, actor);
  postDocument(orgId, billCabs, actor);

  // Cancelled trip: 70% retained as a cancellation charge, 30% credited back.
  const cn = createCreditNote(orgId, inv1024, {
    date: d(-90), bps: 3000, reason: 'Customer cancellation — 70% retained',
  }, actor);
  postDocument(orgId, cn, actor);
  const cnResidual = one<{ residual: number }>('SELECT residual FROM documents WHERE id=?', cn)!.residual;
  const invResidual = one<{ residual: number }>('SELECT residual FROM documents WHERE id=?', inv1024)!.residual;
  if (cnResidual > 0 && invResidual > 0) {
    applyCreditNote(orgId, cn, inv1024, Math.min(cnResidual, invResidual), actor);
  } else if (cnResidual > 0) {
    // Already fully paid, so the credit is refunded rather than netted off.
    createPayment({
      orgId, direction: 'outbound', side: 'customer',
      partnerId: cust['Sneha Reddy'], journalId: jrn('COL'),
      bankAccountId: 'bnk_icici', bookingId: bkg['BK-1024'], payDate: d(-88),
      amount: cnResidual, method: 'neft', reference: 'Refund — cancellation',
      allocations: [{ documentId: cn, amount: cnResidual }],
    }, actor);
  }
  run("UPDATE bookings SET status='cancelled' WHERE id=?", bkg['BK-1024']);

  // ------------------------------------- BK-1025: corporate, part paid, FX
  const inv1025 = createDocument({
    orgId, docType: 'out_invoice', partnerId: cust['Infosys Travel Desk'],
    journalId: jrn('SAL'), bookingId: bkg['BK-1025'], analyticId: analyticOf(bkg['BK-1025']),
    docDate: d(-58), paymentTermsId: 'pt_30',
    lines: [
      { name: 'Dubai 4D/3N — 12 pax', qtyMilli: 12000, unitPrice: 95_000_00, accountId: acc('400000'), taxId: gstSale5 },
      { name: 'Corporate service fee', qtyMilli: 1000, unitPrice: 25_000_00, accountId: acc('406000'), taxId: gstSale18 },
    ],
  }, actor);
  postDocument(orgId, inv1025, actor);
  createPayment({
    orgId, direction: 'inbound', partnerId: cust['Infosys Travel Desk'], journalId: jrn('BNK'),
    bankAccountId: 'bnk_hdfc', bookingId: bkg['BK-1025'], payDate: d(-40),
    amount: 8_00_000_00, method: 'neft', reference: 'INFY/PO/88213',
    allocations: [{ documentId: inv1025, amount: 8_00_000_00 }],
  }, actor);

  // A foreign-currency purchase: AED 30,000 for the ground handler, booked in
  // rupees at the day's rate with the face value kept for the audit trail.
  const billDmc = createDocument({
    orgId, docType: 'in_invoice', partnerId: supp['Dubai DMC Services'],
    journalId: jrn('PUR'), bookingId: bkg['BK-1025'], analyticId: analyticOf(bkg['BK-1025']),
    docDate: d(-55), supplierRef: 'DMC/26/1187', currency: 'AED', rateE6: 22_940_000,
    lines: [{ name: 'Dubai ground handling — 12 pax (AED 30,000)', qtyMilli: 1000, unitPrice: 6_88_200_00, accountId: acc('505000') }],
  }, actor);
  postDocument(orgId, billDmc, actor);
  createPayment({
    orgId, direction: 'outbound', partnerId: supp['Dubai DMC Services'], journalId: jrn('BNK'),
    bankAccountId: 'bnk_hdfc', bookingId: bkg['BK-1025'], payDate: d(-45),
    amount: 4_00_000_00, method: 'neft', reference: 'SWIFT/AED',
    allocations: [{ documentId: billDmc, amount: 4_00_000_00 }],
  }, actor);

  // --------------------------------------------- BK-1026: awaiting payment
  const inv1026 = createDocument({
    orgId, docType: 'out_invoice', partnerId: cust['Arun Prakash'],
    journalId: jrn('SAL'), bookingId: bkg['BK-1026'], analyticId: analyticOf(bkg['BK-1026']),
    docDate: d(-30), paymentTermsId: 'pt_15',
    lines: [
      { name: 'Singapore 6D — 3 pax', qtyMilli: 3000, unitPrice: 1_05_000_00, accountId: acc('400000'), taxId: gstSale5 },
      { name: 'Visa Processing — 3 pax', qtyMilli: 3000, unitPrice: 5_000_00, accountId: acc('403000'), taxId: gstSale18 },
    ],
  }, actor);
  postDocument(orgId, inv1026, actor);
  const billVisa = createDocument({
    orgId, docType: 'in_invoice', partnerId: supp['VisaExpress Pvt Ltd'],
    journalId: jrn('PUR'), bookingId: bkg['BK-1026'], analyticId: analyticOf(bkg['BK-1026']),
    docDate: d(-28), supplierRef: 'VE-7781', withholdingTaxId: taxId('TDS 194J%'),
    lines: [{ name: 'Singapore visas — 3 pax', qtyMilli: 3000, unitPrice: 3_500_00, accountId: acc('503000'), taxId: gstPur18 }],
  }, actor);
  postDocument(orgId, billVisa, actor);

  // ------------------------------------------- BK-1027: upcoming, advance
  createPayment({
    orgId, direction: 'inbound', partnerId: cust['Skyline Holidays (Reseller)'],
    journalId: jrn('BNK'), bankAccountId: 'bnk_hdfc', bookingId: bkg['BK-1027'],
    payDate: d(-10), amount: 3_00_000_00, method: 'neft', reference: 'SKY/ADV/2211',
    isAdvance: true,
  }, actor);
  createPayment({
    orgId, direction: 'outbound', partnerId: supp['Taj Resorts Bali'], journalId: jrn('BNK'),
    bankAccountId: 'bnk_hdfc', bookingId: bkg['BK-1027'], payDate: d(-8),
    amount: 1_50_000_00, method: 'neft', reference: 'Advance — Bali Oct block',
    isAdvance: true,
  }, actor);

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
    postSimple(orgId, {
      journalId: jrn('BNK'), date: d(offset), label,
      debitAccount: acc(code), creditAccount: acc('101000'), amount,
    }, actor);
  }
  const marketingBill = createDocument({
    orgId, docType: 'in_invoice', partnerId: supp['Bright Media Agency'],
    journalId: jrn('PUR'), docDate: d(-35), supplierRef: 'BM-2211',
    withholdingTaxId: taxId('TDS 194J%'),
    lines: [{ name: 'Instagram campaign — September', qtyMilli: 1000, unitPrice: 1_20_000_00, accountId: acc('602000'), taxId: gstPur18 }],
  }, actor);
  postDocument(orgId, marketingBill, actor);

  // --------------------------------------------- assets and deferrals
  const laptops = createAsset({
    orgId, name: 'MacBook Air M4 × 3',
    assetAccountId: acc('150000'), depreciationAccountId: acc('155000'),
    expenseAccountId: acc('609000'), journalId: jrn('MSC'),
    purchaseDate: fy.from, purchaseValue: 3_60_000_00, salvageValue: 30_000_00,
    method: 'straight_line', lifeMonths: 36,
  }, actor);
  confirmAsset(orgId, laptops, actor);
  runDepreciation(orgId, today, actor);

  const insurance = createDeferral({
    orgId, name: 'Office & travel insurance — annual',
    kind: 'expense', balanceAccountId: acc('140000'), recognitionAccountId: acc('605000'),
    journalId: jrn('MSC'), amount: 1_20_000_00, dateFrom: fy.from, months: 12,
  }, actor);
  // The premium was paid up front, which is what puts it on the prepaid account
  // in the first place.
  postSimple(orgId, {
    journalId: jrn('BNK'), date: fy.from, label: 'Annual insurance premium',
    debitAccount: acc('140000'), creditAccount: acc('101000'), amount: 1_20_000_00,
  }, actor);
  runDeferrals(orgId, today, actor);
  void insurance;

  // ------------------------------------------------------- commissions
  for (const [ref, agent, bps] of [['BK-1023', 'Sai Kiran', 500], ['BK-1025', 'Sai Kiran', 300], ['BK-1026', 'Arjun Das', 500]] as const) {
    const commissionId = createCommission(orgId, {
      agentName: agent, bookingId: bkg[ref], basis: 'revenue', rateBps: bps,
    }, actor);
    const amount = one<{ amount: number }>('SELECT amount FROM commissions WHERE id=?', commissionId)!.amount;
    if (amount > 0) postCommission(orgId, commissionId, d(-5), actor);
  }

  // ------------------------------------------------------------ budgets
  createBudget(orgId, {
    name: 'FY operating budget', owner: 'Priya Nair',
    dateFrom: fy.from, dateTo: fy.to,
    lines: [
      { accountId: acc('600000'), planned: 28_00_000_00 },
      { accountId: acc('601000'), planned: 6_60_000_00 },
      { accountId: acc('602000'), planned: 8_00_000_00 },
      { accountId: acc('603000'), planned: 1_80_000_00 },
      { accountId: acc('607000'), planned: 2_40_000_00 },
    ],
  }, actor);

  // ------------------------------------------- an unreconciled statement
  // Left deliberately unmatched, so the Reconciliation screen has real work in
  // it on a fresh install — including one line that is not a customer receipt.
  importStatement(orgId, 'bnk_hdfc', [
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
function postSimple(orgId: string, o: {
  journalId: string; date: string; label: string;
  debitAccount: string; creditAccount: string; amount: number;
}, actor: { id?: string; name?: string }) {
  return postEntry({
    orgId, journalId: o.journalId, date: o.date, reference: o.label, narration: o.label,
    sourceModel: 'manual',
    lines: [
      { accountId: o.debitAccount, debit: o.amount, label: o.label },
      { accountId: o.creditAccount, credit: o.amount, label: o.label },
    ],
  }, actor);
}

/** Apply a posted advance to a posted invoice. Thin wrapper for readability. */
function applyAdvance(orgId: string, paymentId: string, documentId: string, amount: number, actor: { id?: string; name?: string }) {
  allocate(orgId, paymentId, documentId, amount, actor);
}
