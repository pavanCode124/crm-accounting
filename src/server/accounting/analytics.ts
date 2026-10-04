import 'server-only';
import { all, one, scalar } from '../db';
import { isoDate } from '@/lib/accounting';
import { searchTokens } from '@/lib/search';

/**
 * Management accounting — trips, packages, agents, departments, branches.
 *
 * THE POINT OF THIS FILE is that trip profit is not a second set of numbers
 * kept beside the ledger. It is the SAME journal entry lines, sliced by the
 * analytic account they were tagged with when they were posted. Change an
 * invoice and the trip margin changes with it, because there is only one
 * number and it lives in the GL (plan sections 23 and 24).
 *
 * The sign convention is set in engine.ts: analytic amounts are debit minus
 * credit, so COST is positive and REVENUE is negative. Profit is therefore
 * -SUM(amount), which is why every query here negates once and only once.
 */

export interface AnalyticProfit {
  analytic_id: string; code: string; name: string; plan_code: string;
  booking_id: string | null; booking_ref: string | null;
  revenue: number; cost: number; profit: number; margin: number;
}

function marginOf(revenue: number, profit: number): number {
  return revenue === 0 ? 0 : (profit / revenue) * 100;
}

export async function analyticProfitability(orgId: string, opts: {
  planCode?: string; from?: string; to?: string; analyticId?: string; limit?: number;
} = {}): Promise<AnalyticProfit[]> {
  const clauses = ['ad.org_id = ?', "ad.state = 'posted'"];
  const params: Array<string | number> = [orgId];
  if (opts.planCode) { clauses.push('pl.code = ?'); params.push(opts.planCode); }
  if (opts.analyticId) { clauses.push('ad.analytic_id = ?'); params.push(opts.analyticId); }
  if (opts.from) { clauses.push('ad.entry_date >= ?'); params.push(opts.from); }
  if (opts.to) { clauses.push('ad.entry_date <= ?'); params.push(opts.to); }

  return (await all<{
    analytic_id: string; code: string; name: string; plan_code: string;
    booking_id: string | null; booking_ref: string | null; revenue: number; cost: number;
  }>(
    `SELECT ad.analytic_id, an.code, an.name, pl.code AS plan_code,
            an.booking_id, b.ref AS booking_ref,
            COALESCE(SUM(CASE WHEN a.kind IN ('income','income_other') THEN -ad.amount END),0) AS revenue,
            COALESCE(SUM(CASE WHEN a.kind LIKE 'expense%' THEN ad.amount END),0) AS cost
       FROM analytic_distributions ad
       JOIN analytic_accounts an ON an.id = ad.analytic_id
       JOIN analytic_plans pl ON pl.id = an.plan_id
       JOIN accounts a ON a.id = ad.account_id
       LEFT JOIN bookings b ON b.id = an.booking_id
      WHERE ${clauses.join(' AND ')}
      GROUP BY ad.analytic_id, an.code, an.name, pl.code, an.booking_id, b.ref
      ORDER BY revenue DESC
      LIMIT ${opts.limit ?? 200}`,
    ...params,
  )).map((r) => {
    const profit = r.revenue - r.cost;
    return { ...r, profit, margin: marginOf(r.revenue, profit) };
  });
}

/** The cost split behind a trip's margin — hotel, flights, transport, visa. */
export async function analyticCostBreakdown(orgId: string, analyticId: string) {
  return await all<{ code: string; name: string; kind: string; amount: number }>(
    `SELECT a.code, a.name, a.kind, COALESCE(SUM(ad.amount),0) AS amount
       FROM analytic_distributions ad JOIN accounts a ON a.id = ad.account_id
      WHERE ad.org_id = ? AND ad.analytic_id = ? AND ad.state='posted'
      GROUP BY a.id HAVING COALESCE(SUM(ad.amount),0) <> 0 ORDER BY a.kind, amount DESC`,
    orgId, analyticId,
  );
}

// ---------------------------------------------------------------------------
// Booking financial tab (plan section 42)
// ---------------------------------------------------------------------------

export interface BookingFinancials {
  booking: {
    id: string; ref: string; title: string; destination: string | null;
    package_name: string | null; partner_id: string | null; partner_name: string | null;
    customer_name: string | null;
    agent_name: string | null; pax: number; start_date: string | null; end_date: string | null;
    sell_value: number; status: string; analytic_id: string | null;
  };
  invoiced: number; received: number; outstanding: number;
  advances: number;
  cost: number; costLines: Array<{ code: string; name: string; amount: number }>;
  revenue: number; profit: number; margin: number;
  counts: { invoices: number; bills: number; payments: number; refunds: number };
}

