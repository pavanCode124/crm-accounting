import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { listAnalyticPlans } from '@/server/accounting/masters';
import { listAnalyticAccounts } from '@/server/accounting/analytics';
import { can } from '@/lib/accounting';
import { saveAnalyticAction, archiveAnalyticAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, Field, inputClass, btn, EmptyState,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Branches, departments and agents.
 *
 * -------------------------------------------------------------------------
 * WHY THESE ARE ANALYTIC ACCOUNTS AND NOT A TEXT FIELD
 * -------------------------------------------------------------------------
 * A booking used to carry `branch` as free text. Free text means "Mumbai",
 * "mumbai", "Mum" and "Mumbai Br." are four branches to a GROUP BY and one
 * branch to the manager reading the report — so the branch P&L is wrong by
 * however many ways people spell a city, and nobody can tell by looking.
 *
 * As analytic accounts they are tagged ON THE GL LINE, which is what makes
 * "Mumbai made ₹4.2L" RECONCILE to the P&L rather than merely resemble it: the
 * figure is a sum of the same lines the P&L is built from, filtered, instead of
 * a parallel total somebody maintained.
 *
 * TRIPS IS NOT EDITABLE HERE. Its accounts are created with their booking, one
 * apiece, by `createBooking` — a trip typed in by hand would be an analytic
 * account with no booking behind it, which every travel report joins away to
 * nothing.
 */

const PLAN_NOTES: Record<string, string> = {
  BRANCH: 'Each office or city the agency sells from. Tagged on invoices, bills and expenses.',
  DEPT: 'Sales, Operations, Marketing — how operating costs are cut for the management P&L.',
  AGENT: 'Who sold the trip. Drives the agent performance report and the commission basis.',
  TRIPS: 'One per booking, created with the booking. Not edited here.',
};

export default async function DimensionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  const plans = (await listAnalyticPlans(s.orgId)).filter((p) => p.code !== 'TRIPS');
  const accounts = await listAnalyticAccounts(s.orgId);
  const mayConfigure = can(s.role, 'coa.configure');

  return (
    <>
      <PageHeader
        title="Branches, Departments & Agents"
        subtitle="The dimensions every posted amount can be cut by — and what the analytics reports group on."
        accent="var(--color-sec-settings)"
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="space-y-5">
        {plans.map((plan) => {
          const rows = accounts.filter((a) => a.plan_code === plan.code);
          return (
            <Card key={plan.id} title={plan.name} subtitle={PLAN_NOTES[plan.code]} padded={false}>
              <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
                <div>
                  {rows.length === 0 ? (
                    <EmptyState title={`No ${plan.name.toLowerCase()} yet.`} />
                  ) : (
                    <Table>
                      <thead><tr><Th>Code</Th><Th>Name</Th><Th /></tr></thead>
                      <tbody>
                        {rows.map((a) => (
                          <tr key={a.id} className="hover:bg-canvas">
                            <Td><span className="num !text-left font-bold">{a.code}</span></Td>
                            <Td><span className="font-semibold">{a.name}</span></Td>
                            <Td align="right">
                              {mayConfigure && (
                                <form action={archiveAnalyticAction}>
                                  <input type="hidden" name="id" value={a.id} />
                                  <button className="text-[12px] font-bold text-ink-faint hover:text-negative">
                                    Archive
                                  </button>
                                </form>
                              )}
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  )}
                </div>
                {mayConfigure && (
                  <form action={saveAnalyticAction} className="space-y-3 p-5">
                    <input type="hidden" name="plan_code" value={plan.code} />
                    <Field label="Code" hint="Short and stable — reports group on it.">
                      <input name="code" required className={`${inputClass} uppercase`}
                        placeholder={plan.code === 'BRANCH' ? 'BLR' : plan.code === 'DEPT' ? 'OPS' : 'AG-07'} />
                    </Field>
                    <Field label="Name">
                      <input name="name" required className={inputClass}
                        placeholder={plan.code === 'BRANCH' ? 'Bengaluru' : plan.code === 'DEPT' ? 'Operations' : 'Priya Nair'} />
                    </Field>
                    <button className={`${btn.ghost} w-full`}>Add to {plan.name}</button>
                  </form>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <p className="mt-5 text-[12.5px] text-ink-faint">
        Archiving is refused once posted lines are tagged to a dimension — removing it would change what
        every report that groups on it already says. Rename it instead if it has been superseded.
      </p>
    </>
  );
}
