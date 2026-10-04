# Tripzo Finance

Double-entry accounting and travel ERP for **TripzoCRM**, built the way Odoo
Accounting is built: business events produce accounting documents, documents
produce balanced journal entries, and every report — financial and managerial
alike — is a read of those entries.

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 · Postgres, in
the self-hosted Supabase that TripzoCRM already runs on.

---

## Running it

```bash
npm install
npm run dev
```

Then open <http://localhost:3100>. **With no configuration at all it starts in
demo mode** — see below. To point it at the real books, copy `.env.example` to
`.env.local` and fill in `TRIPZO_DATABASE_URL`.

There is **no migration step**. The first request creates the `accounting`
schema, installs a travel-agency chart of accounts and posts a season of demo
trading through the real posting engine — so the reports have something to show
and the ledger's guarantees are exercised on every fresh install.

### Demo mode

With `TRIPZO_DATABASE_URL` unset, the ledger runs against **Postgres compiled to
WASM, inside the Node process** — no database to install, no connection string,
no network. It is the same Postgres and the same `schema.sql`, not an emulation,
so a demo exercises the code the server runs rather than a second implementation
that could quietly disagree with it.

That makes it safe to show a client from a laptop: there is no route from a demo
to a live agency's data. CRM Sync is switched off, and an amber strip on every
screen says the figures are sample bookkeeping.

The database is **in memory**, so every restart re-seeds. A demo always opens on
the same clean books however badly the last one was mangled, and no stray file is
left behind to be mistaken later for real bookkeeping.

Demo mode is the ABSENCE of a connection string, not a flag — so a deployment
that was meant to reach Supabase and lost its variable shows demo books instead
of an error page. The amber strip is the only thing distinguishing the two;
that is what it is for.

> **Deploying?** An in-memory database on a serverless host re-seeds on every
> cold start, so nothing you enter survives. See *Deploying it* below — the
> amber strip on a deployed site always means the environment variables did not
> take.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on port 3100, against whatever `.env.local` points at |
| `npm run dev:demo` | Dev server on port 3101, forced into demo mode — embedded Postgres, sample books, no sign-in, no route to a live agency |
| `npm run build` / `npm start` | Production build and serve |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run reset` | Drop the `accounting` schema so the books are provisioned afresh |

Environment:

- `TRIPZO_DATABASE_URL` — Postgres connection string for the database behind
  your self-hosted Supabase. See *Connecting it to TripzoCRM*. **Leave it unset
  to run in demo mode** against an embedded Postgres.
- `TRIPZO_DB_SCHEMA` — schema the ledger lives in. Defaults to `accounting`.
  The CRM's own tables are in `public` and are never written to.
- `TRIPZO_SUPABASE_URL`, `TRIPZO_SUPABASE_ANON_KEY`, `TRIPZO_BACKEND_URL` —
  the CRM, for Settings → CRM Sync. Copy from `tripzo-crm-mobile/.env`.
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
accounts, CGST/UTGST for a supply inside a union territory without a
legislature, IGST at every slab, tax-inclusive pricing, TDS, and a tax report
read from the ledger's tax lines — component-wise, in the shape GSTR-3B Table
3.1 is filed from, as well as rate by rate.

**Travel** — a financial tab on every booking; profitability by trip (backed
by analytic accounts) and by SALE (every vendor bill, staff claim and agent
commission recorded against a customer invoice, which is the unit an agency
without CRM bookings actually has); package and agent profitability; agent
commissions on revenue or on profit; cancellation reporting.

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
    db.ts                 pool, schema bootstrap, transactions, sequences
    auth.ts               session, tenancy, capability enforcement
    provision.ts          one agency's opening set of books
    seed.ts               the demo agency and a season of its trading
    accounting/           the engine and every service
    crm/                  the TripzoCRM seam — see docs/crm-ledger-map.md
docs/accounting/          domain model, journal-entry rules, 30 scenarios
docs/crm-ledger-map.md    what every CRM field becomes in the ledger, and why
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
- **A per-agency reset.** Deleting one tenant's trading and re-provisioning it,
  leaving every other tenant untouched. `resetAndSeed()` is not that — it
  truncates the schema — so it refuses to run on a connected deployment.
- **Pushing the ledger's own documents back to the CRM.** The flow is one-way:
  the CRM owns invoices, this app reads and writes them there, and a document
  typed here stays here.

---

## Deploying it

Any Node host works. The notes below are for **Vercel**, because that is where
this app is deployed and because its serverless model has one failure mode worth
spelling out.

### The amber strip on a deployment means a missing variable

Demo mode is the **absence** of `TRIPZO_DATABASE_URL`, not a flag. A deployment
with that variable unset does not error — it runs on the embedded in-memory
Postgres and seeds sample books. On a laptop that is the point. On a serverless
host it is useless: every instance has its own memory and is recycled
constantly, so each cold start re-seeds from scratch and anything entered is
gone. The strip says *"changes are lost on restart"*, and on serverless the
restarts are continuous.

So: **amber strip on a deployed site = the environment variables did not take.**
Nothing else causes it.

### Environment variables

Set these in *Project → Settings → Environment Variables*, for **Production**
(and Preview, if previews should reach a database):

| Variable | Value |
|---|---|
| `TRIPZO_DATABASE_URL` | the Supabase Postgres string — see below |
| `TRIPZO_SEED_DEMO` | `0` |
| `TRIPZO_SUPABASE_URL` | `https://supa.tripzocrm.cloud` |
| `TRIPZO_SUPABASE_ANON_KEY` | from `tripzo-crm-mobile/.env` |
| `TRIPZO_BACKEND_URL` | `https://api.tripzocrm.cloud` |

