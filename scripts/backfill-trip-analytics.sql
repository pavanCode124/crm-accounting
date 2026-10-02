-- Repair: posted P&L lines that name a booking but carry no analytic row in
-- the booking's own plan. Caused by the line-level analytic box (a flat list
-- across every plan) displacing the trip tag instead of sitting beside it.
-- Idempotent: the NOT EXISTS guard skips lines already tagged to their plan.
INSERT INTO analytic_distributions
  (org_id, line_id, analytic_id, bps, amount, entry_date, account_id, state)
SELECT jel.org_id, jel.id, b.analytic_id, 10000,
       jel.debit - jel.credit, jel.entry_date, jel.account_id, jel.state
  FROM journal_entry_lines jel
  JOIN bookings b         ON b.id  = jel.booking_id
  JOIN analytic_accounts ban ON ban.id = b.analytic_id
  JOIN accounts a         ON a.id  = jel.account_id
 WHERE a.kind IN ('income','income_other','expense_direct',
                  'expense_operating','expense_depreciation')
   AND NOT EXISTS (
     SELECT 1 FROM analytic_distributions ad
       JOIN analytic_accounts an ON an.id = ad.analytic_id
      WHERE ad.line_id = jel.id AND an.plan_id = ban.plan_id);
