'use client';

import { useState } from 'react';
import { Field, inputClass } from './ui';

/**
 * The advance block on a receipt form: the tick, and the GST that follows it.
 *
 * -------------------------------------------------------------------------
 * WHY AN ADVANCE ASKS FOR A TAX AND AN ORDINARY RECEIPT DOES NOT
 * -------------------------------------------------------------------------
 * Section 13(2) of the CGST Act fixes the time of supply of a SERVICE at the
 * EARLIER of the invoice or the receipt of payment. Notification 66/2017-CT
 * removed that for goods; it never applied to services. A travel agency sells
 * services, so ₹47,200 taken in September against a December trip is a
 * September liability — the GST inside it belongs in that month's GSTR-3B,
 * months before the trip runs or any invoice exists.
 *
 * An ordinary receipt settles an invoice that has already charged its own tax,
 * so asking there would tax the same supply twice. Hence the fields appear only
 * when the box is ticked, and only on the customer side: an advance PAID to a
 * supplier buys no input credit until their invoice arrives (section 16(2)).
 *
 * -------------------------------------------------------------------------
 * THE AMOUNT TYPED ABOVE IS INCLUSIVE, AND THE PREVIEW SAYS SO
 * -------------------------------------------------------------------------
 * What the bank shows is what the customer sent; there is no second payment
 * coming for the tax on the first. So the tax is BACKED OUT of the receipt —
 * ₹47,200 at 18% is ₹40,000 of advance and ₹7,200 of tax, not ₹47,200 less 18%,
 * which is ₹38,704 and wrong by ₹1,296 every time. The split is shown here
 * because an accountant who cannot see it will compute it on paper to check,
 * and because the liability carried to the traveller is the ₹40,000 rather than
 * the whole receipt.
 *
 * The figures here are a PREVIEW. `splitAdvanceTax` computes the stored split
 * on the server, component by component, and those are the ones that post.
 */
export function AdvanceReceiptFields({ taxes, states, defaultTaxId, defaultState }: {
  taxes: Array<{ id: string; name: string; rateBps: number }>;
  states: Array<[string, string]>;
  defaultTaxId: string;
  defaultState: string;
}) {
  const [isAdvance, setIsAdvance] = useState(false);
  const [taxId, setTaxId] = useState(defaultTaxId);
  const [amount, setAmount] = useState('');

  const rateBps = taxes.find((t) => t.id === taxId)?.rateBps ?? 0;
  const gross = Math.round((Number(amount || '0') || 0) * 100);
  const net = rateBps > 0 ? Math.round((gross * 10000) / (10000 + rateBps)) : gross;
  const tax = gross - net;
  const rupees = (minor: number) => `₹${(minor / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

  return (
    <>
      {/*
        THE AMOUNT LIVES HERE so the split below can react to it. It is the same
        field it always was — same name, same shape — moved inside this
        component rather than duplicated, because a preview that reads a
        different number from the one being submitted is worse than no preview.
      */}
      <Field label="Amount" hint={isAdvance && rateBps > 0 ? 'Inclusive of the GST below.' : undefined}>
        <input name="amount" inputMode="decimal" required placeholder="0.00"
          value={amount} onChange={(e) => setAmount(e.target.value)}
          className={`${inputClass} text-right`} />
      </Field>

      <label className="flex items-center gap-2 text-[13px] font-semibold">
        <input type="checkbox" name="is_advance" className="h-4 w-4"
          checked={isAdvance} onChange={(e) => setIsAdvance(e.target.checked)} />
        This is an advance
      </label>

      {isAdvance && (
        <div className="space-y-3 rounded-md border border-line bg-canvas p-3">
          <p className="text-[12px] text-ink-muted">
            An advance for a SERVICE is taxed when the money arrives — section 13(2), and
            Notification 66/2017-CT lifted that for goods only. The receipt is also a receipt
            voucher under section 31(3)(d).
          </p>
          <Field label="GST on this advance"
            hint="Defaults to the rate the agency sells its packages at. None, and no tax is recognised now.">
            <select name="advance_tax_id" value={taxId} className={inputClass}
              onChange={(e) => setTaxId(e.target.value)}>
              <option value="">— none —</option>
              {taxes.map((t) => (
                <option key={t.id} value={t.id}>
                  {(t.rateBps / 100).toFixed(t.rateBps % 100 ? 2 : 0)}% — {t.name}
                </option>
              ))}
            </select>
          </Field>
          {/*
            RULE 50 REQUIRES THE PLACE OF SUPPLY ON A RECEIPT VOUCHER, and it
            decides CGST+SGST against IGST on the advance exactly as it does on
            an invoice. Its two provisos cover the honest unknowns: a rate that
            is not determinable is taxed at 18%, and a supply whose NATURE is not
            determinable is treated as inter-State. Both are choices made here,
            by picking a rate and a state; neither is guessed.
          */}
          <Field label="Place of supply" hint="Rule 50 asks for it on the receipt voucher.">
            <select name="advance_place_of_supply" defaultValue={defaultState} className={inputClass}>
              <option value="">—</option>
              {states.map(([code, name]) => (
                <option key={code} value={code}>{code} — {name}</option>
              ))}
            </select>
          </Field>

          {gross > 0 && (
            <dl className="space-y-1 border-t border-line pt-2 text-[12.5px]">
              <div className="flex justify-between gap-6">
                <dt className="text-ink-muted">Advance (owed to the traveller)</dt>
                <dd className="num font-semibold">{rupees(net)}</dd>
              </div>
              <div className="flex justify-between gap-6">
                <dt className="text-ink-muted">GST (owed this month)</dt>
                <dd className="num font-semibold">{rupees(tax)}</dd>
              </div>
            </dl>
          )}
        </div>
      )}
    </>
  );
}
