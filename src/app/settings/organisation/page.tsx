import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { getOrganisation, GST_STATES, stateName } from '@/server/accounting/organisation';
import { scalar } from '@/server/db';
import { can } from '@/lib/accounting';
import { saveOrganisationAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Field, inputClass, btn, DefList,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The agency's own record.
 *
 * -------------------------------------------------------------------------
 * THIS IS NOT A PROFILE PAGE
 * -------------------------------------------------------------------------
 * Three of these fields are posting inputs, not labels.
 *
 * STATE CODE is one half of the place-of-supply test. An Indian travel agency
 * invoicing a customer in its own state charges CGST+SGST and one outside it
 * charges IGST, and the comparison is made against this value. Wrong here
 * means every invoice carries the wrong tax, and it is found at the GST
 * return, not at the invoice.
 *
 * CURRENCY is the unit every stored amount is already in — the ledger holds
 * minor units with no currency beside them, by design. Changing it converts
 * nothing; it relabels. So the form refuses it once anything has posted.
 *
 * FISCAL YEAR START decides which year an entry belongs to, and the fiscal
 * years already carry opening balances and closing entries. It is editable
 * until the first year is opened and refused after.
 *
 * The refusals live in `updateOrganisation`, not here, because a disabled
 * field is a courtesy and a server action is a public endpoint.
 */
export default async function OrganisationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  const org = await getOrganisation(s.orgId);
  const mayConfigure = can(s.role, 'coa.configure');

  // What has already been committed decides which fields are still open. Shown
  // rather than merely enforced, so nobody fills a field that will be refused.
  const posted = await scalar("SELECT COUNT(*) FROM journal_entries WHERE org_id=? AND state='posted'", s.orgId);
  const years = await scalar('SELECT COUNT(*) FROM fiscal_years WHERE org_id=?', s.orgId);

  if (!org) return <Banner tone="error">No organisation record found.</Banner>;

  return (
    <>
      <PageHeader
        title="Agency Details"
        subtitle="What goes on an invoice, and what the tax engine compares against."
        accent="var(--color-sec-settings)"
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}
      {!mayConfigure && <Banner tone="info">Your role can read these but not change them.</Banner>}

      <form action={saveOrganisationAction} className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-5">
          <Card title="Identity">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Trading name" hint="What the product and the menus call the agency.">
                <input name="name" required defaultValue={org.name} disabled={!mayConfigure}
                  className={inputClass} />
              </Field>
              <Field label="Registered legal name" hint="Printed on the invoice when it differs.">
                <input name="legal_name" defaultValue={org.legal_name ?? ''} disabled={!mayConfigure}
                  className={inputClass} placeholder="Tripzo Holidays Private Limited" />
              </Field>
              <Field label="GSTIN" hint="15 characters. Its first two digits set the state below.">
                <input name="gstin" defaultValue={org.gstin ?? ''} disabled={!mayConfigure}
                  maxLength={15} className={`${inputClass} uppercase`} placeholder="27AABCT1234A1Z5" />
              </Field>
              <Field label="PAN">
                <input name="pan" defaultValue={org.pan ?? ''} disabled={!mayConfigure}
                  maxLength={10} className={`${inputClass} uppercase`} placeholder="AABCT1234A" />
              </Field>
              <Field label="State — place of supply" wide
                hint="Decides CGST+SGST against IGST on every invoice raised. Taken from the GSTIN when one is set.">
                <select name="state_code" defaultValue={org.state_code ?? ''} disabled={!mayConfigure}
                  className={inputClass}>
                  <option value="">— not set —</option>
                  {GST_STATES.map(([code, label]) => (
                    <option key={code} value={code}>{code} — {label}</option>
                  ))}
                </select>
              </Field>
            </div>
          </Card>

          <Card title="Contact & address" subtitle="Printed on invoices, bills and remittance advices.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Email">
                <input name="email" type="email" defaultValue={org.email ?? ''} disabled={!mayConfigure}
                  className={inputClass} placeholder="accounts@agency.com" />
              </Field>
              <Field label="Phone">
                <input name="phone" defaultValue={org.phone ?? ''} disabled={!mayConfigure}
                  className={inputClass} placeholder="+91 22 4000 1234" />
              </Field>
              <Field label="Website">
                <input name="website" defaultValue={org.website ?? ''} disabled={!mayConfigure}
                  className={inputClass} placeholder="https://agency.com" />
              </Field>
              <Field label="Country">
                <input name="country" defaultValue={org.country ?? 'IN'} disabled={!mayConfigure}
                  maxLength={2} className={`${inputClass} uppercase`} />
              </Field>
              {/* A FIELD, not the first line of the address. The payout
                  statement has a "Supply City" column, and splitting the
                  free-text address to find one produced "Road No. 12" —
                  confidently, on every row. */}
              <Field label="City" hint="Printed as the place of supply on a payout statement.">
                <input name="city" defaultValue={org.city ?? ''} disabled={!mayConfigure}
                  className={inputClass} placeholder="Hyderabad" />
              </Field>
              <Field label="Registered address" wide>
                <textarea name="address" rows={3} defaultValue={org.address ?? ''} disabled={!mayConfigure}
                  className={inputClass} />
              </Field>
            </div>
          </Card>

          <Card title="Invoice defaults"
            subtitle="What every document carries unless it says otherwise — the small print, and the code the taxman wants.">
            <div className="space-y-3">
              {/*
                THE LAST RESORT IN THE HSN CHAIN.

                Rule 46 requires an HSN (a SAC, for a service) on every invoice
                line, and no system can derive one — it is a classification the
                agency assigns and answers for. So it is asked once, here, and a
                line that is not a catalogued product, on an account with no code
                of its own, takes this.

                For a travel agency that is 998555, tour operator services, which
                is most of the book. A DEFAULT: copied onto the line and editable
                there, never read back at print time, so changing it cannot
                restate an invoice already issued.
              */}
              <Field label="Default HSN / SAC"
                hint="The agency's principal service code, for a line nothing more specific classifies. A product's own code wins, then the account's. 998555 is tour operator services.">
                <input name="default_hsn_code" defaultValue={org.default_hsn_code ?? ''}
                  disabled={!mayConfigure} inputMode="numeric" maxLength={8}
                  className={`${inputClass} sm:max-w-[200px]`} placeholder="998555" />
              </Field>
              <Field label="Terms & conditions">
                <textarea name="invoice_terms" rows={3} defaultValue={org.invoice_terms ?? ''}
                  disabled={!mayConfigure} className={inputClass}
                  placeholder="Cancellation within 15 days of travel attracts 50% of the package value." />
              </Field>
              <Field label="Footer">
                <input name="invoice_footer" defaultValue={org.invoice_footer ?? ''} disabled={!mayConfigure}
                  className={inputClass} placeholder="Subject to Mumbai jurisdiction" />
              </Field>
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Books"
            subtitle="Both of these are settled once the ledger starts moving, and the save says so.">
            <div className="space-y-3">
              <Field label="Company currency"
                hint={posted > 0
                  ? `Locked — ${posted} entr${posted === 1 ? 'y is' : 'ies are'} already posted in ${org.currency}.`
                  : 'Every amount is stored in this currency. Set it before the first posting.'}>
                <input name="currency" defaultValue={org.currency} maxLength={3}
                  disabled={!mayConfigure || posted > 0} className={`${inputClass} uppercase`} />
              </Field>
              <Field label="Fiscal year starts"
                hint={years > 0
                  ? `Locked — ${years} fiscal year(s) already run on ${MONTHS[org.fy_start_month - 1]}.`
                  : 'April for an Indian agency; January for most others.'}>
                <select name="fy_start_month" defaultValue={String(org.fy_start_month)}
                  disabled={!mayConfigure || years > 0} className={inputClass}>
                  {MONTHS.map((label, i) => <option key={label} value={i + 1}>{label}</option>)}
                </select>
              </Field>
            </div>
            {mayConfigure && <button className={`${btn.primary} mt-5 w-full`}>Save agency details</button>}
          </Card>

          <Card title="As it stands">
            <DefList rows={[
              ['Tenant id', <span key="id" className="num !text-left text-[12px]">{org.id}</span>],
              ['Place of supply', stateName(org.state_code) ?? 'Not set'],
              ['Posted entries', String(posted)],
              ['Fiscal years', String(years)],
              ['Signed in as', s.userName],
            ]} />
          </Card>
        </div>
      </form>
    </>
  );
}
