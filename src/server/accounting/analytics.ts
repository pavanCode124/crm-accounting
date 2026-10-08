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
// Profitability per SALE — keyed on the customer invoice
// ---------------------------------------------------------------------------

/**
 * ===========================================================================
 * WHAT ONE SALE EARNED, AND WHAT IT COST TO DELIVER.
 * ===========================================================================
 * The analytic version above is the right answer for an agency that works in
 * TRIPS: costs are tagged to a `bookings` row's analytic account, the margin
 * is the general ledger sliced by that tag, and it reconciles to the P&L
 * because it IS the P&L.
 *
 * It answers nothing at all for an agency that does not. A booking is created
 * only for a CRM lead carrying a package number; an agency whose leads do not
 * carry one has no bookings, therefore no trip analytic accounts, therefore no
 * analytic distributions — and a profitability report that sums analytic
 * distributions is empty however many invoices have been raised and however
 * many supplier bills have been paid. That is not a reporting bug that can be
 * fixed in the report: the unit it reports on does not exist in the data.
 *
 * THE INVOICE IS THE UNIT THAT ALWAYS EXISTS. The agency raised it — that is
 * why the costs are being incurred — so every cost record can name it, and
 * three of them now do: a vendor bill (`documents.linked_invoice_id`), an
 * expense claim and an agent commission. Profit is revenue less those three.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A SECOND SET OF BOOKS
 * ---------------------------------------------------------------------------
 * Every figure below is read from the documents themselves — the same rows the
 * trial balance is built from, selected by the link somebody made when they
 * recorded the cost. Nothing is stored, nothing is cached, and editing an
 * invoice changes this margin in the same instant it changes the P&L.
 *
 * It does NOT double-count against the analytic report. A sale attached to a
 * trip appears in both, saying the same thing about the same rupees from two
 * directions; the screen shows the analytic table and then the sales NOT
 * attached to a trip, so nothing is added twice on one page.
 *
 * ---------------------------------------------------------------------------
 * EVERY FIGURE IS NET OF TAX, ON BOTH SIDES
 * ---------------------------------------------------------------------------
 * Output GST is collected for the government and input GST is reclaimed from
 * it. Neither is the agency's, and a margin that counted either would move
 * with the tax rate rather than with the trading — which on an 18% book is the
 * difference between a profitable package and a loss-making one. So `untaxed`
 * is summed throughout, never `total`.
 *
 * ---------------------------------------------------------------------------
 * POSTED ONLY, AND THE DRAFTS ARE COUNTED SEPARATELY
 * ---------------------------------------------------------------------------
 * A drafted bill is an intention, not a cost; including it would make a margin
 * that moves when somebody opens a form. But an agency with eighteen drafted
 * invoices and three posted ones needs to be told that, not shown an almost
 * empty report — so what is excluded is counted and named rather than silently
 * dropped. `draft_cost` is the same sum over unposted bills and claims, which
 * is what the margin is ABOUT to become.
 */
export interface SaleProfit {
  document_id: string;
  number: string | null;
  /** The CRM's own invoice number, which is the one an agent recognises. */
  crm_number: string | null;
  doc_date: string;
  state: string;
  partner_name: string | null;
  booking_id: string | null;
  booking_ref: string | null;
  /** Net of GST and net of credit notes raised against the sale. */
  revenue: number;
  credited: number;
  bill_cost: number;
  expense_cost: number;
  commission_cost: number;
  cost: number;
  profit: number;
  margin: number;
  /** Costs recorded but not yet posted — what the margin is about to become. */
  draft_cost: number;
  /** How much of the sale has actually been collected. */
  received: number;
  outstanding: number;
}

