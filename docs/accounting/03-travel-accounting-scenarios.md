# 03 — Travel Accounting Scenarios

The thirty scenarios of plan §51, each documented in the shape the plan asks
for. Sixteen of them are exercised by the seed on every fresh install
(`src/server/seed.ts`), which is noted per scenario — if the seed runs, those
paths posted and the ledger balanced.

Effects are written from the agency's point of view. **BS** = balance sheet,
**P&L** = profit and loss, **CF** = cash flow.

---

### 1. Customer booking created — *seeded*

| | |
|---|---|
| Document | Booking + trip analytic account |
| Entry | **None** |
| Effect | No P&L, no BS, no CF |

A booking is an operational fact. Nothing financial has happened until money
moves or a document is raised. The trip's analytic account is created here so
later costs have somewhere to land.

### 2. Customer advance received — *seeded*

| | |
|---|---|
| Document | Payment, `inbound` / `customer`, `is_advance` |
| Dr | Bank |
| Cr | Customer Advances |
| Analytic | None — a receipt is not income |
| P&L | No effect |
| BS | Cash up, liability up |
| CF | Operating inflow |

### 3. Customer invoice posted — *seeded*

| | |
|---|---|
| Document | `out_invoice` |
| Dr | Accounts Receivable |
| Cr | Revenue accounts, Output CGST/SGST |
| Analytic | Revenue lines → trip |
| P&L | Revenue recognised |
| BS | Receivable up, tax liability up |
| CF | None until paid |

### 4. Advance applied to the invoice — *seeded*

| | |
|---|---|
| Dr | Customer Advances · **Cr** Accounts Receivable |
| P&L | None · **BS** liability down, receivable down · **CF** none |

### 5. Partial customer payment — *seeded*

| | |
|---|---|
| Dr | Bank · **Cr** Accounts Receivable |
| Document | `payment_state` → `partial`, residual recomputed |
| CF | Operating inflow |

### 6. Full customer payment — *seeded*

As 5; residual reaches zero and the document reads `paid`.

### 7. Customer cancellation, partial credit — *seeded*

| | |
|---|---|
| Document | `out_refund` at 30% of the original |
| Dr | Revenue, Output tax · **Cr** Accounts Receivable |
| P&L | Revenue reduced; the 70% retained stays as a cancellation charge |
| BS | Receivable down |

### 8. Customer refund paid out — *seeded*

| | |
|---|---|
| Document | Payment, `outbound` / **`customer`** |
| Dr | Accounts Receivable · **Cr** Bank |
| CF | Operating outflow |

The side matters: see §02 rule 10.

### 9. Hotel supplier bill — *seeded*

| | |
|---|---|
| Document | `in_invoice` |
| Dr | Hotel Cost [trip], Input tax · **Cr** Accounts Payable |
| P&L | Direct cost · **BS** payable up |

### 10. Flight supplier bill with TDS — *seeded*

| | |
|---|---|
| Dr | Flight Cost [trip], Input tax |
| Cr | Accounts Payable (net), TDS Payable |
| BS | Two liabilities: one to the supplier, one to the government |

### 11. Supplier advance — *seeded*

| | |
|---|---|
| Dr | Supplier Advances (asset) · **Cr** Bank |
| BS | Cash down, asset up · **CF** operating outflow |

### 12. Supplier payment — *seeded*

| | |
|---|---|
| Dr | Accounts Payable · **Cr** Bank |

### 13. Supplier refund

| | |
|---|---|
| Document | `in_refund`, then a payment `inbound` / `supplier` |
| Dr | Accounts Payable, then Bank |
| Cr | Cost accounts [trip], then Accounts Payable |
| P&L | Trip cost reduced |

### 14. GST on a domestic sale — *seeded*

One tax on the invoice, two postings: CGST and SGST at half each, to their own
liability accounts. The tax report reads the **tax lines**, so it ties to the
ledger rather than to invoice totals.

### 15. IGST on an interstate or overseas supply

A single 18% line to Output IGST. Configured as its own tax row, chosen on the
invoice line — nothing in code decides which applies.

### 16. TDS withheld and later remitted — *seeded (withheld)*

