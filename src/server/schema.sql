-- ---------------------------------------------------------------------------
-- TripzoCRM Finance — schema
-- ---------------------------------------------------------------------------
-- MONEY IS NEVER A FLOAT. Every amount in this file is an BIGINT in minor
-- units (paise for INR). A ledger that stores 0.1 + 0.2 as a double will fail
-- its own trial balance eventually, and an accounting system that cannot prove
-- debits = credits is not an accounting system. Formatting back to rupees is a
-- presentation concern and lives in src/lib/money.ts.
--
-- EVERY row is scoped to an org. The CRM is multi-tenant and the ledger has to
-- be too: one agency must never see another's books.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organizations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'INR',
  country       TEXT NOT NULL DEFAULT 'IN',
  gstin         TEXT,
  pan           TEXT,
  fy_start_month BIGINT NOT NULL DEFAULT 4,   -- April, the Indian fiscal year
  address       TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id),
  name       TEXT NOT NULL,
  email      TEXT,
  -- Mirrors the CRM's roles (src/lib/capabilities.ts there):
  -- member | admin | accountant | developer | service-role
  role       TEXT NOT NULL DEFAULT 'member',
  active     BIGINT NOT NULL DEFAULT 1
);

-- Every financial action, append-only. Section 45 of the plan.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT NOT NULL,
  at          TEXT NOT NULL,
  user_id     TEXT,
  user_name   TEXT,
  action      TEXT NOT NULL,          -- created | posted | reversed | paid | ...
  model       TEXT NOT NULL,          -- document | payment | journal_entry | ...
  record_id   TEXT NOT NULL,
  summary     TEXT,
  detail      TEXT                    -- JSON blob of changed fields
);
CREATE INDEX IF NOT EXISTS ix_audit_record ON audit_log(model, record_id);

-- Document numbering. A sequence per journal per year, taken inside the same
-- transaction that writes the document so two concurrent posts cannot collide.
CREATE TABLE IF NOT EXISTS sequences (
  org_id   TEXT NOT NULL,
  code     TEXT NOT NULL,
  prefix   TEXT NOT NULL,
  padding  BIGINT NOT NULL DEFAULT 5,
  next_no  BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (org_id, code)
);

-- --------------------------------------------------------------- currencies
CREATE TABLE IF NOT EXISTS currencies (
  code     TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  symbol   TEXT NOT NULL,
  decimals BIGINT NOT NULL DEFAULT 2
);

-- Rate = how many units of company currency one unit of `code` buys, scaled by
-- 1e6, so 84.25 INR/USD is stored exactly as 84250000.
CREATE TABLE IF NOT EXISTS exchange_rates (
  id       BIGSERIAL PRIMARY KEY,
  org_id   TEXT NOT NULL,
  code     TEXT NOT NULL,
  on_date  TEXT NOT NULL,
  rate_e6  BIGINT NOT NULL,
  UNIQUE (org_id, code, on_date)
);

-- ------------------------------------------------------- chart of accounts
-- `kind` drives every report. It is a closed set, because P&L vs Balance Sheet
-- vs Cash Flow is decided from it and a typo'd kind is an account that silently
-- vanishes from both statements. See ACCOUNT_KINDS in src/lib/accounting.ts.
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  currency      TEXT,                     -- NULL = company currency
  -- A reconcilable account is one whose lines are matched off against each
  -- other: receivables, payables, advances. Bank/cash are reconciled against
  -- the statement instead, which is a different mechanism.
  reconcilable  BIGINT NOT NULL DEFAULT 0,
  -- Locking an account stops new postings without destroying its history.
  active        BIGINT NOT NULL DEFAULT 1,
  description   TEXT,
  UNIQUE (org_id, code)
);
CREATE INDEX IF NOT EXISTS ix_accounts_kind ON accounts(org_id, kind);

-- ------------------------------------------------------------------ journals
CREATE TABLE IF NOT EXISTS journals (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  code               TEXT NOT NULL,
  name               TEXT NOT NULL,
  type               TEXT NOT NULL,        -- sale | purchase | bank | cash | general
  currency           TEXT,
  default_account_id TEXT REFERENCES accounts(id),
  -- Bank/cash journals own a bank account; that is what makes them payable from.
  bank_account_id    TEXT,
  sequence_code      TEXT NOT NULL,
  active             BIGINT NOT NULL DEFAULT 1,
  UNIQUE (org_id, code)
);

-- -------------------------------------------------- periods and fiscal years
CREATE TABLE IF NOT EXISTS fiscal_years (
  id        TEXT PRIMARY KEY,
  org_id    TEXT NOT NULL,
  name      TEXT NOT NULL,
  date_from TEXT NOT NULL,
  date_to   TEXT NOT NULL,
  state     TEXT NOT NULL DEFAULT 'open'   -- open | closed
);

-- A period's state is checked by the posting engine before it writes anything.
-- `locked` = no new postings; `closed` = locked and rolled into retained
-- earnings. Neither can be bypassed from the UI -- see engine.ts.
CREATE TABLE IF NOT EXISTS accounting_periods (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  fiscal_year_id TEXT NOT NULL REFERENCES fiscal_years(id),
  name           TEXT NOT NULL,
  date_from      TEXT NOT NULL,
  date_to        TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'open'  -- open | locked | closed
);
CREATE INDEX IF NOT EXISTS ix_periods_range ON accounting_periods(org_id, date_from, date_to);

