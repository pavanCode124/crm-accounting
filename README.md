# Tripzo Finance

Double-entry accounting and travel ERP for **TripzoCRM**, built the way Odoo
Accounting is built: business events produce accounting documents, documents
produce balanced journal entries, and every report — financial and managerial
alike — is a read of those entries.

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 · SQLite via
Node's built-in `node:sqlite`.

---

## Running it

```bash
npm install
npm run dev
```

Then open <http://localhost:3100>.

There is **no migration or seed step**. The first request creates the database,
installs a travel-agency chart of accounts and posts a season of demo trading
through the real posting engine — so the reports have something to show and the
ledger's guarantees are exercised on every fresh install.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on port 3100 |
| `npm run build` / `npm start` | Production build and serve |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run reset` | Delete the local books so they re-seed (stop the dev server first) |

Environment:

- `TRIPZO_DB` — path to the database file. Defaults to `data/tripzo-finance.db`.
- `TRIPZO_USER` — email of the user to sign in as, for trying the product at a
  different role. Defaults to the admin.
- `TRIPZO_SEED_DEMO=0` — configuration only, no demo trading.

Settings → **Reset the books** does the same wipe from inside the app, which
works while the server is running.

---

## The one rule

> **Journal entry lines are the only source of truth.**

No table stores an authoritative balance. Every figure on every screen is a
`SUM` over `journal_entry_lines`, filtered — which is the only way the P&L, the
Balance Sheet and a trip's margin can be *guaranteed* to agree rather than
merely observed to.

Two consequences worth knowing before reading the code:

- **Money is an integer in minor units.** Paise, never rupees, never a float.
  `src/lib/money.ts` is the only place a figure becomes a string.
- **The UI implements no accounting rules.** `src/app/actions.ts` reads a form,
  checks a capability, calls one service and redirects. Debits and credits are
  decided in `src/server/accounting/`.

---

## What is here

Everything in the MVP of the implementation plan, plus the travel-specific
layer that is the point of the product.

**Core** — chart of accounts, journals, journal entries with a draft/post/
reverse lifecycle, fiscal years and lockable periods, opening balances, year-end
close.

**Sales** — customer invoices, credit notes with percentage cancellation,
receipts, customer advances as a real liability, payment allocation across
several invoices, AR ageing, customer statements.

**Purchases** — vendor bills, Indian TDS withholding with per-section
thresholds, supplier advances, debit notes, AP ageing, supplier cost analysis.

**Banking** — bank and cash accounts, CSV statement import that understands the
shapes Indian banks actually export, duplicate-safe re-import, ranked
reconciliation suggestions with a human confirming each one, internal transfers.

**Taxes** — GST as a parent rate with CGST/SGST children posting to their own
accounts, IGST, tax-inclusive pricing, TDS, and a tax report read from the
ledger's tax lines.

**Travel** — a financial tab on every booking, trip profitability backed by
analytic accounts, package and agent profitability, agent commissions on
revenue or on margin, cancellation reporting.

**Management** — analytic plans for trips, departments, branches and agents;
budgets whose actuals come from the ledger; employee expenses with an approval
workflow; fixed assets with stored depreciation schedules; prepaid expenses and
deferred revenue.

**Reports** — Profit & Loss, Balance Sheet, Cash Flow (direct method), Trial
Balance, General Ledger with six filters, AR and AP ageing, tax, and the travel
reports above.

---

## Layout

```text
src/
  app/                    every screen, plus actions.ts (all mutations)
  components/             shared UI, document form, reconciliation, reports
  lib/                    money, the accounting vocabulary, nav registry
  server/
    schema.sql            every table
    db.ts                 connection, transactions, sequences
    auth.ts               session and capability enforcement
    seed.ts               chart of accounts + a season of demo trading
    accounting/           the engine and every service
docs/accounting/          domain model, journal-entry rules, 30 scenarios
```

Read `docs/accounting/` before changing anything under
`src/server/accounting/`. `02-journal-entry-rules.md` gives the exact debit and
credit for every event the system posts; if the code and that file disagree,
one of them is a bug.

---

## Checking that it is right

Two pages are the system's own proof, and both should be opened after any
change to posting code:

- `/reports/trial-balance?range=all` — debits must equal credits.
- `/reports/balance-sheet` — assets must equal liabilities plus equity,
  including the current year's unclosed profit.

If either stops agreeing, something has written to `journal_entry_lines`
without going through `postEntry`.

---

## What is deliberately not here

The plan's §54 says what to delay, and this follows it. Named so nobody
discovers them by surprise:

- **Automatic FX conversion, gain/loss and revaluation.** Currency, rate and
  face value are recorded on every document and every ledger line; amounts are
  entered in company currency and the accounts for gain and loss are
  configured. The automation is not written. See
  `docs/accounting/03-travel-accounting-scenarios.md` §23–26.
- **Direct bank feeds.** Statements come in as CSV; the reconciliation engine
  is already fed by a normalised transaction, so a provider is an adapter.
- **Payroll**, enterprise consolidation and jurisdictions beyond India.
- **A test suite.** The seed is the integration exercise: it posts sixteen of
  the thirty scenarios through the real engine on every fresh install, and the
  Trial Balance and Balance Sheet are the assertions.
- **The CRM session.** `src/server/auth.ts` is the seam, and it currently
  resolves the seeded organisation rather than a Supabase session.

## Connecting it to TripzoCRM

Two seams, both deliberately small:

- **`src/server/auth.ts`** is where the CRM session arrives. Today it resolves
  the seeded organisation and a user chosen by `TRIPZO_USER`; in production it
  reads the Supabase session and the org membership from the Node backend.
  Everything downstream is already written against the real shape.
- **`bookings` and `partners`** mirror the CRM's own records and carry
  `crm_lead_id` back to them. `createBooking()` creates a booking *and* its trip
  analytic account together — a booking without one is a trip whose costs cannot
  be tagged.

Finance permissions mirror the CRM's capability architecture
(`src/lib/accounting.ts`), and the server enforces them on every mutation.
