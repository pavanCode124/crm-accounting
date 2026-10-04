# TripzoCRM → the ledger: what becomes what, and why

This app is the finance branch of TripzoCRM, not a separate product beside it.
Everything an agency sells is recorded in the CRM; everything it has to answer
for is recorded here. This file is the map between the two, feature by feature,
with the reason for each decision beside it — because the reasons are the part
that gets lost, and a mapping nobody can justify is a mapping the next person
changes by accident.

Read `docs/accounting/02-journal-entry-rules.md` for the debits and credits
themselves. This file is only about where the CRM's data lands.

---

## The rule everything else rests on

**One set of books per CRM agency.** `organizations.crm_org_id` is the join,
the unique index on it is the enforcement, and `session.orgId` — which every
query in this product is filtered by — is the id it resolves to.

When Wander Travels signs in, every account, journal, invoice, receipt, journal
entry, tax figure and report they see is a row whose `org_id` is Wander
Travels'. There is no path through the app that reads another agency's row, and
three separate things keep it that way:

| Where | What it stops |
|---|---|
| `resolveBooks` in `server/auth.ts` | an agency opening books that are not theirs; a second agency being refused instead of provisioned |
| the `org_id` filter on every query, including the child readers (`documentLines`, `allocationsFor`, `paymentTaxes`, `taxChildren`) | a document id out of a URL reaching another agency's lines |
| `connect` and `syncFromCrm` in `server/crm/` | a mis-typed sync credential importing another agency's customers and invoices into this ledger |

The CRM's own scoping is never re-implemented here. Every read of CRM data goes
through `/api/*` carrying the signed-in person's token, so this app sees exactly
what that person sees on their phone, decided in the same place — see the note
at the top of `server/crm/live.ts`.

---

## Identity

| TripzoCRM | The ledger | Why |
|---|---|---|
| organisation | `organizations` row, `crm_org_id` | One business, one set of books. The CRM owns the **name**, so a rename there reaches the masthead, every report header and every exported statement on the next page load. |
| user (Supabase auth id) | `users` row, `crm_user_id` | **Mirrored, not replaced.** Every audit entry and every posted entry names a `users.id`, and those references have to resolve for ever — including when the CRM is unreachable and after somebody is removed from it. What is refreshed each visit is the mutable part, name and role, so a promotion reaches the books on the next page load. |
| role (`member`, `admin`, `developer`, …) | `session.role`, read by `ROLE_CAPS` | `ROLE_CAPS` in `lib/accounting.ts` is keyed by the CRM's **own** role names, deliberately, so there is no translation table — a translation table is exactly where a privilege bug hides. |
| lead | `partners` row, `crm_lead_id` | A lead that has been invoiced is a customer. The back-reference is an identity, not a label, so a renamed lead is still the same partner. |
| supplier | `partners` row (`is_supplier`) | Same reasoning on the buying side. |
| lead with a package | `bookings` row **and** a `TRIPS` analytic account | `createBooking` makes both together. A booking without an analytic account is a trip whose costs cannot be tagged, so profit-per-departure stops being answerable. |

### What does *not* get mirrored

Conversations, messages, tasks, batches, Instagram and WhatsApp threads. None of
them is a financial event. A ledger that mirrored them would be a second copy of
the CRM with worse search.

---

## Packages — and the GST column

The question this answers: *why does the ledger have a GST rate against a
package when the package lives in the CRM?*

| TripzoCRM | The ledger | Why |
|---|---|---|
| `packages` | read **live** (`server/crm/live.ts`), with a fallback snapshot in `crm_packages` | A package re-priced this morning has to appear in this afternoon's invoice at the new price, so the live read always wins when it answers. The snapshot is what a form falls back to when the CRM does not — a dropdown that empties because another system is restarting is a form nobody can raise an invoice on — and it is what lets a rate chosen for a package still **name** that package after it has gone from the catalogue. Fallback only on an empty live read, never merged: merging would resurrect a package deliberately hidden over there, for ever, on a form that raises statutory documents. |
| — | `crm_package_tax` (`org_id`, `crm_package_id`, `tax_id`) | **The rate is the agency's, the package is the CRM's.** |