export async function bookingFinancials(orgId: string, bookingId: string): Promise<BookingFinancials | null> {
  const booking = await one<BookingFinancials['booking']>(
    `SELECT b.id, b.ref, b.title, b.destination, b.package_name, b.partner_id, b.customer_name,
            p.name AS partner_name, b.agent_name, b.pax, b.start_date, b.end_date,
            b.sell_value, b.status, b.analytic_id
       FROM bookings b LEFT JOIN partners p ON p.id = b.partner_id
      WHERE b.id = ? AND b.org_id = ?`, bookingId, orgId,
  );
  if (!booking) return null;

  const invoiced = await scalar(
    `SELECT COALESCE(SUM(CASE WHEN doc_type='out_invoice' THEN total ELSE -total END),0)
       FROM documents WHERE org_id=? AND booking_id=? AND state='posted'
         AND doc_type IN ('out_invoice','out_refund')`, orgId, bookingId,
  );
  const outstanding = await scalar(
    `SELECT COALESCE(SUM(CASE WHEN doc_type='out_invoice' THEN residual ELSE -residual END),0)
       FROM documents WHERE org_id=? AND booking_id=? AND state='posted'
         AND doc_type IN ('out_invoice','out_refund')`, orgId, bookingId,
  );
  const received = await scalar(
    `SELECT COALESCE(SUM(amount),0) FROM payments
      WHERE org_id=? AND booking_id=? AND direction='inbound' AND state<>'cancelled'`, orgId, bookingId,
  );
  const advances = await scalar(
    `SELECT COALESCE(SUM(unallocated),0) FROM payments
      WHERE org_id=? AND booking_id=? AND direction='inbound' AND is_advance=1 AND state<>'cancelled'`,
    orgId, bookingId,
  );

  // Cost and revenue come from the ANALYTIC rows, not from the documents: an
  // employee expense or a cash payment tagged to the trip is part of its cost
  // even though no vendor bill was ever raised.
  const analyticId = booking.analytic_id;
  const breakdown = analyticId ? await analyticCostBreakdown(orgId, analyticId) : [];
  const costLines = breakdown.filter((r) => r.kind.startsWith('expense'))
    .map((r) => ({ code: r.code, name: r.name, amount: r.amount }));
  const cost = costLines.reduce((s, r) => s + r.amount, 0);
  const revenue = -breakdown.filter((r) => r.kind.startsWith('income'))
    .reduce((s, r) => s + r.amount, 0);
  const profit = revenue - cost;

  const counts = {
    invoices: await scalar(`SELECT COUNT(*) FROM documents WHERE org_id=? AND booking_id=? AND doc_type='out_invoice' AND state='posted'`, orgId, bookingId),
    bills: await scalar(`SELECT COUNT(*) FROM documents WHERE org_id=? AND booking_id=? AND doc_type='in_invoice' AND state='posted'`, orgId, bookingId),
    payments: await scalar(`SELECT COUNT(*) FROM payments WHERE org_id=? AND booking_id=? AND state<>'cancelled'`, orgId, bookingId),
    refunds: await scalar(`SELECT COUNT(*) FROM documents WHERE org_id=? AND booking_id=? AND doc_type='out_refund' AND state='posted'`, orgId, bookingId),
  };

  return {
    booking, invoiced, received, outstanding, advances,
    cost, costLines, revenue, profit, margin: marginOf(revenue, profit), counts,
  };
}

// ---------------------------------------------------------------------------
// Travel reports (plan section 40)
// ---------------------------------------------------------------------------

export async function tripProfitability(orgId: string, p: { from?: string; to?: string } = {}) {
  return await analyticProfitability(orgId, { planCode: 'TRIPS', ...p });
}

/**
 * Package profitability — several trips of the same package, added up.
 *
 * Grouped from the BOOKING's package name rather than from a package analytic
 * account, because a booking belongs to exactly one package and tagging every
 * line twice would double the analytic rows for no new information.
 */
export async function packageProfitability(orgId: string, p: { from?: string; to?: string } = {}) {
  return (await all<{ package_name: string; bookings: number; revenue: number; cost: number }>(
    `SELECT COALESCE(b.package_name, 'Unpackaged') AS package_name,
            COUNT(DISTINCT b.id) AS bookings,
            COALESCE(SUM(CASE WHEN a.kind IN ('income','income_other') THEN -ad.amount END),0) AS revenue,
            COALESCE(SUM(CASE WHEN a.kind LIKE 'expense%' THEN ad.amount END),0) AS cost
       FROM analytic_distributions ad
       JOIN analytic_accounts an ON an.id = ad.analytic_id
       JOIN bookings b ON b.id = an.booking_id
       JOIN accounts a ON a.id = ad.account_id
      WHERE ad.org_id = ? AND ad.state='posted'
        AND (?::text IS NULL OR ad.entry_date >= ?) AND (?::text IS NULL OR ad.entry_date <= ?)
      GROUP BY package_name ORDER BY revenue DESC`,
    orgId, p.from ?? null, p.from ?? null, p.to ?? null, p.to ?? null,
  )).map((r) => {
    const profit = r.revenue - r.cost;
    return { ...r, profit, margin: marginOf(r.revenue, profit) };
  });
}

