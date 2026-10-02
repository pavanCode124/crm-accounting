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
  products?: Array<{
    id: string; name: string; price: number; accountId: string | null; taxId: string | null;
    hsnCode?: string | null; mrp?: number;
  }>;
  /** GST state codes, for the place-of-supply field. Closed list, by design. */
  states?: Array<[string, string]>;
  /**
   * The draft being edited, if this is an edit rather than a new document.
   * Only a draft ever reaches here — a posted document is immutable, and the
   * server refuses the update even if the form were reached by hand.
   */
  existing?: { id: string };
  defaults?: {
    partnerName?: string; journalId?: string; bookingId?: string; analyticId?: string; date?: string;
    dueDate?: string; paymentTermsId?: string; supplierRef?: string;
    currency?: string; rate?: string; withholdingTaxId?: string; note?: string;
    placeOfSupply?: string; orderRef?: string; orderDate?: string;
    irn?: string; irnAckNo?: string; irnAckDate?: string;
    lines?: LineDefault[];
  };
  canPost: boolean;
}

/** One existing line, already rendered into the strings the inputs carry. */
export interface LineDefault {
  name: string; qty: string; price: string; discount: string;
  taxId: string; accountId: string; analyticId: string;
  hsn: string; mrp: string;
}

interface Line {
  key: number;
  name: string; qty: string; price: string; discount: string;
  taxId: string; accountId: string; analyticId: string;
  hsn: string; mrp: string;
}

let nextKey = 1;
const blankLine = (accountId = ''): Line => ({
  key: nextKey++, name: '', qty: '1', price: '', discount: '0',
  taxId: '', accountId, analyticId: '', hsn: '', mrp: '',
});