The rate could not live in the CRM, and that is not a layering preference:

- It is a **classification of the agency's own supply**, made under the agency's
  own GSTIN, and it is the agency that answers for it in a return.
- **Two agencies reselling the same itinerary can legitimately be on different
  rates.** A tour operator that takes input credit charges 18% under Heading
  9985; one that has deliberately chosen the no-credit option charges 5%. The
  catalogue cannot answer for either of them.
- So the catalogue stays live from the CRM and the rate is a row in this
  ledger, joined by the CRM's id at read time. Nothing is copied in either
  direction.

Three consequences worth knowing:

1. **No row means the default**, resolved at read time — 18%, or the nearest
   rate the agency has configured. A table pre-filled with a row per package
   would have to be kept in step with a catalogue this database does not own.
2. **The catalogue price is GST-inclusive.** A traveller is quoted one figure
   and pays that figure, so backing the tax out is a *division*
   (`splitInclusive`). ₹47,200 at 18% is ₹40,000 + ₹7,200 — not ₹47,200 plus
   18%, which charges ₹8,496 nobody quoted, and not ₹47,200 less 18%, which
   understates the base by ₹1,296 on every sale.
3. **Changing the rate changes the next invoice, never the last one.** A
   document line's tax split is snapshotted onto the line when it is saved
   (`document_line_taxes`), so an invoice already raised keeps the rate it was
   raised at. Audited, because it decides what every future invoice from that
   package will charge.

`package_name` on that table is a snapshot for the screen, so a row whose
package has been deleted in the CRM can still say what it used to be instead of
showing a bare id.

---

## Invoices

**The traffic is one-way. TripzoCRM is read; this ledger is written.**

The CRM owns the *sale*: an agent raises the invoice on their phone, takes the
advance, and the customer's copy is generated there. This ledger owns the
*books*: the journal, the revenue account per line, the CGST/SGST split, the
HSN, and the entry a trial balance reconciles to. Neither system holds what the
other is answerable for.

Three stages, and it is worth knowing which one you are looking at:

| Stage | Where | Repeatable? |
|---|---|---|
| **fetch** | `server/crm/sync.ts` → `server/crm/mirror.ts` | **Always.** A row is overwritten with a fresher reading of the same CRM record. No accounting judgement is applied and nothing is decided. |
| **import** | `server/crm/sync.ts` → `createDocument` / `createPayment` | **Never repeats.** `crm_invoices.document_id` is claimed in the same transaction as the document, so a second run — or a concurrent one — skips what is already in the books. |
| **complete and post** | `/sales/invoices/{id}/edit`, then Review & Post | A person's act, every time. |

### Why this app never writes to the CRM

For one release it did: the invoice screens POSTed, PATCHed and DELETEd
`/api/invoices` directly. The reasoning was that there is only one invoice and
it belongs to the CRM. Two things went wrong with it, and the second is worse
than the first.

1. **No invoice ever reached the ledger.** A CRM invoice has no journal, no
   revenue account, no tax row and no HSN, so nothing was written to
   `documents` — therefore no journal entry, no tax posting, no balance. Review
   & Post, the general ledger, the trial balance, the GST summary and every
   report built on them were empty, in a product whose entire purpose is to
   produce them.
2. **An accounting app was writing to the agency's operational system.** A
   mapping bug, a double-submitted form or a mis-scoped token could alter the
   record a customer's invoice is generated from, and nothing in the ledger
   could detect or undo it.

So the direction is now enforced **structurally rather than by convention**:
`crmFetch` takes no method and no body parameter, and refuses a path whose shape
names a mutating action. A write to the CRM is not forbidden in this codebase —
it is unexpressible. `createInvoice`, `updateInvoice`, `deleteInvoice` and
`addInvoicePayment` are gone, along with the three actions that called them.