Withholding credits TDS Payable. Remitting it is an outbound payment against
that account, which clears the liability.

### 17. Bank charges — *seeded as a statement line*

| | |
|---|---|
| Dr | Bank Charges · **Cr** Bank |
| Route | Reconciliation → "post straight to an account" |

### 18. Cash expense on a trip — *seeded*

A tour guide paid in cash, tagged to the trip. It has **no vendor bill**, and
it still belongs in the trip's cost — which is the case a spreadsheet forgets
and the analytic account catches.

### 19. Employee expense claim — *seeded*

Draft → submitted → **approved (posts)** → paid. Dr cost [trip], Cr Employee
Advances; reimbursement clears it against the bank.

### 20. Employee advance — *available*

Dr Employee Advances, Cr Bank. The account runs as a balance per employee.

### 21. Agent commission — *seeded*

Dr Agent Commission [trip], Cr Commission Payable. The base is read from the
trip's analytic account, so it can only be calculated on recognised revenue.

### 22. Package cancellation reversal of commission

Reverse the commission entry. Because the base came from the ledger, a
cancelled trip's commission is visibly wrong before it is paid.

### 23. Foreign-currency purchase — *seeded*

AED 30,000 at ₹22.94. The bill records its `currency` and `rate_e6`, and every
journal entry line carries `currency`, `amount_currency` and `rate_e6` so the
original transaction is auditable.

**Scope, stated plainly:** amounts are ENTERED in company currency at the rate
shown, and the ledger carries that rupee figure. The schema and the UI capture
everything a conversion needs; what is not implemented is the engine doing the
conversion for you, nor a settlement at a different rate producing a gain or
loss automatically. Plan §30 places both in the "later" bucket.

### 24. Foreign-currency payment / 25. FX gain / 26. FX loss — *not implemented*

The accounts exist and are configured (`account.fx_gain`, `account.fx_loss`),
and a difference on settlement or a period-end revaluation can be posted today
as a manual journal entry against them. What is missing is the automation:

- converting entered amounts at the document's rate inside `postDocument`
- comparing the settlement rate to the document rate in `allocate` and posting
  the difference
- a period-end revaluation run over open foreign-currency balances

Each is a contained addition to the service it belongs to. None of them should
be added to a screen.

### 27. Prepaid expense — *seeded*

Annual insurance paid up front, recognised one twelfth a month. Dr Prepaid on
payment; Dr Expense / Cr Prepaid each month.

### 28. Accrued expense

A manual journal entry: Dr Expense, Cr Accrued Liability, reversed when the
bill arrives. Available through Manual Journal Entry.

### 29. Fixed asset purchase and depreciation — *seeded*

Asset at cost, schedule generated and stored, slices posted Dr Depreciation /
Cr Accumulated Depreciation. The last slice carries the rounding remainder, so
the asset fully depreciates.

### 30. Opening balances and year-end close — *opening seeded*

Opening: one balanced migration entry, refused if it does not balance.
Close: every P&L account zeroed to retained earnings, then the twelve periods
locked.

---

## What the seed proves

Running the app on an empty database posts every *seeded* scenario above
through the same services the screens call. Afterwards:

- **Trial Balance** — debits equal credits, exactly.
- **Balance Sheet** — assets equal liabilities plus equity, including the
  current year's unclosed profit.
- **Accounts Receivable** — the control account equals the sum of open
  customer-document residuals.
- **Accounts Payable** — likewise for suppliers.
- **Trip profitability** — the analytic totals reconcile to the P&L.

Those five are the checkable part of plan §56. Open
`/reports/trial-balance?range=all` and `/reports/balance-sheet` after any change
to the posting code; if either stops agreeing, something has written to
`journal_entry_lines` without going through `postEntry`.

---

## Adding a scenario

1. Write the debit/credit here and in `02-journal-entry-rules.md` **first**.
2. Implement it as a function in the relevant service under
   `src/server/accounting/`, ending in a single `postEntry` call.
3. Resolve every account through `org_settings`, never by code or by name.
4. Add it to the seed if it is a shape a travel agency meets routinely.
5. Re-check the Trial Balance and the Balance Sheet.
