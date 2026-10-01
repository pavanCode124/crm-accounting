'use client';

import { useMemo, useState } from 'react';
import { saveDocumentAction } from '@/app/actions';
import { inputClass, btn, Card, Field, PartnerDatalist } from './ui';
import { fmt, toMinor, qtyToMilli, pct, roundHalfUp } from '@/lib/money';
import type { DocType } from '@/lib/accounting';

/**
 * The invoice / vendor bill editor.
 *
 * Client-side, and it is the only screen in the product that needs to be: the
 * line table adds and removes rows, and the totals have to move as the user
 * types or the tax is a surprise at the bottom of the page.
 *
 * THE TOTALS SHOWN HERE ARE A PREVIEW, NOT THE ANSWER. The same arithmetic is
 * done again on the server by the tax engine when the document is saved, and
 * the server's figures are the ones stored. Duplicating it is deliberate — the
 * alternative is a round trip per keystroke — but the preview is never allowed
 * to be the source of the number that reaches the ledger.
 */

export interface Option { id: string; label: string; hint?: string }
export interface TaxOption { id: string; label: string; rateBps: number; priceIncluded: boolean }

export interface DocFormProps {
  docType: DocType;
  partners: Option[];
  journals: Option[];
  accounts: Option[];
  taxes: TaxOption[];
  analytics: Option[];
  bookings: Option[];
  paymentTerms: Option[];
  withholdingTaxes?: TaxOption[];
  products?: Array<{ id: string; name: string; price: number; accountId: string | null; taxId: string | null }>;
  defaults?: {
    partnerName?: string; journalId?: string; bookingId?: string; analyticId?: string; date?: string;
  };
  canPost: boolean;
}

interface Line {
  key: number;
  name: string; qty: string; price: string; discount: string;
  taxId: string; accountId: string; analyticId: string;
}

let nextKey = 1;
const blankLine = (accountId = ''): Line => ({
  key: nextKey++, name: '', qty: '1', price: '', discount: '0',
  taxId: '', accountId, analyticId: '',
});

