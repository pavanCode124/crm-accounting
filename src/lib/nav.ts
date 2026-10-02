import { can, type FinanceCap } from './accounting';
import { searchTokens } from './search';

/**
 * THE ONE MENU REGISTRY.
 *
 * The CRM learned this the hard way: the web app ships three panels with three
 * menu files, and a screen added to one and missed in the others is a feature
 * half the staff never sees. There is exactly one list here, every entry names
 * the capability that reveals it, and adding a second list is the thing to
 * avoid rather than the thing to do.
 *
 * The tree mirrors plan section 47 verbatim, so a reader holding the plan can
 * find any screen by walking the same path.
 */

export interface NavItem {
  label: string;
  href: string;
  cap?: FinanceCap;
  /** Matched as a prefix so a detail page keeps its parent highlighted. */
  match?: string;
  /**
   * Extra words the search bar should find this screen by.
   *
   * The label is what the menu calls a screen; these are what a person calls
   * it out loud. An accountant asks for "P&L" and a manager asks for "margin
   * by trip", and neither phrase appears in the menu text.
   */
  keywords?: string[];
}

/**
 * A section carries no colour and no icon.
 *
 * It used to carry both, mirroring the CRM's SECTION table. In a CRM that works
 * — the sections are places, and a colour per place helps you learn the map. In
 * a ledger it fights the content: red, green and amber already MEAN something
 * on these screens, and a menu that spends nine more hues on decoration leaves
 * the reader deciding, every time, whether a colour is telling them something.
 * The masthead marks the active section by weight and an underline instead.
 */