The "Save to TripzoCRM" button is now just **Save**, and it writes a document to
this ledger's own Postgres through `saveDocumentAction` — the same action, the
same table and the same posting service a vendor bill uses. One invoice form,
one save path, one database.

### The mirror

| TripzoCRM | The ledger | Why |
|---|---|---|
| `invoices` row | `crm_invoices` (`org_id`, `crm_id`) | Everything read is kept, in paise, with `fetched_at` saying when it was true and `raw` holding the whole payload. |
| `invoice_items` | `crm_invoice_items` | Replaced wholesale on each fetch of their invoice: the CRM's own update endpoint deletes and rewrites lines, so ids are not stable and a line removed over there has to disappear here. |
| `invoice_payments` | `crm_invoice_payments`, with `is_advance` | Re-read for **every** invoice on every fetch, including ones already in the books — a second instalment arrives long after the invoice has stopped changing. The old importer only fetched payments for invoices it was creating, so later instalments were never seen again by anything. |
| `packages` | `crm_packages` | The fallback snapshot described above. |

Three reasons the mirror exists rather than reading the CRM live on each render:

- **The CRM cannot be edited, so the thing being edited has to live here** —
  and it has to be complete before anybody edits it.
- **A ledger cannot depend on a network call.** The live screens emptied
  themselves, tiles included, whenever the backend cold-started or a token aged
  out. A trial balance that goes blank because another system is restarting is
  not a trial balance.
- **A figure already filed must not move.** An invoice reported in September's
  GSTR-1 says what it said. Reading the CRM live meant somebody editing it in
  October silently restated a filed return.

`raw` is the whole payload as JSON because every column beside it is a field
this app understands *today*. A field the schema has not got yet is a fact
silently dropped at the moment of import, unrecoverable afterwards — the next
fetch sees an invoice already mirrored. A few kilobytes per invoice buys the
ability to backfill from what was actually read.

### Units, which is the one thing to get right

The CRM answers in **whole rupees** (`subtotal: 55000` is ₹55,000). This app
stores and formats **minor units** throughout, the mirror included. The
conversion happens exactly once, on the way in, in `mirror.ts`. A figure that
crosses it twice is out by a factor of a hundred — on an invoice, the difference
between ₹550 and ₹55,000.

### The import, field by field

`server/crm/invoiceMapping.ts` holds this and nothing else, so each decision has
somewhere to be written down.