export async function saleProfitability(orgId: string, opts: {
  from?: string; to?: string; documentId?: string; limit?: number;
} = {}): Promise<SaleProfit[]> {
  const clauses = ['d.org_id = ?', "d.doc_type = 'out_invoice'", "d.state <> 'cancelled'"];
  const params: Array<string | number> = [orgId];
  if (opts.documentId) { clauses.push('d.id = ?'); params.push(opts.documentId); }
  if (opts.from) { clauses.push('d.doc_date >= ?'); params.push(opts.from); }
  if (opts.to) { clauses.push('d.doc_date <= ?'); params.push(opts.to); }

  /*
   * CORRELATED SUBQUERIES RATHER THAN FOUR LEFT JOINS, and the reason is
   * arithmetic rather than taste. Joining bills, expenses and commissions onto
   * one invoice row multiplies them together — two bills and three claims
   * produce six rows, and every figure on the invoice is then counted six
   * times. A subquery per cost source is one scalar each, and cannot fan out.
   *
   * A CREDIT NOTE REDUCES REVENUE. `reversal_of` is what ties a note to the
   * invoice it cancels, and a cancelled sale that still showed its full
   * revenue beside its full cost would report a loss on a trip that never ran.
   *
   * A DEBIT NOTE REDUCES COST, for the mirror reason: the hotel refunded a
   * room, and the trip did not bear it.
   */
  const rows = await all<Omit<SaleProfit, 'cost' | 'profit' | 'margin'>>(
    `SELECT d.id AS document_id, d.number, ci.invoice_number AS crm_number,
            d.doc_date, d.state, p.name AS partner_name,
            d.booking_id, b.ref AS booking_ref,
            d.untaxed
              - COALESCE((SELECT SUM(n.untaxed) FROM documents n
                           WHERE n.org_id = d.org_id AND n.reversal_of = d.id
                             AND n.doc_type = 'out_refund' AND n.state = 'posted'), 0)
              AS revenue,
            COALESCE((SELECT SUM(n.untaxed) FROM documents n
                       WHERE n.org_id = d.org_id AND n.reversal_of = d.id
                         AND n.doc_type = 'out_refund' AND n.state = 'posted'), 0) AS credited,
            COALESCE((SELECT SUM(CASE WHEN c.doc_type = 'in_refund' THEN -c.untaxed ELSE c.untaxed END)
                        FROM documents c
                       WHERE c.org_id = d.org_id AND c.linked_invoice_id = d.id
                         AND c.doc_type IN ('in_invoice','in_refund') AND c.state = 'posted'), 0)
              AS bill_cost,
            COALESCE((SELECT SUM(e.amount) FROM expenses e
                       WHERE e.org_id = d.org_id AND e.linked_invoice_id = d.id
                         AND e.state IN ('posted','paid')), 0) AS expense_cost,
            COALESCE((SELECT SUM(m.amount) FROM commissions m
                       WHERE m.org_id = d.org_id AND m.linked_invoice_id = d.id
                         AND m.state IN ('posted','paid')), 0) AS commission_cost,
            COALESCE((SELECT SUM(c.untaxed) FROM documents c
                       WHERE c.org_id = d.org_id AND c.linked_invoice_id = d.id
                         AND c.doc_type = 'in_invoice' AND c.state = 'draft'), 0)
            + COALESCE((SELECT SUM(e.amount) FROM expenses e
                         WHERE e.org_id = d.org_id AND e.linked_invoice_id = d.id
                           AND e.state NOT IN ('posted','paid','refused')), 0)
            + COALESCE((SELECT SUM(m.amount) FROM commissions m
                         WHERE m.org_id = d.org_id AND m.linked_invoice_id = d.id
                           AND m.state = 'draft'), 0) AS draft_cost,
            CASE WHEN d.state = 'posted' THEN d.total - d.residual ELSE 0 END AS received,
            CASE WHEN d.state = 'posted' THEN d.residual ELSE 0 END AS outstanding
       FROM documents d
       LEFT JOIN partners p ON p.id = d.partner_id
       LEFT JOIN bookings b ON b.id = d.booking_id
       LEFT JOIN LATERAL (
         SELECT x.invoice_number FROM crm_invoices x
          WHERE x.org_id = d.org_id AND x.document_id = d.id
          ORDER BY x.fetched_at DESC LIMIT 1
       ) ci ON TRUE
      WHERE ${clauses.join(' AND ')}
      ORDER BY d.doc_date DESC, d.number DESC
      LIMIT ${opts.limit ?? 500}`,
    ...params,
  );

  return rows.map((r) => {
    const cost = r.bill_cost + r.expense_cost + r.commission_cost;
    const profit = r.revenue - cost;
    return { ...r, cost, profit, margin: marginOf(r.revenue, profit) };
  });
}