-- ------------------------------------------------------------ journal entries
-- THE SOURCE OF TRUTH. Nothing else in this schema is allowed to be the
-- authoritative record of a balance (plan section 49, Rule 2). Account balances
-- are always SUM(journal_entry_lines) over posted entries.
CREATE TABLE IF NOT EXISTS journal_entries (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  journal_id    TEXT NOT NULL REFERENCES journals(id),
  entry_no      TEXT,                    -- assigned at posting, never at draft
  entry_date    TEXT NOT NULL,
  reference     TEXT,
  narration     TEXT,
  state         TEXT NOT NULL DEFAULT 'draft',  -- draft | posted | reversed
  -- Where this entry came from. Rule 3: every entry is traceable both ways.
  source_model  TEXT,                    -- document | payment | expense | asset | opening | manual
  source_id     TEXT,
  reversal_of   TEXT REFERENCES journal_entries(id),
  currency      TEXT NOT NULL DEFAULT 'INR',
  created_by    TEXT, created_at TEXT NOT NULL,
  posted_by     TEXT, posted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_je_date   ON journal_entries(org_id, entry_date);
CREATE INDEX IF NOT EXISTS ix_je_source ON journal_entries(source_model, source_id);

CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  entry_id       TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  partner_id     TEXT,
  label          TEXT,
  -- Exactly one of these is non-zero on any given line. Storing both rather
  -- than one signed column is what makes the trial balance a straight SUM and
  -- keeps a printed ledger readable without a sign convention to remember.
  debit          BIGINT NOT NULL DEFAULT 0,
  credit         BIGINT NOT NULL DEFAULT 0,
  -- Foreign-currency face value of the same line, kept for audit (section 30).
  currency       TEXT,
  amount_currency BIGINT NOT NULL DEFAULT 0,
  rate_e6        BIGINT,
  tax_id         TEXT,
  -- Set on a tax line: the taxable value it was computed from, so tax reports
  -- can show the base beside the tax.
  tax_base       BIGINT NOT NULL DEFAULT 0,
  booking_id     TEXT,
  entry_date     TEXT NOT NULL,   -- denormalised from the entry: every report filters on it
  state          TEXT NOT NULL DEFAULT 'draft',
  -- Matching: reconciled receivable/payable lines share a match id.
  match_id       TEXT,
  reconciled     BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_jel_account ON journal_entry_lines(org_id, account_id, entry_date);
CREATE INDEX IF NOT EXISTS ix_jel_partner ON journal_entry_lines(org_id, partner_id);
CREATE INDEX IF NOT EXISTS ix_jel_entry   ON journal_entry_lines(entry_id);
CREATE INDEX IF NOT EXISTS ix_jel_booking ON journal_entry_lines(booking_id);

-- Analytic tagging hangs off the GL line, not off the invoice -- that is what
-- makes trip profitability reconcile to the P&L instead of merely resembling it.
CREATE TABLE IF NOT EXISTS analytic_plans (
  id     TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name   TEXT NOT NULL,
  code   TEXT NOT NULL,
  UNIQUE (org_id, code)
);

CREATE TABLE IF NOT EXISTS analytic_accounts (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  plan_id    TEXT NOT NULL REFERENCES analytic_plans(id),
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  -- When the analytic account IS a trip, this points at the CRM booking.
  booking_id TEXT,
  partner_id TEXT,
  active     BIGINT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_aa_plan ON analytic_accounts(org_id, plan_id);

CREATE TABLE IF NOT EXISTS analytic_distributions (
  id           BIGSERIAL PRIMARY KEY,
  org_id       TEXT NOT NULL,
  line_id      TEXT NOT NULL REFERENCES journal_entry_lines(id) ON DELETE CASCADE,
  analytic_id  TEXT NOT NULL REFERENCES analytic_accounts(id),
  -- Percent in basis points: 10000 = 100%. One GL line can be split across
  -- several trips or departments.
  bps          BIGINT NOT NULL DEFAULT 10000,
  amount       BIGINT NOT NULL,  -- signed: +cost / -revenue, in company currency
  entry_date   TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'draft'
);
CREATE INDEX IF NOT EXISTS ix_ad_analytic ON analytic_distributions(org_id, analytic_id);

-- ------------------------------------------------------------------ partners
-- ONE partner master, flagged for both sides. A supplier who is also a
-- reselling agency is one row, not two (plan section 9: do not create a second
-- customer master).
CREATE TABLE IF NOT EXISTS partners (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  name             TEXT NOT NULL,
  is_customer      BIGINT NOT NULL DEFAULT 0,
  is_supplier      BIGINT NOT NULL DEFAULT 0,
  partner_type     TEXT NOT NULL DEFAULT 'b2c',  -- b2c | b2b | agency | reseller | employee
  crm_lead_id      TEXT,          -- back-reference into the CRM
  email            TEXT,
  phone            TEXT,
  gstin            TEXT,
  pan              TEXT,
  address          TEXT,
  country          TEXT DEFAULT 'IN',
  currency         TEXT,
  payment_terms_id TEXT,
  credit_limit     BIGINT NOT NULL DEFAULT 0,
  -- Overrides of the org defaults; NULL falls back to the default AR/AP account.
  receivable_account_id TEXT,
  payable_account_id    TEXT,
  -- TDS section applicable when we PAY this supplier (194C, 194H, 194J...).
  tds_section      TEXT,
  active           BIGINT NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_partners_name ON partners(org_id, name);

CREATE TABLE IF NOT EXISTS payment_terms (
  id        TEXT PRIMARY KEY,
  org_id    TEXT NOT NULL,
  name      TEXT NOT NULL,
  days      BIGINT NOT NULL DEFAULT 0,
  note      TEXT
);

-- --------------------------------------------------------------------- taxes
-- Rates are configuration, never constants in code (plan section 20). `scope`
-- keeps a sales GST from being offered on a vendor bill.
CREATE TABLE IF NOT EXISTS taxes (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  name           TEXT NOT NULL,
  computation    TEXT NOT NULL DEFAULT 'percent',  -- percent | fixed
  rate_bps       BIGINT NOT NULL,                 -- 1800 = 18%
  scope          TEXT NOT NULL DEFAULT 'sale',     -- sale | purchase | none
  tax_group      TEXT NOT NULL DEFAULT 'gst',      -- gst | igst | cgst_sgst | tcs | tds | vat | none
  price_included BIGINT NOT NULL DEFAULT 0,
  account_id     TEXT REFERENCES accounts(id),     -- where the tax is booked
  refund_account_id TEXT REFERENCES accounts(id),
  -- TDS/TCS only: the annual threshold below which no tax is withheld.
  threshold      BIGINT NOT NULL DEFAULT 0,
  effective_from TEXT,
  active         BIGINT NOT NULL DEFAULT 1
);

-- A CGST+SGST pair is modelled as one parent with two children, so an invoice
-- line picks "GST 18%" and the engine books 9% to each account.
CREATE TABLE IF NOT EXISTS tax_children (
  parent_id TEXT NOT NULL REFERENCES taxes(id),
  child_id  TEXT NOT NULL REFERENCES taxes(id),
  PRIMARY KEY (parent_id, child_id)
);

-- ------------------------------------------------------------------ products
CREATE TABLE IF NOT EXISTS products (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  name           TEXT NOT NULL,
  code           TEXT,
  -- package | hotel | flight | visa | transport | sightseeing | guide | fee | other
  category       TEXT NOT NULL DEFAULT 'other',
  sale_price     BIGINT NOT NULL DEFAULT 0,
  cost_price     BIGINT NOT NULL DEFAULT 0,
  income_account_id  TEXT REFERENCES accounts(id),
  expense_account_id TEXT REFERENCES accounts(id),
  sale_tax_id      TEXT REFERENCES taxes(id),
  purchase_tax_id  TEXT REFERENCES taxes(id),
  active         BIGINT NOT NULL DEFAULT 1
);

-- ----------------------------------------------------------------- bookings
-- A thin mirror of the CRM booking, so Finance can show a booking financial
-- tab (section 42) without a round trip, and so a trip analytic account has a
-- home.
CREATE TABLE IF NOT EXISTS bookings (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  ref            TEXT NOT NULL,             -- BK-1023
  title          TEXT NOT NULL,             -- "Bali 5D/4N -- Rahul"
  partner_id     TEXT REFERENCES partners(id),
  -- Typed on the New Booking form, not chosen from the customer dropdown: a
  -- trip is often booked before the traveller exists as a CRM partner record,
  -- and making that record a precondition for logging the trip is backwards.
  -- `partner_id` stays alongside it for bookings that DO resolve to a real
  -- partner (every CRM sync sets both), so the AR-side reports that join on
  -- partner_id keep working unchanged.
  customer_name  TEXT,
  destination    TEXT,
  package_name   TEXT,
  agent_id       TEXT,
  agent_name     TEXT,
  branch         TEXT,
  pax            BIGINT NOT NULL DEFAULT 1,
  start_date     TEXT,
  end_date       TEXT,
  sell_value     BIGINT NOT NULL DEFAULT 0,   -- quoted value; the invoice is the truth
  status         TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | travelling | completed | cancelled
  analytic_id    TEXT REFERENCES analytic_accounts(id),
  created_at     TEXT NOT NULL,
  UNIQUE (org_id, ref)
);
-- Additive for databases that created `bookings` before `customer_name`
-- existed: `CREATE TABLE IF NOT EXISTS` above is a no-op once the table is
-- there, so the column has to be added onto the live table explicitly.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_name TEXT;

-- ---------------------------------------------------------------- documents
-- ONE table for all four invoice-shaped documents, Odoo's move model:
--   out_invoice  customer invoice      out_refund  customer credit note
--   in_invoice   vendor bill           in_refund   vendor credit note
-- The alternative -- four near-identical tables -- means four copies of the
-- posting, tax and residual logic, and they drift.
CREATE TABLE IF NOT EXISTS documents (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  doc_type       TEXT NOT NULL,
  number         TEXT,                     -- assigned on posting
  partner_id     TEXT NOT NULL REFERENCES partners(id),
  journal_id     TEXT NOT NULL REFERENCES journals(id),
  booking_id     TEXT REFERENCES bookings(id),
  analytic_id    TEXT REFERENCES analytic_accounts(id),
  doc_date       TEXT NOT NULL,
  due_date       TEXT,
  payment_terms_id TEXT,
  supplier_ref   TEXT,                     -- the vendor's own bill number
  currency       TEXT NOT NULL DEFAULT 'INR',
  rate_e6        BIGINT NOT NULL DEFAULT 1000000,
  state          TEXT NOT NULL DEFAULT 'draft',      -- draft | posted | cancelled
  -- not_paid | partial | paid | reversed -- derived, refreshed on every payment
  payment_state  TEXT NOT NULL DEFAULT 'not_paid',
  untaxed        BIGINT NOT NULL DEFAULT 0,
  tax_total      BIGINT NOT NULL DEFAULT 0,
  total          BIGINT NOT NULL DEFAULT 0,
  -- What is still owed. Cached for list speed, but recomputed from allocations
  -- on every change and never edited by hand.
  residual       BIGINT NOT NULL DEFAULT 0,
  withheld_tax   BIGINT NOT NULL DEFAULT 0,   -- TDS withheld on a vendor bill
  entry_id       TEXT REFERENCES journal_entries(id),
  reversed_by    TEXT,
  reversal_of    TEXT,
  note           TEXT,
  created_by TEXT, created_at TEXT NOT NULL,
  posted_by  TEXT, posted_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_doc_partner ON documents(org_id, partner_id, doc_type);
CREATE INDEX IF NOT EXISTS ix_doc_state   ON documents(org_id, state, doc_date);
CREATE INDEX IF NOT EXISTS ix_doc_booking ON documents(booking_id);

CREATE TABLE IF NOT EXISTS document_lines (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         BIGINT NOT NULL DEFAULT 0,
  product_id  TEXT REFERENCES products(id),
  name        TEXT NOT NULL,
  qty_milli   BIGINT NOT NULL DEFAULT 1000,   -- quantity x1000, so 2.5 nights is exact
  unit_price  BIGINT NOT NULL DEFAULT 0,
  discount_bps BIGINT NOT NULL DEFAULT 0,
  tax_id      TEXT REFERENCES taxes(id),
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  analytic_id TEXT REFERENCES analytic_accounts(id),
  subtotal    BIGINT NOT NULL DEFAULT 0,
  tax_amount  BIGINT NOT NULL DEFAULT 0,
  total       BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_dl_doc ON document_lines(document_id);

-- ----------------------------------------------------------------- payments
CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  number        TEXT,
  direction     TEXT NOT NULL,        -- inbound (money in) | outbound (money out)
  -- WHICH CONTROL ACCOUNT THIS BELONGS AGAINST, and not derivable from the
  -- direction: a refund to a customer is money going OUT against the
  -- RECEIVABLE side, and booking it to payables (as direction alone would)
  -- leaves both control accounts wrong by the same amount.
  --   out_invoice -> inbound  / customer      out_refund -> outbound / customer
  --   in_invoice  -> outbound / supplier      in_refund  -> inbound  / supplier
  side          TEXT NOT NULL DEFAULT 'customer',
  partner_id    TEXT REFERENCES partners(id),
  journal_id    TEXT NOT NULL REFERENCES journals(id),
  bank_account_id TEXT,
  booking_id    TEXT REFERENCES bookings(id),
  pay_date      TEXT NOT NULL,
  amount        BIGINT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'INR',
  rate_e6       BIGINT NOT NULL DEFAULT 1000000,
  method        TEXT NOT NULL DEFAULT 'bank',  -- cash | bank | upi | card | cheque | neft | other
  reference     TEXT,
  -- An advance is money with no invoice behind it yet: it lands on a LIABILITY
  -- (customer advance) or ASSET (supplier advance) account, not on AR/AP.
  is_advance    BIGINT NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'draft',  -- draft | posted | reconciled | cancelled
  unallocated   BIGINT NOT NULL DEFAULT 0,
  entry_id      TEXT REFERENCES journal_entries(id),
  note          TEXT,
  created_by TEXT, created_at TEXT NOT NULL,
  posted_by  TEXT, posted_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_pay_partner ON payments(org_id, partner_id);

-- One payment can settle many documents (section 16), and one document can be
-- settled by many payments. Hence a join table rather than a column on either.
CREATE TABLE IF NOT EXISTS payment_allocations (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT NOT NULL,
  payment_id  TEXT REFERENCES payments(id) ON DELETE CASCADE,
  -- A credit note can also be applied to an invoice, with no payment involved.
  credit_doc_id TEXT REFERENCES documents(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  amount      BIGINT NOT NULL,
  at          TEXT NOT NULL,
  by_user     TEXT
);
CREATE INDEX IF NOT EXISTS ix_alloc_doc ON payment_allocations(document_id);

-- ------------------------------------------------------------------ banking
CREATE TABLE IF NOT EXISTS bank_accounts (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  name        TEXT NOT NULL,
  bank_name   TEXT,
  account_no  TEXT,
  ifsc        TEXT,
  currency    TEXT NOT NULL DEFAULT 'INR',
  -- cash accounts live here too, so the Banking screen is one list
  is_cash     BIGINT NOT NULL DEFAULT 0,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  journal_id  TEXT REFERENCES journals(id),
  active      BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  txn_date     TEXT NOT NULL,
  description  TEXT,
  reference    TEXT,
  -- Signed: a credit on the statement is positive, a debit negative. A bank
  -- statement is written from the BANK's point of view, so this is the one
  -- place in the schema where a signed amount is the honest representation.
  amount       BIGINT NOT NULL,
  balance      BIGINT,
  partner_id   TEXT,
  state        TEXT NOT NULL DEFAULT 'unreconciled', -- unreconciled | reconciled
  matched_payment_id TEXT REFERENCES payments(id),
  entry_id     TEXT REFERENCES journal_entries(id),
  import_batch TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bt_acct ON bank_transactions(org_id, bank_account_id, txn_date);

-- ------------------------------------------------------------------ budgets
CREATE TABLE IF NOT EXISTS budgets (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  name        TEXT NOT NULL,
  owner       TEXT,
  date_from   TEXT NOT NULL,
  date_to     TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'draft'  -- draft | confirmed | done
);

CREATE TABLE IF NOT EXISTS budget_lines (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  budget_id   TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  account_id  TEXT REFERENCES accounts(id),
  analytic_id TEXT REFERENCES analytic_accounts(id),
  planned     BIGINT NOT NULL DEFAULT 0
);

-- ----------------------------------------------------------------- expenses
CREATE TABLE IF NOT EXISTS expenses (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  number       TEXT,
  employee_id  TEXT,
  employee_name TEXT,
  description  TEXT NOT NULL,
  expense_date TEXT NOT NULL,
  amount       BIGINT NOT NULL,
  tax_id       TEXT REFERENCES taxes(id),
  tax_amount   BIGINT NOT NULL DEFAULT 0,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  analytic_id  TEXT REFERENCES analytic_accounts(id),
  booking_id   TEXT,
  -- company = paid on the agency card, employee = reimbursable
  paid_by      TEXT NOT NULL DEFAULT 'employee',
  journal_id   TEXT REFERENCES journals(id),
  state        TEXT NOT NULL DEFAULT 'draft',  -- draft | submitted | approved | posted | paid | refused
  receipt      TEXT,
  entry_id     TEXT REFERENCES journal_entries(id),
  created_at   TEXT NOT NULL,
  approved_by  TEXT, approved_at TEXT
);

-- ------------------------------------------------------------------- assets
CREATE TABLE IF NOT EXISTS assets (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  name            TEXT NOT NULL,
  asset_account_id TEXT NOT NULL REFERENCES accounts(id),
  depreciation_account_id TEXT NOT NULL REFERENCES accounts(id), -- accumulated depreciation
  expense_account_id TEXT NOT NULL REFERENCES accounts(id),      -- depreciation expense
  journal_id      TEXT REFERENCES journals(id),
  purchase_date   TEXT NOT NULL,
  purchase_value  BIGINT NOT NULL,
  salvage_value   BIGINT NOT NULL DEFAULT 0,
  method          TEXT NOT NULL DEFAULT 'straight_line',  -- straight_line | declining
  life_months     BIGINT NOT NULL DEFAULT 36,
  declining_bps   BIGINT NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'draft',  -- draft | running | disposed
  analytic_id     TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_lines (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  asset_id   TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  seq        BIGINT NOT NULL,
  due_date   TEXT NOT NULL,
  amount     BIGINT NOT NULL,
  cumulative BIGINT NOT NULL,
  remaining  BIGINT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pending',  -- pending | posted
  entry_id   TEXT REFERENCES journal_entries(id)
);

-- Deferred expenses and deferred revenue share the asset machinery: a spread of
-- one amount over N months, posted a slice at a time (sections 34, 35).
CREATE TABLE IF NOT EXISTS deferrals (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'expense',  -- expense | revenue
  balance_account_id TEXT NOT NULL REFERENCES accounts(id),  -- prepaid / deferred revenue
  recognition_account_id TEXT NOT NULL REFERENCES accounts(id),
  journal_id    TEXT REFERENCES journals(id),
  amount        BIGINT NOT NULL,
  date_from     TEXT NOT NULL,
  months        BIGINT NOT NULL,
  analytic_id   TEXT,
  state         TEXT NOT NULL DEFAULT 'draft',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deferral_lines (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  deferral_id TEXT NOT NULL REFERENCES deferrals(id) ON DELETE CASCADE,
  seq        BIGINT NOT NULL,
  due_date   TEXT NOT NULL,
  amount     BIGINT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pending',
  entry_id   TEXT REFERENCES journal_entries(id)
);

-- -------------------------------------------------------------- commissions
CREATE TABLE IF NOT EXISTS commissions (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  agent_id     TEXT,
  agent_name   TEXT NOT NULL,
  booking_id   TEXT REFERENCES bookings(id),
  -- revenue | profit -- commission on the sale, or on what the trip actually made.
  -- 'margin' is the old name for 'profit'; rows written before the rename keep it.
  basis        TEXT NOT NULL DEFAULT 'revenue',
  rate_bps     BIGINT NOT NULL DEFAULT 0,
  fixed_amount BIGINT NOT NULL DEFAULT 0,
  base_amount  BIGINT NOT NULL DEFAULT 0,
  amount       BIGINT NOT NULL DEFAULT 0,
  due_date     TEXT,
  state        TEXT NOT NULL DEFAULT 'draft',  -- draft | posted | paid | reversed
  entry_id     TEXT REFERENCES journal_entries(id),
  created_at   TEXT NOT NULL
);

-- Settings that are genuinely per-org and would otherwise become constants in
-- code: which account the engine reaches for when nothing more specific is set.
CREATE TABLE IF NOT EXISTS org_settings (
  org_id TEXT NOT NULL,
  key    TEXT NOT NULL,
  value  TEXT,
  PRIMARY KEY (org_id, key)
);

-- ---------------------------------------------------------------------------
-- TripzoCRM connection and record links
-- ---------------------------------------------------------------------------
-- The books are DERIVED from the CRM rather than typed into this app twice, so
-- two things have to be remembered between syncs: who we are signed in as, and
-- which local record each CRM record became.

-- One row, holding the Supabase session the accountant signed in with at
-- /settings/crm-sync. The PASSWORD IS NEVER HERE — see src/server/crm/client.ts.
CREATE TABLE IF NOT EXISTS crm_connection (
  org_id        TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    BIGINT NOT NULL,       -- epoch ms
  crm_org_id    TEXT,
  crm_org_name  TEXT,
  last_sync_at  TEXT,
  last_result   TEXT
);

-- The identity map. Without it a second sync creates a second copy of every
-- invoice, which in a double-entry system is not a duplicate row but a doubled
-- set of postings — revenue, receivable and tax all twice over.
CREATE TABLE IF NOT EXISTS crm_links (
  org_id   TEXT NOT NULL,
  kind     TEXT NOT NULL,               -- partner | booking | document | payment
  crm_id   TEXT NOT NULL,
  local_id TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (org_id, kind, crm_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_links_local ON crm_links(org_id, kind, local_id);

-- ---------------------------------------------------------------------------
-- Additive columns (scale-out release)
-- ---------------------------------------------------------------------------
-- `CREATE TABLE IF NOT EXISTS` above is a no-op once a table exists, so every
-- column added after a schema has shipped has to be stated here explicitly.
-- This file is re-executed on every cold start (see db.ts `ready()`), which
-- makes these the migration: idempotent, ordered, and applied before the first
-- query of the process.

-- An agency is a legal entity, not just a display name. The invoice has to
-- carry the registered name, the GSTIN and the place of supply, and the place
-- of supply is what decides CGST+SGST against IGST — so `state_code` is a
-- posting input, not decoration.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS legal_name     TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS email          TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS phone          TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS website        TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS state_code     TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS invoice_terms  TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS invoice_footer TEXT;

-- What a remittance advice has to print, and what an agency with eleven
-- accounts needs in order to tell two HDFC currents apart in a dropdown.
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS branch_name TEXT;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS swift       TEXT;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS upi_id      TEXT;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS note        TEXT;
-- Exactly one account per org carries this, and it is what every money form
-- opens on. Without it the first option alphabetically becomes the default by
-- accident, which is how receipts end up in the wrong account.
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS is_default  BIGINT NOT NULL DEFAULT 0;

-- Terms get retired, not deleted: an invoice posted on "30 days nett" must
-- keep meaning that after the agency stops offering it.
ALTER TABLE payment_terms ADD COLUMN IF NOT EXISTS active BIGINT NOT NULL DEFAULT 1;

-- Which TDS rate was chosen on a vendor bill, not just the rupees it withheld.
-- Without it, reopening a draft bill cannot show the deduction back to the
-- user, and saving the edit would quietly drop it.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS withholding_tax_id TEXT;

-- ---------------------------------------------------------------------------
-- Statutory invoice detail (a GST tax invoice, and the statement that pays it)
-- ---------------------------------------------------------------------------
-- Everything below exists because a printed Indian tax invoice, and the payout
-- statement a marketplace or OTA sends back against it, carry facts this schema
-- could not hold. They were being lost at three separate points:
--
--   * the HSN/SAC code and the MRP are columns of the invoice itself, and Rule
--     46 of the CGST Rules requires the HSN. There was nowhere to put either.
--   * the PLACE OF SUPPLY is what decides CGST+SGST against IGST. The agency's
--     own state was already stored; the customer's was not, so the comparison
--     that chooses the tax had only one side of itself.
--   * the per-component tax SPLIT was computed at posting and then discarded. A
--     GSTR-1 return and every settlement statement want rate-wise IGST, CGST,
--     SGST and cess per line, and recomputing them later reads today's tax rows
--     rather than the ones the invoice was actually raised under.

-- The buyer's own identity, as it has to be printed. `gst_name` is the
-- registered trade name, which is routinely not the name the agency files them
-- under; `city` and `state_code` are the place of supply.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS gst_name         TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS city             TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS state_code       TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS shipping_address TEXT;

-- What a product contributes to an invoice line when it is chosen. The HSN and
-- the MRP are DEFAULTS copied onto the line, never read back at print time:
-- editing a product must not retrospectively change what an invoice said.
ALTER TABLE products ADD COLUMN IF NOT EXISTS hsn_code TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS mrp      BIGINT NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS variant  TEXT;

-- The header fields a tax invoice and an e-invoice carry.
--
-- `place_of_supply` is a GST state code and a POSTING INPUT: compared against
-- the agency's own state it is what makes a supply intra- or inter-state. It is
-- snapshotted onto the document rather than read off the partner, because a
-- customer who moves states must not change the tax on invoices already raised.
--
-- `irn` and its acknowledgement are what the Invoice Registration Portal
-- returns when an invoice is registered. They are RECORDED, not generated: this
-- product does not talk to the portal, and an invoice whose IRN cannot be
-- stored cannot be reconciled against the portal's own report.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS place_of_supply TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS irn             TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS irn_ack_no      TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS irn_ack_date    TEXT;
-- The customer's or the channel's own order reference, which is how a payout
-- statement identifies the sale. `supplier_ref` is the other direction — the
-- vendor's bill number on a purchase — and conflating the two left a sales
-- invoice with nowhere to record the order it came from.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS order_ref       TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS order_date      TEXT;
CREATE INDEX IF NOT EXISTS ix_doc_order ON documents(org_id, order_ref);

ALTER TABLE document_lines ADD COLUMN IF NOT EXISTS hsn_code TEXT;
-- The list price the discount is taken off, for the MRP column. Zero means not
-- stated, which is a different fact from an MRP of nothing.
ALTER TABLE document_lines ADD COLUMN IF NOT EXISTS mrp      BIGINT NOT NULL DEFAULT 0;

-- The per-component tax split, STORED: one row per line per tax component.
--
-- This is the same `splits` the tax engine already computes in order to decide
-- what to post; it is merely kept. Rebuilt whenever a draft's lines are saved
-- and untouched afterwards, so a posted invoice's CGST at 2.5% stays 2.5% after
-- the rate is changed for new business. `tax_group` is denormalised from the tax
-- row because that is what a statement column is keyed on (IGST / CGST / SGST /
-- CESS), and a tax later retired must not take the column heading of an invoice
-- already raised under it.
CREATE TABLE IF NOT EXISTS document_line_taxes (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  line_id     TEXT NOT NULL REFERENCES document_lines(id) ON DELETE CASCADE,
  tax_id      TEXT,
  tax_name    TEXT NOT NULL,
  tax_group   TEXT NOT NULL,          -- cgst | sgst | igst | cess | gst | other
  rate_bps    BIGINT NOT NULL DEFAULT 0,
  base        BIGINT NOT NULL DEFAULT 0,
  amount      BIGINT NOT NULL DEFAULT 0,
  account_id  TEXT
);
CREATE INDEX IF NOT EXISTS ix_dlt_doc  ON document_line_taxes(document_id);
CREATE INDEX IF NOT EXISTS ix_dlt_line ON document_line_taxes(line_id);

-- ---------------------------------------------------------------------------
-- Settlements — the payout statement
-- ---------------------------------------------------------------------------
-- WHAT A SETTLEMENT IS. An agency that sells through an OTA or a marketplace is
-- not paid per invoice. The channel collects from the traveller, keeps its
-- commission, its shipping and storage charges and the GST on all of them,
-- withholds TCS and TDS, and remits ONE net amount per cycle with a statement
-- attached. Three figures in that statement matter to the books, and none of
-- them is the invoice total:
--
--   customer payable   what the channel collected on the agency's behalf
--   deductions         its charges, the GST on them, and the tax withheld
--   net payout         what actually reaches the bank
--
-- WHY IT IS ITS OWN RECORD RATHER THAN A PAYMENT WITH A NOTE ON IT. Booking the
-- net receipt against the invoices leaves the difference nowhere: receivables
-- stay permanently short by the commission, the commission expense is never
-- recognised, and the input GST on it is never claimed. Revenue and cost are
-- both understated and the AR ageing fills with residuals nobody can clear. A
-- settlement is the record that CARRIES the deductions, and posting it is what
-- turns them into ledger entries.
--
-- POSTING reuses the machinery that already exists rather than adding a second
-- copy of it: one journal entry for the charges (each charge debited, input GST
-- debited, the receivable credited) and one ordinary inbound PAYMENT for the
-- net, allocated across the documents in the cycle. See settlements.ts.
CREATE TABLE IF NOT EXISTS settlements (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  number         TEXT,
  -- The channel: a partner flagged as a customer, because it is who owes the
  -- gross until the cycle settles.
  partner_id     TEXT NOT NULL REFERENCES partners(id),
  cycle_from     TEXT NOT NULL,
  cycle_to       TEXT NOT NULL,
  -- ORDER-LEVEL RATES, held on the header and applied per document, because
  -- that is how the channel's own statement computes them: one commission
  -- percentage for the cycle, one flat shipping charge per order. Storing the
  -- resulting rupees per order (settlement_documents) AND the rate that
  -- produced them is what lets the statement be reproduced exactly.
  commission_bps  BIGINT NOT NULL DEFAULT 0,
  charge_gst_bps  BIGINT NOT NULL DEFAULT 1800,  -- GST the channel charges on its own fees
  shipping_charge BIGINT NOT NULL DEFAULT 0,     -- per delivered order
  return_charge   BIGINT NOT NULL DEFAULT 0,     -- per cancelled or returned order
  tcs_bps         BIGINT NOT NULL DEFAULT 0,
  tds_bps         BIGINT NOT NULL DEFAULT 0,
  -- Carried forward from the channel's previous statement. INFORMATIONAL: it is
  -- already on the ledger as an unsettled receivable, so posting must not book
  -- it a second time (plan section 49, Rule 2 — the ledger is the truth).
  previous_unsettled BIGINT NOT NULL DEFAULT 0,
  pay_date        TEXT,
  utr             TEXT,                          -- the bank reference on the remittance
  bank_account_id TEXT REFERENCES bank_accounts(id),
  journal_id      TEXT REFERENCES journals(id),
  state           TEXT NOT NULL DEFAULT 'draft', -- draft | posted | cancelled
  -- Rolled up from the rows below on every change, never edited by hand.
  customer_payable BIGINT NOT NULL DEFAULT 0,
  deductions       BIGINT NOT NULL DEFAULT 0,
  additions        BIGINT NOT NULL DEFAULT 0,
  net_payout       BIGINT NOT NULL DEFAULT 0,
  entry_id        TEXT REFERENCES journal_entries(id),
  payment_id      TEXT REFERENCES payments(id),
  note            TEXT,
  created_by TEXT, created_at TEXT NOT NULL,
  posted_by  TEXT, posted_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_settle_partner ON settlements(org_id, partner_id, cycle_to);
CREATE INDEX IF NOT EXISTS ix_settle_state   ON settlements(org_id, state, cycle_to);

-- One row per document in the cycle: the order-level half of the statement.
-- Every figure is computed from the settlement's rates and the document's own
-- gross, and recomputed whenever either changes.
CREATE TABLE IF NOT EXISTS settlement_documents (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  settlement_id  TEXT NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  document_id    TEXT NOT NULL REFERENCES documents(id),
  -- forward = a sale being paid for; return = a credit note being clawed back.
  -- The channel splits its statement on exactly this line, and so does the
  -- exported workbook.
  kind           TEXT NOT NULL DEFAULT 'forward',
  gross          BIGINT NOT NULL DEFAULT 0,
  commission     BIGINT NOT NULL DEFAULT 0,
  commission_gst BIGINT NOT NULL DEFAULT 0,
  shipping       BIGINT NOT NULL DEFAULT 0,
  shipping_gst   BIGINT NOT NULL DEFAULT 0,
  return_fee     BIGINT NOT NULL DEFAULT 0,
  return_gst     BIGINT NOT NULL DEFAULT 0,
  tcs            BIGINT NOT NULL DEFAULT 0,
  tds            BIGINT NOT NULL DEFAULT 0,
  deductions     BIGINT NOT NULL DEFAULT 0,
  additions      BIGINT NOT NULL DEFAULT 0,
  payout         BIGINT NOT NULL DEFAULT 0,
  -- What the statement reports back about this order, which is not the same
  -- fact as what the ledger knows: a channel can mark an order SUCCESS in a
  -- cycle it has not actually remitted yet.
  status         TEXT NOT NULL DEFAULT 'PENDING',
  UNIQUE (settlement_id, document_id)
);
CREATE INDEX IF NOT EXISTS ix_sd_settlement ON settlement_documents(settlement_id);
CREATE INDEX IF NOT EXISTS ix_sd_document   ON settlement_documents(document_id);

-- The cycle-level charges: storage, advertising, recall, a credit or debit note
-- the channel raised, a reimbursement for inventory it lost. They belong to the
-- CYCLE rather than to any one order, which is exactly why they cannot live on
-- settlement_documents and why the statement prints them in their own block.
--
-- `section` decides the sign at posting: a deduction reduces the payout and is
-- debited to its account; an addition increases it. `code` is the catalogue
-- entry in settlements.ts, which owns the label and the default account.
CREATE TABLE IF NOT EXISTS settlement_charges (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  settlement_id TEXT NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  seq           BIGINT NOT NULL DEFAULT 0,
  code          TEXT NOT NULL,
  label         TEXT NOT NULL,
  section       TEXT NOT NULL DEFAULT 'deduction',  -- deduction | addition
  amount        BIGINT NOT NULL DEFAULT 0,
  gst_amount    BIGINT NOT NULL DEFAULT 0,
  account_id    TEXT REFERENCES accounts(id),
  note          TEXT
);
CREATE INDEX IF NOT EXISTS ix_sc_settlement ON settlement_charges(settlement_id);

-- A settlement clears the documents in its cycle without a payment row behind
-- it: the cash that arrives is the NET, while the invoices are discharged for
-- the GROSS, and the difference is the channel's charges rather than a receipt.
-- Allocation stays the one mechanism that moves a residual (see
-- `refreshResidual`), so the settlement writes allocation rows of its own and
-- this column is what makes them traceable back to it.
ALTER TABLE payment_allocations ADD COLUMN IF NOT EXISTS settlement_id TEXT;
CREATE INDEX IF NOT EXISTS ix_alloc_settlement ON payment_allocations(settlement_id);

-- The agency's own city, as a field rather than as the first line of its
-- address. A payout statement has a "Supply City" column, and deriving it by
-- splitting the free-text address on the first comma produced "Road No. 12" —
-- confidently, and wrongly, on every row. An address is for printing; a city
-- is a datum, and the two are not the same shape.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS city TEXT;

-- ---------------------------------------------------------------------------
-- The GSTIN on the document, and a default HSN/SAC that fills itself in
-- ---------------------------------------------------------------------------
-- Two gaps left by the statutory block above, both of the same shape: the field
-- existed on a master record and had no way of reaching the document.

-- THE COUNTERPARTY'S GSTIN, SNAPSHOTTED ONTO THE DOCUMENT.
--
-- It was only ever held on the partner and joined in at print time, which fails
-- in both directions. A customer or supplier typed straight into the invoice
-- form — the path this product is built around — has no partner record carrying
-- a GSTIN yet, so the registration number of the very invoice being raised had
-- nowhere to go. And joining it at read time means a partner who re-registers,
-- or whose GSTIN is corrected, retrospectively changes what every invoice
-- already issued says it was. A GSTIN is part of the document, exactly as the
-- place of supply is, so it is stored on the document.
--
-- Reads COALESCE this over the partner's own, so a document saved before this
-- column existed still prints the registration it was raised against.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS party_gstin TEXT;

-- A DEFAULT HSN/SAC, SO THE COLUMN FILLS ITSELF.
--
-- Rule 46 requires the HSN (or the SAC, for a service) on every line of a tax
-- invoice, and no system can derive it: it is a classification the taxpayer
-- assigns and answers for, and nothing in a free-text description determines it.
-- What a system CAN do is stop asking for the same six digits again.
--
-- `products.hsn_code` already covers a catalogued item. These two cover the rest
-- — and the rest is most of it for a travel agency, where a line is typed as
-- "Bali 5D/4N — 2 pax" and is not a catalogue row at all. The ACCOUNT is the
-- right place for the fallback because an account and a SAC classify the same
-- thing from two directions: everything posted to Air Ticketing Revenue is
-- 998551, everything posted to Visa Charges is 998599. The ORGANISATION's is the
-- last resort, the agency's principal service code, for a line on an account
-- nobody has classified yet.
--
-- DEFAULTS, copied onto the line and read back off it afterwards — never
-- consulted at print time. Reclassifying an account must not restate an invoice
-- issued last year, which is the same rule the price and the tax already follow.
ALTER TABLE accounts      ADD COLUMN IF NOT EXISTS default_hsn_code TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_hsn_code TEXT;