| CRM field | Ledger | Why this and not something else |
|---|---|---|
| `status` = `cancelled` | mirrored, **not drafted** | A cancelled invoice never happened, so it is not a fact the ledger should carry — but the fact that the CRM holds it is worth keeping, so it is mirrored and shows as "Not drafted" on the import screen rather than vanishing. |
| `status` = `draft` | a **ledger draft**, with a note saying so | This used to be skipped, on the reasoning that a CRM draft is a proposal. In this product's actual workflow that was the wrong call: an agent raises the invoice in the CRM with no books fields on it at all, and the accountant's whole job is to complete it here. A ledger draft moves no balance, appears in no report and proves nothing until somebody posts it — so importing it costs nothing, while skipping it meant the invoice the accountant was waiting for simply never appeared, with nothing on screen to say why. |
| `doc_type` = `refund` | `out_refund` | A refund is a credit note, not a bill owed on. |
| `items[].item_type` | the revenue account, via `REVENUE_ACCOUNT_OF_ITEM` | **The mapping the importer did not have, and its absence was the most expensive thing about it.** Every line used to go to whichever income account sorted first, so a year of hotels, flights, visas and packages all landed in Package Revenue. The trial balance was right, the P&L was one line, and *which part of what we sell makes money* had no answer in the books. |
| `items[].qty` × `items[].rate` | `qtyMilli`, `unitPrice` | The CRM stores `amount` as well and the ledger recomputes it, so sending the stored figure would be sending something this app ignores. Where the three disagree, `reconcileTotal` reports it rather than papering over it. |
| `items[].hsn_sac` | `document_lines.hsn_code` | Rule 46 of the CGST Rules requires an HSN or SAC **per line**. Snapshotted onto the line, not read off the product at print time: a product reclassified next year must not change what this invoice said it was selling. |
| — (blank `hsn_sac`) | `SAC_OF_ITEM`, then the account's default, then the agency's | Four rungs, because the CRM's invoice form leaves `hsn_sac` blank on most lines and a blank Rule 46 column is a defective tax invoice. |
| `tax_amount` | a `tax_id` on every line | The CRM holds an **amount** for the whole invoice; the ledger needs a **rate**, because tax is posted per line and split per component. `resolveSaleTax` divides it out and matches the agency's own rows within a tenth of a percent — a tolerance, because the CRM rounds to whole rupees, but a tight one, because the real rates are 5/12/18% and hundreds of basis points apart. |
| `place_of_supply`, or the customer GSTIN's first two digits | `documents.place_of_supply`, and **CGST+SGST vs IGST** | Not a label — a posting input. Against the agency's own state it decides whether the 18% is two liabilities to two governments or one. Getting it wrong changes what the customer pays by nothing and makes every row of GSTR-1 wrong, corrected by paying again and claiming a refund. Unknown is treated as **intra**-state, because an unknown state is not a different state. |
| `customer_gstin` | `documents.party_gstin`, and `supply_type` | A GSTIN means a supply to a registered business, reported invoice-wise in GSTR-1 Table 4A; none means a consumer, reported in aggregate. Deriving the supply type rather than defaulting to `b2c` is what keeps a corporate booking out of the wrong table. Snapshotted, so a customer who re-registers does not change an invoice already issued. |
| `discount_amount` | `discountBps`, the **same rate on every line** | The CRM holds one figure for the invoice; a ledger line holds its own, because a discount changes the taxable value tax is computed on. A ₹5,000 discount on a ₹50,000 invoice was almost always "10% off", and 10% off each line gives the right tax per line. Putting the whole amount on the first line makes that line's tax wrong and the next line's wrong the other way. |
| `amount_withheld` | **a note on the draft, not a posting** | On a *sales* invoice this is income tax the **customer** withheld from what they paid — a Section 194 deduction on the agency's own receipts. It is an **asset** (`TDS Receivable`), set off at assessment; booking it as an expense makes the agency pay the same tax twice. It is emphatically *not* the document's `withholdingTaxId`, which is for a **vendor bill**, where the agency withholds and the credit is TDS Payable. It is also not yet a fact: nothing is withheld until the customer pays. So it is recorded where the reviewer reads it and realised against TDS Receivable when the short receipt is entered. |
| `payments[]` dated **on or after** the invoice | a `payments` row, unposted, unallocated | A receipt against the receivable. It carries no tax of its own — the invoice already charged it. The allocation cannot be made yet: the invoice is a draft too, and settling an unposted document is meaningless. Review & Post handles the pair in the order that works. |
| `payments[]` dated **before** the invoice | a `payments` row with `is_advance`, and the invoice's own GST rate on it | **Section 13(2) of the CGST Act** fixes the time of supply of a *service* at the earlier of the invoice or the receipt of payment, and Notification 66/2017-CT lifted that for goods only. So ₹47,200 taken in September against a December trip is a **September** liability: ₹40,000 on Customer Advances and ₹7,200 of output GST, backed **out** of the receipt because what the bank shows is what the customer actually sent. The receipt is itself a statutory document under section 31(3)(d) — a receipt voucher. TripzoCRM records both kinds as "a payment on an invoice" and draws no distinction, so the comparison is made once at fetch time and stored; deriving it later would read whatever the invoice's date had become since. Where no rate can be derived the advance is drafted with **no** tax and the run says so by name, because an untaxed advance is visibly incomplete in Review & Post whereas a guessed rate is a filed figure nobody questioned. |
| the CRM's `invoice_number` | `documents.order_ref`, **never** `documents.number` | `documents.number` is this ledger's own serial, taken from a sequence inside the posting transaction, and it has to be gapless and unique for an auditor. Putting another system's numbering into the agency's statutory series is not a thing to do for convenience. `order_ref` is the column for the counterparty's own reference, and it is indexed — so searching the ledger by the number on the CRM invoice finds the document. |
| the total | compared against the ledger's, every time | See below. |

