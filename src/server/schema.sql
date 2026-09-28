-- ---------------------------------------------------------------------------
-- TripzoCRM Finance — schema
-- ---------------------------------------------------------------------------
-- MONEY IS NEVER A FLOAT. Every amount in this file is an INTEGER in minor
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
  fy_start_month INTEGER NOT NULL DEFAULT 4,   -- April, the Indian fiscal year
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
  active     INTEGER NOT NULL DEFAULT 1
);

-- Every financial action, append-only. Section 45 of the plan.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
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
  padding  INTEGER NOT NULL DEFAULT 5,
  next_no  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (org_id, code)
);

-- --------------------------------------------------------------- currencies
CREATE TABLE IF NOT EXISTS currencies (
  code     TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  symbol   TEXT NOT NULL,
  decimals INTEGER NOT NULL DEFAULT 2
);

-- Rate = how many units of company currency one unit of `code` buys, scaled by
-- 1e6, so 84.25 INR/USD is stored exactly as 84250000.
CREATE TABLE IF NOT EXISTS exchange_rates (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id   TEXT NOT NULL,
  code     TEXT NOT NULL,
  on_date  TEXT NOT NULL,
  rate_e6  INTEGER NOT NULL,
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
  reconcilable  INTEGER NOT NULL DEFAULT 0,
  -- Locking an account stops new postings without destroying its history.
  active        INTEGER NOT NULL DEFAULT 1,
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
  active             INTEGER NOT NULL DEFAULT 1,
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
  debit          INTEGER NOT NULL DEFAULT 0,
  credit         INTEGER NOT NULL DEFAULT 0,
  -- Foreign-currency face value of the same line, kept for audit (section 30).
  currency       TEXT,
  amount_currency INTEGER NOT NULL DEFAULT 0,
  rate_e6        INTEGER,
  tax_id         TEXT,
  -- Set on a tax line: the taxable value it was computed from, so tax reports
  -- can show the base beside the tax.
  tax_base       INTEGER NOT NULL DEFAULT 0,
  booking_id     TEXT,
  entry_date     TEXT NOT NULL,   -- denormalised from the entry: every report filters on it
  state          TEXT NOT NULL DEFAULT 'draft',
  -- Matching: reconciled receivable/payable lines share a match id.
  match_id       TEXT,
  reconciled     INTEGER NOT NULL DEFAULT 0
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
  active     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_aa_plan ON analytic_accounts(org_id, plan_id);

CREATE TABLE IF NOT EXISTS analytic_distributions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id       TEXT NOT NULL,
  line_id      TEXT NOT NULL REFERENCES journal_entry_lines(id) ON DELETE CASCADE,
  analytic_id  TEXT NOT NULL REFERENCES analytic_accounts(id),
  -- Percent in basis points: 10000 = 100%. One GL line can be split across
  -- several trips or departments.
  bps          INTEGER NOT NULL DEFAULT 10000,
  amount       INTEGER NOT NULL,  -- signed: +cost / -revenue, in company currency
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
  is_customer      INTEGER NOT NULL DEFAULT 0,
  is_supplier      INTEGER NOT NULL DEFAULT 0,
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
  credit_limit     INTEGER NOT NULL DEFAULT 0,
  -- Overrides of the org defaults; NULL falls back to the default AR/AP account.
  receivable_account_id TEXT,
  payable_account_id    TEXT,
  -- TDS section applicable when we PAY this supplier (194C, 194H, 194J...).
  tds_section      TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_partners_name ON partners(org_id, name);

CREATE TABLE IF NOT EXISTS payment_terms (
  id        TEXT PRIMARY KEY,
  org_id    TEXT NOT NULL,
  name      TEXT NOT NULL,
  days      INTEGER NOT NULL DEFAULT 0,
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
  rate_bps       INTEGER NOT NULL,                 -- 1800 = 18%
  scope          TEXT NOT NULL DEFAULT 'sale',     -- sale | purchase | none
  tax_group      TEXT NOT NULL DEFAULT 'gst',      -- gst | igst | cgst_sgst | tcs | tds | vat | none
  price_included INTEGER NOT NULL DEFAULT 0,
  account_id     TEXT REFERENCES accounts(id),     -- where the tax is booked
  refund_account_id TEXT REFERENCES accounts(id),
  -- TDS/TCS only: the annual threshold below which no tax is withheld.
  threshold      INTEGER NOT NULL DEFAULT 0,
  effective_from TEXT,
  active         INTEGER NOT NULL DEFAULT 1
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
  sale_price     INTEGER NOT NULL DEFAULT 0,
  cost_price     INTEGER NOT NULL DEFAULT 0,
  income_account_id  TEXT REFERENCES accounts(id),
  expense_account_id TEXT REFERENCES accounts(id),
  sale_tax_id      TEXT REFERENCES taxes(id),
  purchase_tax_id  TEXT REFERENCES taxes(id),
  active         INTEGER NOT NULL DEFAULT 1
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
  destination    TEXT,
  package_name   TEXT,
  agent_id       TEXT,
  agent_name     TEXT,
  branch         TEXT,
  pax            INTEGER NOT NULL DEFAULT 1,
  start_date     TEXT,
  end_date       TEXT,
  sell_value     INTEGER NOT NULL DEFAULT 0,   -- quoted value; the invoice is the truth
  status         TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | travelling | completed | cancelled
  analytic_id    TEXT REFERENCES analytic_accounts(id),
  created_at     TEXT NOT NULL,
  UNIQUE (org_id, ref)
);

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
  rate_e6        INTEGER NOT NULL DEFAULT 1000000,
  state          TEXT NOT NULL DEFAULT 'draft',      -- draft | posted | cancelled
  -- not_paid | partial | paid | reversed -- derived, refreshed on every payment
  payment_state  TEXT NOT NULL DEFAULT 'not_paid',
  untaxed        INTEGER NOT NULL DEFAULT 0,
  tax_total      INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  -- What is still owed. Cached for list speed, but recomputed from allocations
  -- on every change and never edited by hand.
  residual       INTEGER NOT NULL DEFAULT 0,
  withheld_tax   INTEGER NOT NULL DEFAULT 0,   -- TDS withheld on a vendor bill
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
  seq         INTEGER NOT NULL DEFAULT 0,
  product_id  TEXT REFERENCES products(id),
  name        TEXT NOT NULL,
  qty_milli   INTEGER NOT NULL DEFAULT 1000,   -- quantity x1000, so 2.5 nights is exact
  unit_price  INTEGER NOT NULL DEFAULT 0,
  discount_bps INTEGER NOT NULL DEFAULT 0,
  tax_id      TEXT REFERENCES taxes(id),
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  analytic_id TEXT REFERENCES analytic_accounts(id),
  subtotal    INTEGER NOT NULL DEFAULT 0,
  tax_amount  INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0
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
  amount        INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'INR',
  rate_e6       INTEGER NOT NULL DEFAULT 1000000,
  method        TEXT NOT NULL DEFAULT 'bank',  -- cash | bank | upi | card | cheque | neft | other
  reference     TEXT,
  -- An advance is money with no invoice behind it yet: it lands on a LIABILITY
  -- (customer advance) or ASSET (supplier advance) account, not on AR/AP.
  is_advance    INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'draft',  -- draft | posted | reconciled | cancelled
  unallocated   INTEGER NOT NULL DEFAULT 0,
  entry_id      TEXT REFERENCES journal_entries(id),
  note          TEXT,
  created_by TEXT, created_at TEXT NOT NULL,
  posted_by  TEXT, posted_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_pay_partner ON payments(org_id, partner_id);

-- One payment can settle many documents (section 16), and one document can be
-- settled by many payments. Hence a join table rather than a column on either.
CREATE TABLE IF NOT EXISTS payment_allocations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL,
  payment_id  TEXT REFERENCES payments(id) ON DELETE CASCADE,
  -- A credit note can also be applied to an invoice, with no payment involved.
  credit_doc_id TEXT REFERENCES documents(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  amount      INTEGER NOT NULL,
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
  is_cash     INTEGER NOT NULL DEFAULT 0,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  journal_id  TEXT REFERENCES journals(id),
  active      INTEGER NOT NULL DEFAULT 1
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
  amount       INTEGER NOT NULL,
  balance      INTEGER,
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
  planned     INTEGER NOT NULL DEFAULT 0
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
  amount       INTEGER NOT NULL,
  tax_id       TEXT REFERENCES taxes(id),
  tax_amount   INTEGER NOT NULL DEFAULT 0,
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
  purchase_value  INTEGER NOT NULL,
  salvage_value   INTEGER NOT NULL DEFAULT 0,
  method          TEXT NOT NULL DEFAULT 'straight_line',  -- straight_line | declining
  life_months     INTEGER NOT NULL DEFAULT 36,
  declining_bps   INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'draft',  -- draft | running | disposed
  analytic_id     TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_lines (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  asset_id   TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  due_date   TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  cumulative INTEGER NOT NULL,
  remaining  INTEGER NOT NULL,
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
  amount        INTEGER NOT NULL,
  date_from     TEXT NOT NULL,
  months        INTEGER NOT NULL,
  analytic_id   TEXT,
  state         TEXT NOT NULL DEFAULT 'draft',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deferral_lines (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  deferral_id TEXT NOT NULL REFERENCES deferrals(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  due_date   TEXT NOT NULL,
  amount     INTEGER NOT NULL,
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
  -- revenue | margin -- commission on the sale, or on what the trip actually made
  basis        TEXT NOT NULL DEFAULT 'revenue',
  rate_bps     INTEGER NOT NULL DEFAULT 0,
  fixed_amount INTEGER NOT NULL DEFAULT 0,
  base_amount  INTEGER NOT NULL DEFAULT 0,
  amount       INTEGER NOT NULL DEFAULT 0,
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
  expires_at    INTEGER NOT NULL,       -- epoch ms
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
