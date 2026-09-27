# 01 — Accounting Domain Model

The vocabulary of the Finance branch of TripzoCRM, and what each entity is
responsible for. Read this before changing anything under `src/server/accounting/`.

The guiding rule, stated once here and assumed everywhere else:

> **Journal entry lines are the only source of truth.** No table in this system
> stores an authoritative balance. Every figure on every screen is a `SUM` over
> `journal_entry_lines`, filtered. If you are about to add a `balance` column,
> you are about to add a number that can disagree with the ledger.

---

## The shape of the system

```text
Business event (a booking, a payment, a cancellation)
        ↓
Accounting document (invoice, bill, payment, expense, depreciation slice)
        ↓
Posting engine  ── src/server/accounting/engine.ts
        ↓
Journal entry + balanced journal entry lines
        ↓
General ledger  ── the lines themselves
        ↓
Reports + analytics ── src/server/accounting/reports.ts, analytics.ts
```

Every arrow is one-way. A report never writes; a screen never posts; the engine
never decides *which* account, only *that* the entry balances.

---

## Money

Every amount is an **integer in minor units** — paise. There is no `number` of
rupees in the ledger, and `src/lib/money.ts` is the only place a minor-unit
integer becomes a string for a screen.

Quantities are stored ×1000 (`qty_milli`) so 2.5 nights or a third of a room is
exact. Percentages are stored in **basis points** (`rate_bps`, `discount_bps`,
`bps`): 1800 = 18%, 10000 = 100%. Exchange rates are stored ×10⁶ (`rate_e6`).

Rounding is half-up on the absolute value. A document's tax total is the **sum
of the rounded per-line taxes**, never a rounding of the sum — the customer adds
the column they can see, and the ledger must agree with the paper.

---

## Entities

### Account

A line in the Chart of Accounts. Identified by `code` (configurable per
organisation) and classified by `kind` (a closed set, defined in
`src/lib/accounting.ts`).

`kind` — not the code range — drives every report. An agency that renumbers its
chart must get the same Profit & Loss afterwards, so nothing may decide "6xxxxx
is an expense".

| Group | Kinds |
|---|---|
| asset | `asset_cash` `asset_receivable` `asset_current` `asset_prepaid` `asset_fixed` |
| liability | `liability_payable` `liability_tax` `liability_current` `liability_noncurrent` |
| equity | `equity` `equity_unaffected` |
| income | `income` `income_other` |
| expense | `expense_direct` `expense_operating` `expense_depreciation` |

`equity_unaffected` is retained earnings. The Balance Sheet adds the current,
**unclosed** year's profit to equity explicitly — without it the statement is
out by exactly that amount, which is the most common home-made-ledger bug.

`reconcilable` marks accounts whose lines are matched off against each other —
receivables, payables, advances. Bank and cash are reconciled against a
statement instead, which is a different mechanism.

An account that has ever been posted to is **archived, never deleted**.

### Journal

The book an entry is written in *and* the numbering series it takes its number
from. Types: `sale`, `purchase`, `bank`, `cash`, `general`. A bank or cash
journal carries a `default_account_id` — the account money moves through — and
that is what makes it payable from.

Every journal owns a sequence. Invoice numbers and payment numbers must never
interleave, and a gap in a series is a question from an auditor.

### Journal Entry / Journal Entry Line

The ledger. An entry has a date, a journal, a state (`draft` → `posted` →
`reversed`) and a **source document** (`source_model` + `source_id`). Lines
carry an account, optional partner, `debit`, `credit`, and a denormalised
`entry_date` that every report filters on.

Debit and credit are two columns, not one signed column. That makes the trial
balance a straight `SUM` and keeps a printed ledger readable without a sign
convention to remember. Exactly one of them is non-zero on any line.

A posted entry is never edited or deleted. Correcting one means a **reversal** —
a new entry with the sides swapped, dated when the correction happened.

### Partner

One master for customers and suppliers, flagged `is_customer` / `is_supplier`.
A reselling agency that also sells you hotel rooms is **one row**. Carries
GSTIN, PAN, payment terms, credit limit, an applicable TDS section, and
optional overrides of the default receivable/payable accounts.

### Document

One table (`documents`) for all four invoice-shaped records, distinguished by
`doc_type`:

| doc_type | What it is | Partner side | Sign |
|---|---|---|---|
| `out_invoice` | Customer invoice | customer | +1 |
| `out_refund` | Customer credit note | customer | −1 |
| `in_invoice` | Vendor bill | supplier | +1 |
| `in_refund` | Vendor credit note | supplier | −1 |

The posting routine is written **once** against that sign rather than four times
with the debits and credits swapped by hand. Four near-identical tables would
mean four copies of the posting, tax and residual logic, and they drift.

States: `draft` → `posted` → `cancelled`.
Payment states, derived: `not_paid` → `partial` → `paid`, or `reversed`.

`residual` is a cached column for list speed. It is recomputed from the
allocations on every change and never written by hand, so it can be rebuilt at
any time — which is the test that customer balances reconcile to AR.

### Payment

Money in or out. Two independent fields, and conflating them is a real bug this
codebase has already had:

- `direction` — `inbound` (money in) or `outbound` (money out)
- `side` — `customer` or `supplier`: **which control account it settles**

