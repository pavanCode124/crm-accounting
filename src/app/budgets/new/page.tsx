import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { accountOptions, analyticOptions } from '@/server/options';
import { fiscalYearOf, isoDate } from '@/lib/accounting';
import { saveBudgetAction } from '@/app/actions';
import { PageHeader, Card, Banner, Field, inputClass, btn, LinkButton } from '@/components/ui';

export const dynamic = 'force-dynamic';

/** How many budget lines the form offers at once. */
const LINES = 8;

export default async function NewBudgetPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  const fy = fiscalYearOf(isoDate(), s.fyStartMonth);
  const accounts = await accountOptions(s.orgId, ['expense_direct', 'expense_operating', 'income']);
  const analytics = await analyticOptions(s.orgId);

  return (
    <>
      <PageHeader
        title="New Budget"
        subtitle="Only the planned figures are typed here. The actuals are read from the ledger over this window, which is what stops the two ever disagreeing."
        accent="var(--color-sec-settings)"
        actions={<LinkButton href="/budgets">Cancel</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}

      <Card className="max-w-3xl">
        <form action={saveBudgetAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <input name="name" required className={inputClass} placeholder="FY operating budget" />
            </Field>
            <Field label="Responsible">
              <input name="owner" className={inputClass} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From">
              <input type="date" name="date_from" defaultValue={fy.from} className={inputClass} />
            </Field>
            <Field label="To">
              <input type="date" name="date_to" defaultValue={fy.to} className={inputClass} />
            </Field>
          </div>

          <div>
            <div className="mb-2 text-[12px] font-bold text-ink-muted">Lines</div>
            {/*
              A grid with a header row rather than eight repeated <Field>
              labels. On the old side-panel version each line was a stack of
              three controls with no column headings, so which box was the
              amount was something you worked out by typing in it.
            */}
            <div className="hidden gap-2 pb-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint sm:grid sm:grid-cols-[1fr_150px_1fr]">
              <span>Account</span>
              <span className="text-right">Planned</span>
              <span>Analytic (optional)</span>
            </div>
            <div className="space-y-2">
              {Array.from({ length: LINES }, (_, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[1fr_150px_1fr]">
                  <select name="line_account" className={inputClass} defaultValue="">
                    <option value="">— account —</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                  <input name="line_planned" inputMode="decimal" placeholder="0.00"
                    className={`${inputClass} text-right`} />
                  <select name="line_analytic" className={inputClass} defaultValue="">
                    <option value="">— any analytic —</option>
                    {analytics.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[12px] text-ink-faint">
              Blank rows are ignored. Need more than {LINES}? Create a second budget for the same window.
            </p>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button className={btn.primary}>Create budget</button>
            <LinkButton href="/budgets">Cancel</LinkButton>
          </div>
        </form>
      </Card>
    </>
  );
}
