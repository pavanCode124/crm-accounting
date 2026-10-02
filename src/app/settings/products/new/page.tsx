import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { accountOptions } from '@/server/options';
import { listTaxes } from '@/server/accounting/tax';
import { titleise } from '@/lib/accounting';
import { saveProductAction } from '@/app/actions';
import { PageHeader, Card, Banner, Field, inputClass, btn, LinkButton } from '@/components/ui';

export const dynamic = 'force-dynamic';

const CATEGORIES = [
  'package', 'hotel', 'flight', 'visa', 'transport', 'sightseeing', 'guide', 'fee', 'other',
];

export default async function NewProductPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  const income = await accountOptions(s.orgId, ['income', 'income_other']);
  const expense = await accountOptions(s.orgId, ['expense_direct', 'expense_operating']);
  const saleTaxes = await listTaxes(s.orgId, 'sale');
  const purchaseTaxes = await listTaxes(s.orgId, 'purchase');

  return (
    <>
      <PageHeader
        title="New Product or Service"
        subtitle="A product is a shortcut, not a rule: it fills in the price, account and tax on an invoice line, and every one of those can still be changed there."
        accent="var(--color-sec-settings)"
        actions={<LinkButton href="/settings/products">Cancel</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}

      <Card className="max-w-2xl">
        <form action={saveProductAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <input name="name" required className={inputClass} placeholder="Bali 5N/6D — Deluxe" />
            </Field>
            <Field label="Category">
              <select name="category" className={inputClass} defaultValue="package">
                {CATEGORIES.map((c) => <option key={c} value={c}>{titleise(c)}</option>)}
              </select>
            </Field>
          </div>

          {/*
            THE HSN IS WHY THIS FIELD IS WORTH THE ROW IT TAKES.

            A GST tax invoice must carry an HSN (goods) or SAC (services) per
            line — CGST Rule 46 — and it is a six-digit code nobody recalls
            while typing an invoice. Holding it on the product is the only way
            the invoice column gets filled in practice rather than in
            principle: choosing the product on a line brings it along with the
            price. For a travel agency these are mostly SACs — 9985 for a tour
            operator, 996311 for hotel accommodation, 996425 for transport.
          */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="HSN / SAC code"
              hint="Printed on every invoice line this product fills. 998555 is tour-operator services.">
              <input name="hsn_code" inputMode="numeric" className={inputClass} placeholder="998555" />
            </Field>
            <Field label="Variant" hint="Deluxe, twin-sharing, economy — what distinguishes this from the others of its kind.">
              <input name="variant" className={inputClass} placeholder="Deluxe · twin sharing" />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sale price">
              <input name="sale_price" inputMode="decimal" className={`${inputClass} text-right`} placeholder="0.00" />
            </Field>
            <Field label="MRP / list price"
              hint="The published price the sale price is discounted from. Printed beside it; it does not affect the tax or the total.">
              <input name="mrp" inputMode="decimal" className={`${inputClass} text-right`} placeholder="0.00" />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Typical cost" hint="What it usually costs to buy. Used for the margin column only.">
              <input name="cost_price" inputMode="decimal" className={`${inputClass} text-right`} placeholder="0.00" />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Revenue account">
              <select name="income_account_id" className={inputClass} defaultValue="">
                <option value="">—</option>
                {income.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </Field>
            <Field label="Cost account">
              <select name="expense_account_id" className={inputClass} defaultValue="">
                <option value="">—</option>
                {expense.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sales tax">
              <select name="sale_tax_id" className={inputClass} defaultValue="">
                <option value="">—</option>
                {saleTaxes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Purchase tax">
              <select name="purchase_tax_id" className={inputClass} defaultValue="">
                <option value="">—</option>
                {purchaseTaxes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button className={btn.primary}>Create product</button>
            <LinkButton href="/settings/products">Cancel</LinkButton>
          </div>
        </form>
      </Card>
    </>
  );
}