A refund to a customer is `outbound` money on the `customer` side. Deriving the
control account from the direction alone puts it on payables and leaves both
control accounts wrong by the same amount.

| Document being settled | direction | side |
|---|---|---|
| `out_invoice` | inbound | customer |
| `out_refund` | outbound | customer |
| `in_invoice` | outbound | supplier |
| `in_refund` | inbound | supplier |

`is_advance` marks money with no document behind it yet. An advance lands on a
**liability** (customer advance) or an **asset** (supplier advance), never on
AR/AP — see §02.

### Payment Allocation

The join between money and documents. One payment can settle many documents and
one document can be settled by many payments, so it is a table, not a column.
It also records a credit note applied to an invoice, where no money moves.

### Tax

Rate rows, never constants in code. `scope` (`sale` / `purchase`) keeps a sales
GST from being offered on a vendor bill. `tax_group` names the family (`gst`,
`igst`, `cgst_sgst`, `tds`, `tcs`, `vat`).

A CGST+SGST pair is **one tax on the invoice and two postings**: a parent at the
full rate the customer sees, with two children at half each carrying the
accounts the return is filed from (`tax_children`).

`price_included` means the base is a *division*, not a subtraction. ₹1,180
inclusive at 18% is a ₹1,000 base — not ₹1,180 less 18%, which is ₹967.60 and
wrong on every line.

Withholding (TDS) rows carry a `threshold`: below it, nothing is withheld.

### Analytic Plan / Analytic Account / Analytic Distribution

The management-accounting dimension. Plans seeded: **Trips**, **Departments**,
**Branches**, **Agents**.

Analytic tagging hangs off the **GL line**, not off the invoice. That is what
makes trip profitability reconcile to the P&L instead of merely resembling it,
and it is why a cash expense tagged to a trip counts toward its cost even
though no vendor bill exists.

Distributions are split in basis points and must total 10000. Only P&L lines
carry analytic weight — tagging the receivable side of an invoice to a trip
would double-count it.

**Sign convention:** analytic `amount` is `debit − credit`, so **cost is
positive and revenue is negative**. Profit is therefore `−SUM(amount)`. Every
query negates once, and only once.

### Booking

A thin mirror of the CRM booking, so Finance can show a booking financial tab
without a round trip. Creating a booking **always** creates its trip analytic
account at the same time: a booking without one is a trip whose costs cannot be
tagged, discovered three invoices later when its margin reads zero.

### Bank Account / Bank Transaction

A bank transaction is a line off the **statement**. Importing one changes no
balance. Reconciling is what posts, and it posts through the payment service,
so a matched receipt behaves exactly like one keyed by hand.

Statement amounts are **signed** — credit positive, debit negative — because a
statement is written from the bank's point of view. This is the only signed
amount in the schema.

### Accounting Period / Fiscal Year

States: `open` → `locked` → `closed`. The posting engine refuses to write into a
non-open period, so the lock is enforced at the one place everything passes
through. A date with *no* period defined is allowed — locking is an explicit
act, so an absent period cannot mean "locked".

Closing a year zeroes every income and expense account against retained
earnings and locks the twelve periods inside it.

### Asset / Deferral

Both are one amount recognised a slice at a time. The schedule is **generated
and stored**, not computed on read: it is agreed once and then followed, and
recomputing it would silently rewrite entries already posted and filed. The last
slice carries the rounding remainder, so an asset always fully depreciates.

### Budget

Planned amounts per account and/or analytic account. The **actual** column is
read from the ledger over the budget's own window — it cannot drift from the
accounts, because it *is* the accounts.

### Audit Log

Append-only, never updated, written **inside the same transaction** as the thing
it describes. A rolled-back post leaves no ghost line claiming it happened, and
a committed post can never be missing from the trail.

---

## Module map

| File | Owns |
|---|---|
| `src/server/db.ts` | The connection, transactions, ids, sequences |
| `src/server/schema.sql` | Every table |
| `src/server/accounting/engine.ts` | Posting, balancing, reversal, period guard |
| `src/server/accounting/settings.ts` | Account/journal resolution by key |
| `src/server/accounting/tax.ts` | Tax arithmetic, CGST/SGST split, withholding |
| `src/server/accounting/documents.ts` | Invoices, bills, credit notes, residuals |
| `src/server/accounting/payments.ts` | Payments, advances, allocation, matching |
| `src/server/accounting/banking.ts` | Statements, CSV import, reconciliation |
| `src/server/accounting/periods.ts` | Fiscal years, locking, opening balances, close |
| `src/server/accounting/assets.ts` | Depreciation and deferral schedules |
| `src/server/accounting/expenses.ts` | Employee expenses, advances, commissions |
| `src/server/accounting/analytics.ts` | Trip/package/agent profitability, budgets |
| `src/server/accounting/reports.ts` | P&L, Balance Sheet, Cash Flow, TB, GL, ageing |
| `src/server/accounting/masters.ts` | Accounts, journals, partners, products, bookings |
| `src/app/actions.ts` | Every mutation: capability check, one service call, redirect |

**The UI implements no accounting rules.** `src/app/actions.ts` reads a form,
calls one service and redirects. If you find yourself computing a debit in a
component, the logic belongs in a service.
