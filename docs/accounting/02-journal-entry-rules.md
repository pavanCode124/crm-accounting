# 02 — Journal Entry Rules

The exact debit and credit for every business event the system posts. Each rule
names the service that implements it, so a disagreement between this file and
the code is a bug in one of them.

Conventions used throughout:

- `Dr` = debit, `Cr` = credit. Every entry balances; that is enforced in
  `postEntry()`, not by the caller.
- Account names are the **seeded** ones. Real postings resolve through
  `org_settings` keys (`account.receivable`, `journal.general`, …) so an agency
  can renumber its chart without touching code.
- `[trip]` marks a line that carries the trip's analytic account. Only P&L
  lines are tagged.

---

## 1. Customer invoice — `postDocument`, `doc_type = out_invoice`

```text
Accounts Receivable        Dr  1,94,700
      Package Revenue           Cr  1,50,000   [trip]
      Visa Service Revenue      Cr    10,000   [trip]
      Transport Revenue         Cr     5,000   [trip]
      Output CGST               Cr     4,450
      Output SGST               Cr     4,450
```

- One revenue line per document line, each on the account the line names.
- One tax line per tax **component**, so a CGST/SGST pair produces two.
- The receivable is the document total.
- The partner's own receivable account overrides the default if set.

## 2. Customer credit note — `doc_type = out_refund`

The same entry with the sides swapped. One code path, one flag
(`DOC_TYPES[type].sign === -1`).

```text
Package Revenue            Dr    45,000   [trip]
Output CGST                Dr     1,125
Output SGST                Dr     1,125
      Accounts Receivable       Cr    47,250
```

A **partial** cancellation is a percentage of the original, in basis points, so
the note stays tied to the invoice: "30% credited" means 70% retained as a
cancellation charge.

## 3. Vendor bill — `doc_type = in_invoice`

```text
Hotel Cost                 Dr    60,000   [trip]
Transport Cost             Dr    10,000   [trip]
Input CGST                 Dr     6,300
Input SGST                 Dr     6,300
      Accounts Payable          Cr    82,600
```

## 4. Vendor bill with withholding tax (TDS) — §21 of the plan

TDS is computed on the **taxable value**, never on the GST-inclusive total: the
government does not withhold tax on its own tax. Below the section's threshold
nothing is withheld, and the threshold is a row on the tax, not a number in
code.

```text
Flight Cost                Dr  1,00,000   [trip]
Input CGST                 Dr     9,000
Input SGST                 Dr     9,000
      Accounts Payable          Cr  1,08,000
      TDS Payable               Cr    10,000
```

The withholding splits off the **payable**, not the cost: the agency still
incurred ₹1,00,000, it simply owes part of the settlement to the government
instead of to the supplier.

## 5. Vendor credit note — `doc_type = in_refund`

Rule 3 with the sides swapped.

---

## 6. Customer payment — `postPayment`, direction `inbound`, side `customer`

```text
HDFC Bank                  Dr    90,000
      Accounts Receivable       Cr    90,000
```

Allocating this payment to an invoice posts **nothing further**: the receivable
already moved. Allocation is matching at document level.

## 7. Customer advance — `is_advance = 1`

Money taken before the trip is invoiced is **not** revenue and **not** a
reduction of a receivable that does not exist yet. It is something the agency
owes the customer.

```text
ICICI Collections          Dr    50,000
      Customer Advances         Cr    50,000      (a LIABILITY)
```

### Applying the advance to an invoice — `allocate`

```text
Customer Advances          Dr    50,000
      Accounts Receivable       Cr    50,000
```

Booking the receipt straight to AR instead produces a negative receivable,
which flatters the balance sheet and hides a real liability.

## 8. Supplier payment — direction `outbound`, side `supplier`

```text
Accounts Payable           Dr    80,000
      HDFC Bank                 Cr    80,000
```

## 9. Supplier advance

```text
Supplier Advances          Dr    30,000      (an ASSET)
      HDFC Bank                 Cr    30,000
```

### Applying it to a bill

```text
Accounts Payable           Dr    30,000
      Supplier Advances         Cr    30,000
```

## 10. Customer refund — direction `outbound`, **side `customer`**

The case the direction alone gets wrong.

```text
Accounts Receivable        Dr    40,320
      ICICI Collections         Cr    40,320
```

Settling the credit note from Rule 2. The debit clears the credit balance the
note left on receivables. Posting this to Accounts Payable — which is what
deriving the side from the direction does — leaves **both** control accounts
wrong by the same amount, and neither reconciles to its document list.

## 11. Credit note applied to an invoice — `applyCreditNote`

