/**
 * The accounting vocabulary, shared by server and client.
 *
 * Nothing in this file touches the database — it is the closed sets that both
 * the posting engine and the screens have to agree on. A status the engine can
 * write and the UI cannot colour is a bug you only see in production, so both
 * read the same table here.
 */

// ---------------------------------------------------------------------------
// Account kinds
// ---------------------------------------------------------------------------
/**
 * WHY `kind` AND NOT JUST THE ACCOUNT CODE RANGE. Codes are configurable per
 * org (plan section 7 requires it), so a report that decides "6xxxxx is an
 * expense" breaks the first time an agency renumbers its chart. The kind is the
 * semantic, the code is the label.
 *
 * `equity_unaffected` is retained earnings: the account the year-end close
 * rolls profit into, and the one the Balance Sheet adds current-year P&L to
 * when the year has NOT been closed yet. Without it the Balance Sheet does not
 * balance mid-year, which is the single most common home-made-ledger bug.
 */
export const ACCOUNT_KINDS = {
  asset_cash: { label: 'Bank & Cash', group: 'asset', sheet: 'balance', sign: 1 },
  asset_receivable: { label: 'Receivable', group: 'asset', sheet: 'balance', sign: 1 },
  asset_current: { label: 'Current Asset', group: 'asset', sheet: 'balance', sign: 1 },
  asset_prepaid: { label: 'Prepaid / Advance', group: 'asset', sheet: 'balance', sign: 1 },
  asset_fixed: { label: 'Fixed Asset', group: 'asset', sheet: 'balance', sign: 1 },
  liability_payable: { label: 'Payable', group: 'liability', sheet: 'balance', sign: -1 },
  liability_tax: { label: 'Tax Liability', group: 'liability', sheet: 'balance', sign: -1 },
  liability_current: { label: 'Current Liability', group: 'liability', sheet: 'balance', sign: -1 },
  liability_noncurrent: { label: 'Long-term Liability', group: 'liability', sheet: 'balance', sign: -1 },
  equity: { label: 'Equity', group: 'equity', sheet: 'balance', sign: -1 },
  equity_unaffected: { label: 'Retained Earnings', group: 'equity', sheet: 'balance', sign: -1 },
  income: { label: 'Revenue', group: 'income', sheet: 'pl', sign: -1 },
  income_other: { label: 'Other Income', group: 'income', sheet: 'pl', sign: -1 },
  expense_direct: { label: 'Direct Trip Cost', group: 'expense', sheet: 'pl', sign: 1 },
  expense_operating: { label: 'Operating Expense', group: 'expense', sheet: 'pl', sign: 1 },
  expense_depreciation: { label: 'Depreciation', group: 'expense', sheet: 'pl', sign: 1 },
} as const;

export type AccountKind = keyof typeof ACCOUNT_KINDS;

export const ACCOUNT_GROUPS = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountGroup = (typeof ACCOUNT_GROUPS)[number];

export function kindLabel(kind: string): string {
  return ACCOUNT_KINDS[kind as AccountKind]?.label ?? kind;
}
export function kindGroup(kind: string): AccountGroup {
  return (ACCOUNT_KINDS[kind as AccountKind]?.group ?? 'asset') as AccountGroup;
}
/**
 * The natural side of an account.
 *
 * +1 means debits increase it (assets, expenses). -1 means credits do
 * (liabilities, equity, income). Every report that shows "balance" rather than
 * "debit and credit" multiplies by this, which is why a revenue account reads
 * as a positive 2,00,000 on the P&L instead of a negative one.
 */
export function kindSign(kind: string): 1 | -1 {
  return (ACCOUNT_KINDS[kind as AccountKind]?.sign ?? 1) as 1 | -1;
}
export function isPl(kind: string): boolean {
  return ACCOUNT_KINDS[kind as AccountKind]?.sheet === 'pl';
}

