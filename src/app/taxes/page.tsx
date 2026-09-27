import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { all } from '@/server/db';
import { accountOptions } from '@/server/options';
import { bpsToPct, fmt } from '@/lib/money';
import { titleise } from '@/lib/accounting';
import { saveTaxAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, Chip, Field, inputClass, btn,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Taxes and withholding — plan sections 20 and 21.
 *
 * Rates are rows, never constants: a GST change is an edit here, and a new
 * jurisdiction is new rows rather than a release. A CGST+SGST pair shows as
 * ONE tax with its two children listed under it, because that is how it is
 * chosen on an invoice and how it must be posted — one line to the customer,
 * two to the government.
 */
export default async function TaxesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const m = msg(await searchParams);

  const taxes = all<{
    id: string; name: string; rate_bps: number; scope: string; tax_group: string;
    price_included: number; threshold: number; account_name: string | null; account_code: string | null;
    is_child: number; parent_name: string | null; used: number;
  }>(
    `SELECT t.id, t.name, t.rate_bps, t.scope, t.tax_group, t.price_included, t.threshold,
            a.name AS account_name, a.code AS account_code,
            EXISTS (SELECT 1 FROM tax_children c WHERE c.child_id = t.id) AS is_child,
            (SELECT p.name FROM tax_children c JOIN taxes p ON p.id = c.parent_id WHERE c.child_id = t.id) AS parent_name,
            (SELECT COUNT(*) FROM journal_entry_lines l WHERE l.tax_id = t.id AND l.state='posted') AS used
       FROM taxes t LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.org_id = ? AND t.active = 1
      ORDER BY t.tax_group, t.scope, t.rate_bps`,
    s.orgId,
  );

  const parents = taxes.filter((t) => !t.is_child && t.tax_group !== 'tds');
  const children = taxes.filter((t) => t.is_child);
  const withholding = taxes.filter((t) => t.tax_group === 'tds');
  const accounts = accountOptions(s.orgId, ['liability_tax', 'asset_current']);

  return (
    <>
      <PageHeader
        title="Taxes"
        subtitle="GST, IGST and TDS — configured, not hard-coded."
        accent="var(--color-sec-taxes)"
        actions={<Link href="/reports/tax" className={btn.ghost}>Tax report →</Link>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-5">
          <Card title="Sales and purchase taxes" padded={false}
            subtitle="What an invoice or bill line can carry.">
            <Table>
              <thead>
                <tr><Th>Tax</Th><Th align="right">Rate</Th><Th>Applies to</Th>
                  <Th>Posted to</Th><Th align="right">Used on</Th></tr>
              </thead>
              <tbody>
                {parents.map((t) => {
                  const kids = children.filter((c) => c.parent_name === t.name);
                  return (
                    <tr key={t.id} className="hover:bg-canvas">
                      <Td>
                        <span className="font-semibold">{t.name}</span>
                        {!!t.price_included && <span className="ml-2"><Chip state="draft" label="Price included" /></span>}
                        {kids.length > 0 && (
                          <div className="mt-1 text-[12px] text-ink-faint">
                            Splits into {kids.map((k) => `${k.name} → ${k.account_code}`).join(' · ')}
                          </div>
                        )}
                      </Td>
                      <Td align="right"><span className="num font-bold">{bpsToPct(t.rate_bps)}</span></Td>
                      <Td><Chip state="draft" label={titleise(t.scope)} /></Td>
                      <Td>
                        <span className="text-ink-muted">
                          {t.account_name ?? (kids.length ? 'via its components' : '— not set —')}
                        </span>
                      </Td>
                      <Td align="right"><span className="num">{t.used}</span></Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Card>

          <Card title="Withholding tax (TDS)" padded={false}
            subtitle="Deducted from what a supplier is paid and owed to the government instead.">
            <Table>
              <thead>
                <tr><Th>Section</Th><Th align="right">Rate</Th><Th align="right">Threshold</Th>
                  <Th>Payable to</Th><Th align="right">Used on</Th></tr>
              </thead>
              <tbody>
                {withholding.map((t) => (
                  <tr key={t.id} className="hover:bg-canvas">
                    <Td><span className="font-semibold">{t.name}</span></Td>
                    <Td align="right"><span className="num font-bold">{bpsToPct(t.rate_bps)}</span></Td>
                    <Td align="right"><span className="num">{t.threshold ? fmt(t.threshold) : '—'}</span></Td>
                    <Td><span className="text-ink-muted">{t.account_name ?? '—'}</span></Td>
                    <Td align="right"><span className="num">{t.used}</span></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="px-5 py-4 text-[12.5px] text-ink-faint">
              TDS is computed on the taxable value, never on the GST-inclusive total: the government
              does not withhold tax on its own tax. Below the threshold, nothing is withheld.
            </p>
          </Card>
        </div>

        <Card title="Add a tax">
          <form action={saveTaxAction} className="space-y-3">
            <Field label="Name"><input name="name" required className={inputClass} placeholder="GST 28% (Sales)" /></Field>
            <Field label="Rate %">
              <input name="rate" required inputMode="decimal" className={`${inputClass} text-right`} placeholder="28" />
            </Field>
            <Field label="Applies to">
              <select name="scope" className={inputClass} defaultValue="sale">
                <option value="sale">Sales</option>
                <option value="purchase">Purchases</option>
                <option value="none">Neither (manual)</option>
              </select>
            </Field>
            <Field label="Group">
              <select name="tax_group" className={inputClass} defaultValue="gst">
                {['gst', 'igst', 'cgst_sgst', 'tds', 'tcs', 'vat', 'none'].map((g) =>
                  <option key={g} value={g}>{g.toUpperCase()}</option>)}
              </select>
            </Field>
            <Field label="Posted to">
              <select name="account_id" className={inputClass} defaultValue="">
                <option value="">— choose —</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </Field>
            <Field label="Threshold" hint="TDS only. Below this annual value nothing is withheld.">
              <input name="threshold" inputMode="decimal" className={`${inputClass} text-right`} />
            </Field>
            <label className="flex items-center gap-2 text-[13px] font-semibold">
              <input type="checkbox" name="price_included" className="h-4 w-4" />
              Price already includes this tax
            </label>
            <button className={`${btn.primary} w-full`}>Add tax</button>
          </form>
          <p className="mt-3 text-[12px] text-ink-faint">
            A CGST/SGST pair is created as a parent at the full rate with two children at half —
            the seed shows the shape.
          </p>
        </Card>
      </div>
    </>
  );
}
