import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { listProducts } from '@/server/accounting/masters';
import { accountOptions } from '@/server/options';
import { listTaxes } from '@/server/accounting/tax';
import { titleise } from '@/lib/accounting';
import { saveProductAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, Money, Chip, EmptyState, Field, inputClass, btn,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Products and services.
 *
 * A product is a SHORTCUT, not a rule: choosing one on an invoice fills in the
 * price, the revenue account and the tax, and every one of those can then be
 * changed on the line. The posting always reads the line, never the product —
 * otherwise editing a product would retrospectively change what an invoice
 * meant.
 */
export default async function ProductsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const m = msg(await searchParams);
  const products = listProducts(s.orgId);
  const income = accountOptions(s.orgId, ['income', 'income_other']);
  const expense = accountOptions(s.orgId, ['expense_direct', 'expense_operating']);
  const saleTaxes = listTaxes(s.orgId, 'sale');
  const purchaseTaxes = listTaxes(s.orgId, 'purchase');

  return (
    <>
      <PageHeader
        title="Products & Services"
        subtitle="Packages, hotel nights, flights, visas — what the agency sells and what it buys."
        accent="var(--color-sec-settings)"
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Card padded={false}>
          {products.length === 0 ? (
            <EmptyState title="No products yet." />
          ) : (
            <Table>
              <thead>
                <tr><Th>Name</Th><Th>Category</Th><Th align="right">Sale price</Th>
                  <Th align="right">Typical cost</Th><Th align="right">Margin</Th></tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const margin = p.sale_price ? ((p.sale_price - p.cost_price) / p.sale_price) * 100 : 0;
                  return (
                    <tr key={p.id} className="hover:bg-canvas">
                      <Td><span className="font-semibold">{p.name}</span></Td>
                      <Td><Chip state="draft" label={titleise(p.category)} /></Td>
                      <Td align="right"><Money value={p.sale_price} /></Td>
                      <Td align="right"><Money value={p.cost_price} /></Td>
                      <Td align="right">
                        <span className="num">{p.sale_price ? `${margin.toFixed(1)}%` : '—'}</span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          <p className="px-5 py-4 text-[12.5px] text-ink-faint">
            The listed price is a default for the invoice line. What a trip actually earned comes
            from the posted invoice, never from this table.
          </p>
        </Card>

        <Card title="Add a product">
          <form action={saveProductAction} className="space-y-3">
            <Field label="Name"><input name="name" required className={inputClass} /></Field>
            <Field label="Category">
              <select name="category" className={inputClass} defaultValue="package">
                {['package', 'hotel', 'flight', 'visa', 'transport', 'sightseeing', 'guide', 'fee', 'other']
                  .map((c) => <option key={c} value={c}>{titleise(c)}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Sale price">
                <input name="sale_price" inputMode="decimal" className={`${inputClass} text-right`} />
              </Field>
              <Field label="Typical cost">
                <input name="cost_price" inputMode="decimal" className={`${inputClass} text-right`} />
              </Field>
            </div>
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
            <button className={`${btn.primary} w-full`}>Add product</button>
          </form>
        </Card>
      </div>
    </>
  );
}
