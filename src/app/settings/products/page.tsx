import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { listProducts } from '@/server/accounting/masters';
import { titleise } from '@/lib/accounting';
import {
  PageHeader, Card, Banner, Table, Th, Td, Money, Chip, EmptyState, LinkButton,
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
  const s = await ctx();
  const m = await msg(await searchParams);
  const products = await listProducts(s.orgId);

  return (
    <>
      <PageHeader
        title="Products & Services"
        subtitle="Packages, hotel nights, flights, visas — what the agency sells and what it buys."
        accent="var(--color-sec-settings)"
        actions={<LinkButton href="/settings/products/new" variant="primary">+ New Product</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <Card padded={false}>
          {products.length === 0 ? (
            <EmptyState title="No products yet." />
          ) : (
            <Table>
              <thead>
                <tr><Th>Name</Th><Th>HSN / SAC</Th><Th>Category</Th>
                  <Th align="right">MRP</Th><Th align="right">Sale price</Th>
                  <Th align="right">Typical cost</Th><Th align="right">Margin</Th></tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const margin = p.sale_price ? ((p.sale_price - p.cost_price) / p.sale_price) * 100 : 0;
                  return (
                    <tr key={p.id} className="hover:bg-canvas">
                      <Td>
                        <span className="font-semibold">{p.name}</span>
                        {p.variant && <div className="text-[11.5px] text-ink-faint">{p.variant}</div>}
                      </Td>
                      {/* An unset HSN reads red, not as a dash. It is the one
                          field here whose absence makes an invoice
                          non-compliant, and a neutral em dash alongside a
                          column of neutral em dashes says nothing about that. */}
                      <Td>
                        {p.hsn_code
                          ? <span className="num !text-left text-ink-muted">{p.hsn_code}</span>
                          : <span className="text-[12px] font-bold text-negative" title="A GST tax invoice needs an HSN or SAC on every line.">Not set</span>}
                      </Td>
                      <Td><Chip state="draft" label={titleise(p.category)} /></Td>
                      <Td align="right"><Money value={p.mrp} /></Td>
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
    </>
  );
}
