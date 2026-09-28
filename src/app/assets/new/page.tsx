import { ctx } from '@/server/bootstrap';
import { msg, one, type SearchParams } from '@/lib/range';
import { accountOptions, journalOptions } from '@/server/options';
import { isoDate } from '@/lib/accounting';
import { saveAssetAction, saveDeferralAction } from '@/app/actions';
import { PageHeader, Card, Banner, Tabs, Field, inputClass, btn, LinkButton } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * A new fixed asset, or a new deferral.
 *
 * Both are the same idea — one amount recognised a slice at a time on a
 * schedule agreed once and then followed — so they sit behind one page with
 * the same two tabs the list screen uses, and the tab you were on carries over.
 */
export default async function NewAssetPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const m = await msg(params);
  const tab = await one(params, 'tab') === 'deferrals' ? 'deferrals' : 'assets';
  const today = isoDate();

  const fixedAccounts = await accountOptions(s.orgId, ['asset_fixed']);
  const depAccounts = await accountOptions(s.orgId, ['expense_depreciation', 'expense_operating']);
  const prepaidAccounts = await accountOptions(s.orgId, ['asset_prepaid', 'liability_current']);
  const pnlAccounts = await accountOptions(s.orgId, ['expense_operating', 'expense_direct', 'income']);
  const journals = await journalOptions(s.orgId, ['general']);

  return (
    <>
      <PageHeader
        title={tab === 'deferrals' ? 'New Deferral' : 'New Fixed Asset'}
        subtitle={tab === 'deferrals'
          ? 'An annual premium or a year of software, spread across the months it actually covers.'
          : 'The schedule is written once and then followed — changing a useful life later never rewrites entries already posted.'}
        accent="var(--color-sec-settings)"
        actions={<LinkButton href={`/assets?tab=${tab}`}>Cancel</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}

      <div className="max-w-2xl">
        <Tabs
          active={`/assets/new?tab=${tab}`}
          tabs={[
            { label: 'Fixed asset', href: '/assets/new?tab=assets' },
            { label: 'Deferral', href: '/assets/new?tab=deferrals' },
          ]}
        />

        <Card>
          {tab === 'assets' ? (
            <form action={saveAssetAction} className="space-y-4">
              <Field label="Name">
                <input name="name" required className={inputClass} placeholder="Office laptop — Dell 5540" />
              </Field>

              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Purchase value">
                  <input name="purchase_value" required inputMode="decimal" className={`${inputClass} text-right`} />
                </Field>
                <Field label="Salvage value" hint="Worth at end of life.">
                  <input name="salvage_value" inputMode="decimal" className={`${inputClass} text-right`} />
                </Field>
                <Field label="Purchased on">
                  <input type="date" name="purchase_date" defaultValue={today} className={inputClass} />
                </Field>
              </div>

              <Field label="Asset account">
                <select name="asset_account_id" required className={inputClass}>
                  {fixedAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </Field>

              <Field label="Accumulated depreciation"
                hint="A contra-asset: the cost stays on the books at what was paid.">
                <select name="depreciation_account_id" required className={inputClass}>
                  {fixedAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </Field>

              <Field label="Depreciation expense">
                <select name="expense_account_id" required className={inputClass}>
                  {depAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </Field>

              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Method">
                  <select name="method" className={inputClass} defaultValue="straight_line">
                    <option value="straight_line">Straight line</option>
                    <option value="declining">Written-down value</option>
                  </select>
                </Field>
                <Field label="Life (months)">
                  <input name="life_months" defaultValue="36" inputMode="numeric" className={`${inputClass} text-right`} />
                </Field>
                <Field label="WDV rate %" hint="Written-down value only.">
                  <input name="declining_rate" inputMode="decimal" className={`${inputClass} text-right`} />
                </Field>
              </div>

              <input type="hidden" name="journal_id" value={journals[0]?.id ?? ''} />

              <label className="flex items-center gap-2.5 rounded-[10px] border border-line px-3.5 py-3">
                <input type="checkbox" name="confirm_now" defaultChecked className="h-4 w-4" />
                <span className="text-[13px] font-bold">Confirm the schedule straight away</span>
              </label>

              <div className="flex items-center gap-2 pt-1">
                <button className={btn.primary}>Create asset</button>
                <LinkButton href="/assets?tab=assets">Cancel</LinkButton>
              </div>
            </form>
          ) : (
            <form action={saveDeferralAction} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
                <Field label="Name">
                  <input name="name" required className={inputClass} placeholder="Office insurance 2026-27" />
                </Field>
                <Field label="Kind">
                  <select name="kind" className={inputClass} defaultValue="expense">
                    <option value="expense">Prepaid expense</option>
                    <option value="revenue">Deferred revenue</option>
                  </select>
                </Field>
              </div>

              <Field label="Amount">
                <input name="amount" required inputMode="decimal" className={`${inputClass} text-right`} />
              </Field>

              <Field label="Balance account" hint="Prepaid expenses, or deferred revenue.">
                <select name="balance_account_id" required className={inputClass}>
                  {prepaidAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </Field>

              <Field label="Recognition account" hint="Where each slice lands in the P&L.">
                <select name="recognition_account_id" required className={inputClass}>
                  {pnlAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Starts">
                  <input type="date" name="date_from" defaultValue={today} className={inputClass} />
                </Field>
                <Field label="Months">
                  <input name="months" defaultValue="12" inputMode="numeric" className={`${inputClass} text-right`} />
                </Field>
              </div>

              <input type="hidden" name="journal_id" value={journals[0]?.id ?? ''} />

              <div className="flex items-center gap-2 pt-1">
                <button className={btn.primary}>Schedule deferral</button>
                <LinkButton href="/assets?tab=deferrals">Cancel</LinkButton>
              </div>
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