export async function agentPerformance(orgId: string, p: { from?: string; to?: string } = {}) {
  return (await all<{ agent_name: string; bookings: number; revenue: number; cost: number; commission: number }>(
    `SELECT COALESCE(b.agent_name,'Unassigned') AS agent_name,
            COUNT(DISTINCT b.id) AS bookings,
            COALESCE(SUM(CASE WHEN a.kind IN ('income','income_other') THEN -ad.amount END),0) AS revenue,
            COALESCE(SUM(CASE WHEN a.kind LIKE 'expense%' THEN ad.amount END),0) AS cost,
            COALESCE((SELECT SUM(c.amount) FROM commissions c
                       WHERE c.agent_name = b.agent_name AND c.state IN ('posted','paid')),0) AS commission
       FROM analytic_distributions ad
       JOIN analytic_accounts an ON an.id = ad.analytic_id
       JOIN bookings b ON b.id = an.booking_id
       JOIN accounts a ON a.id = ad.account_id
      WHERE ad.org_id = ? AND ad.state='posted'
        AND (?::text IS NULL OR ad.entry_date >= ?) AND (?::text IS NULL OR ad.entry_date <= ?)
      GROUP BY b.agent_name ORDER BY revenue DESC`,
    orgId, p.from ?? null, p.from ?? null, p.to ?? null, p.to ?? null,
  )).map((r) => {
    const profit = r.revenue - r.cost;
    return { ...r, profit, margin: marginOf(r.revenue, profit) };
  });
}

export async function supplierCostReport(orgId: string, p: { from?: string; to?: string } = {}) {
  return await all<{ partner_id: string; name: string; purchases: number; paid: number; outstanding: number; bills: number }>(
    `SELECT p.id AS partner_id, p.name,
            COALESCE(SUM(CASE WHEN d.doc_type='in_invoice' THEN d.total ELSE -d.total END),0) AS purchases,
            COALESCE(SUM(CASE WHEN d.doc_type='in_invoice' THEN d.total - d.residual - d.withheld_tax ELSE 0 END),0) AS paid,
            COALESCE(SUM(CASE WHEN d.doc_type='in_invoice' THEN d.residual ELSE -d.residual END),0) AS outstanding,
            COUNT(d.id) AS bills
       FROM partners p JOIN documents d ON d.partner_id = p.id
      WHERE p.org_id = ? AND d.state='posted' AND d.doc_type IN ('in_invoice','in_refund')
        AND (?::text IS NULL OR d.doc_date >= ?) AND (?::text IS NULL OR d.doc_date <= ?)
      GROUP BY p.id ORDER BY purchases DESC`,
    orgId, p.from ?? null, p.from ?? null, p.to ?? null, p.to ?? null,
  );
}

export async function bookingPaymentReport(orgId: string) {
  return await all<{
    booking_id: string; ref: string; title: string; partner_name: string | null;
    customer_name: string | null;
    total: number; paid: number; balance: number; due_date: string | null; status: string;
  }>(
    `SELECT b.id AS booking_id, b.ref, b.title, p.name AS partner_name, b.customer_name, b.status,
            COALESCE(SUM(CASE WHEN d.doc_type='out_invoice' THEN d.total ELSE -d.total END),0) AS total,
            COALESCE(SUM(CASE WHEN d.doc_type='out_invoice' THEN d.total - d.residual ELSE 0 END),0) AS paid,
            COALESCE(SUM(CASE WHEN d.doc_type='out_invoice' THEN d.residual ELSE -d.residual END),0) AS balance,
            MIN(d.due_date) AS due_date
       FROM bookings b
       LEFT JOIN partners p ON p.id = b.partner_id
       LEFT JOIN documents d ON d.booking_id = b.id AND d.state='posted'
            AND d.doc_type IN ('out_invoice','out_refund')
      WHERE b.org_id = ?
      GROUP BY b.id, p.name ORDER BY balance DESC, b.ref DESC`,
    orgId,
  );
}