**No journal entry.** Both documents already sit on the same receivable account
with opposite signs. The allocation records *which* invoice the note settled,
so the ageing report and the customer statement agree.

---

## 12. Bank charges — `reconcileToAccount`

```text
Bank Charges               Dr     1,180
      HDFC Bank                 Cr     1,180
```

## 13. Internal transfer — `transfer`

```text
Petty Cash                 Dr    20,000
      HDFC Bank                 Cr    20,000
```

Changes where the money is, never how much there is.

---

## 14. Employee expense, approved — `approveExpense`, `paid_by = employee`

The ledger moves at **approval**, not at submission.

```text
Tour Guide Cost            Dr    10,000   [trip]
Input CGST                 Dr       900
      Employee Advances         Cr    10,900
```

### Paid by the company card — `paid_by = company`

```text
Office Expenses            Dr     4,500
      Petty Cash                Cr     4,500
```

### Reimbursing the employee — `reimburseExpense`

```text
Employee Advances          Dr    10,900
      HDFC Bank                 Cr    10,900
```

## 15. Employee advance paid out — `payEmployeeAdvance`

```text
Employee Advances          Dr    20,000
      HDFC Bank                 Cr    20,000
```

The account runs as a balance per employee: advance ₹20,000 less expenses
₹17,500 leaves ₹2,500 still to return.

---

## 16. Agent commission — `postCommission`

```text
Agent Commission           Dr    10,000   [trip]
      Commission Payable        Cr    10,000
```

The base is read from the trip's analytic account, so a commission can only be
calculated on revenue the ledger has actually recognised. `basis` chooses
between revenue and gross margin — the accounting is identical either way.

Paying the agent is an ordinary outbound payment against Commission Payable.

---

## 17. Depreciation slice — `runDepreciation`

```text
Depreciation               Dr    10,000
      Accumulated Depreciation  Cr    10,000
```

Accumulated depreciation is a **contra-asset**: the asset stays on the books at
what was paid, which is what an auditor asks to see.

## 18. Prepaid expense recognised — `runDeferrals`, kind `expense`

The premium was paid up front:

```text
Prepaid Expenses           Dr  1,20,000
      HDFC Bank                 Cr  1,20,000
```

and each month one slice is recognised:

```text
Office Expenses            Dr    10,000
      Prepaid Expenses          Cr    10,000
```

## 19. Deferred revenue recognised — kind `revenue`

```text
Deferred Revenue           Dr    25,000
      Package Revenue           Cr    25,000   [trip]
```

---

## 20. Opening balances — `postOpeningBalances`

```text
HDFC Bank                  Dr  18,50,000
Cash on Hand               Dr     45,000
Office Equipment           Dr   4,20,000
      Owner Capital             Cr  20,00,000
      Retained Earnings         Cr   3,15,000
```

If the figures do not balance the engine **refuses the entry** and names the
difference. Almost always that is a transposed digit, and finding it now is far
cheaper than finding it in a report next quarter. A genuine remainder can be
carried to a named account, as an explicit choice.

## 21. Year-end close — `closeFiscalYear`

Every income and expense account is zeroed against retained earnings, dated the
last day of the year:

```text
Package Revenue            Dr  16,94,600
Hotel Cost                        Cr    80,000
Salaries                          Cr  8,40,000
…
Retained Earnings          Dr   5,93,493      (a loss, so retained earnings is debited)
```

Then every period in the year is locked.

---

## 22. Foreign currency

Every line keeps its face value and the rate used:

```text
Supplier Charges           Dr  6,88,200   [trip]     (AED 30,000 at ₹22.94)
      Accounts Payable          Cr  6,88,200
```

`currency`, `amount_currency` and `rate_e6` are stored on the line for audit.
FX gain and loss accounts are configured (`account.fx_gain`, `account.fx_loss`)
for revaluation.

---

## 23. Reversal — `reverseEntry`

A new entry with every line's debit and credit swapped, dated when the
reversal happened, linked to the original in both directions. The original is
marked `reversed`; nothing is deleted.

Reversing keeps a closed period's totals untouched, and keeps both the mistake
and its correction in the audit trail.

---

## Invariants the engine enforces

Checked in `postEntry()` before a single row is written:

1. At least two lines.
2. Every line has a debit **or** a credit, never both, never negative.
3. Total debits equal total credits — the difference is named in the error.
4. Every account exists in **this** organisation and is active.
5. The date falls in an `open` period, or in no period at all.
6. Analytic distributions on a line total exactly 100%.
7. The whole entry — header, lines, analytic rows, sequence bump, audit row —
   is one transaction. Half an entry on disk is an unbalanced ledger.
