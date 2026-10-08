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
  /**
   * The agency's departures, LIVE from TripzoCRM — a batch is a dated
   * departure of a package that several invoices are commonly raised against,
   * and that vendor bills and expenses are often bought for as a whole rather
   * than per traveller.
   *
   * OFFERED ON BOTH AN INVOICE AND A BILL, unlike the trip/invoice block below
   * it which branches: a batch is sold (customer invoices) and bought for
   * (vendor bills), so both directions carry it. It is independent of that
   * block — a document can name a trip AND a batch, or a sale AND a batch —
   * because a batch groups invoices the way a trip groups GL lines, which is a
   * different cut of the same costs.
   */
  batches: Option[];
  /**
   * VENDOR BILLS: THE CUSTOMER INVOICES A COST CAN BE RECORDED AGAINST.
   *
   * This REPLACES the trip picker on a bill, and the replacement is the point.
   * A trip here is a CRM booking, and most invoices an agency raises — a
   * traveller typed into the form, a package sold off the catalogue — never
   * produce one, so the Trip dropdown frequently did not contain the trip the
   * purchase clerk meant. It was left blank, the cost was tagged to nothing,
   * and the trip's margin showed revenue with no cost against it.
   *
   * The invoice always exists: it is why the cost is being incurred. Picking
   * it carries the trip across on the server (`deriveTripFromInvoice`), so
   * profitability is computed exactly as before — from the analytic tag on the
   * GL line — off a question the user can actually answer.
   *
   * `hint` is the trip the invoice already belongs to, so the form can say
   * which one the bill is about to join.
   */
  invoices?: Array<Option & { total?: number; date?: string }>;
  paymentTerms: Option[];
  withholdingTaxes?: TaxOption[];
  products?: Array<{
    id: string; name: string; price: number; accountId: string | null; taxId: string | null;
    hsnCode?: string | null; mrp?: number;
  }>;
  /**
   * The agency's TripzoCRM package catalogue, live.
   *
   * SEPARATE FROM `products` EVEN THOUGH BOTH FILL A LINE, because they are
   * different kinds of thing and the form says so. A product is the agency's
   * own classification — it knows its revenue account, its tax and its SAC — and
   * a package is what the CRM is selling, which knows a name and a price and
   * nothing about the books. Merging them into one dropdown would present the
   * two as interchangeable and leave nobody able to tell why picking one filled
   * the Account column and picking the other did not.
   *
   * Empty on a vendor bill, and empty whenever the CRM is unreachable: the
   * column then simply does not appear. Raising an invoice by hand has to keep
   * working when TripzoCRM does not.
   */
  packages?: Array<{
    id: string; name: string;
    /**
     * MINOR UNITS, and the TAXABLE VALUE rather than the catalogue figure.
     *
     * A package is quoted inclusive of GST, because that is the one number a
     * traveller is told. A document line's `unit_price` is what the tax is
     * computed on, so the inclusive price would be taxed a second time. The
     * conversion and the back-out both happen in `documentFormOptions`, at the
     * single edge where the CRM's rupees become the ledger's paise.
     */
    price: number;
    /** The inclusive figure, for the dropdown label the agent recognises. */
    grossPrice?: number;
    code?: string | null; duration?: string; currency?: string;
    /** The rate the agency put this package on, under Packages -> GST. */
    taxId?: string | null; taxName?: string | null; taxRateBps?: number;
  }>;
  /** GST state codes, for the place-of-supply field. Closed list, by design. */
  states?: Array<[string, string]>;
  /**
   * The agency's own default HSN/SAC — the last step of the chain that fills a
   * blank HSN cell (the line's own, then the account's, then this).
   */
  defaultHsn?: string;
  /**
   * The document being edited, if this is an edit rather than a new one.
   *
   * A POSTED DOCUMENT REACHES HERE TOO. It used to be drafts only, on the rule
   * that a posted document is immutable — but the correction people actually
   * need is "this invoice was wrong", and offering only a reversal plus a fresh
   * invoice meant two documents and two numbers for one sale. The server
   * decides which path a save takes: a draft is updated, a posted document is
   * AMENDED, which rewrites its ledger entry in place and audits what it used
   * to say. See `saveDocumentAction` and `amendDocument`.
   */
  existing?: { id: string };
  defaults?: {
    partnerName?: string; journalId?: string; bookingId?: string; analyticId?: string;
    linkedInvoiceId?: string; crmBatchId?: string; batchName?: string; date?: string;
    dueDate?: string; paymentTermsId?: string; supplierRef?: string;
    currency?: string; rate?: string; withholdingTaxId?: string; note?: string;
    placeOfSupply?: string; partyGstin?: string; supplyType?: 'b2b' | 'b2c';
    orderRef?: string; orderDate?: string;
    irn?: string; irnAckNo?: string; irnAckDate?: string;
    /**
     * What the source document stated, as plain decimals for the inputs.
     *
     * On an invoice fetched from TripzoCRM these are the CRM's own Discount,
     * Tax and Amount-paid fields, and they are shown here because the screen
     * that drafts the books has to show every figure the customer's copy
     * carries. See `DocInput.statedDiscount` for what each one does to the
     * posting — briefly: the discount and the advance do nothing, and the tax
     * is carved out of the lines rather than added to them.
     */
    statedDiscount?: string; statedTax?: string; statedAdvance?: string;
    lines?: LineDefault[];
  };
  canPost: boolean;
}