export async function customerLifetimeValue(orgId: string) {
  return await all<{
    partner_id: string; name: string; bookings: number; revenue: number;
    outstanding: number; profit: number;
  }>(
    `SELECT p.id AS partner_id, p.name,
            (SELECT COUNT(*) FROM bookings b WHERE b.partner_id = p.id) AS bookings,
            COALESCE(SUM(CASE WHEN d.doc_type='out_invoice' THEN d.untaxed ELSE -d.untaxed END),0) AS revenue,
            COALESCE(SUM(CASE WHEN d.doc_type='out_invoice' THEN d.residual ELSE -d.residual END),0) AS outstanding,
            COALESCE((SELECT -SUM(ad.amount) FROM analytic_distributions ad
                        JOIN analytic_accounts an ON an.id = ad.analytic_id
                        JOIN bookings b2 ON b2.id = an.booking_id
                       WHERE b2.partner_id = p.id AND ad.state='posted'),0) AS profit
       FROM partners p
       LEFT JOIN documents d ON d.partner_id = p.id AND d.state='posted'
            AND d.doc_type IN ('out_invoice','out_refund')
      WHERE p.org_id = ? AND p.is_customer = 1
      GROUP BY p.id
      HAVING COALESCE(SUM(CASE WHEN d.doc_type='out_invoice' THEN d.untaxed ELSE -d.untaxed END),0) <> 0
          OR (SELECT COUNT(*) FROM bookings b WHERE b.partner_id = p.id) > 0
      ORDER BY revenue DESC`,
    orgId,
  );
}

export async function cancellationReport(orgId: string) {
  return (await all<{
    booking_id: string; ref: string; title: string; revenue: number;
    refund: number; cost: number; net: number;
  }>(
    `SELECT b.id AS booking_id, b.ref, b.title,
            COALESCE((SELECT SUM(total) FROM documents d WHERE d.booking_id=b.id
                       AND d.doc_type='out_invoice' AND d.state='posted'),0) AS revenue,
            COALESCE((SELECT SUM(total) FROM documents d WHERE d.booking_id=b.id
                       AND d.doc_type='out_refund' AND d.state='posted'),0) AS refund,
            COALESCE((SELECT SUM(ad.amount) FROM analytic_distributions ad
                       JOIN accounts a ON a.id=ad.account_id
                       JOIN analytic_accounts an ON an.id=ad.analytic_id
                      WHERE an.booking_id=b.id AND a.kind LIKE 'expense%' AND ad.state='posted'),0) AS cost
       FROM bookings b
      WHERE b.org_id = ? AND b.status = 'cancelled'
      ORDER BY b.ref DESC`,
    orgId,
  )).map((r) => ({ ...r, net: r.revenue - r.refund - r.cost }));
}

// ---------------------------------------------------------------------------
// Budgets (plan section 38)
// ---------------------------------------------------------------------------

export async function budgetWithActuals(orgId: string, budgetId: string) {
  const budget = await one<{ id: string; name: string; owner: string | null; date_from: string; date_to: string; state: string }>(
    'SELECT * FROM budgets WHERE id = ? AND org_id = ?', budgetId, orgId,
  );
  if (!budget) return null;

  const rows = await all<{
    id: string; planned: number; account_id: string | null; analytic_id: string | null;
    account_code: string | null; account_name: string | null; analytic_name: string | null;
  }>(
    `SELECT bl.id, bl.planned, bl.account_id, bl.analytic_id,
            a.code AS account_code, a.name AS account_name, an.name AS analytic_name
       FROM budget_lines bl
       LEFT JOIN accounts a ON a.id = bl.account_id
       LEFT JOIN analytic_accounts an ON an.id = bl.analytic_id
      WHERE bl.budget_id = ?`, budgetId,
  );

  const lines = [];
  for (const l of rows) {
    // Actual is read from the ledger over the budget's own window, filtered by
    // whichever dimensions the line names. A budget line with neither is a
    // planning row with no actual, and reads as 0 rather than as everything.
    const actual = l.analytic_id
      ? await scalar(
        `SELECT COALESCE(SUM(ad.amount),0) FROM analytic_distributions ad
          WHERE ad.org_id=? AND ad.analytic_id=? AND ad.state='posted'
            AND ad.entry_date BETWEEN ? AND ?
            AND (?::text IS NULL OR ad.account_id = ?)`,
        orgId, l.analytic_id, budget.date_from, budget.date_to, l.account_id ?? null, l.account_id ?? null,
      )
      : l.account_id
        ? await scalar(
          `SELECT COALESCE(SUM(debit - credit),0) FROM journal_entry_lines
            WHERE org_id=? AND account_id=? AND state='posted' AND entry_date BETWEEN ? AND ?`,
          orgId, l.account_id, budget.date_from, budget.date_to,
        )
        : 0;
    const remaining = l.planned - actual;
    lines.push({
      ...l, actual, remaining,
      variancePct: l.planned === 0 ? 0 : (remaining / l.planned) * 100,
    });
  }

  const planned = lines.reduce((s, l) => s + l.planned, 0);
  const actual = lines.reduce((s, l) => s + l.actual, 0);
  return { budget, lines, planned, actual, remaining: planned - actual };
}

