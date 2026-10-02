import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { isoDate, addDays, can } from '@/lib/accounting';
import { partnerOptions, bankAccountOptions } from '@/server/options';
import { saveSettlementAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Field, inputClass, btn, PartnerDatalist,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Draft a payout cycle.
 *
 * WHY THE RATES ARE ON THE CYCLE AND NOT ON THE CHANNEL.
 *
 * A commission percentage looks like a property of the channel, and storing it
 * there is the obvious design. It is wrong for the same reason a tax rate is
 * not stored on a customer: the rate CHANGES, and when it does, every statement
 * already reconciled under the old one has to keep reconciling. A rate held on
 * the channel is a rate that silently restates history the first time it is
 * renegotiated.
 *
 * Held on the cycle, each month carries the terms it was actually settled
 * under, the statement can be reproduced years later, and a renegotiation is
 * simply the next cycle's figures.
 */
export default async function NewSettlementPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);

  if (!can(s.role, 'payment.create')) {
    return (
      <>
        <PageHeader title="New settlement cycle" />
        <Banner tone="error">Your role cannot record payments, so it cannot draft a settlement.</Banner>
      </>
    );
  }

  const today = isoDate();
  // Defaults to the last fortnight, which is the cycle length most channels
  // remit on. It is a starting point, not a constraint — the dates are editable
  // and the pull simply reads whatever window is given.
  const from = addDays(today, -14);
  const customers = await partnerOptions(s.orgId, 'customer');
  const banks = await bankAccountOptions(s.orgId);

  return (
    <>
      <PageHeader
        title="New settlement cycle"
        subtitle="A channel, a date window, and the terms it settled under. The invoices are pulled from the ledger."
        accent="var(--color-sec-sales)"
        actions={<Link href="/settlements" className={btn.ghost}>Cancel</Link>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}

      <form action={saveSettlementAction} className="space-y-5">
        <Card title="The cycle">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {/* Typed, not chosen, like every other partner field in the
                product: a channel being settled for the first time should not
                have to be created as a customer beforehand. */}
            <Field label="Channel" hint="The OTA or marketplace that collected the money.">
              <input name="partner_name" list="channel-options" required autoComplete="off"
                placeholder="Who collected and remitted" className={inputClass} />
              <PartnerDatalist id="channel-options" options={customers} />
            </Field>
            <Field label="Cycle from">
              <input type="date" name="cycle_from" defaultValue={from} className={inputClass} />
            </Field>
            <Field label="Cycle to">
              <input type="date" name="cycle_to" defaultValue={today} className={inputClass} />
            </Field>
            <Field label="Payout date" hint="When the money reached the bank. Needed before posting.">
              <input type="date" name="pay_date" defaultValue={today} className={inputClass} />
            </Field>
            <Field label="Bank UTR" hint="The reference on the remittance, so the bank line can be matched.">
              <input name="utr" className={inputClass} placeholder="CMS5643191908" />
            </Field>
            <Field label="Paid into">
              <select name="bank_account_id" className={inputClass}>
                {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
          </div>
        </Card>

        <Card title="What the channel keeps"
          subtitle="Applied to every order in the cycle. The charges that are not per order — storage, advertising, a one-off note — are entered on the cycle once it exists.">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Commission %" hint="Of each order's gross.">
              <input name="commission_pct" inputMode="decimal" defaultValue="0"
                className={`${inputClass} text-right`} />
            </Field>
            <Field label="GST on the channel's charges %"
              hint="The rate the channel charges on its own fees. Claimed as input credit.">
              <input name="charge_gst_pct" inputMode="decimal" defaultValue="18"
                className={`${inputClass} text-right`} />
            </Field>
            <Field label="Shipping charge per delivered order">
              <input name="shipping_charge" inputMode="decimal" defaultValue="0"
                className={`${inputClass} text-right`} />
            </Field>
            <Field label="Return charge per returned order">
              <input name="return_charge" inputMode="decimal" defaultValue="0"
                className={`${inputClass} text-right`} />
            </Field>
            {/*
              TCS AND TDS ARE TAX, NOT CHARGES, and the hint says so because the
              distinction decides where they land. Booked as expenses they
              understate the profit and lose the set-off; booked as receivables
              — which is what this does — they are tax already paid that the
              agency claims at assessment.
            */}
            <Field label="TCS %" hint="Collected by the channel under 206C. Booked as tax receivable, not as a cost.">
              <input name="tcs_pct" inputMode="decimal" defaultValue="0"
                className={`${inputClass} text-right`} />
            </Field>
            <Field label="TDS %" hint="Withheld under 194-O. Also a receivable: it is income tax paid in advance.">
              <input name="tds_pct" inputMode="decimal" defaultValue="0"
                className={`${inputClass} text-right`} />
            </Field>
            <Field label="Unsettled from the previous cycle" wide
              hint="What the channel's last statement carried forward. Recorded for comparison only — it is already a receivable on the ledger, and posting this cycle must not book it twice.">
              <input name="previous_unsettled" inputMode="decimal" defaultValue="0"
                className={`${inputClass} text-right`} />
            </Field>
          </div>
        </Card>

        <Card title="Notes">
          <textarea name="note" rows={3} className={inputClass}
            placeholder="The channel's own statement reference, or anything the auditor should see." />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="submit" className={btn.primary}>Draft the cycle</button>
            <p className="text-[12.5px] text-ink-faint">
              Drafting moves nothing. The invoices in the window are pulled in, the figures are shown
              against them, and nothing reaches the ledger until the cycle is posted.
            </p>
          </div>
        </Card>
      </form>
    </>
  );
}