export interface NavSection {
  key: string;
  label: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    key: 'overview',
    label: 'Overview',
    items: [
      { label: 'Finance Overview', href: '/', keywords: ['dashboard', 'home', 'kpi'] },
      { label: 'Bookings', href: '/bookings', match: '/bookings', keywords: ['trips', 'tours', 'reservations'] },
    ],
  },
  {
    key: 'sales',
    label: 'Sales',
    items: [
      { label: 'Invoices', href: '/sales/invoices', match: '/sales/invoices', cap: 'finance.view', keywords: ['sales', 'billing', 'receivable', 'tax invoice'] },
      { label: 'Payments Received', href: '/sales/payments', match: '/sales/payments', keywords: ['receipts', 'collections', 'customer payments'] },
      /*
       * UNDER SALES, not under Banking, and that placement is an argument.
       *
       * A channel settlement arrives as one bank credit, which makes it look
       * like a banking screen. It is not: what it settles is a month of
       * INVOICES, and the question it answers is "did the channel pay us what
       * it owed for what we sold" — a receivables question. Filed under Banking
       * it would be found by whoever reconciles the statement and missed by
       * whoever chases the money.
       */
      { label: 'Channel Settlements', href: '/settlements', match: '/settlements', cap: 'payment.create', keywords: ['ota', 'payout', 'remittance', 'marketplace'] },
      { label: 'Credit Notes', href: '/sales/credit-notes', match: '/sales/credit-notes', keywords: ['refund', 'cancellation', 'sales return'] },
      { label: 'Customers', href: '/sales/customers', match: '/sales/customers', keywords: ['clients', 'travellers', 'debtors', 'partners'] },
    ],
  },
  {
    key: 'purchases',
    label: 'Purchases',
    items: [
      { label: 'Vendor Bills', href: '/purchases/bills', match: '/purchases/bills', keywords: ['purchase invoices', 'supplier bills', 'payable'] },
      { label: 'Payments Made', href: '/purchases/payments', match: '/purchases/payments', keywords: ['supplier payments', 'outgoing', 'disbursements'] },
      { label: 'Debit Notes', href: '/purchases/debit-notes', match: '/purchases/debit-notes', keywords: ['purchase return', 'vendor credit'] },
      { label: 'Suppliers', href: '/purchases/suppliers', match: '/purchases/suppliers', keywords: ['vendors', 'hotels', 'creditors', 'partners'] },
    ],
  },
  {
    key: 'banking',
    label: 'Banking',
    items: [
      { label: 'Bank Accounts', href: '/banking', match: '/banking', keywords: ['cash', 'statements', 'balances'] },
      { label: 'Reconciliation', href: '/banking/reconcile', match: '/banking/reconcile', cap: 'bank.reconcile', keywords: ['reconcile', 'match statement', 'brs'] },
    ],
  },
  {
    key: 'accounting',
    label: 'Accounting',
    items: [
      /*
       * FIRST in the section, deliberately.
       *
       * It is the screen an accountant opens most days and the only place
       * anything enters the ledger. Sorting it under J for Journal, between
       * two configuration screens, buried the daily job under the annual one.
       */
      { label: 'Review & Post', href: '/accounting/review', match: '/accounting/review', keywords: ['approve', 'drafts', 'posting'] },
      { label: 'Chart of Accounts', href: '/accounting/chart-of-accounts', match: '/accounting/chart-of-accounts', keywords: ['coa', 'ledgers', 'account codes'] },
      { label: 'Journal Entries', href: '/accounting/entries', match: '/accounting/entries', keywords: ['vouchers', 'manual entry', 'double entry'] },
      { label: 'Journals', href: '/accounting/journals', match: '/accounting/journals' },
      { label: 'Accounting Periods', href: '/accounting/periods', match: '/accounting/periods', keywords: ['year end', 'close books', 'lock period'] },
      { label: 'Opening Balances', href: '/accounting/opening-balances', cap: 'coa.configure', keywords: ['migration', 'carry forward'] },
      { label: 'Audit Trail', href: '/accounting/audit', match: '/accounting/audit', keywords: ['history', 'who changed', 'log'] },
    ],
  },
  {
    /**
     * THE PRIMARY BOOKS, as a section of their own.
     *
     * They used to be scattered: the General Ledger and the Trial Balance sat
     * under Reports, beside the P&L. That is the wrong grouping. A financial
     * STATEMENT is a summary prepared for a reader; a BOOK is the record the
     * statements are prepared from, and an accountant reaching for a day book
     * is doing a different job from one reaching for a balance sheet. They are
     * moved here rather than repeated — one entry per screen, still.
     */
    key: 'books',
    label: 'Books',
    items: [
      { label: 'Day Book', href: '/reports/day-book', match: '/reports/day-book', cap: 'reports.view', keywords: ['daily register', 'transactions'] },
      { label: 'Ledger Account', href: '/reports/ledger-account', match: '/reports/ledger-account', cap: 'reports.view', keywords: ['account statement', 't account'] },
      { label: 'General Ledger', href: '/reports/general-ledger', match: '/reports/general-ledger', cap: 'reports.view', keywords: ['gl', 'all accounts'] },
      { label: 'Cash Book', href: '/reports/cash-book', match: '/reports/cash-book', cap: 'reports.view' },
      { label: 'Bank Book', href: '/reports/bank-book', match: '/reports/bank-book', cap: 'reports.view' },
      { label: 'Trial Balance', href: '/reports/trial-balance', match: '/reports/trial-balance', cap: 'reports.view', keywords: ['tb', 'debits credits'] },
    ],
  },
  {
    key: 'taxes',
    label: 'Taxes',
    items: [
      { label: 'Taxes & TDS', href: '/taxes', match: '/taxes', keywords: ['gst', 'tcs', 'withholding', 'hsn', 'sac'] },
      { label: 'Tax Report', href: '/reports/tax', keywords: ['gstr', 'gst return', 'output tax', 'input credit'] },
    ],
  },
  {
    key: 'analytics',
    label: 'Analytics',
    items: [
      { label: 'Trip Profitability', href: '/analytics/trips', match: '/analytics/trips', cap: 'profitability.view', keywords: ['margin', 'trip margin', 'profit per trip', 'tour profit'] },
      { label: 'Packages', href: '/analytics/packages', cap: 'profitability.view', keywords: ['package margin', 'itinerary profit'] },
      { label: 'Agents', href: '/analytics/agents', cap: 'profitability.view', keywords: ['agent performance', 'sales rep'] },
      { label: 'Cost Centres', href: '/analytics/cost-centres', cap: 'profitability.view', keywords: ['departments', 'branches', 'analytic'] },
    ],
  },
  {
    key: 'operations',
    label: 'Operations',
    items: [
      { label: 'Expenses', href: '/expenses', match: '/expenses', keywords: ['claims', 'reimbursement', 'spend'] },
      { label: 'Commissions', href: '/commissions', keywords: ['agent commission', 'incentive', 'brokerage'] },
      { label: 'Budgets', href: '/budgets', match: '/budgets', cap: 'budget.manage', keywords: ['forecast', 'plan vs actual'] },
      { label: 'Assets & Deferrals', href: '/assets', match: '/assets', keywords: ['depreciation', 'prepaid', 'amortisation'] },
      { label: 'CRM Sync', href: '/settings/crm-sync', match: '/settings/crm-sync', cap: 'coa.configure', keywords: ['integration', 'tripzocrm', 'import bookings'] },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    items: [
      { label: 'Profit & Loss', href: '/reports/profit-and-loss', cap: 'reports.view', keywords: ['p&l', 'pnl', 'income statement', 'profitability'] },
      { label: 'Balance Sheet', href: '/reports/balance-sheet', cap: 'reports.view', keywords: ['assets liabilities', 'financial position'] },
      { label: 'Cash Flow', href: '/reports/cash-flow', cap: 'reports.view', keywords: ['cashflow', 'liquidity'] },
      { label: 'AR Ageing', href: '/reports/ar-ageing', cap: 'reports.view', keywords: ['receivable ageing', 'overdue customers', 'aging'] },
      { label: 'AP Ageing', href: '/reports/ap-ageing', cap: 'reports.view', keywords: ['payable ageing', 'overdue suppliers', 'aging'] },
      { label: 'Travel Reports', href: '/reports/travel', cap: 'reports.view', keywords: ['pax', 'destination', 'occupancy'] },
    ],
  },
];