export async function listAnalyticAccounts(orgId: string, planCode?: string) {
  return await all<{ id: string; code: string; name: string; plan_code: string; plan_name: string; booking_id: string | null }>(
    `SELECT an.id, an.code, an.name, pl.code AS plan_code, pl.name AS plan_name, an.booking_id
       FROM analytic_accounts an JOIN analytic_plans pl ON pl.id = an.plan_id
      WHERE an.org_id = ? AND an.active = 1 AND (?::text IS NULL OR pl.code = ?)
      ORDER BY pl.code, an.code`,
    orgId, planCode ?? null, planCode ?? null,
  );
}

export async function listBookings(orgId: string, opts: { status?: string; search?: string; limit?: number } = {}) {
  const clauses = ['b.org_id = ?'];
  const params: Array<string | number> = [orgId];
  if (opts.status) { clauses.push('b.status = ?'); params.push(opts.status); }
  if (opts.search) {
    for (const token of searchTokens(opts.search)) {
      clauses.push('(b.ref ILIKE ? OR b.title ILIKE ? OR b.destination ILIKE ? OR b.customer_name ILIKE ? OR b.agent_name ILIKE ?)');
      const like = `%${token}%`;
      params.push(like, like, like, like, like);
    }
  }
  return await all<{
    id: string; ref: string; title: string; destination: string | null; status: string;
    partner_name: string | null; customer_name: string | null; agent_name: string | null;
    start_date: string | null; sell_value: number; pax: number; analytic_id: string | null;
  }>(
    `SELECT b.id, b.ref, b.title, b.destination, b.status, b.agent_name, b.start_date,
            b.sell_value, b.pax, b.analytic_id, b.customer_name, p.name AS partner_name
       FROM bookings b LEFT JOIN partners p ON p.id = b.partner_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY b.start_date DESC, b.ref DESC LIMIT ${opts.limit ?? 200}`,
    ...params,
  );
}

export const today = isoDate;

// ---------------------------------------------------------------------------
// The trip dossier — everything tagged to one trip, for the drill-down export
// ---------------------------------------------------------------------------

/**
 * WHY THE DOSSIER IS ASSEMBLED HERE AND NOT IN THE WORKBOOK.
 *
 * `tripProfitability` answers "what did this trip make"; the reader's next
 * question is always "where did it go", and that question is answered by rows,
 * not by a total. This function gathers every row the ledger holds against one
 * trip — the invoices that earned it, the bills and employee claims that cost
 * it, the commission paid on it, the money that actually moved, and underneath
 * all of them the GL lines themselves — so that the spreadsheet in exports.ts
 * is layout and nothing else.
 *
 * THE LEDGER SHEET IS THE SPINE, and the others are readings of it. Every
 * figure on the summary comes from `ledger`, which is the posted analytic
 * distributions and therefore the same lines the P&L is built from. The
 * document, expense and commission sheets exist because a GL line reading
 * "Transport Cost 500.00" does not tell a reader it was a cab to the airport
 * that an agent paid for out of his own pocket and is still owed back.
 *
 * A TRIP IS AN ANALYTIC ACCOUNT, not a booking. Most trips have a booking and
 * the dossier carries it, but a trip analytic with no CRM booking behind it
 * still has costs and still exports — it simply has no customer block.
 */

export interface TripLedgerRow {
  entry_date: string; entry_no: string | null; entry_id: string;
  journal_code: string | null; journal_name: string | null;
  account_code: string; account_name: string; account_kind: string;
  label: string | null; narration: string | null; reference: string | null;
  partner_name: string | null;
  source_model: string | null; source_id: string | null;
  doc_number: string | null; doc_type: string | null;
  /** The GL line's own figures, before the analytic share is applied. */
  debit: number; credit: number;
  /** The share of that line this trip carries: 10000 = all of it. */
  bps: number;
  /** Signed as the engine writes it: +cost, -revenue. */
  amount: number;
}

export interface TripDocRow {
  id: string; doc_type: string; number: string | null; doc_date: string;
  due_date: string | null; supplier_ref: string | null; state: string; payment_state: string;
  partner_name: string | null; partner_gstin: string | null; place_of_supply: string | null;
  untaxed: number; tax_total: number; total: number; residual: number; withheld_tax: number;
  note: string | null;
}

export interface TripDocItemRow {
  document_id: string; doc_type: string; number: string | null; doc_date: string;
  partner_name: string | null; partner_gstin: string | null;
  seq: number; name: string; hsn_code: string | null; tax_name: string | null;
  account_code: string | null; account_name: string | null;
  qty_milli: number; unit_price: number; discount_bps: number;
  taxable: number; igst_bps: number; igst: number; cgst_bps: number; cgst: number;
  sgst_bps: number; sgst: number;
  /** The union-territory half, which is a different liability from SGST. */
  utgst_bps: number; utgst: number;
  cess: number; tax_total: number; total: number;
  /** Whether this particular line is the one tagged to the trip. */
  on_trip: number;
}

