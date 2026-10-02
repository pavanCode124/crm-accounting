import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { one, msg, type SearchParams } from '@/lib/range';
import { fmtDate } from '@/lib/accounting';
import { listSettlements, settlementAccountsReady } from '@/server/accounting/settlements';
import {
  PageHeader, Card, Banner, Table, Th, Td, Money, Chip, EmptyState, LinkButton, RefLink,
  inputClass, btn,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Channel payout cycles.
 *
 * WHAT THIS SCREEN IS FOR. An agency selling through OTAs and marketplaces
 * receives one net credit per channel per cycle, with a statement behind it,
 * and the question is always the same: does the statement agree with our books.
 * The list is therefore arranged around the three figures that answer it — what
 * the channel collected, what it kept, and what reached the bank — rather than
 * around the dates, which is what a generic transaction list would show.
 */
export default async function SettlementsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const m = await msg(params);
  const state = await one(params, 'state');

  const settlements = await listSettlements(s.orgId, { state });
  const ready = await settlementAccountsReady(s.orgId);

  const totals = settlements.reduce((t, x) => ({
    payable: t.payable + x.customer_payable,
    deductions: t.deductions + x.deductions,
    net: t.net + x.net_payout,
  }), { payable: 0, deductions: 0, net: 0 });

  return (
    <>
      <PageHeader
        title="Channel Settlements"
        subtitle="What an OTA or a marketplace collected on the agency's behalf, what it kept, and what it paid out."
        accent="var(--color-sec-sales)"
        actions={<LinkButton href="/settlements/new" variant="primary">+ New Cycle</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      {/*
        SAID BEFORE THE FIRST CYCLE IS DRAFTED, not at the moment it is posted.
        Posting a settlement reaches for six accounts — commission, shipping,
        other charges, recoveries, TCS and TDS receivable. An agency that set
        none of them finds out from a `requireSetting` error after filling in a
        month of figures, which is the worst possible time to discover it.
      */}
      {!ready && (
        <Banner tone="warn">
          The channel-charge accounts are not all configured, so a cycle can be drafted here but not
          posted. Set them under <Link href="/settings/accounts" className="underline">Settings → Default Accounts</Link>.
        </Banner>
      )}

      <form method="get" action="/settlements"
        className="no-print mb-5 flex flex-wrap items-end gap-2 rounded-card border border-line bg-surface px-4 py-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">State</span>
          <select name="state" defaultValue={state ?? ''} className={`${inputClass} w-[160px]`}>
            <option value="">All</option>
            <option value="draft">Draft</option>
            <option value="posted">Posted</option>
            <option value="cancelled">Reversed</option>
          </select>
        </label>
        <button className={btn.ghost}>Filter</button>
      </form>

      <Card padded={false}>
        {settlements.length === 0 ? (
          <EmptyState
            title="No settlement cycles yet."
            hint="Draft one for a channel and a date window; the invoices it covers are pulled from the ledger, the charges are entered against them, and posting books the commission, the GST and the tax withheld in a single balanced entry."
            action={<Link href="/settlements/new" className={btn.primary}>Draft a cycle</Link>}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th width="130px">Number</Th>
                <Th>Channel</Th>
                <Th width="190px">Cycle</Th>
                <Th align="right" width="80px">Orders</Th>
                <Th align="right" width="140px">Collected</Th>
                <Th align="right" width="130px">Deductions</Th>
                <Th align="right" width="140px">Net payout</Th>
                <Th width="150px">UTR</Th>
                <Th width="110px">Status</Th>
                <Th width="80px" />
              </tr>
            </thead>
            <tbody>
              {settlements.map((x) => (
                <tr key={x.id} className="hover:bg-canvas">
                  <Td>
                    <RefLink href={`/settlements/${x.id}`}>{x.number ?? 'Draft'}</RefLink>
                    {x.pay_date && <div className="text-[11.5px] text-ink-faint">{fmtDate(x.pay_date)}</div>}
                  </Td>
                  <Td>
                    <Link href={`/settlements/${x.id}`} className="font-semibold hover:underline">
                      {x.partner_name}
                    </Link>
                  </Td>
                  <Td><span className="text-ink-muted">{fmtDate(x.cycle_from)} – {fmtDate(x.cycle_to)}</span></Td>
                  <Td align="right"><span className="num">{x.orders ?? 0}</span></Td>
                  <Td align="right"><Money value={x.customer_payable} dash={false} /></Td>
                  <Td align="right"><Money value={-x.deductions} /></Td>
                  <Td align="right"><Money value={x.net_payout} bold dash={false} /></Td>
                  <Td><span className="num !text-left text-ink-muted">{x.utr ?? '—'}</span></Td>
                  <Td><Chip state={x.state} label={x.state === 'cancelled' ? 'Reversed' : undefined} /></Td>
                  <Td align="right">
                    {/* The export is the point of the record for most readers,
                        so it is reachable from the list and not only from the
                        cycle itself. */}
                    <a href={`/api/exports/settlement/${x.id}`}
                      className="text-[12px] font-bold text-brand hover:underline"
                      title="Download this cycle as the three-sheet payout statement">
                      Excel
                    </a>
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-canvas">
                <Td colSpan={4}><span className="font-bold">{settlements.length} cycle(s)</span></Td>
                <Td align="right"><Money value={totals.payable} bold dash={false} /></Td>
                <Td align="right"><Money value={-totals.deductions} bold /></Td>
                <Td align="right"><Money value={totals.net} bold dash={false} /></Td>
                <Td colSpan={3} />
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>
    </>
  );
}
