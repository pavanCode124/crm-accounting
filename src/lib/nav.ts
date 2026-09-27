import type { FinanceCap } from './accounting';

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
}

export interface NavSection {
  key: string;
  label: string;
  /** The section's deep colour — the CRM's SECTION table. */
  color: string;
  icon: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    key: 'overview',
    label: 'Overview',
    color: 'var(--color-brand)',
    icon: 'grid',
    items: [
      { label: 'Finance Overview', href: '/' },
      { label: 'Bookings', href: '/bookings', match: '/bookings' },
    ],
  },
  {
    key: 'sales',
    label: 'Sales',
    color: 'var(--color-sec-sales)',
    icon: 'receipt',
    items: [
      { label: 'Invoices', href: '/sales/invoices', match: '/sales/invoices', cap: 'finance.view' },
      { label: 'Payments Received', href: '/sales/payments', match: '/sales/payments' },
      { label: 'Credit Notes', href: '/sales/credit-notes', match: '/sales/credit-notes' },
      { label: 'Customers', href: '/sales/customers', match: '/sales/customers' },
    ],
  },
  {
    key: 'purchases',
    label: 'Purchases',
    color: 'var(--color-sec-purchases)',
    icon: 'bag',
    items: [
      { label: 'Vendor Bills', href: '/purchases/bills', match: '/purchases/bills' },
      { label: 'Payments Made', href: '/purchases/payments', match: '/purchases/payments' },
      { label: 'Debit Notes', href: '/purchases/debit-notes', match: '/purchases/debit-notes' },
      { label: 'Suppliers', href: '/purchases/suppliers', match: '/purchases/suppliers' },
    ],
  },
  {
    key: 'banking',
    label: 'Banking',
    color: 'var(--color-sec-banking)',
    icon: 'bank',
    items: [
      { label: 'Bank Accounts', href: '/banking', match: '/banking' },
      { label: 'Reconciliation', href: '/banking/reconcile', match: '/banking/reconcile', cap: 'bank.reconcile' },
    ],
  },
  {
    key: 'accounting',
    label: 'Accounting',
    color: 'var(--color-sec-accounting)',
    icon: 'book',
    items: [
      { label: 'Chart of Accounts', href: '/accounting/chart-of-accounts', match: '/accounting/chart-of-accounts' },
      { label: 'Journal Entries', href: '/accounting/entries', match: '/accounting/entries' },
      { label: 'Journals', href: '/accounting/journals', match: '/accounting/journals' },
      { label: 'Accounting Periods', href: '/accounting/periods', match: '/accounting/periods' },
      { label: 'Opening Balances', href: '/accounting/opening-balances', cap: 'coa.configure' },
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
    color: 'var(--color-sec-books)',
    icon: 'ledger',
    items: [
      { label: 'Day Book', href: '/reports/day-book', match: '/reports/day-book', cap: 'reports.view' },
      { label: 'Ledger Account', href: '/reports/ledger-account', match: '/reports/ledger-account', cap: 'reports.view' },
      { label: 'General Ledger', href: '/reports/general-ledger', match: '/reports/general-ledger', cap: 'reports.view' },
      { label: 'Cash Book', href: '/reports/cash-book', match: '/reports/cash-book', cap: 'reports.view' },
      { label: 'Bank Book', href: '/reports/bank-book', match: '/reports/bank-book', cap: 'reports.view' },
      { label: 'Trial Balance', href: '/reports/trial-balance', match: '/reports/trial-balance', cap: 'reports.view' },
    ],
  },
  {
    key: 'taxes',
    label: 'Taxes',
    color: 'var(--color-sec-taxes)',
    icon: 'percent',
    items: [
      { label: 'Taxes & TDS', href: '/taxes', match: '/taxes' },
      { label: 'Tax Report', href: '/reports/tax' },
    ],
  },
  {
    key: 'analytics',
    label: 'Analytics',
    color: 'var(--color-sec-analytics)',
    icon: 'chart',
    items: [
      { label: 'Trip Profitability', href: '/analytics/trips', match: '/analytics/trips', cap: 'profitability.view' },
      { label: 'Packages', href: '/analytics/packages', cap: 'profitability.view' },
      { label: 'Agents', href: '/analytics/agents', cap: 'profitability.view' },
      { label: 'Cost Centres', href: '/analytics/cost-centres', cap: 'profitability.view' },
    ],
  },
  {
    key: 'operations',
    label: 'Operations',
    color: 'var(--color-sec-settings)',
    icon: 'tools',
    items: [
      { label: 'Expenses', href: '/expenses', match: '/expenses' },
      { label: 'Commissions', href: '/commissions' },
      { label: 'Budgets', href: '/budgets', match: '/budgets', cap: 'budget.manage' },
      { label: 'Assets & Deferrals', href: '/assets', match: '/assets' },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    color: 'var(--color-sec-reports)',
    icon: 'report',
    items: [
      { label: 'Profit & Loss', href: '/reports/profit-and-loss', cap: 'reports.view' },
      { label: 'Balance Sheet', href: '/reports/balance-sheet', cap: 'reports.view' },
      { label: 'Cash Flow', href: '/reports/cash-flow', cap: 'reports.view' },
      { label: 'AR Ageing', href: '/reports/ar-ageing', cap: 'reports.view' },
      { label: 'AP Ageing', href: '/reports/ap-ageing', cap: 'reports.view' },
      { label: 'Travel Reports', href: '/reports/travel', cap: 'reports.view' },
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