export interface TripExpenseRow {
  id: string; number: string | null; employee_name: string | null; description: string;
  expense_date: string; amount: number; tax_amount: number; tax_name: string | null;
  tax_rate_bps: number | null; account_code: string | null; account_name: string | null;
  paid_by: string; state: string; receipt: string | null;
  approved_by: string | null; approved_at: string | null;
  entry_no: string | null;
}

export interface TripCommissionRow {
  id: string; agent_name: string; basis: string; rate_bps: number; fixed_amount: number;
  base_amount: number; amount: number; due_date: string | null; state: string;
  created_at: string; entry_no: string | null;
}

export interface TripPaymentRow {
  id: string; number: string | null; direction: string; side: string; pay_date: string;
  partner_name: string | null; journal_name: string | null; method: string;
  reference: string | null; amount: number; unallocated: number; is_advance: number;
  state: string; note: string | null;
}

export interface TripDossier {
  analytic: {
    id: string; code: string; name: string; plan_code: string; plan_name: string;
    booking_id: string | null;
  };
  booking: BookingFinancials['booking'] | null;
  ledger: TripLedgerRow[];
  documents: TripDocRow[];
  items: TripDocItemRow[];
  expenses: TripExpenseRow[];
  commissions: TripCommissionRow[];
  payments: TripPaymentRow[];
  /** Revenue and cost by account — the split behind the margin. */
  revenueLines: Array<{ code: string; name: string; amount: number }>;
  costLines: Array<{ code: string; name: string; amount: number }>;
  totals: {
    revenue: number; cost: number; profit: number; margin: number;
    invoiced: number; creditNotes: number; billed: number; debitNotes: number;
    outputTax: number; inputTax: number; withheldTax: number;
    expenseClaims: number; expenseTax: number; expenseOwed: number;
    commissionPosted: number; commissionDraft: number;
    received: number; paidOut: number; advances: number; outstanding: number;
    firstEntry: string | null; lastEntry: string | null;
  };
}

/** `?,?,?` for an IN list, so a set of ids stays parameterised. */
function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