export function DocumentForm(props: DocFormProps) {
  const { docType, partners, journals, accounts, taxes, analytics, bookings, paymentTerms } = props;
  const isBill = docType.startsWith('in_');
  const today = props.defaults?.date ?? new Date().toISOString().slice(0, 10);

  const [lines, setLines] = useState<Line[]>([blankLine(accounts[0]?.id ?? '')]);
  const [analyticId, setAnalyticId] = useState(props.defaults?.analyticId ?? '');
  const [withholdingId, setWithholdingId] = useState('');

  const update = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const totals = useMemo(() => {
    let untaxed = 0;
    let tax = 0;
    for (const l of lines) {
      const gross = roundHalfUp((qtyToMilli(l.qty || '0') * toMinor(l.price || '0')) / 1000);
      const net = gross - pct(gross, Math.round(parseFloat(l.discount || '0') * 100));
      const t = taxes.find((x) => x.id === l.taxId);
      // Tax-inclusive pricing backs the base out of the gross — the same
      // division the server does, kept in step with src/server/accounting/tax.ts.
      const base = t?.priceIncluded ? roundHalfUp((net * 10000) / (10000 + t.rateBps)) : net;
      untaxed += base;
      tax += t ? pct(base, t.rateBps) : 0;
    }
    const wht = props.withholdingTaxes?.find((w) => w.id === withholdingId);
    const withheld = wht ? pct(untaxed, wht.rateBps) : 0;
    return { untaxed, tax, total: untaxed + tax, withheld, payable: untaxed + tax - withheld };
  }, [lines, taxes, withholdingId, props.withholdingTaxes]);

  const title = isBill ? 'New Vendor Bill' : 'New Customer Invoice';

  return (
    <form action={saveDocumentAction} className="space-y-5">
      <input type="hidden" name="doc_type" value={docType} />
      <input type="hidden" name="analytic_id" value={analyticId} />

      <Card title={title} subtitle={
        isBill
          ? 'What a supplier has charged the agency, against the trip it belongs to.'
          : 'What the customer owes. Posting creates the balanced journal entry behind it.'
      }>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={isBill ? 'Supplier' : 'Customer'}>
            <input name="partner_name" list="partner-options" required autoComplete="off"
              defaultValue={props.defaults?.partnerName ?? ''}
              placeholder={isBill ? 'Who billed it' : 'Who it is billed to'} className={inputClass} />
            <PartnerDatalist id="partner-options" options={partners} />
          </Field>
          <Field label="Journal">
            <select name="journal_id" required defaultValue={props.defaults?.journalId ?? journals[0]?.id} className={inputClass}>
              {journals.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}
            </select>
          </Field>
          <Field label={isBill ? 'Bill date' : 'Invoice date'}>
            <input type="date" name="doc_date" defaultValue={today} className={inputClass} />
          </Field>
          <Field label="Payment terms">
            <select name="payment_terms_id" className={inputClass} defaultValue="">
              <option value="">—</option>
              {paymentTerms.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Due date" hint="Left blank, the payment terms decide it.">
            <input type="date" name="due_date" className={inputClass} />
          </Field>
          <Field label="Trip / booking" hint="Tags every line to the trip, which is what makes its margin real.">
            <select
              name="booking_id"
              className={inputClass}
              defaultValue={props.defaults?.bookingId ?? ''}
              onChange={(e) => {
                const b = bookings.find((x) => x.id === e.target.value);
                setAnalyticId(b?.hint ?? '');
              }}
            >
              <option value="">—</option>
              {bookings.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
          </Field>
          {isBill && (
            <>
              <Field label="Supplier bill number">
                <input name="supplier_ref" className={inputClass} placeholder="TRB/2026/4471" />
              </Field>
              <Field label="Withholding (TDS)" hint="Deducted from what the supplier is paid, not from the cost.">
                <select name="withholding_tax_id" className={inputClass} value={withholdingId}
                  onChange={(e) => setWithholdingId(e.target.value)}>
                  <option value="">None</option>
                  {(props.withholdingTaxes ?? []).map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
                </select>
              </Field>
            </>
          )}
          <Field label="Currency"
            hint="Amounts are entered in rupees; the currency and rate are recorded against every line for audit.">
            <div className="flex gap-2">
              <select name="currency" defaultValue="INR" className={inputClass}>
                {['INR', 'USD', 'AED', 'EUR', 'THB'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <input name="rate" defaultValue="1" className={`${inputClass} w-24`} title="Rate to INR" />
            </div>
          </Field>
        </div>
      </Card>

      <Card title="Lines" padded={false}>
        <div className="scroll-x">
          <table className="w-full min-w-[980px] border-collapse text-[13px]">
            <thead>
              <tr className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">
                <th className="border-b border-line px-3 py-2 text-left">Description</th>
                <th className="border-b border-line px-3 py-2 text-left w-[120px]">Account</th>
                <th className="border-b border-line px-3 py-2 text-right w-[80px]">Qty</th>
                <th className="border-b border-line px-3 py-2 text-right w-[130px]">Unit price</th>
                <th className="border-b border-line px-3 py-2 text-right w-[80px]">Disc %</th>
                <th className="border-b border-line px-3 py-2 text-left w-[150px]">Tax</th>
                <th className="border-b border-line px-3 py-2 text-left w-[150px]">Analytic</th>
                <th className="border-b border-line px-3 py-2 text-right w-[120px]">Subtotal</th>
                <th className="border-b border-line px-3 py-2 w-[40px]" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const gross = roundHalfUp((qtyToMilli(l.qty || '0') * toMinor(l.price || '0')) / 1000);
                const net = gross - pct(gross, Math.round(parseFloat(l.discount || '0') * 100));
                return (
                  <tr key={l.key}>
                    <td className="border-b border-line px-2 py-1.5">
                      <input name="line_name" value={l.name} required={false}
                        onChange={(e) => update(l.key, { name: e.target.value })}
                        placeholder="Bali 5D/4N Package — 2 pax" className={inputClass} />
                    </td>
                    <td className="border-b border-line px-2 py-1.5">
                      <select name="line_account" value={l.accountId}
                        onChange={(e) => update(l.key, { accountId: e.target.value })} className={inputClass}>
                        <option value="">—</option>
                        {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                      </select>
                    </td>
                    <td className="border-b border-line px-2 py-1.5">
                      <input name="line_qty" value={l.qty} inputMode="decimal"
                        onChange={(e) => update(l.key, { qty: e.target.value })} className={`${inputClass} text-right`} />
                    </td>
                    <td className="border-b border-line px-2 py-1.5">
                      <input name="line_price" value={l.price} inputMode="decimal" placeholder="0.00"
                        onChange={(e) => update(l.key, { price: e.target.value })} className={`${inputClass} text-right`} />
                    </td>
                    <td className="border-b border-line px-2 py-1.5">
                      <input name="line_discount" value={l.discount} inputMode="decimal"
                        onChange={(e) => update(l.key, { discount: e.target.value })} className={`${inputClass} text-right`} />
                    </td>
                    <td className="border-b border-line px-2 py-1.5">
                      <select name="line_tax" value={l.taxId}
                        onChange={(e) => update(l.key, { taxId: e.target.value })} className={inputClass}>
                        <option value="">No tax</option>
                        {taxes.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                      </select>
                    </td>
                    <td className="border-b border-line px-2 py-1.5">
                      <select name="line_analytic" value={l.analyticId}
                        onChange={(e) => update(l.key, { analyticId: e.target.value })} className={inputClass}>
                        <option value="">Document default</option>
                        {analytics.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                      </select>
                    </td>
                    <td className="border-b border-line px-3 py-1.5 num">{fmt(net)}</td>
                    <td className="border-b border-line px-2 py-1.5 text-center">
                      <button type="button" title="Remove line"
                        onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : ls))}
                        className="text-ink-faint hover:text-negative">×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-3">
          <button type="button" className={btn.ghost}
            onClick={() => setLines((ls) => [...ls, blankLine(accounts[0]?.id ?? '')])}>
            + Add line
          </button>
          <dl className="min-w-[280px] space-y-1.5 text-[13.5px]">
            <Row label="Subtotal" value={totals.untaxed} />
            <Row label="Tax" value={totals.tax} />
            <Row label="Total" value={totals.total} bold />
            {totals.withheld > 0 && (
              <>
                <Row label="TDS withheld" value={-totals.withheld} />
                <Row label="Payable to supplier" value={totals.payable} bold />
              </>
            )}
          </dl>
        </div>
      </Card>

      <Card title="Notes">
        <textarea name="note" rows={3} className={inputClass}
          placeholder="Anything the customer or the auditor should see on this document." />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="submit" className={btn.ghost}>Save as draft</button>
          {props.canPost && (
            <button type="submit" name="post_now" value="true" className={btn.primary}>
              Save and post
            </button>
          )}
          <p className="text-[12.5px] text-ink-faint">
            A draft moves nothing. Posting writes the journal entry and locks the document.
          </p>
        </div>
      </Card>
    </form>
  );
}

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className="flex justify-between gap-8">
      <dt className={bold ? 'font-bold' : 'text-ink-muted'}>{label}</dt>
      <dd className={`num ${bold ? 'font-bold' : ''}`}>{fmt(value)}</dd>
    </div>
  );
}