export const SETTINGS_ITEM: NavItem = { label: 'Settings', href: '/settings' };

/** The section a path belongs to — the colour its header wears. */
export function sectionFor(pathname: string): NavSection | null {
  for (const s of NAV) {
    for (const i of s.items) {
      if (i.match ? pathname.startsWith(i.match) : pathname === i.href) return s;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Searching the menu
// ---------------------------------------------------------------------------

export interface NavHit extends NavItem {
  /** The section the screen lives under, so a hit says where it was found. */
  section: string;
}

/**
 * Screens matching a query.
 *
 * A finance app has sixty-odd screens and no reader memorises which section a
 * report hangs under. Typing "trip profitability" into the bar and being told
 * nothing matched is the search bar failing at the easiest question it gets —
 * the answer is a menu entry, and the menu is right here.
 *
 * Capability filtering is the same rule the masthead applies: a screen a role
 * cannot open is a screen search must not offer, or the hit is a link to a
 * forbidden page.
 */
export function searchNav(q: string, role: string): NavHit[] {
  const tokens = searchTokens(q).map((t) => t.toLowerCase());
  if (!tokens.length) return [];

  const scored: Array<{ hit: NavHit; score: number }> = [];
  for (const s of NAV) {
    for (const i of s.items) {
      if (i.cap && !can(role, i.cap as FinanceCap)) continue;
      const label = i.label.toLowerCase();
      const haystack = [label, s.label.toLowerCase(), ...(i.keywords ?? [])].join(' ');
      if (!tokens.every((t) => haystack.includes(t))) continue;

      // Label hits beat keyword hits, and a label that STARTS with what was
      // typed beats one that merely contains it, so "tax" offers Taxes & TDS
      // before Trip Profitability's "tax invoice" neighbours.
      const joined = tokens.join(' ');
      const score = label === joined ? 0 : label.startsWith(joined) ? 1 : label.includes(joined) ? 2
        : tokens.every((t) => label.includes(t)) ? 3 : 4;
      scored.push({ hit: { ...i, section: s.label }, score });
    }
  }
  return scored
    .sort((a, b) => a.score - b.score || a.hit.label.localeCompare(b.hit.label))
    .map((x) => x.hit);
}
