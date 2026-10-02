import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { isoDate } from '@/lib/accounting';
import { listAnalyticAccounts } from '@/server/accounting/analytics';
import { createBookingAction } from '@/app/actions';
import { PageHeader, Card, Banner, Field, inputClass, btn, LinkButton } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function NewBookingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  const today = isoDate();
  /*
   * Branch and agent are SUGGESTED from the configured dimensions rather than
   * typed blind. Free text made "Mumbai", "mumbai" and "Mum" three branches to
   * a GROUP BY and one branch to the manager reading the report. A datalist
   * keeps the field typable — a booking taken at a new desk should not wait on
   * an admin — while making the configured spelling the path of least effort,
   * which is what actually keeps the branch P&L from fragmenting.
   */
  const branches = await listAnalyticAccounts(s.orgId, 'BRANCH');
  const agents = await listAnalyticAccounts(s.orgId, 'AGENT');

  return (
    <>
      <PageHeader
        title="New Booking"
        subtitle="Its trip analytic account is created alongside it, which is what lets every invoice and bill line be tagged back to this trip."
        accent="var(--color-brand)"
        actions={<LinkButton href="/bookings">Cancel</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}

      <Card className="max-w-2xl">
        <form action={createBookingAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
            <Field label="Reference">
              <input name="ref" required className={inputClass} placeholder="BK-1028" />
            </Field>
            <Field label="Title">
              <input name="title" required className={inputClass} placeholder="Bali 5D/4N — Rahul" />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Customer">
              <input name="customer_name" className={inputClass} placeholder="Rahul Mehta" />
            </Field>
            <Field label="Destination">
              <input name="destination" className={inputClass} placeholder="Bali" />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Package">
              <input name="package_name" className={inputClass} />
            </Field>
            <Field label="Agent" hint="Drives the agent performance report and the commission basis.">
              <input name="agent_name" list="booking-agent-options" autoComplete="off" className={inputClass} />
              <datalist id="booking-agent-options">
                {agents.map((a) => <option key={a.id} value={a.name} />)}
              </datalist>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Branch" hint="Configured under Settings → Branches & Agents.">
              <input name="branch" list="booking-branch-options" autoComplete="off" className={inputClass} />
              <datalist id="booking-branch-options">
                {branches.map((b) => <option key={b.id} value={b.name} />)}
              </datalist>
            </Field>
            <div />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Pax">
              <input name="pax" defaultValue="2" inputMode="numeric" className={`${inputClass} text-right`} />
            </Field>
            <Field label="Quoted value"
              hint="What was sold. The invoice is what is owed — reports read the invoice, never this field.">
              <input name="sell_value" inputMode="decimal" className={`${inputClass} text-right`} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Departs">
              <input type="date" name="start_date" defaultValue={today} className={inputClass} />
            </Field>
            <Field label="Returns">
              <input type="date" name="end_date" className={inputClass} />
            </Field>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button className={btn.primary}>Create booking</button>
            <LinkButton href="/bookings">Cancel</LinkButton>
          </div>
        </form>
      </Card>
    </>
  );
}
