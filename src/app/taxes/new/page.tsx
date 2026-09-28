import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { accountOptions } from '@/server/options';
import { saveTaxAction } from '@/app/actions';
import { PageHeader, Card, Banner, Field, inputClass, btn, LinkButton } from '@/components/ui';

export const dynamic = 'force-dynamic';

const TAX_GROUPS = ['gst', 'igst', 'cgst_sgst', 'tds', 'tcs', 'vat', 'none'];

export default async function NewTaxPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const m = msg(await searchParams);
  const accounts = accountOptions(s.orgId, ['liability_tax', 'asset_current']);

  return (
    <>
      <PageHeader
        title="New Tax"
        subtitle="GST, IGST and TDS are configured here, never hard-coded — a rate change is a row, not a release."
        accent="var(--color-sec-taxes)"
        actions={<LinkButton href="/taxes">Cancel</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}

      <Card className="max-w-2xl">
        <form action={saveTaxAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
            <Field label="Name">
              <input name="name" required className={inputClass} placeholder="GST 28% (Sales)" />
            </Field>
            <Field label="Rate %">
              <input name="rate" required inputMode="decimal" className={`${inputClass} text-right`} placeholder="28" />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Applies to">
              <select name="scope" className={inputClass} defaultValue="sale">
                <option value="sale">Sales</option>
                <option value="purchase">Purchases</option>
                <option value="none">Neither (manual)</option>
              </select>
            </Field>
            <Field label="Group">
              <select name="tax_group" className={inputClass} defaultValue="gst">
                {TAX_GROUPS.map((g) => <option key={g} value={g}>{g.toUpperCase()}</option>)}
              </select>
            </Field>
          </div>

          <Field label="Posted to" hint="The liability or input-credit account this tax accumulates on.">
            <select name="account_id" className={inputClass} defaultValue="">
              <option value="">— choose —</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </Field>

          <Field label="Threshold" hint="TDS only. Below this annual value nothing is withheld.">
            <input name="threshold" inputMode="decimal" className={`${inputClass} text-right`} />
          </Field>

          <label className="flex items-start gap-2.5 rounded-[10px] border border-line px-3.5 py-3">
            <input type="checkbox" name="price_included" className="mt-0.5 h-4 w-4" />
            <span>
              <span className="block text-[13px] font-bold">Price already includes this tax</span>
              <span className="mt-0.5 block text-[12px] text-ink-faint">
                The line amount is treated as gross and the tax is worked back out of it.
              </span>
            </span>
          </label>

          <p className="rounded-[10px] bg-canvas px-3.5 py-3 text-[12px] text-ink-muted">
            A CGST/SGST pair is created as a parent at the full rate with two children at half —
            the seeded taxes show the shape.
          </p>

          <div className="flex items-center gap-2 pt-1">
            <button className={btn.primary}>Create tax</button>
            <LinkButton href="/taxes">Cancel</LinkButton>
          </div>
        </form>
      </Card>
    </>
  );
}
