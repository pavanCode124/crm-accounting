import 'server-only';
import { all, one } from '../db';
import { pct, roundHalfUp } from '@/lib/money';

/**
 * The tax engine.
 *
 * Rates live in the `taxes` table and never in this file (plan section 20). A
 * GST change is a configuration edit; a new jurisdiction is new rows. What is
 * code here is only the ARITHMETIC — and the two parts of it people get wrong:
 *
 *   1. A CGST+SGST pair is ONE tax on the invoice line and TWO postings. The
 *      child rows carry 9% each and the parent carries the 18% the customer
 *      sees, so the ledger can file GSTR and the invoice can print one line.
 *
 *   2. Tax-included pricing is a division, not a multiplication. A ₹1,180
 *      inclusive price at 18% is a ₹1,000 base — not ₹1,180 less 18%, which is
 *      ₹967.60 and wrong by ₹32.40 on every single line.
 *
 * Every amount in and out is minor units. Rounding is half-up per line, and the
 * document's tax total is the SUM OF THE ROUNDED LINES rather than a rounding
 * of the sum, because that is what the printed invoice shows and the ledger has
 * to agree with the paper.
 */

export interface TaxRow {
  id: string;
  name: string;
  computation: string;
  rate_bps: number;
  scope: string;
  tax_group: string;
  price_included: number;
  account_id: string | null;
  refund_account_id: string | null;
  threshold: number;
}

export function getTax(orgId: string, taxId: string): TaxRow | null {
  return one<TaxRow>(
    `SELECT id, name, computation, rate_bps, scope, tax_group, price_included,
            account_id, refund_account_id, threshold
       FROM taxes WHERE id = ? AND org_id = ?`, taxId, orgId,
  );
}

export function taxChildren(taxId: string): TaxRow[] {
  return all<TaxRow>(
    `SELECT t.id, t.name, t.computation, t.rate_bps, t.scope, t.tax_group,
            t.price_included, t.account_id, t.refund_account_id, t.threshold
       FROM tax_children c JOIN taxes t ON t.id = c.child_id
      WHERE c.parent_id = ?`, taxId,
  );
}

export function listTaxes(orgId: string, scope?: 'sale' | 'purchase'): TaxRow[] {
  return all<TaxRow>(
    `SELECT id, name, computation, rate_bps, scope, tax_group, price_included,
            account_id, refund_account_id, threshold
       FROM taxes WHERE org_id = ? AND active = 1
         AND (? IS NULL OR scope = ? OR scope = 'none')
         AND tax_group <> 'tds'
         AND id NOT IN (SELECT child_id FROM tax_children)
      ORDER BY rate_bps`,
    orgId, scope ?? null, scope ?? null,
  );
}

/** Withholding taxes are chosen on the PAYMENT side, so they list separately. */
export function listWithholdingTaxes(orgId: string): TaxRow[] {
  return all<TaxRow>(
    `SELECT id, name, computation, rate_bps, scope, tax_group, price_included,
            account_id, refund_account_id, threshold
       FROM taxes WHERE org_id = ? AND active = 1 AND tax_group = 'tds' ORDER BY rate_bps`,
    orgId,
  );
}

export interface LineInput {
  qtyMilli: number;
  unitPrice: number;
  discountBps?: number;
  taxId?: string | null;
}

export interface TaxSplit {
  taxId: string;
  name: string;
  accountId: string | null;
  base: number;
  amount: number;
}

export interface LineAmounts {
  /** Net of discount, exclusive of tax. This is what hits the revenue account. */
  subtotal: number;
  taxAmount: number;
  total: number;
  /** One row per account the tax must be posted to. */
  splits: TaxSplit[];
}

export function computeLine(orgId: string, line: LineInput): LineAmounts {
  const gross = roundHalfUp((line.qtyMilli * line.unitPrice) / 1000);
  const afterDiscount = gross - pct(gross, line.discountBps ?? 0);

  const tax = line.taxId ? getTax(orgId, line.taxId) : null;
  if (!tax) return { subtotal: afterDiscount, taxAmount: 0, total: afterDiscount, splits: [] };

  const children = taxChildren(tax.id);
  const components = children.length ? children : [tax];

  // Tax-included: back the base out of the gross first, so the customer pays
  // exactly the round number on the price list.
  let subtotal = afterDiscount;
  if (tax.price_included && tax.computation === 'percent') {
    subtotal = roundHalfUp((afterDiscount * 10000) / (10000 + tax.rate_bps));
  }

  const splits: TaxSplit[] = components.map((c) => ({
    taxId: c.id,
    name: c.name,
    accountId: c.account_id,
    base: subtotal,
    amount: c.computation === 'fixed' ? c.rate_bps : pct(subtotal, c.rate_bps),
  }));

  const taxAmount = splits.reduce((s, x) => s + x.amount, 0);
  return { subtotal, taxAmount, total: subtotal + taxAmount, splits };
}

/**
 * Withholding tax (TDS) on a vendor bill — plan section 21.
 *
 * TDS is computed on the TAXABLE value, not on the GST-inclusive total: the
 * government does not withhold tax on its own tax. Below the section's annual
 * threshold nothing is withheld, and the threshold is configuration on the tax
 * row rather than a number in this function.
 *
 *   Expense        Dr 1,00,000
 *   Input GST      Dr   18,000
 *        Vendor Payable    Cr 1,08,000
 *        TDS Payable       Cr   10,000
 */
export function computeWithholding(orgId: string, taxId: string | null, taxableBase: number): { amount: number; accountId: string | null; name: string } {
  if (!taxId) return { amount: 0, accountId: null, name: '' };
  const tax = getTax(orgId, taxId);
  if (!tax) return { amount: 0, accountId: null, name: '' };
  if (tax.threshold > 0 && taxableBase < tax.threshold) {
    return { amount: 0, accountId: tax.account_id, name: tax.name };
  }
  const amount = tax.computation === 'fixed' ? tax.rate_bps : pct(taxableBase, tax.rate_bps);
  return { amount, accountId: tax.account_id, name: tax.name };
}