Then **redeploy**. Variables are read at build time and bundled into the
deployment, so saving them in the dashboard changes nothing until a new
deployment is made.

`TRIPZO_SEED_DEMO=0` is now belt and braces rather than the belt. A deployment
that has a Supabase anon key set is a deployment that authenticates against
TripzoCRM, and `ensureDemoBooks()` refuses to seed on one at all — see the guard
in `src/server/seed.ts`. Leave the variable set anyway: it costs nothing and it
is the second of two reasons the demo cannot reach a real agency's database.

It used to be the only reason, and that was not enough. Without it the first
request seeded Wander Travels — a fictional agency with a season of invented
invoices, receipts and a cancellation — into the agency's own Postgres, and the
first real agency to sign in then **adopted those books**, so the demo's figures
turned up in its trial balance, its receivables and its GST summary. One
forgotten environment variable, and the ledger was wrong in a way that looked
like data.

What a connected deployment starts with instead is nothing: an empty schema. One
set of books per TripzoCRM agency is then provisioned on that agency's first
sign-in — chart of accounts, journals, GST and TDS, analytic plans, the default
account for every posting routine, and the current fiscal year open — with no
trading in it. See *One ledger per agency* below.

A blank field in the dashboard sets an empty string, not an unset variable.
`connectionString()` trims and checks for emptiness precisely because of this:
an empty connection string does not fail, it makes libpq quietly default to a
Postgres on localhost, which reads as "demo mode is broken" when demo mode was
simply never entered.

### Use the session pooler, port 5432

