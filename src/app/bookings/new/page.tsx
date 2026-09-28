import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { partnerOptions } from '@/server/options';
import { isoDate } from '@/lib/accounting';
import { createBookingAction } from '@/app/actions';
import { PageHeader, Card, Banner, Field, inputClass, btn, LinkButton } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function NewBookingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  const customers = await partnerOptions(s.orgId, 'customer');
  const today = isoDate();

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
              <select name="partner_id" className={inputClass} defaultValue="">
                <option value="">—</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="Destination">
              <input name="destination" className={inputClass} placeholder="Bali" />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Package">
              <input name="package_name" className={inputClass} />
            </Field>
            <Field label="Agent">
              <input name="agent_name" className={inputClass} />
            </Field>
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
