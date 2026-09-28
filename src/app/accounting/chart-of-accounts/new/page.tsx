import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { ACCOUNT_KINDS, kindLabel, type AccountKind } from '@/lib/accounting';
import { saveAccountAction } from '@/app/actions';
import { PageHeader, Card, Banner, Field, inputClass, btn, LinkButton } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Add an account, on a page of its own.
 *
 * WHY THIS IS NOT A CARD BESIDE THE TABLE ANY MORE. The chart of accounts is a
 * six-column table — code, name, type, nature, debit, credit — and it was being
 * asked to share the window with a form it has nothing to do with. The table
 * got two thirds of the width, the account names wrapped, and the form sat
 * there taking up a third of every visit whether or not anyone was adding an
 * account, which is almost never.
 *
 * The invoices screen already had the right answer: the list owns the full
 * width, a single button sits at the top right, and creating a thing is a page.
 * That is the pattern now, here and on every other master-data screen.
 */
export default async function NewAccountPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  ctx();
  const m = msg(await searchParams);

  // Grouped by statement group, because that is the decision the person filling
  // this in is actually making — an "expense" that lands on the balance sheet
  // is the single most expensive mistake available on this form.
  const kinds = Object.keys(ACCOUNT_KINDS) as AccountKind[];
  const groups = [...new Set(kinds.map((k) => ACCOUNT_KINDS[k].group))];

  return (
    <>
      <PageHeader
        title="New Account"
        subtitle="The type decides which statement it lands on, and how its balance is read."
        accent="var(--color-sec-accounting)"
        actions={<LinkButton href="/accounting/chart-of-accounts">Cancel</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}

      <Card className="max-w-2xl">
        <form action={saveAccountAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Code" hint="Four to six digits, following the ranges already in use.">
              <input name="code" required inputMode="numeric" className={inputClass} placeholder="512000" />
            </Field>
            <Field label="Name">
              <input name="name" required className={inputClass} placeholder="Visa & Permit Charges" />
            </Field>
          </div>

          <Field label="Type" hint="Assets and expenses are debit accounts; income, liabilities and equity are credit accounts.">
            <select name="kind" className={inputClass} defaultValue="expense_direct">
              {groups.map((g) => (
                <optgroup key={g} label={g.charAt(0).toUpperCase() + g.slice(1)}>
                  {kinds.filter((k) => ACCOUNT_KINDS[k].group === g).map((k) => (
                    <option key={k} value={k}>{kindLabel(k)}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>

          <Field label="Description">
            <input name="description" className={inputClass}
              placeholder="What belongs on this account, for whoever posts to it next." />
          </Field>

          <label className="flex items-start gap-2.5 rounded-[10px] border border-line px-3.5 py-3">
            <input type="checkbox" name="reconcilable" className="mt-0.5 h-4 w-4" />
            <span>
              <span className="block text-[13px] font-bold">Reconcilable</span>
              <span className="mt-0.5 block text-[12px] text-ink-faint">
                Tick it for receivables, payables and advances — accounts whose lines are matched off
                against each other rather than against a bank statement.
              </span>
            </span>
          </label>

          <div className="flex items-center gap-2 pt-1">
            <button className={btn.primary}>Create account</button>
            <LinkButton href="/accounting/chart-of-accounts">Cancel</LinkButton>
          </div>
        </form>
      </Card>
    </>
  );
}