### The total check, which is the most useful line in the file

Every decision above is a judgement, and any of them can be wrong in a way that
**posts perfectly cleanly**: debits equal credits, the balance sheet balances,
every guarantee the engine offers holds, and the document states a different
total from the invoice the customer was actually sent.

Nothing in the posting machinery can catch that, because it has no idea what the
CRM said. `reconcileTotal` is the one place the two figures meet, so the
comparison is made on every import and a discrepancy is reported **with both
figures in the message** — one rupee of tolerance, because the CRM rounds its
totals to whole rupees while the ledger works in paise.

### Nothing posts itself

A sync writes drafts and master data and stops. The CA signs the books; a
posting that appeared because a sales executive changed a status in another
application is a posting nobody chose, in an entry nobody read, and the first
time anyone examines it is when the GST return will not tie. A draft costs one
click per document and buys the thing the product is for: every figure in these
books was put there by a person who looked at it.

Every warning the mapping raises is non-blocking for the same reason. **Money is
never silently dropped** — a rate that did not divide out, an `item_type` with no
revenue account, a total that does not tie — but neither does a figure this app
could not place stop the rest of the agency's invoices from arriving.

### The GST block the mobile app strips, and why it no longer matters here

This used to be the most dangerous paragraph in the file, and the change above
has defused it. It is kept because the CRM-side hazard is real and somebody will
meet it.

TripzoCRM's invoice editor and its `syncPaidStatus` helper both save through
`PATCH /api/invoices/{id}`, and that endpoint **replaces every line item with
what it is sent**. What the mobile app sends is `item_type`, `title`,
`description`, `qty`, `rate`, `amount`, `sort_order` — no `hsn_sac`, and no
`customer_gstin`, `place_of_supply` or `amount_withheld` in its header payload
either, because the mobile `Invoice` type does not carry the GST block at all. A
phone does not raise a tax invoice.

So a CRM invoice can lose its Rule 46 column the next time anybody opens it on
their phone, and `syncPaidStatus` takes the same path **with no human
involved** the moment a balance reaches zero: an invoice can become defective by
being paid.

**None of that can reach the books, and now none of it can be caused by this
app either.**

1. **The ledger's copy was never at risk.** A document line's HSN and tax split
   are snapshotted onto `document_lines.hsn_code` and `document_line_taxes` when
   the document is saved, and never read back off the CRM. The book of account
   is independent of what the CRM does to its own row afterwards.
2. **The mirror keeps what was read.** `crm_invoices` and `crm_invoice_items`
   hold the GST block as it stood at `fetched_at`, and `raw` holds the whole
   payload. If the CRM's copy is later stripped, this database still has the
   version the document was drafted from — which is the evidence an assessment
   actually turns on.
3. **This app no longer PATCHes anything**, so it cannot strip the block itself,
   and it cannot be blamed for a round-trip that dropped a column. Saving an
   invoice here writes a ledger document and nothing else.
4. **A blank `hsn_sac` is resolved through four rungs** — the line, then
   `SAC_OF_ITEM`, then the account's `default_hsn_code`, then the agency's — so
   a stripped column still produces a compliant invoice out of this app.

The remaining fix is on the CRM side: the mobile app should round-trip the
columns it does not edit. That is a change in `tripzo-crm-mobile`, not here, and
nothing in this repository should attempt it.

---

## Finances (the CRM's per-trip books)