/** One sale's margin — the same figures, for a single invoice. */
export async function saleMargin(orgId: string, documentId: string): Promise<SaleProfit | null> {
  const [row] = await saleProfitability(orgId, { documentId, limit: 1 });
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Profitability per BATCH — keyed on the TripzoCRM departure
// ---------------------------------------------------------------------------

/**
 * ===========================================================================
 * WHAT ONE DEPARTURE EARNED, ACROSS EVERY INVOICE RAISED AGAINST IT.
 * ===========================================================================
 * The per-sale report above answers "what did this one invoice earn"; an
 * agency selling a shared departure wants the same question asked of the
 * BATCH — several travellers' invoices and the costs bought for the group as
 * a whole, hotel rooms and a coach booked once for everyone on it rather than
 * once per traveller.
 *
 * `crm_batch_id` on `documents`, `expenses` and `commissions` is the same
 * mechanism as `linked_invoice_id`, one level up: a cost reaches a batch
 * either DIRECTLY — someone picked the batch itself on the bill because it
 * covers the whole departure — or INDIRECTLY, by naming an invoice that is
 * itself tagged to the batch. Both count, via `COALESCE(cost.crm_batch_id,
 * linked_invoice.crm_batch_id)` in every cost subquery below, so a hotel bill
 * tagged at the invoice level and one tagged at the batch level land in the
 * same total.
 *
 * NOT DOUBLE-COUNTED AGAINST "BY INVOICE": the two are different cuts of the
 * same `crm_batch_id`/`linked_invoice_id` links, read independently rather
 * than one nested inside the other — the screen says so.
 */
export interface BatchProfit {
  crm_batch_id: string;
  batch_name: string | null;
  invoices: number;
  /** Net of GST and net of credit notes raised against invoices in the batch. */
  revenue: number;
  credited: number;
  bill_cost: number;
  expense_cost: number;
  commission_cost: number;
  cost: number;
  profit: number;
  margin: number;
  received: number;
  outstanding: number;
}

export async function batchProfitability(orgId: string, opts: {
  from?: string; to?: string; batchId?: string; limit?: number;
} = {}): Promise<BatchProfit[]> {
  const clauses = [
    'd.org_id = ?', "d.doc_type = 'out_invoice'", "d.state <> 'cancelled'", 'd.crm_batch_id IS NOT NULL',
  ];
  const params: Array<string | number> = [orgId];
  if (opts.batchId) { clauses.push('d.crm_batch_id = ?'); params.push(opts.batchId); }
  if (opts.from) { clauses.push('d.doc_date >= ?'); params.push(opts.from); }
  if (opts.to) { clauses.push('d.doc_date <= ?'); params.push(opts.to); }

  const rows = await all<Omit<BatchProfit, 'cost' | 'profit' | 'margin'>>(
    `SELECT d.crm_batch_id, MAX(d.batch_name) AS batch_name,
            COUNT(*) AS invoices,
            COALESCE(SUM(d.untaxed - cr.credited), 0) AS revenue,
            COALESCE(SUM(cr.credited), 0) AS credited,
            COALESCE((SELECT SUM(CASE WHEN c.doc_type = 'in_refund' THEN -c.untaxed ELSE c.untaxed END)
                        FROM documents c
                        LEFT JOIN documents li ON li.id = c.linked_invoice_id AND li.org_id = c.org_id
                       WHERE c.org_id = d.org_id AND c.doc_type IN ('in_invoice','in_refund') AND c.state = 'posted'
                         AND COALESCE(c.crm_batch_id, li.crm_batch_id) = d.crm_batch_id), 0) AS bill_cost,
            COALESCE((SELECT SUM(e.amount) FROM expenses e
                        LEFT JOIN documents li ON li.id = e.linked_invoice_id AND li.org_id = e.org_id
                       WHERE e.org_id = d.org_id AND e.state IN ('posted','paid')
                         AND COALESCE(e.crm_batch_id, li.crm_batch_id) = d.crm_batch_id), 0) AS expense_cost,
            COALESCE((SELECT SUM(m.amount) FROM commissions m
                        LEFT JOIN documents li ON li.id = m.linked_invoice_id AND li.org_id = m.org_id
                       WHERE m.org_id = d.org_id AND m.state IN ('posted','paid')
                         AND COALESCE(m.crm_batch_id, li.crm_batch_id) = d.crm_batch_id), 0) AS commission_cost,
            COALESCE(SUM(CASE WHEN d.state = 'posted' THEN d.total - d.residual ELSE 0 END), 0) AS received,
            COALESCE(SUM(CASE WHEN d.state = 'posted' THEN d.residual ELSE 0 END), 0) AS outstanding
       FROM documents d
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(n.untaxed), 0) AS credited FROM documents n
          WHERE n.org_id = d.org_id AND n.reversal_of = d.id AND n.doc_type = 'out_refund' AND n.state = 'posted'
       ) cr ON TRUE
      WHERE ${clauses.join(' AND ')}
      GROUP BY d.crm_batch_id, d.org_id
      ORDER BY revenue DESC
      LIMIT ${opts.limit ?? 200}`,
    ...params,
  );

  return rows.map((r) => {
    const cost = r.bill_cost + r.expense_cost + r.commission_cost;
    const profit = r.revenue - cost;
    return { ...r, cost, profit, margin: marginOf(r.revenue, profit) };
  });
}

/** One batch's margin — the same figures, for a single departure. */
export async function batchMargin(orgId: string, crmBatchId: string): Promise<BatchProfit | null> {
  const [row] = await batchProfitability(orgId, { batchId: crmBatchId, limit: 1 });
  return row ?? null;
}

/**
 * Every cost record recorded against one batch, directly or via one of its
 * invoices — the detail behind `batchProfitability`, same shape as
 * `saleCosts` for the same reason: a hotel bill and a guide paid in cash are
 * the same kind of fact about this departure.
 */
export async function batchCosts(orgId: string, crmBatchId: string): Promise<SaleCostRow[]> {
  const bills = await all<SaleCostRow>(
    `SELECT 'bill' AS kind, d.id, d.number, d.doc_date AS on_date,
            p.name AS party, d.supplier_ref AS description, d.state,
            CASE WHEN d.doc_type = 'in_refund' THEN -d.untaxed ELSE d.untaxed END AS amount,
            d.tax_total AS tax_amount
       FROM documents d
       LEFT JOIN partners p ON p.id = d.partner_id
       LEFT JOIN documents li ON li.id = d.linked_invoice_id AND li.org_id = d.org_id
      WHERE d.org_id = ? AND COALESCE(d.crm_batch_id, li.crm_batch_id) = ?
        AND d.doc_type IN ('in_invoice','in_refund') AND d.state <> 'cancelled'`,
    orgId, crmBatchId,
  );
  const expenses = await all<SaleCostRow>(
    `SELECT 'expense' AS kind, e.id, e.number, e.expense_date AS on_date,
            e.employee_name AS party, e.description, e.state,
            e.amount, e.tax_amount
       FROM expenses e
       LEFT JOIN documents li ON li.id = e.linked_invoice_id AND li.org_id = e.org_id
      WHERE e.org_id = ? AND COALESCE(e.crm_batch_id, li.crm_batch_id) = ? AND e.state <> 'refused'`,
    orgId, crmBatchId,
  );
  const commissions = await all<SaleCostRow>(
    `SELECT 'commission' AS kind, c.id, NULL AS number, COALESCE(c.due_date, c.created_at) AS on_date,
            c.agent_name AS party, 'Agent commission' AS description, c.state,
            c.amount, 0 AS tax_amount
       FROM commissions c
       LEFT JOIN documents li ON li.id = c.linked_invoice_id AND li.org_id = c.org_id
      WHERE c.org_id = ? AND COALESCE(c.crm_batch_id, li.crm_batch_id) = ? AND c.state <> 'reversed'`,
    orgId, crmBatchId,
  );
  return [...bills, ...expenses, ...commissions]
    .sort((a, b) => (a.on_date < b.on_date ? -1 : a.on_date > b.on_date ? 1 : 0));
}

export interface BatchInvoiceRow {
  document_id: string; number: string | null; crm_number: string | null;
  doc_date: string; state: string; partner_name: string | null;
  untaxed: number; total: number; residual: number;
}

/** Every invoice raised against one batch, for the export's Invoices sheet. */
export async function batchInvoices(orgId: string, crmBatchId: string): Promise<BatchInvoiceRow[]> {
  return await all<BatchInvoiceRow>(
    `SELECT d.id AS document_id, d.number, ci.invoice_number AS crm_number,
            d.doc_date, d.state, p.name AS partner_name, d.untaxed, d.total, d.residual
       FROM documents d
       LEFT JOIN partners p ON p.id = d.partner_id
       LEFT JOIN LATERAL (
         SELECT x.invoice_number FROM crm_invoices x
          WHERE x.org_id = d.org_id AND x.document_id = d.id
          ORDER BY x.fetched_at DESC LIMIT 1
       ) ci ON TRUE
      WHERE d.org_id = ? AND d.crm_batch_id = ? AND d.doc_type = 'out_invoice' AND d.state <> 'cancelled'
      ORDER BY d.doc_date, d.number`,
    orgId, crmBatchId,
  );
}

/**
 * Every cost record recorded against one sale, in one list.
 *
 * THE DETAIL BEHIND THE MARGIN, and it has to be one list rather than three
 * because the question is "where did the money go", not "show me the bills".
 * A guide paid in cash and a hotel invoiced on 30 days are the same kind of
 * fact about this package, and a reader comparing them should not have to
 * visit three screens to add them up.
 *
 * DRAFTS ARE INCLUDED AND FLAGGED. They are not in the margin — nothing
 * unposted is — but they are exactly what the reader needs to see when asking
 * why the margin looks too good, so they are listed with their state rather
 * than hidden until somebody remembers to post them.
 */
export interface SaleCostRow {
  kind: 'bill' | 'expense' | 'commission';
  id: string;
  number: string | null;
  on_date: string;
  party: string | null;
  description: string | null;
  state: string;
  /** Net of reclaimable tax, signed: a supplier's credit note is negative. */
  amount: number;
  tax_amount: number;
}

export async function saleCosts(orgId: string, documentId: string): Promise<SaleCostRow[]> {
  const bills = await all<SaleCostRow>(
    `SELECT 'bill' AS kind, d.id, d.number, d.doc_date AS on_date,
            p.name AS party, d.supplier_ref AS description, d.state,
            CASE WHEN d.doc_type = 'in_refund' THEN -d.untaxed ELSE d.untaxed END AS amount,
            d.tax_total AS tax_amount
       FROM documents d LEFT JOIN partners p ON p.id = d.partner_id
      WHERE d.org_id = ? AND d.linked_invoice_id = ?
        AND d.doc_type IN ('in_invoice','in_refund') AND d.state <> 'cancelled'`,
    orgId, documentId,
  );
  const expenses = await all<SaleCostRow>(
    `SELECT 'expense' AS kind, e.id, e.number, e.expense_date AS on_date,
            e.employee_name AS party, e.description, e.state,
            e.amount, e.tax_amount
       FROM expenses e
      WHERE e.org_id = ? AND e.linked_invoice_id = ? AND e.state <> 'refused'`,
    orgId, documentId,
  );
  const commissions = await all<SaleCostRow>(
    `SELECT 'commission' AS kind, c.id, NULL AS number, COALESCE(c.due_date, c.created_at) AS on_date,
            c.agent_name AS party, 'Agent commission' AS description, c.state,
            c.amount, 0 AS tax_amount
       FROM commissions c
      WHERE c.org_id = ? AND c.linked_invoice_id = ? AND c.state <> 'reversed'`,
    orgId, documentId,
  );
  return [...bills, ...expenses, ...commissions]
    .sort((a, b) => (a.on_date < b.on_date ? -1 : a.on_date > b.on_date ? 1 : 0));
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