/** One existing line, already rendered into the strings the inputs carry. */
export interface LineDefault {
  name: string; qty: string; price: string; discount: string;
  taxId: string; accountId: string; analyticId: string;
  hsn: string; mrp: string; itemType: string;
}

interface Line {
  key: number;
  name: string; qty: string; price: string; discount: string;
  taxId: string; accountId: string; analyticId: string;
  hsn: string; mrp: string;
  /** TripzoCRM's own kind for this line. See `CRM_ITEM_TYPES`. */
  itemType: string;
}

/**
 * THE LINE KINDS TRIPZOCRM'S INVOICE FORM OFFERS, in its order.
 *
 * This column used to be a PACKAGE PICKER — the agency's live catalogue, with
 * "Raigad Fort · 2D/1N · INR 17,999" in the dropdown. It was headed Package,
 * and the column of the same name on the invoice it was drafted from holds
 * something else entirely: the KIND of line, which is what every TripzoCRM
 * invoice item carries and what the agent actually chose. Two columns with one
 * name and different contents is how a drafted invoice comes to look wrong to
 * the person who raised it.
 *
 * So the column is the CRM's now, and the catalogue moved into the description
 * box beside it, where a product is already picked by typing its name.
 *
 * WHATEVER THE LINE ALREADY SAYS IS OFFERED TOO, even when it is not in this
 * list — see `typeOptions`. TripzoCRM's mobile app offers a different six
 * (package, hotel, flight, transport, activity, other) and a line fetched from
 * it must not have its kind silently rewritten to one of these three by being
 * opened here.
 */
const CRM_ITEM_TYPES = ['service', 'package', 'extra'] as const;

let nextKey = 1;
const blankLine = (accountId = '', hsn = ''): Line => ({
  key: nextKey++, name: '', qty: '1', price: '', discount: '0',
  taxId: '', accountId, analyticId: '', hsn, mrp: '', itemType: '',
});

/**
 * The kinds offered on one line: the CRM's list, plus whatever this line
 * already says if that is something else.
 *
 * A select can only show what is in it, and a line fetched from TripzoCRM's
 * mobile app says `hotel` or `flight`. Dropping it into a list of three would
 * display the wrong kind and — worse — SAVE the wrong kind the moment anything
 * else on the row was edited, because a select with no matching option posts
 * its first one.
 */
function typeOptions(current: string): string[] {
  const own = current.trim().toLowerCase();
  return own && !CRM_ITEM_TYPES.includes(own as typeof CRM_ITEM_TYPES[number])
    ? [...CRM_ITEM_TYPES, own]
    : [...CRM_ITEM_TYPES];
}

/**
 * The HSN/SAC an account implies, falling back to the agency's own.
 *
 * Module level rather than a closure because a new line needs it before the
 * component's own state exists — the first row arrives with an account already
 * selected, and arriving with the matching HSN already in the box is the whole
 * difference between a column that is filled and a column that is not.
 */