export function DocumentForm(props: DocFormProps) {
  const { docType, partners, journals, accounts, taxes, analytics, bookings, paymentTerms } = props;
  const isBill = docType.startsWith('in_');
  const today = props.defaults?.date ?? new Date().toISOString().slice(0, 10);

  const [lines, setLines] = useState<Line[]>(() =>
    props.defaults?.lines?.length
      ? props.defaults.lines.map((l) => ({ key: nextKey++, ...l }))
      : [blankLine(accounts[0]?.id ?? '')]);
  const [analyticId, setAnalyticId] = useState(props.defaults?.analyticId ?? '');
  // A line with no description or no account is dropped on the server, and the
  // whole form would bounce back empty — everything typed, lost. Catch it here
  // instead, before anything is submitted.
  const [lineError, setLineError] = useState<string | null>(null);
  const [withholdingId, setWithholdingId] = useState(props.defaults?.withholdingTaxId ?? '');

  const update = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  /**
   * Typing a product's name fills the rest of the line from it.
   *
   * THE SAME IDIOM AS THE CUSTOMER FIELD — typed, not chosen — so a line that
   * is not a catalogued product is still just a description, and nothing has to
   * exist in Products before it can be invoiced. A name that DOES match brings
   * the price, the account, the tax, the HSN and the MRP with it.
   *
   * The HSN is the reason this is wired at all. It is mandatory on a GST
   * invoice and it is six digits nobody recalls per line; a column that can
   * only be typed from memory is a column that stays empty, and an invoice with
   * an empty HSN is not compliant however carefully the rest of it was filled.
   *
   * WHAT THE PRODUCT OVERRIDES, AND WHAT IT ONLY FILLS IN.
   *
   * The account, the tax, the HSN and the MRP are CLASSIFICATION — facts about
   * the thing being sold, which the product is the authority on — so choosing a
   * product sets them, replacing whatever was there. That is not merely a
   * preference: the first line arrives pre-set to the first account in the
   * list, which nobody chose, so a rule of "only fill what is blank" meant the
   * product's own revenue account could never apply and every visa sale landed
   * in Package Revenue.
   *
   * The PRICE is different. It is negotiated per sale, and the list price is
   * only a starting point — so a price already typed survives, and someone
   * correcting a typo in the description does not lose the figure they agreed
   * with the customer.
   */
  const applyProduct = (l: Line, name: string) => {
    const p = props.products?.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
    if (!p) { update(l.key, { name }); return; }
    update(l.key, {
      name,
      price: l.price || (p.price ? fmtPlain(p.price) : ''),
      accountId: p.accountId || l.accountId,
      taxId: p.taxId ?? l.taxId,
      hsn: p.hsnCode || l.hsn,
      mrp: p.mrp ? fmtPlain(p.mrp) : l.mrp,
    });
  };

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

  const editing = !!props.existing;
  const noun = isBill ? 'Vendor Bill' : 'Customer Invoice';
  // The page header already says this is an edit; the card just names the thing.
  const title = editing ? noun : `New ${noun}`;

  return (
    <form
      action={saveDocumentAction}
      onSubmit={(e) => {
        if (lines.some((l) => l.name.trim() && l.accountId)) { setLineError(null); return; }
        e.preventDefault();
        setLineError('Give at least one line a description and an account — there is nothing to save yet.');
      }}
      className="space-y-5"
    >
      <input type="hidden" name="doc_type" value={docType} />
      <input type="hidden" name="analytic_id" value={analyticId} />
      {editing && <input type="hidden" name="id" value={props.existing!.id} />}

      <Card title={title} subtitle={
        editing
          ? 'Nothing has reached the ledger yet, so every figure here is still open to change.'
          : isBill
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
            <select name="payment_terms_id" className={inputClass} defaultValue={props.defaults?.paymentTermsId ?? ''}>
              <option value="">—</option>
              {paymentTerms.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Due date" hint="Left blank, the payment terms decide it.">
            <input type="date" name="due_date" defaultValue={props.defaults?.dueDate ?? ''} className={inputClass} />
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
          {/*
            THE PLACE OF SUPPLY IS NOT DECORATION.

            Against the agency's own state it is what makes a supply intra-state
            (CGST+SGST) or inter-state (IGST), and it is the field a customer's
            accountant checks before any other. It is offered as a closed list
            because the comparison is an exact string match: "07" and "7" are
            the same state to a person and two different states to the engine.

            Left blank it falls back to the customer's own state on the server —
            which is why it is not `required`. Raising the first invoice against
            a traveller who does not exist as a master record yet is the path
            that matters most here, and it must not be blocked by a field that
            can be filled in afterwards.
          */}
          <Field label="Place of supply"
            hint="Decides CGST+SGST against IGST. Blank takes the customer's own state.">
            <select name="place_of_supply" className={inputClass}
              defaultValue={props.defaults?.placeOfSupply ?? ''}>
              <option value="">From the {isBill ? 'supplier' : 'customer'} record</option>
              {(props.states ?? []).map(([code, name]) =>
                <option key={code} value={code}>{code} — {name}</option>)}
            </select>
          </Field>
          <Field label={isBill ? 'Purchase order reference' : 'Order reference'}
            hint="The number the other side quotes — a channel's order id, or the customer's own PO.">
            <input name="order_ref" defaultValue={props.defaults?.orderRef ?? ''}
              className={inputClass} placeholder="1917427960" />
          </Field>
          <Field label="Order date" hint="When it was placed, if that is not the document date.">
            <input type="date" name="order_date" defaultValue={props.defaults?.orderDate ?? ''}
              className={inputClass} />
          </Field>
          {isBill && (
            <>
              <Field label="Supplier bill number">
                <input name="supplier_ref" defaultValue={props.defaults?.supplierRef ?? ''}
                  className={inputClass} placeholder="TRB/2026/4471" />
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
              <select name="currency" defaultValue={props.defaults?.currency ?? 'INR'} className={inputClass}>
                {['INR', 'USD', 'AED', 'EUR', 'THB'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <input name="rate" defaultValue={props.defaults?.rate ?? '1'} className={`${inputClass} w-24`} title="Rate to INR" />
            </div>
          </Field>
        </div>

        {/*
          THE E-INVOICE REFERENCE IS RECORDED HERE, NOT GENERATED.

          An IRN comes from the Invoice Registration Portal, which this product
          does not talk to. What it can do — and has to, if the portal's own
          report is to be reconcilable against these books — is hold the number
          the portal returned, so an invoice in the ledger and an invoice on the
          portal match one to one. On a vendor bill it serves the other
          direction: it is what GSTR-2B is checked on when a supplier's input
          credit fails to appear.

          Tucked into a details block because most agencies will not be
          registering invoices at all, and three empty fields at the top of the
          form make the ones that matter harder to find.
        */}
        <details className="mt-5 border-t border-line pt-4">
          <summary className="cursor-pointer text-[12.5px] font-bold text-ink-muted">
            E-invoice reference (IRN)
          </summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="IRN" wide>
              <input name="irn" defaultValue={props.defaults?.irn ?? ''} className={inputClass}
                placeholder="As returned by the portal" />
            </Field>
            <Field label="Acknowledgement number">
              <input name="irn_ack_no" defaultValue={props.defaults?.irnAckNo ?? ''} className={inputClass} />
            </Field>
            <Field label="Acknowledgement date">
              <input type="date" name="irn_ack_date" defaultValue={props.defaults?.irnAckDate ?? ''}
                className={inputClass} />
            </Field>
          </div>
        </details>
      </Card>

      <Card title="Lines" padded={false}>
        {/* A plain datalist, like the customer field: it filters as you type
            with no client JS of its own, and a browser that ignores `list`
            degrades to an ordinary text box rather than to a broken combobox. */}
        <datalist id="product-options">
          {(props.products ?? []).map((p) => <option key={p.id} value={p.name} />)}
        </datalist>
        <div className="scroll-x">
          <table className="w-full min-w-[1180px] border-collapse text-[13px]">
            <thead>
              <tr className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">
                <th className="border-b border-line px-3 py-2 text-left">Description</th>
                {/* HSN/SAC is mandatory on a GST tax invoice (CGST Rule 46),
                    so it sits next to the description rather than behind a
                    disclosure: a column people have to go looking for is a
                    column that stays empty. */}
                <th className="border-b border-line px-3 py-2 text-left w-[100px]" title="HSN for goods, SAC for a service. Required on a GST tax invoice.">HSN / SAC</th>
                <th className="border-b border-line px-3 py-2 text-left w-[120px]">Account</th>
                <th className="border-b border-line px-3 py-2 text-right w-[80px]">Qty</th>
                <th className="border-b border-line px-3 py-2 text-right w-[120px]" title="The list price. Shown on the invoice beside what was actually charged; it does not affect the tax or the total.">MRP</th>
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
                        list="product-options" autoComplete="off"
                        onChange={(e) => applyProduct(l, e.target.value)}
                        placeholder="Bali 5D/4N Package — 2 pax" className={inputClass} />
                    </td>
                    <td className="border-b border-line px-2 py-1.5">
                      <input name="line_hsn" value={l.hsn} inputMode="numeric"
                        onChange={(e) => update(l.key, { hsn: e.target.value })}
                        placeholder="998555" className={inputClass} />
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
                      <input name="line_mrp" value={l.mrp} inputMode="decimal" placeholder="0.00"
                        onChange={(e) => update(l.key, { mrp: e.target.value })} className={`${inputClass} text-right`} />
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
        {lineError && (
          <p className="px-4 pt-3 text-[13px] font-semibold text-negative">{lineError}</p>
        )}
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
        <textarea name="note" rows={3} className={inputClass} defaultValue={props.defaults?.note ?? ''}
          placeholder="Anything the customer or the auditor should see on this document." />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="submit" className={btn.ghost}>{editing ? 'Save changes' : 'Save as draft'}</button>
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

/**
 * Minor units as the plain decimal an amount input expects.
 *
 * NOT `fmt()`: that returns "₹1,50,000.00", and a currency symbol and digit
 * grouping typed back into the form would be parsed as 1.00 — the product's
 * price silently becoming one rupee. This is the inverse of what the inputs
 * post, and nothing else.
 */
function fmtPlain(minor: number): string {
  return (minor / 100).toFixed(2);
}

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className="flex justify-between gap-8">
      <dt className={bold ? 'font-bold' : 'text-ink-muted'}>{label}</dt>
      <dd className={`num ${bold ? 'font-bold' : ''}`}>{fmt(value)}</dd>
    </div>
  );
}