export async function tripDossier(orgId: string, analyticId: string): Promise<TripDossier | null> {
  const analytic = await one<TripDossier['analytic']>(
    `SELECT an.id, an.code, an.name, pl.code AS plan_code, pl.name AS plan_name, an.booking_id
       FROM analytic_accounts an JOIN analytic_plans pl ON pl.id = an.plan_id
      WHERE an.id = ? AND an.org_id = ?`, analyticId, orgId,
  );
  if (!analytic) return null;

  const financials = analytic.booking_id
    ? await bookingFinancials(orgId, analytic.booking_id) : null;
  const booking = financials?.booking ?? null;
  const bookingId = booking?.id ?? null;

  // -------------------------------------------------------------- the spine
  const ledger = await all<TripLedgerRow>(
    `SELECT ad.entry_date, je.entry_no, je.id AS entry_id,
            j.code AS journal_code, j.name AS journal_name,
            a.code AS account_code, a.name AS account_name, a.kind AS account_kind,
            jel.label, je.narration, je.reference,
            p.name AS partner_name, je.source_model, je.source_id,
            d.number AS doc_number, d.doc_type,
            jel.debit, jel.credit, ad.bps, ad.amount
       FROM analytic_distributions ad
       JOIN journal_entry_lines jel ON jel.id = ad.line_id
       JOIN journal_entries je ON je.id = jel.entry_id
       JOIN journals j ON j.id = je.journal_id
       JOIN accounts a ON a.id = ad.account_id
       LEFT JOIN partners p ON p.id = jel.partner_id
       LEFT JOIN documents d ON d.id = je.source_id AND je.source_model = 'document'
      WHERE ad.org_id = ? AND ad.analytic_id = ? AND ad.state = 'posted'
      ORDER BY ad.entry_date, je.entry_no, a.code`,
    orgId, analyticId,
  );

  // ---------------------------------------------------------- the documents
  /*
   * A document belongs to the trip three ways, and all three are honoured.
   * The header may carry the analytic account or the booking, and a mixed
   * invoice may tag only SOME of its lines to it — a supplier bill covering
   * two trips is the ordinary case, not the exotic one. Matching on the header
   * alone would drop exactly the documents whose allocation a reader most
   * wants to see.
   */
  const documents = await all<TripDocRow>(
    `SELECT DISTINCT d.id, d.doc_type, d.number, d.doc_date, d.due_date, d.supplier_ref,
            d.state, d.payment_state, p.name AS partner_name, COALESCE(d.party_gstin, p.gstin) AS partner_gstin,
            d.place_of_supply, d.untaxed, d.tax_total, d.total, d.residual,
            d.withheld_tax, d.note
       FROM documents d
       LEFT JOIN partners p ON p.id = d.partner_id
      WHERE d.org_id = ? AND d.state = 'posted'
        AND (d.analytic_id = ?
             OR (?::text IS NOT NULL AND d.booking_id = ?)
             OR EXISTS (SELECT 1 FROM document_lines dl
                         WHERE dl.document_id = d.id AND dl.analytic_id = ?))
      ORDER BY d.doc_date, d.number`,
    orgId, analyticId, bookingId, bookingId, analyticId,
  );

  /*
   * ONE ROW PER LINE, WITH ITS OWN TAX SPLIT, because "with GSTs" is the
   * question and a document total cannot answer it: a bill carrying a hotel at
   * 12% and a transfer at 5% has no single rate. The split is aggregated in
   * SQL by component group rather than line by line in JavaScript, since a
   * trip with forty bills would otherwise be forty round trips.
   *
   * `on_trip` marks the lines actually tagged to this analytic account, so a
   * bill shared with another trip prints in full — the reader can see what the
   * whole bill was — while the column says which part of it this trip carries.
   */
  const items = documents.length
    ? await all<TripDocItemRow>(
      `SELECT dl.document_id, d.doc_type, d.number, d.doc_date,
              p.name AS partner_name, COALESCE(d.party_gstin, p.gstin) AS partner_gstin,
              dl.seq, dl.name, dl.hsn_code, t.name AS tax_name,
              a.code AS account_code, a.name AS account_name,
              dl.qty_milli, dl.unit_price, dl.discount_bps,
              dl.subtotal AS taxable,
              COALESCE(SUM(CASE WHEN lt.tax_group='igst' THEN lt.rate_bps END),0) AS igst_bps,
              COALESCE(SUM(CASE WHEN lt.tax_group='igst' THEN lt.amount END),0) AS igst,
              COALESCE(SUM(CASE WHEN lt.tax_group='cgst' THEN lt.rate_bps END),0) AS cgst_bps,
              COALESCE(SUM(CASE WHEN lt.tax_group='cgst' THEN lt.amount END),0) AS cgst,
              COALESCE(SUM(CASE WHEN lt.tax_group='sgst' THEN lt.rate_bps END),0) AS sgst_bps,
              COALESCE(SUM(CASE WHEN lt.tax_group='sgst' THEN lt.amount END),0) AS sgst,
              COALESCE(SUM(CASE WHEN lt.tax_group='utgst' THEN lt.rate_bps END),0) AS utgst_bps,
              COALESCE(SUM(CASE WHEN lt.tax_group='utgst' THEN lt.amount END),0) AS utgst,
              COALESCE(SUM(CASE WHEN lt.tax_group='cess' THEN lt.amount END),0) AS cess,
              dl.tax_amount AS tax_total, dl.total,
              CASE WHEN dl.analytic_id = ? OR d.analytic_id = ? THEN 1 ELSE 0 END AS on_trip
         FROM document_lines dl
         JOIN documents d ON d.id = dl.document_id
         LEFT JOIN partners p ON p.id = d.partner_id
         LEFT JOIN accounts a ON a.id = dl.account_id
         LEFT JOIN taxes t ON t.id = dl.tax_id
         LEFT JOIN document_line_taxes lt ON lt.line_id = dl.id
        WHERE dl.document_id IN (${placeholders(documents.length)})
        GROUP BY dl.id, d.id, p.name, p.gstin, a.code, a.name, t.name
        ORDER BY d.doc_date, d.number, dl.seq`,
      analyticId, analyticId, ...documents.map((d) => d.id),
    )
    : [];

  // -------------------------------------------------------- what staff spent
  const expenses = await all<TripExpenseRow>(
    `SELECT e.id, e.number, e.employee_name, e.description, e.expense_date,
            e.amount, e.tax_amount, t.name AS tax_name, t.rate_bps AS tax_rate_bps,
            a.code AS account_code, a.name AS account_name,
            e.paid_by, e.state, e.receipt, e.approved_by, e.approved_at,
            je.entry_no
       FROM expenses e
       LEFT JOIN accounts a ON a.id = e.account_id
       LEFT JOIN taxes t ON t.id = e.tax_id
       LEFT JOIN journal_entries je ON je.id = e.entry_id
      WHERE e.org_id = ?
        AND (e.analytic_id = ? OR (?::text IS NOT NULL AND e.booking_id = ?))
      ORDER BY e.expense_date, e.number`,
    orgId, analyticId, bookingId, bookingId,
  );

  // ------------------------------------------------------ what agents earned
  const commissions = bookingId
    ? await all<TripCommissionRow>(
      `SELECT c.id, c.agent_name, c.basis, c.rate_bps, c.fixed_amount, c.base_amount,
              c.amount, c.due_date, c.state, c.created_at, je.entry_no
         FROM commissions c
         LEFT JOIN journal_entries je ON je.id = c.entry_id
        WHERE c.org_id = ? AND c.booking_id = ?
        ORDER BY c.created_at`, orgId, bookingId,
    )
    : [];

  // ----------------------------------------------------- what actually moved
  const payments = bookingId
    ? await all<TripPaymentRow>(
      `SELECT pay.id, pay.number, pay.direction, pay.side, pay.pay_date,
              p.name AS partner_name, j.name AS journal_name, pay.method, pay.reference,
              pay.amount, pay.unallocated, pay.is_advance, pay.state, pay.note
         FROM payments pay
         LEFT JOIN partners p ON p.id = pay.partner_id
         LEFT JOIN journals j ON j.id = pay.journal_id
        WHERE pay.org_id = ? AND pay.booking_id = ? AND pay.state <> 'cancelled'
        ORDER BY pay.pay_date, pay.number`, orgId, bookingId,
    )
    : [];

  // ----------------------------------------------------------------- the sums
  /*
   * Revenue and cost are summed from the LEDGER rows above rather than from
   * the documents, and that is the whole discipline of this file: an employee
   * claim and a manual journal are costs of the trip with no document behind
   * them, and a total built from documents would quietly leave the agent's cab
   * out of the margin it actually reduced.
   */
  const byAccount = (keep: (kind: string) => boolean, sign: 1 | -1) => {
    const map = new Map<string, { code: string; name: string; amount: number }>();
    for (const l of ledger) {
      if (!keep(l.account_kind)) continue;
      const row = map.get(l.account_code)
        ?? { code: l.account_code, name: l.account_name, amount: 0 };
      row.amount += sign * l.amount;
      map.set(l.account_code, row);
    }
    return [...map.values()].filter((r) => r.amount !== 0)
      .sort((a, b) => b.amount - a.amount);
  };

  const revenueLines = byAccount((k) => k.startsWith('income'), -1);
  const costLines = byAccount((k) => k.startsWith('expense'), 1);
  const revenue = revenueLines.reduce((t, r) => t + r.amount, 0);
  const cost = costLines.reduce((t, r) => t + r.amount, 0);
  const profit = revenue - cost;

  const docSum = (type: string, f: (d: TripDocRow) => number) =>
    documents.filter((d) => d.doc_type === type).reduce((t, d) => t + f(d), 0);

  const live = expenses.filter((e) => e.state !== 'refused' && e.state !== 'draft');
  const expenseClaims = live.reduce((t, e) => t + e.amount, 0);
  const expenseTax = live.reduce((t, e) => t + e.tax_amount, 0);
  // Posted, paid for by the employee, not yet reimbursed: what the agency
  // still owes its own staff out of this trip.
  const expenseOwed = expenses
    .filter((e) => e.state === 'posted' && e.paid_by === 'employee')
    .reduce((t, e) => t + e.amount + e.tax_amount, 0);

  const paySum = (f: (p: TripPaymentRow) => boolean) =>
    payments.filter(f).reduce((t, p) => t + p.amount, 0);

  return {
    analytic, booking, ledger, documents, items, expenses, commissions, payments,
    revenueLines, costLines,
    totals: {
      revenue, cost, profit, margin: marginOf(revenue, profit),
      invoiced: docSum('out_invoice', (d) => d.total),
      creditNotes: docSum('out_refund', (d) => d.total),
      billed: docSum('in_invoice', (d) => d.total),
      debitNotes: docSum('in_refund', (d) => d.total),
      outputTax: docSum('out_invoice', (d) => d.tax_total) - docSum('out_refund', (d) => d.tax_total),
      inputTax: docSum('in_invoice', (d) => d.tax_total) - docSum('in_refund', (d) => d.tax_total)
        + expenseTax,
      withheldTax: documents.reduce((t, d) => t + d.withheld_tax, 0),
      expenseClaims, expenseTax, expenseOwed,
      commissionPosted: commissions.filter((c) => c.state === 'posted' || c.state === 'paid')
        .reduce((t, c) => t + c.amount, 0),
      commissionDraft: commissions.filter((c) => c.state === 'draft')
        .reduce((t, c) => t + c.amount, 0),
      received: paySum((p) => p.direction === 'inbound' && p.side === 'customer'),
      paidOut: paySum((p) => p.direction === 'outbound'),
      advances: payments.filter((p) => p.is_advance && p.direction === 'inbound')
        .reduce((t, p) => t + p.unallocated, 0),
      outstanding: financials?.outstanding ?? 0,
      firstEntry: ledger[0]?.entry_date ?? null,
      lastEntry: ledger.length ? ledger[ledger.length - 1].entry_date : null,
    },
  };
}