function hsnOfAccount(accounts: Option[], orgDefault: string | undefined, accountId: string): string {
  return accounts.find((a) => a.id === accountId)?.hint || orgDefault || '';
}

export function DocumentForm(props: DocFormProps) {
  const { docType, partners, journals, accounts, taxes, analytics, bookings, batches, paymentTerms } = props;
  const isBill = docType.startsWith('in_');
  // A column that can never be filled is worse than no column: it teaches the
  // reader to skip past one. Vendor bills have no packages by definition, and a
  // form rendered while TripzoCRM is unreachable gets an empty list rather than
  // an error — so in both cases the column simply is not there.
  const hasPackages = !isBill && (props.packages?.length ?? 0) > 0;
  const today = props.defaults?.date ?? new Date().toISOString().slice(0, 10);

  const [lines, setLines] = useState<Line[]>(() => {
    if (props.defaults?.lines?.length) {
      return props.defaults.lines.map((l) => ({ key: nextKey++, ...l }));
    }
    const first = accounts[0]?.id ?? '';
    return [blankLine(first, hsnOfAccount(accounts, props.defaultHsn, first))];
  });
  const [analyticId, setAnalyticId] = useState(props.defaults?.analyticId ?? '');
  // The batch's own label, snapshotted into a hidden field at the moment it is
  // picked — see the Batch field below and the schema note on `batch_name`.
  const [batchName, setBatchName] = useState(props.defaults?.batchName ?? '');
  // A line with no description or no account is dropped on the server, and the
  // whole form would bounce back empty — everything typed, lost. Catch it here
  // instead, before anything is submitted.
  const [lineError, setLineError] = useState<string | null>(null);
  const [withholdingId, setWithholdingId] = useState(props.defaults?.withholdingTaxId ?? '');
  const [partnerName, setPartnerName] = useState(props.defaults?.partnerName ?? '');
  /*
   * THE THREE FIGURES THE SOURCE DOCUMENT STATED FOR THE WHOLE INVOICE.
   *
   * State rather than uncontrolled inputs because the tax one moves the totals
   * panel: it is carved OUT of the line amounts, so typing 2,400 changes what
   * the Taxable row says without changing the Total by a rupee. That is the
   * behaviour the panel has to show while it is being typed, or the first time
   * anybody sees it is after saving.
   */
  const [statedDiscount, setStatedDiscount] = useState(props.defaults?.statedDiscount ?? '');
  const [statedTax, setStatedTax] = useState(props.defaults?.statedTax ?? '');
  const [statedAdvance, setStatedAdvance] = useState(props.defaults?.statedAdvance ?? '');
  const [gstin, setGstin] = useState(props.defaults?.partyGstin ?? '');
  /*
   * B2B OR B2C IS STATE, BECAUSE IT CHANGES WHAT IS REQUIRED.
   *
   * The GSTIN field below is optional, and it has to be: most of a travel
   * agency's book is an unregistered traveller with no registration to state.
   * But blank then means two different things — "this is a retail supply" and
   * "this is a business and somebody forgot" — and only the second is a defect.
   * Nothing on the document could tell them apart, so neither could any check.
   *
   * Saying which it is turns the optional field into a conditional one. It is
   * also the split GSTR-1 reports on: invoice-wise in Table 4A for B2B, in
   * aggregate in Tables 5 and 7 for B2C. Enforced again on the server, where
   * `resolveSupplyType` refuses a B2B document with no registration.
   *
   * Defaulted from what the document already says, so reopening one never
   * silently changes what kind of supply it was.
   */
  const [supplyType, setSupplyType] = useState<'b2b' | 'b2c'>(
    props.defaults?.supplyType ?? (props.defaults?.partyGstin ? 'b2b' : 'b2c'),
  );

  const update = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  /**
   * The HSN/SAC a blank cell falls back to: the account's default, then the
   * agency's.
   *
   * THE SAME CHAIN THE SERVER APPLIES, deliberately duplicated — like the
   * totals above, and for the same reason. The server's copy in `replaceLines`
   * is the one that decides what is stored; this one exists so the column is
   * visibly filled while the invoice is being typed, because an HSN that only
   * appears after saving is an HSN nobody trusts and everyone re-types.
   *
   * NO SYSTEM CAN DERIVE AN HSN from a description — it is a classification the
   * agency assigns and answers for under Rule 46. Every link in this chain is a
   * code somebody set deliberately, on a product, on an account, or on the
   * agency; nothing here guesses one.
   */
  const hsnFor = (accountId: string) => hsnOfAccount(accounts, props.defaultHsn, accountId);

  /**
   * Changing a line's account fills a BLANK HSN from it, and leaves a filled one
   * alone.
   *
   * The opposite of how a product behaves, and the asymmetry is the point. A
   * product IS the authority on what is being sold, so choosing one overrides
   * the classification. An account is a weaker signal — a single revenue account
   * carries several SACs in practice — so it may complete the column but must
   * never overwrite a code someone typed or a product supplied.
   */
  const setAccount = (l: Line, accountId: string) =>
    update(l.key, { accountId, hsn: l.hsn || hsnFor(accountId) });

  /**
   * Typing a customer or supplier name fills the GSTIN beside it.
   *
   * Typed, not chosen — the same idiom as every other partner field here — so a
   * name with no match leaves the GSTIN for the user to type, and that typed
   * registration is what back-fills the partner record on save. A name that DOES
   * match brings its registration with it, and only into an empty box: a GSTIN
   * already typed is the fresher statement of the two and survives someone
   * correcting a spelling in the name.
   */
  const applyPartner = (name: string) => {
    setPartnerName(name);
    const p = partners.find((x) => x.label.toLowerCase() === name.trim().toLowerCase());
    if (p?.hint && !gstin.trim()) setGstin(p.hint);
  };

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
    // The agency's own catalogue first, then the CRM's. A product knows its
    // revenue account, its tax and its SAC; a package knows a price and a rate
    // the agency chose for it. Neither matching leaves the box as plain text,
    // which is the ordinary case and must keep working.
    if (!p) { if (!applyPackage(l, name)) update(l.key, { name }); return; }
    const accountId = p.accountId || l.accountId;
    update(l.key, {
      name,
      price: l.price || (p.price ? fmtPlain(p.price) : ''),
      accountId,
      taxId: p.taxId ?? l.taxId,
      // The product's own code wins; a product with none still leaves the line
      // classified by the account it moved to, rather than blanking a cell that
      // the previous account had filled.
      hsn: p.hsnCode || l.hsn || hsnFor(accountId),
      mrp: p.mrp ? fmtPlain(p.mrp) : l.mrp,
    });
  };

  /**
   * Typing a TripzoCRM package's name fills the line from the live catalogue.
   *
   * IT USED TO BE A COLUMN, and the column had to go: it was headed Package and
   * the column of that name on the TripzoCRM invoice this document is drafted
   * from holds the line's KIND, not the agency's catalogue. Two columns with
   * one name and different contents is how a drafted invoice comes to look
   * wrong to the agent who raised it, so the heading went back to the CRM and
   * the catalogue came here — beside Products, reached the same way, because a
   * package and a product are both "the thing being sold" and picking either by
   * typing its name is one idiom instead of two.
   *
   * WHAT IT SETS AND WHAT IT LEAVES ALONE, unchanged from when it was a
   * dropdown:
   *
   *   the PRICE is filled only when the box is EMPTY. A package price is a list
   *     price; the figure on the invoice is what was negotiated, and silently
   *     overwriting an agreed amount with the catalogue's is the one behaviour
   *     that would cost somebody money.
   *   the TAX is set, because the agency has said what it is — the rate on the
   *     Packages → GST screen is its own answer about its own supply, not a
   *     guess read off a package name.
   *   the ACCOUNT and the HSN are untouched. Nothing in a package says where the
   *     money belongs in the books, so the account column keeps whatever it had
   *     and the HSN chain (line, then account, then agency) still applies.
   *   the KIND becomes `package`, but only if the cell is empty. It is what the
   *     CRM would have recorded for a line that is a package, and it is what
   *     sends the revenue to Package Revenue on a line nobody classified.
   */
  const applyPackage = (l: Line, name: string): boolean => {
    const pkg = props.packages?.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
    if (!pkg) return false;
    update(l.key, {
      name,
      price: l.price || (pkg.price ? fmtPlain(pkg.price) : ''),
      taxId: pkg.taxId ?? l.taxId,
      hsn: l.hsn || hsnFor(l.accountId),
      itemType: l.itemType || 'package',
    });
    return true;
  };

  const totals = useMemo(() => {
    const stated = Math.max(0, toMinor(statedTax || '0'));
    let untaxed = 0;
    let tax = 0;
    /*
     * WHEN THE TAX IS STATED, THE LINES DO NOT COMPUTE IT.
     *
     * The invoice arrived with the tax already decided, as one figure for the
     * whole of it, and the customer has a copy totalling the line amounts. So
     * the total is their sum and the stated figure is carved out of it —
     * exactly what `pinStatedTax` does on the server, which is the arithmetic
     * that gets stored. Choosing a slab on a line decides which tax accounts
     * that figure is split across and moves nothing on this panel.
     */
    const grossOf = (l: Line) => {
      const gross = roundHalfUp((qtyToMilli(l.qty || '0') * toMinor(l.price || '0')) / 1000);
      return gross - pct(gross, Math.round(parseFloat(l.discount || '0') * 100));
    };
    if (stated > 0) {
      const sold = lines.reduce((t, l) => t + grossOf(l), 0);
      tax = Math.min(stated, sold);
      untaxed = sold - tax;
    } else {
      for (const l of lines) {
        const net = grossOf(l);
        const t = taxes.find((x) => x.id === l.taxId);
        // Tax-inclusive pricing backs the base out of the gross — the same
        // division the server does, kept in step with src/server/accounting/tax.ts.
        const base = t?.priceIncluded ? roundHalfUp((net * 10000) / (10000 + t.rateBps)) : net;
        untaxed += base;
        tax += t ? pct(base, t.rateBps) : 0;
      }
    }
    const wht = props.withholdingTaxes?.find((w) => w.id === withholdingId);
    const withheld = wht ? pct(untaxed, wht.rateBps) : 0;
    return {
      untaxed, tax, stated, total: untaxed + tax, withheld, payable: untaxed + tax - withheld,
      discount: Math.max(0, toMinor(statedDiscount || '0')),
      advance: Math.max(0, toMinor(statedAdvance || '0')),
    };
  }, [lines, taxes, withholdingId, props.withholdingTaxes, statedTax, statedDiscount, statedAdvance]);

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
          ? 'Changing a figure here rewrites the journal entry behind this document, and records that it was changed.'
          : isBill
            ? 'What a supplier has charged the agency, against the sale it was bought for.'
            : 'What the customer owes. Posting creates the balanced journal entry behind it.'
      }>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={isBill ? 'Supplier' : 'Customer'}>
            <input name="partner_name" list="partner-options" required autoComplete="off"
              value={partnerName} onChange={(e) => applyPartner(e.target.value)}
              placeholder={isBill ? 'Who billed it' : 'Who it is billed to'} className={inputClass} />
            <PartnerDatalist id="partner-options" options={partners} />
          </Field>
          {/*
            THE GSTIN BELONGS ON THE DOCUMENT, NOT ONLY ON THE PARTNER.

            A tax invoice that does not carry the buyer's registration is not a
            tax invoice, and it is the first field their accountant checks —
            without it they cannot claim the input credit at all. On a vendor
            bill it is the other direction: the supplier's GSTIN is what the
            agency's own purchase is matched on in GSTR-2B, and a bill recorded
            without one is a credit that quietly never arrives.

            It sits beside the name because that is where it is read from — the
            same certificate, the same glance — and because the name field is
            TYPED. A customer who does not exist as a master record yet is the
            path this form is built around, and such a customer has no partner
            row to inherit a registration from. Typing it here records it on the
            document AND fills it onto the partner, so it is typed once.

            CONDITIONAL, NOT OPTIONAL. Most of a travel agency's book is B2C: an
            unregistered traveller has no GSTIN, and a blank there is the correct
            and common answer. On a B2B supply it is not — it is what the invoice
            is reported against in GSTR-1 Table 4A and the only way the
            customer's input credit can reach them — so the field beside this one
            is what decides which.
          */}
          <Field label="Supply type"
            hint={supplyType === 'b2b'
              ? 'A registered business. The GSTIN is required, and the document is reported invoice-wise in GSTR-1 Table 4A.'
              : 'A consumer. No registration needed; reported in aggregate in GSTR-1 Tables 5 and 7.'}>
            <select name="supply_type" value={supplyType} className={inputClass}
              onChange={(e) => setSupplyType(e.target.value as 'b2b' | 'b2c')}>
              <option value="b2c">
                {isBill ? 'B2C — unregistered supplier' : 'B2C — unregistered traveller'}
              </option>
              <option value="b2b">B2B — registered business</option>
            </select>
          </Field>
          <Field label={supplyType === 'b2b' ? 'GSTIN (required)' : 'GSTIN'}
            hint={isBill
              ? "The supplier's registration — what this bill is matched on in GSTR-2B."
              : "The customer's registration. Blank for an unregistered traveller (B2C)."}>
            <input name="party_gstin" value={gstin} autoComplete="off"
              required={supplyType === 'b2b'}
              maxLength={15} spellCheck={false}
              onChange={(e) => setGstin(e.target.value.toUpperCase())}
              placeholder="27AAACT1234A1Z5" className={`${inputClass} num !text-left`} />
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
          {/*
            ON A BILL THIS IS THE SALE; ON AN INVOICE IT IS THE TRIP.

            A cost is bought AGAINST something, and on a vendor bill the thing
            it was bought against is the customer invoice — the hotel is booked
            because a traveller bought the package. Naming the invoice is what
            makes the margin on that sale computable, and it is a question the
            person recording the bill can always answer, which the trip
            dropdown was not: a trip is a CRM booking, most invoices never
            produce one, so the field sat blank and the cost reached no trip.

            The trip itself still comes across — the server copies the
            invoice's own booking and analytic account onto the bill — so
            nothing downstream changes. The sale's own trip is named in the
            hint so the clerk can see which one the cost is joining.

            A SALE KEEPS THE TRIP PICKER. An invoice is not bought against
            anything; it IS the thing, and the trip is a property of it.
          */}
          {isBill ? (
            <Field label="Against customer invoice"
              hint="The sale this cost was incurred for. It carries the trip across, which is what makes the margin on that sale real.">
              <select
                name="linked_invoice_id"
                className={inputClass}
                defaultValue={props.defaults?.linkedInvoiceId ?? ''}
              >
                <option value="">— not against a particular sale</option>
                {(props.invoices ?? []).map((inv) => (
                  <option key={inv.id} value={inv.id}>{inv.label}</option>
                ))}
              </select>
            </Field>
          ) : (
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
          )}
          {/*
            THE BATCH, LIVE FROM TRIPZOCRM — INDEPENDENT OF THE FIELD ABOVE.

            A departure that several invoices are raised against, and that
            vendor bills and expenses are often bought for as a whole rather
            than per traveller. Offered on both an invoice and a bill, unlike
            the field above: a batch is sold (invoices) and bought for
            (bills), so both directions carry it.

            THE LABEL IS THE FIX for the dropdown that showed nothing to pick:
            unlike Trip/booking, which is empty until a CRM lead has been
            synced or a booking created by hand, this is read live from the
            CRM on every form load, so it has content from the first invoice
            an agency raises — and it is named id, package and date so it is
            never a bare, unreadable id in a list.
          */}
          <Field label="Batch" hint="The CRM departure this is for — several invoices often share one, and a bill or expense can be bought for the whole batch.">
            <select
              name="crm_batch_id"
              className={inputClass}
              defaultValue={props.defaults?.crmBatchId ?? ''}
              onChange={(e) => {
                const b = batches.find((x) => x.id === e.target.value);
                setBatchName(b?.label ?? '');
              }}
            >
              <option value="">— not against a particular batch</option>
              {batches.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
            {/*
              SNAPSHOTTED AT THE MOMENT IT IS PICKED, like a package's name and
              price when a line is added — so a document raised against this
              batch still reads sensibly months later even if the departure is
              renamed or removed in the CRM afterwards.
            */}
            <input type="hidden" name="batch_name" value={batchName} />
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
              {/* Says which fallback will actually apply. A GSTIN typed above
                  carries the state in its first two digits and is used before
                  the partner record, so naming the record would be wrong. */}
              <option value="">
                {/^[0-9]{2}/.test(gstin.trim())
                  ? `From the GSTIN (${gstin.trim().slice(0, 2)})`
                  : `From the ${isBill ? 'supplier' : 'customer'} record`}
              </option>
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
        {/*
          PRODUCTS AND PACKAGES IN ONE LIST, because the description box now
          takes either: the agency's own catalogue, which knows a revenue
          account, a tax and a SAC, and TripzoCRM's, which knows a price and the
          GST rate the agency put it on. They are suggestions for one field, so
          they belong in one list — and a package's own duration and price ride
          along in the label, which is how an agent recognises the itinerary
          they quoted.
        */}
        <datalist id="product-options">
          {(props.products ?? []).map((p) => <option key={p.id} value={p.name} />)}
          {(props.packages ?? []).map((pkg) => (
            <option key={pkg.id} value={pkg.name}>
              {[pkg.duration, pkg.grossPrice ? `${pkg.currency ?? 'INR'} ${(pkg.grossPrice / 100).toLocaleString('en-IN')}` : null]
                .filter(Boolean).join(' · ')}
            </option>
          ))}
        </datalist>
        <div className="scroll-x">
          <table className="w-full min-w-[1180px] border-collapse text-[13px]">
            <thead>
              <tr className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">
                {/*
                  THE PACKAGE COLUMN IS FIRST, because on a travel agency's
                  invoice it is the question that gets answered first: which
                  trip is this? Everything to its right — the description, the
                  price, the SAC — follows from it.

                  It appears only when there is a catalogue to offer: a vendor
                  bill has none, and neither does a form rendered while the CRM
                  is unreachable. A permanently empty dropdown would be a column
                  of em dashes teaching people to ignore a column.
                */}
                {/*
                  THE SAME COLUMN TRIPZOCRM'S INVOICE FORM OPENS EACH LINE WITH,
                  and it is the kind of line rather than the agency's catalogue
                  — which is what the heading used to offer under the same word.
                  An agent raising "Airport pickup & drop" over there picks
                  `extra`; this is where that choice is read back, and where a
                  line typed here is given one.

                  It earns the position because it is the only cell that says
                  what was SOLD rather than what it was called, and it is what
                  the import routes the revenue by: `package` goes to Package
                  Revenue, `extra` and `service` to Service Fees. Changing it
                  here does not move an account somebody already chose — the
                  Account column is two cells away and says so itself.
                */}
                <th className="border-b border-line px-3 py-2 text-left w-[130px]"
                    title="The kind of line, as TripzoCRM records it: service, package or extra. Carried across on a fetched invoice and kept as the CRM spelt it.">Type</th>
                <th className="border-b border-line px-3 py-2 text-left">Description</th>
                {/* HSN/SAC is mandatory on a GST tax invoice (CGST Rule 46),
                    so it sits next to the description rather than behind a
                    disclosure: a column people have to go looking for is a
                    column that stays empty. */}
                <th className="border-b border-line px-3 py-2 text-left w-[100px]"
                    title="HSN for goods, SAC for a service. Required on a GST tax invoice. Filled from the product, or from the account's default, or from the agency's — and always editable.">HSN / SAC</th>
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
                      {/*
                        A BLANK OPTION, because a line typed in this ledger
                        against a vendor bill or a hand-raised invoice has no
                        TripzoCRM kind and inventing one would put a word on the
                        document that nobody chose.
                      */}
                      <select name="line_item_type" value={l.itemType}
                        onChange={(e) => update(l.key, { itemType: e.target.value })}
                        className={inputClass}>
                        <option value="">—</option>
                        {typeOptions(l.itemType).map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </td>
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
                        onChange={(e) => setAccount(l, e.target.value)} className={inputClass}>
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
            onClick={() => setLines((ls) => {
              // A new row inherits the LAST row's account, not the first in the
              // list: an invoice is nearly always several lines on one account,
              // and it brings that account's HSN with it.
              const prev = ls[ls.length - 1]?.accountId || accounts[0]?.id || '';
              return [...ls, blankLine(prev, hsnFor(prev))];
            })}>
            + Add line
          </button>
          <div className="flex flex-wrap items-start gap-6">
            {/*
              THE THREE FIGURES THE CRM HOLDS FOR THE WHOLE INVOICE, EDITABLE.

              They were missing from this screen entirely, which is why an
              invoice drafted from TripzoCRM could not be checked against the
              customer's copy here: the copy says Discount 1,500, Tax 2,400 and
              Amount paid 14,000, and the editor showed none of the three. Shown
              beside the totals rather than up with the dates because that is
              where they are read — against the figures they explain.

              WHAT EACH ONE DOES, said on the field rather than in a manual:
              the discount is RECORDED and not deducted (the line prices already
              account for it), the tax is CARVED OUT of the line amounts instead
              of being added to them, and the advance is context — the money
              itself reaches the books as a receipt.
            */}
            <div className="min-w-[250px] space-y-2">
              <Field label="Discount (stated)"
                hint="What the source invoice says was taken off. Recorded on the document; the line prices already account for it, so it is not deducted again.">
                <input name="stated_discount" value={statedDiscount} inputMode="decimal"
                  onChange={(e) => setStatedDiscount(e.target.value)}
                  placeholder="0.00" className={`${inputClass} text-right`} />
              </Field>
              <Field label="Tax (stated)"
                hint="The tax the invoice was raised with. The books post this figure exactly; the GST slab on a line decides which tax accounts it is split across, never how much it is.">
                <input name="stated_tax" value={statedTax} inputMode="decimal"
                  onChange={(e) => setStatedTax(e.target.value)}
                  placeholder="0.00" className={`${inputClass} text-right`} />
              </Field>
              <Field label="Advance / amount paid"
                hint="What had already been collected when this invoice was raised. Shown here; the receipt itself is what moves the books.">
                <input name="stated_advance" value={statedAdvance} inputMode="decimal"
                  onChange={(e) => setStatedAdvance(e.target.value)}
                  placeholder="0.00" className={`${inputClass} text-right`} />
              </Field>
            </div>
            <dl className="min-w-[280px] space-y-1.5 text-[13.5px]">
              <Row label={totals.stated > 0 ? 'Taxable value' : 'Subtotal'} value={totals.untaxed} />
              <Row label={totals.stated > 0 ? 'Tax (as stated)' : 'Tax'} value={totals.tax} />
              <Row label="Total" value={totals.total} bold />
              {totals.discount > 0 && <Row label="Discount stated (not deducted)" value={totals.discount} />}
              {totals.advance > 0 && <Row label="Already paid (recorded)" value={totals.advance} />}
              {totals.withheld > 0 && (
                <>
                  <Row label="TDS withheld" value={-totals.withheld} />
                  <Row label="Payable to supplier" value={totals.payable} bold />
                </>
              )}
            </dl>
          </div>
        </div>
      </Card>

      <Card title="Notes">
        <textarea name="note" rows={3} className={inputClass} defaultValue={props.defaults?.note ?? ''}
          placeholder="Anything the customer or the auditor should see on this document." />
        {/*
          ONE BUTTON: SAVE.

          There used to be two, and the quiet one was the problem. "Save as
          draft" produced a document that looked saved, carried no number,
          touched no ledger and appeared in no report — a thing the agency had
          raised and the books had never heard of. Agencies accumulated them,
          and the first anyone knew was a month-end that did not reconcile.

          Saving now means saving: the journal entry is written and the
          document takes its number. Correcting it afterwards is Edit, which a
          posted document still offers — it rewrites its entry in place rather
          than leaving the old figures behind (see `amendDocument`). That is the
          trade this makes, and it is the honest one: a correction that is
          recorded beats a save that was never real.

          SOMEBODY WHO CANNOT POST STILL SAVES. The button is the same; what it
          produces is a document waiting in Review & Post, which is the queue
          that exists for exactly that separation of duties.
        */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="submit" name="post_now" value={props.canPost ? 'true' : 'false'}
            className={btn.primary}>
            {editing ? 'Save changes' : 'Save'}
          </button>
          <p className="text-[12.5px] text-ink-faint">
            {props.canPost
              ? 'Saving writes the journal entry behind this document. It can still be edited afterwards — the entry is rewritten with it.'
              : 'Saved for review. Someone with posting rights writes the journal entry from Review & Post.'}
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