```
postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Two things in `src/server/db.ts` decide this, and both break on the
**transaction** pooler at port 6543:

- The schema bootstrap takes `pg_advisory_lock` in one statement and releases it
  in another. Transaction pooling can route those to different backends, so the
  lock protects nothing and the unlock errors.
- The pool sets `options: -c search_path=accounting`, a startup parameter that
  transaction pooling does not carry reliably. Without it every query fails with
  *relation does not exist*.

The direct address (`db.<ref>.supabase.co:5432`) satisfies both too, but is
IPv6-only on newer Supabase projects and a Vercel function cannot reach it.
Session pooling gives the same semantics over IPv4.

`TRIPZO_DB_POOL_MAX` defaults to 5 and rarely needs changing. It is per
instance, not per deployment: raise it and a busy afternoon is how a Postgres
runs out of backends while every individual function looks idle.

### What `vercel.json` sets, and why

- **`regions: ["icn1"]`** — Seoul, matching the Supabase project's own region
  (`ap-northeast-2`). This app is chatty with Postgres: one posting is a
  multi-statement transaction and one page is several queries, and every one of
  them pays the round trip. The function belongs in the same region as the
  database rather than wherever the default put it. **Change this if the
  database moves** — the two must agree, and a mismatch costs a few hundred
  milliseconds on every query rather than failing visibly.
- **`framework: "nextjs"`** — stated rather than detected, so a deployment from
  an unusual working tree cannot guess wrong.

Two things deliberately **not** in `vercel.json`:

- `maxDuration` lives on the route instead, as `export const maxDuration = 60`
  in `src/app/settings/crm-sync/page.tsx`. A sync is several round trips to the
  CRM plus a few hundred draft documents and will exceed the default ten
  seconds. No other route needs the headroom, and a blanket ceiling would hide a
  slow page rather than surface it.
- `outputFileTracingIncludes` lives in `next.config.ts`, because it is a Next
  concern rather than a host one. `src/server/schema.sql` is read with
  `readFileSync` at runtime and Next traces `import`s, not file paths — without
  that entry the file is left out of the bundle and the first request fails with
  ENOENT instead of creating the tables.

### Checking that a deployment is real

1. The amber strip is **gone**.
2. `/accounting/chart-of-accounts` lists the chart, and with
   `TRIPZO_SEED_DEMO=0` every balance is nil.
3. Raise an invoice, post it from **Review & Post**, then hard-reload. It is
   still there — which is the whole difference from demo mode.
4. `/reports/trial-balance?range=all` says debits equal credits.

---

## Connecting it to TripzoCRM

The ledger and the CRM share one Postgres — the database inside the self-hosted
Supabase at `supa.tripzocrm.cloud`. They do **not** share tables: the CRM owns
`public`, this app owns `accounting`, and nothing here writes outside its own
schema.

### 1. The connection string

Self-hosted Supabase keeps this in its own `.env` as `POSTGRES_PASSWORD`, and
Studio shows the assembled string under *Project Settings -> Database*. It looks
like:

```
postgresql://postgres:<password>@<db-host>:5432/postgres
```

Put it in `.env.local` as `TRIPZO_DATABASE_URL`. If Postgres is only reachable
from inside the Docker network, either publish port 5432 or run this app on the
same host. `sslmode=disable` in the string turns TLS off for a local instance.

**This is a superuser-grade credential.** It is server-side only — nothing under
`src/server/**` reaches a client bundle — and `.env*.local` is gitignored. Do
not put it in a `NEXT_PUBLIC_*` variable.

### 2. Reading the CRM's data

Two different routes, for two different things:

- **Business records** — leads, suppliers, invoices, payments — come over the
  CRM's REST API, exactly as the mobile app reads them (`src/server/crm/`).
  The accountant signs in at Settings -> CRM Sync with their own CRM
  credentials; the backend resolves their organization from that Supabase token
  and returns only that agency's records. There is no service account, by
  design.
- **The ledger** — accounts, journal entries, documents — is this app's own
  `accounting` schema, over the direct connection above.

To look at what the CRM actually holds before syncing, connect with psql and
read `public`:

```
psql "$TRIPZO_DATABASE_URL" -c "\dt public.*"
psql "$TRIPZO_DATABASE_URL" -c "SELECT id, name FROM public.organizations ORDER BY name"
```

### 3. Testing against Wander Travels

1. Find the agency's row: `SELECT id, name FROM public.organizations WHERE
   name ILIKE '%wander%'`. Note its `id`.
2. Sign in to the CRM as a user who belongs to that organization — an admin or
   accountant. The sync imports whatever that user can see, so a member of a
   different agency will import a different agency's books.
3. Start this app, open **Settings -> CRM Sync**, and sign in with those
   credentials. The screen shows which organization the token resolved to;
   check it says Wander Travels before syncing.
4. Press **Sync**. It imports suppliers, leads as customers, leads with a
   package as bookings, and non-draft invoices with their receipts. Everything
   lands as a **draft** in Review & Post — nothing posts itself.
5. Confirm the org name on the masthead is the CRM's. Two things keep it so:
   `resolveBooks()` adopts the name on every sign-in, and `syncFromCrm()`
   re-reads it — but only *after* checking the connection belongs to these
   books, which is why connecting with another agency's credentials can no
   longer rename this ledger after their business.
6. Check the sync report's warnings. An import that could not place a figure
   says so there by name — a GST rate that did not divide out, an `item_type`
   with no revenue account, a document whose total does not match the invoice
   the customer was sent. None of those block the import; all of them mean a
   draft to look at before posting. See `src/server/crm/invoiceMapping.ts`.
7. Post a document from Review & Post, then open
   `/reports/trial-balance?range=all` — debits must equal credits.

To start over: `npm run reset` drops the `accounting` schema, so the books are
re-provisioned on the next sign-in. The CRM's tables are untouched either way.
Settings -> **Reset the books** is the same operation from the UI and is offered
**only on a demo deployment**, because the schema now holds every agency's
ledger and truncating it would destroy all of them.

To see the demo without disturbing any of this: `npm run dev:demo`, which runs
on port 3101 against the embedded in-memory Postgres with the connection string
and the anon key emptied, so nothing in that process can reach a live agency.

### One ledger per agency

The ledger is multi-tenant, and `organizations.crm_org_id` is the whole of the
rule: **one set of books per TripzoCRM organisation**, matched on that column,
with a unique index enforcing it. `session.orgId` is the id it resolves to, and
every query in the product is filtered by it — so when Wander Travels signs in,
every account, journal, invoice, receipt, journal entry, GST figure and report
they see belongs to Wander Travels' books, and there is no path through the app
that reads a row belonging to another agency.

What happens on a first sign-in, in `resolveBooks` (`src/server/auth.ts`):

| The agency | What it gets |
|---|---|
| has books already | them, renamed to whatever the CRM now calls it |
| has none, and the deployment holds exactly one unclaimed, non-demo ledger | that one, adopted — the upgrade path for a ledger configured before the CRM was connected |
| has none, and there is nothing to adopt | a fresh set, provisioned by `provisionOrg` (`src/server/provision.ts`) |
| is not attached to any agency in the CRM | the sign-in screen, saying so — a CRM account with no organisation is a state the CRM creates on sign-up by design |

Adoption is narrow on purpose. It never takes books flagged `demo_data`, and it
never guesses between two unclaimed ledgers; both would hand one business's
history to another. A second agency signing into the same deployment used to be
refused outright (`WrongAgencyError`); it now gets its own books, which is the
difference between a multi-tenant schema and a multi-tenant product.

Two things follow from several agencies sharing one database, and both are
enforced server-side rather than in the UI:

- **Reset is demo-only.** It truncates the whole schema, so on a connected
  deployment one agency's administrator would destroy every other agency's
  ledger. `resetAndSeed()` refuses, and the Settings card says why.
- **A saved sync connection must belong to these books.** A correct password
  proves who someone is, not which agency's ledger they may import into.
  `connect()` checks before storing the token and `syncFromCrm()` aborts before
  reading a single record, because the alternative is an unattended 3am import
  of somebody else's customers and invoices into this ledger.

### The seams

- **`src/server/auth.ts`** is where the CRM session arrives: the visitor signs
  in with their own TripzoCRM credentials, the backend says who they are and
  which agency they belong to, and `resolveBooks` turns that agency into a set
  of books. `mirrorUser` gives each person a local row so that every audit entry
  and every posted entry names somebody who exists — including when the CRM is
  unreachable, and including after they leave it.
- **`bookings` and `partners`** mirror the CRM's own records and carry
  `crm_lead_id` back to them. `createBooking()` creates a booking *and* its trip
  analytic account together — a booking without one is a trip whose costs cannot
  be tagged.

Finance permissions mirror the CRM's capability architecture
(`src/lib/accounting.ts`), and the server enforces them on every mutation.