The CRM's Finances tab keeps per-departure revenue and expense rows — a
management view, owned by operations, edited on a phone. It is **not** imported.

The ledger answers the same question from its own data and better: a booking's
analytic account carries every posted line that touched that trip, so
profit-per-departure is a query over the book of account rather than a second
ledger kept in parallel. Importing the CRM's rows would mean the same expense
appearing twice — once as the operations team recorded it and once as the vendor
bill that paid for it — and no way to tell which was which.

The two are reconciled by *looking*, not by copying: `/analytics/trips`.

---

## What the ledger owns outright

None of these exist in the CRM, and that is why this app does:

| Feature | Why it cannot live in the CRM |
|---|---|
| chart of accounts, journals | The CRM has no concept of an account. Every figure here lands in one. |
| journal entries and lines | Double entry is the whole point. The CRM records a sale; this records which accounts it moved. |
| taxes and `document_line_taxes` | A CGST+SGST pair is one tax on screen and two in the ledger, because CGST goes to the centre and SGST to the state. The CRM carries a single `tax_amount`. |
| fiscal years and periods | A closed period refuses a posting. Nothing in a CRM closes. |
| opening balances | The books before this app existed. |
| bank accounts, statements, reconciliation | Money moving is not a CRM event. |
| vendor bills, debit notes, TDS payable | The buying side. The CRM has suppliers but not what is owed them. |
| expenses, employee advances, commissions | Staff cost against a trip. |
| assets, depreciation, deferrals | Time-based postings nobody triggers. |
| settlements (OTA / channel payouts) | What a channel keeps out of a payout, in the three accounts it has to be read in. |
| every report | Trial balance, P&L, balance sheet, cash flow, ageing, GST summary, day book, general ledger. |

---

## When something looks wrong

| Symptom | Look here first |
|---|---|
| **Review & Post, the general ledger, the tax report and every book are empty** | nothing has been imported. `SELECT COUNT(*) FROM documents` is the whole diagnosis: no documents means no journal entries, and every report in this product is built on posted entry lines. Open **TripzoCRM → Invoices** and press **Fetch & import**, then post the drafts. |
| invoices are drafted but the books are still empty | they are **drafts**. A draft moves no balance by design. Post them in Accounting → Review & Post — that is the only thing in this product that writes to the general ledger. |
| a fetched invoice never became a document | the run's warnings, and the Difference column on TripzoCRM → Invoices. A cancelled CRM invoice is deliberately never drafted; anything else failed on a missing revenue account, a missing GST rate or a missing customer, each of which is named. |
| the same invoice appears twice in the books | it should not be possible: `crm_invoices.document_id` is claimed in the same transaction as the document. If it happened, somebody ran **Clear import history**, which is not an undo — it lets the importer run *alongside* postings it already made. |
| a screen shows no CRM data at all | `Live.connected` is false — nobody is signed in to the CRM. The banner says so. |
| an empty list that should not be empty | the `probe` line under it: it prints the endpoint called and the **shape** of what came back (keys and types, never values), because "the agency has none" and "this code read the wrong key" look identical otherwise. |
| the masthead names the wrong agency | `resolveBooks` adopts the CRM's name on every sign-in. A wrong one means the session resolved to a different agency — check `/settings`, which prints the CRM org behind the session. |
| an imported invoice's total is wrong | the sync report's warnings. `reconcileTotal` names both figures. |
| all revenue on one account | an `item_type` the chart has no code for. The report warns, naming the type. |
| GST missing on imported invoices | a rate that did not divide out to anything configured. The report warns, naming the percentage it computed. |
| "these books belong to another agency" on a fetch | the token resolves to a different CRM org. Sign in with an account in this agency, or reconnect under Settings → CRM Sync; nothing was imported. |
| an advance has no GST on it | no rate could be derived from its invoice. The run names it. Set the tax on the draft receipt before posting — section 13(2) makes it due in the month the money arrived. |