/**
 * Split a signed ledger balance into the two columns a ledger actually has.
 *
 * WHY THIS EXISTS. Internally a balance is one signed integer: `SUM(debit -
 * credit)`, positive for a debit balance. That is the right shape to compute
 * with and the wrong shape to read. No ledger, cash book or trial balance ever
 * printed "-45,000" — it prints 45,000 in the credit column, and an accountant
 * checking a figure looks at WHICH COLUMN before they look at the digits.
 *
 * Every screen that shows a balance passes it through here, so the convention
 * is decided in one place rather than re-derived, slightly differently, on each
 * of a dozen pages. Note that exactly one of the two is ever non-zero, which is
 * what lets a column total be a plain sum.
 */
export function drCr(balance: number): { debit: number; credit: number } {
  return { debit: balance > 0 ? balance : 0, credit: balance < 0 ? -balance : 0 };
}

/** The side a signed balance sits on: 'Dr', 'Cr', or nothing when it is nil. */
export function drCrLabel(balance: number): 'Dr' | 'Cr' | '' {
  return balance > 0 ? 'Dr' : balance < 0 ? 'Cr' : '';
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
export type DocType = 'out_invoice' | 'out_refund' | 'in_invoice' | 'in_refund';

export const DOC_TYPES: Record<DocType, {
  label: string; short: string; side: 'customer' | 'supplier'; sign: 1 | -1; seq: string;
}> = {
  // `sign` is the effect on the partner's balance: an invoice increases what a
  // customer owes, a credit note reduces it. The posting engine flips debit and
  // credit off this one value rather than branching four ways.
  out_invoice: { label: 'Customer Invoice', short: 'Invoice', side: 'customer', sign: 1, seq: 'sale' },
  out_refund: { label: 'Customer Credit Note', short: 'Credit Note', side: 'customer', sign: -1, seq: 'sale_refund' },
  in_invoice: { label: 'Vendor Bill', short: 'Bill', side: 'supplier', sign: 1, seq: 'purchase' },
  in_refund: { label: 'Vendor Credit Note', short: 'Debit Note', side: 'supplier', sign: -1, seq: 'purchase_refund' },
};

export const DOC_STATES = ['draft', 'posted', 'cancelled'] as const;
export const PAYMENT_STATES = ['not_paid', 'partial', 'paid', 'reversed'] as const;

export const PAYMENT_STATE_LABEL: Record<string, string> = {
  not_paid: 'Not paid',
  partial: 'Partially paid',
  paid: 'Paid',
  reversed: 'Reversed',
};

/**
 * Status chip colours.
 *
 * Condensed from the CRM's own STATUS_COLORS convention (bg/fg pairs) so a
 * "Posted" chip here looks like a "Booked" chip there. Read through
 * `stateChip()`, which falls back to neutral grey rather than crashing on a
 * state the backend added.
 */
export const STATE_CHIP: Record<string, { bg: string; fg: string }> = {
  draft: { bg: '#eef0f5', fg: '#4b5468' },
  posted: { bg: '#e8f1ff', fg: '#1d4ed8' },
  cancelled: { bg: '#f3f0f7', fg: '#6b6480' },
  reversed: { bg: '#f3f0f7', fg: '#6b6480' },
  not_paid: { bg: '#fef2f2', fg: '#b91c1c' },
  partial: { bg: '#fffbeb', fg: '#92400e' },
  paid: { bg: '#f0fdf4', fg: '#15803d' },
  overdue: { bg: '#fef2f2', fg: '#b91c1c' },
  reconciled: { bg: '#f0fdf4', fg: '#15803d' },
  unreconciled: { bg: '#fffbeb', fg: '#92400e' },
  open: { bg: '#f0fdf4', fg: '#15803d' },
  locked: { bg: '#fffbeb', fg: '#92400e' },
  closed: { bg: '#f3f0f7', fg: '#6b6480' },
  submitted: { bg: '#e8f1ff', fg: '#1d4ed8' },
  approved: { bg: '#f0fdf4', fg: '#15803d' },
  refused: { bg: '#fef2f2', fg: '#b91c1c' },
  running: { bg: '#e8f1ff', fg: '#1d4ed8' },
  confirmed: { bg: '#f0fdf4', fg: '#15803d' },
  completed: { bg: '#eef0f5', fg: '#4b5468' },
  travelling: { bg: '#e8f1ff', fg: '#1d4ed8' },
};

export function stateChip(state: string) {
  return STATE_CHIP[state] ?? { bg: '#eef0f5', fg: '#4b5468' };
}

export function titleise(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Journals, payments, methods
// ---------------------------------------------------------------------------
export const JOURNAL_TYPES = ['sale', 'purchase', 'bank', 'cash', 'general'] as const;
export type JournalType = (typeof JOURNAL_TYPES)[number];

export const PAYMENT_METHODS = ['bank', 'cash', 'upi', 'card', 'cheque', 'neft', 'other'] as const;

// ---------------------------------------------------------------------------
// Permissions — mirrors the CRM's capability architecture (plan section 46)
// ---------------------------------------------------------------------------
/**
 * The finance capabilities, and which role holds each.
 *
 * The UI reads this to decide whether to DRAW a button. The server reads the
 * same table to decide whether to honour the request — see requireCap() in
 * src/server/auth.ts. Both, always: a hidden button is a courtesy, not a
 * control, and anyone can POST to a route handler.
 */
export const FINANCE_CAPS = [
  'finance.view',
  'invoice.create', 'invoice.post',
  'bill.create', 'bill.post',
  'payment.create', 'payment.approve',
  'bank.reconcile',
  'journal.create', 'journal.post',
  'reports.view',
  'tax.configure', 'coa.configure',
  'period.close',
  'budget.manage',
  'profitability.view',
] as const;
export type FinanceCap = (typeof FINANCE_CAPS)[number];

const ALL: FinanceCap[] = [...FINANCE_CAPS];

export const ROLE_CAPS: Record<string, FinanceCap[]> = {
  // A sales agent raises the invoice and takes the money. What they cannot do
  // is decide where either one lands in the books.
  member: ['finance.view', 'invoice.create', 'payment.create', 'reports.view'],
  // The agency's own admin, exactly as in the CRM: runs the business, and in
  // finance that means everything except closing a period, which is the
  // accountant's signature.
  admin: ALL.filter((c) => c !== 'period.close'),
  accountant: ALL,
  developer: ALL,
  tester: ['finance.view', 'reports.view', 'profitability.view'],
  'service-role': ALL,
  service_role: ALL,
};

export function can(role: string | undefined, cap: FinanceCap): boolean {
  return (ROLE_CAPS[role ?? 'member'] ?? ROLE_CAPS.member).includes(cap);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
/** ISO date, no time. Every date column in the schema is this shape. */
export function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

export function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  // Clamp: one month after 31 Jan is 28/29 Feb, not 3 March.
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return isoDate(d);
}

/** Last day of the month `iso` falls in — what a depreciation slice is dated. */
export function endOfMonth(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * The Indian fiscal year containing `iso`: 1 April to 31 March.
 * `startMonth` is org configuration, because an agency with a foreign parent
 * may close in December.
 */
export function fiscalYearOf(iso: string, startMonth = 4): { from: string; to: string; name: string } {
  const d = new Date(`${iso}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const startYear = d.getUTCMonth() + 1 >= startMonth ? y : y - 1;
  const from = `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
  const to = addDays(addMonths(from, 12), -1);
  return { from, to, name: `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}` };
}

/** The AR/AP ageing buckets of plan section 39. */
export const AGEING_BUCKETS = [
  { key: 'current', label: 'Current', from: -99999, to: 0 },
  { key: 'b1', label: '1–30', from: 1, to: 30 },
  { key: 'b2', label: '31–60', from: 31, to: 60 },
  { key: 'b3', label: '61–90', from: 61, to: 90 },
  { key: 'b4', label: '90+', from: 91, to: 999999 },
] as const;

export function ageingBucket(overdueDays: number): string {
  for (const b of AGEING_BUCKETS) if (overdueDays >= b.from && overdueDays <= b.to) return b.key;
  return 'b4';
}
