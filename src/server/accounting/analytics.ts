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
