import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { listCommissions, commissionBasisLabel } from '@/server/accounting/expenses';
import { bookingOptions } from '@/server/options';
import { fmtDate, isoDate } from '@/lib/accounting';
import { bpsToPct } from '@/lib/money';
import { commissionAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, Money, Chip, StatTile, EmptyState, RefLink, Field, inputClass, btn,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Agent commissions — plan section 28.
 *
 * The BASIS is the decision worth making deliberately. Commission on revenue
 * rewards closing; commission on margin rewards closing PROFITABLY, and an
 * agency paying on revenue will watch its agents discount the trip away to hit
 * the number. Both are offered; the accounting is the same either way —
 * expense debited, payable credited — and the base is read from the ledger, so
 * a commission cannot be calculated on a figure the books do not support.
 */
export default async function CommissionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  const rows = await listCommissions(s.orgId);
  const bookings = await bookingOptions(s.orgId);
  const today = isoDate();

  const payable = rows.filter((r) => r.state === 'posted').reduce((sum, r) => sum + r.amount, 0);
  const draft = rows.filter((r) => r.state === 'draft').reduce((sum, r) => sum + r.amount, 0);

  return (
    <>
      <PageHeader
        title="Agent Commissions"
        subtitle="What each booking owes the agent who closed it."
        accent="var(--color-sec-settings)"
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile label="Posted and payable" value={payable} compact={false} />
        <StatTile label="Calculated, not posted" value={draft} compact={false}
          tone={draft ? 'warn' : 'neutral'} />
        <StatTile label="Commission records" value={String(rows.length)} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Card padded={false}>
          {rows.length === 0 ? (
            <EmptyState title="No commissions calculated yet." />
          ) : (
            <Table>
              <thead>
                <tr><Th>Agent</Th><Th>Booking</Th><Th>Basis</Th><Th align="right">Rate</Th>
                  <Th align="right">Base</Th><Th align="right">Commission</Th>
                  <Th>Due</Th><Th>State</Th><Th width="90px" /></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-canvas">
                    <Td><span className="font-semibold">{r.agent_name}</span></Td>
                    <Td>
                      {r.booking_ref
                        ? <RefLink href={`/bookings/${r.booking_id}`}>{r.booking_ref}</RefLink>
                        : <span className="text-ink-faint">—</span>}
                    </Td>
                    <Td><Chip state="draft" label={commissionBasisLabel(r.basis)} /></Td>
                    <Td align="right"><span className="num">{r.rate_bps ? bpsToPct(r.rate_bps) : 'fixed'}</span></Td>
                    <Td align="right"><Money value={r.base_amount} /></Td>
                    <Td align="right"><Money value={r.amount} bold dash={false} /></Td>
                    <Td>{fmtDate(r.due_date)}</Td>
                    <Td><Chip state={r.state} /></Td>
                    <Td>
                      {r.state === 'draft' && (
                        <form action={commissionAction}>
                          <input type="hidden" name="action" value="post" />
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="date" value={today} />
                          <button className="text-[12px] font-bold text-brand hover:underline">Post</button>
                        </form>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title="Calculate a commission">
          <form action={commissionAction} className="space-y-3">
            <input type="hidden" name="action" value="create" />
            <Field label="Agent"><input name="agent_name" required className={inputClass} /></Field>
            <Field label="Booking">
              <select name="booking_id" required className={inputClass}>
                <option value="">Choose…</option>
                {bookings.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </Field>
            <Field label="Basis"
              hint="Profit is revenue less every cost tagged to the trip — the same figure Trip Profitability shows. It rewards selling profitably; revenue rewards volume.">
              <select name="basis" className={inputClass} defaultValue="revenue">
                <option value="revenue">Revenue from the trip</option>
                <option value="profit">Profit from the trip</option>
              </select>
            </Field>
            <Field label="Rate %">
              <input name="rate" inputMode="decimal" defaultValue="5" className={`${inputClass} text-right`} />
            </Field>
            <Field label="…or a fixed amount" hint="A fixed amount overrides the percentage.">
              <input name="fixed_amount" inputMode="decimal" className={`${inputClass} text-right`} />
            </Field>
            <Field label="Payable on">
              <input type="date" name="due_date" className={inputClass} />
            </Field>
            <button className={`${btn.primary} w-full`}>Calculate</button>
          </form>
          <p className="mt-3 text-[12px] text-ink-faint">
            The base is read from the trip&rsquo;s analytic account, so a commission is only ever
            calculated on what the ledger has actually recognised. A trip whose supplier bills are
            not in yet will show a profit that is too high, and a commission on it will be too.
          </p>
        </Card>
      </div>
    </>
  );
}
