import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { one, resolveRange, type SearchParams } from '@/lib/range';
import { tripProfitability, saleProfitability, batchProfitability } from '@/server/accounting/analytics';
import { fmt } from '@/lib/money';
import { fmtDate } from '@/lib/accounting';
import { RangeBar } from '@/components/RangeBar';
import { PageHeader, Card, Table, Th, Td, Money, StatTile, EmptyState, Bar, Chip, Banner } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Profitability — plan section 23.
 *
 * ===========================================================================
 * TWO UNITS, BECAUSE TRAVEL AGENCIES ARE RUN TWO WAYS
 * ===========================================================================
 * BY TRIP, which is the analytic version and the stronger of the two: costs
 * are tagged to a booking's analytic account, and the margin is the SAME
 * journal entry lines sliced by that tag. It reconciles to the P&L rather than
 * approximating it, and it handles a cost shared across two departures.
 *
 * BY SALE, which is the one most agencies can actually use. A trip here is a
 * `bookings` row, and a booking is created only for a CRM lead that carried a
 * package number — so an agency whose leads do not carry one has no bookings,
 * no trip analytic accounts, no analytic distributions, and this page was
 * permanently, silently empty for them however much they had invoiced and
 * spent. That is not something the report could fix: the unit it reported on
 * was absent from the data.
 *
 * The INVOICE is never absent. The agency raised it, which is why the costs
 * exist, so every cost record can name it — a vendor bill, an expense claim,
 * an agent commission — and profit is revenue less the three.
 *
 * NOTHING IS COUNTED TWICE ON THIS PAGE. A sale attached to a trip is already
 * inside the trip's margin above, so the sales table lists only the sales that
 * are NOT, and the KPI tiles add the two disjoint sets.
 */
export default async function TripsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const range = resolveRange(
    { range: await one(params, 'range'), from: await one(params, 'from'), to: await one(params, 'to') }, s.fyStartMonth,
  );
  const trips = await tripProfitability(s.orgId, range);
  const allSales = await saleProfitability(s.orgId, range);
  const batches = await batchProfitability(s.orgId, range);
  /*
   * ONLY THE SALES NOT ALREADY IN A TRIP'S MARGIN. An invoice tagged to a
   * booking has its revenue and its costs inside the analytic figures above;
   * listing it again below and adding both into one total would report the
   * agency's turnover twice.
   */
  const sales = allSales.filter((x) => !x.booking_id);

  const tripRevenue = trips.reduce((sum, t) => sum + t.revenue, 0);
  const tripCost = trips.reduce((sum, t) => sum + t.cost, 0);
  const saleRevenue = sales.reduce((sum, x) => sum + x.revenue, 0);
  const saleCost = sales.reduce((sum, x) => sum + x.cost, 0);
  const revenue = tripRevenue + saleRevenue;
  const cost = tripCost + saleCost;
  const profit = revenue - cost;

  const peakTrip = Math.max(1, ...trips.map((t) => t.revenue));
  const peakSale = Math.max(1, ...sales.map((x) => x.revenue));
  const thin = [
    ...trips.filter((t) => t.margin < 10 && t.revenue > 0),
    ...sales.filter((x) => x.margin < 10 && x.revenue > 0),
  ];
  /*
   * A SALE WITH NO COST AGAINST IT IS THE ONE WORTH NAMING.
   *
   * It reports a 100% margin, which is almost never true — it is a package
   * whose supplier bills have not been recorded, or have been recorded without
   * naming the sale. Left unflagged it quietly inflates every total on this
   * page, and it is the single most likely reason a figure here looks wrong.
   */
  const uncosted = sales.filter((x) => x.revenue > 0 && x.cost === 0 && x.draft_cost === 0);
  const pending = sales.reduce((sum, x) => sum + x.draft_cost, 0);

  return (
    <>
      <PageHeader
        title="Profitability"
        subtitle="What each trip and each sale earned against what it cost to deliver — straight from the ledger."
        accent="var(--color-sec-analytics)"
      />
      <RangeBar action="/analytics/trips" range={range} />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Revenue" value={revenue} />
        <StatTile label="Cost of delivery" value={cost} />
        <StatTile label="Gross profit" value={profit} tone={profit >= 0 ? 'positive' : 'negative'} />
        <StatTile label="Thin margins" value={String(thin.length)}
          tone={thin.length ? 'warn' : 'positive'} hint="Under 10% margin" />
      </div>

      {pending > 0 && (
        <Banner tone="info">
          {fmt(pending)} of costs is recorded against these sales but not posted, so it is not in
          any margin below. Post the bills and claims and every figure here moves with them.
        </Banner>
      )}

      {uncosted.length > 0 && (
        <Banner tone="warn">
          {uncosted.length} sale{uncosted.length === 1 ? ' has' : 's have'} no cost recorded against
          {uncosted.length === 1 ? ' it' : ' them'} at all, so {uncosted.length === 1 ? 'it shows' : 'they show'}{' '}
          a 100% margin and the totals above are overstated by whatever was actually spent. A cost
          reaches a sale by naming that sale on the vendor bill, the expense claim or the
          commission — the field is on all three forms.
        </Banner>
      )}

      {/*
        TRIPS FIRST WHERE THERE ARE ANY, because the analytic margin is the
        stronger statement: it is the general ledger sliced, not documents
        added up, so it holds for a cost split across two departures. The
        whole card is dropped rather than shown empty for an agency that does
        not work in bookings — an empty table it can never fill is the thing
        that sent somebody looking for a bug in the first place.
      */}
      {trips.length > 0 && (
        <Card title="By trip" padded={false} className="mb-5"
          subtitle="Thinnest margin first — a trip losing money is worth more attention than one making it. Click a trip to download it in full: every invoice, bill, staff claim, commission and GL line behind the margin.">
          <Table>
            <thead>
              <tr>
                <Th>Trip</Th><Th>Booking</Th>
                <Th align="right">Revenue</Th><Th align="right">Cost</Th>
                <Th align="right">Profit</Th><Th align="right">Margin</Th><Th width="160px">Share</Th>
              </tr>
            </thead>
            <tbody>
              {[...trips].sort((a, b) => a.margin - b.margin).map((t) => (
                <tr key={t.analytic_id} className="hover:bg-canvas">
                  <Td>
                    {/*
                      A plain <a>, not a <Link>: the href is a download route,
                      and a client-side navigation to one leaves the router
                      waiting on a response it can never render.
                    */}
                    <a href={`/api/exports/trip/${t.analytic_id}`}
                      className="font-semibold text-brand hover:underline"
                      title="Download this trip in full — revenue, costs, GST, commissions and every ledger line">
                      {t.name}
                    </a>
                  </Td>
                  <Td>
                    {t.booking_id
                      ? <Link href={`/bookings/${t.booking_id}`} className="font-bold text-brand hover:underline">
                        {t.booking_ref}
                      </Link>
                      : <span className="text-ink-faint">—</span>}
                  </Td>
                  <Td align="right"><Money value={t.revenue} /></Td>
                  <Td align="right"><Money value={t.cost} /></Td>
                  <Td align="right">
                    <span className={`num font-bold ${t.profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                      {fmt(t.profit)}
                    </span>
                  </Td>
                  <Td align="right">
                    <span className={`num font-bold ${t.margin < 10 ? 'text-negative' : ''}`}>
                      {t.margin.toFixed(1)}%
                    </span>
                  </Td>
                  <Td><Bar value={t.revenue} max={peakTrip} color="var(--color-sec-analytics)" /></Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-brand-soft">
                <Td colSpan={2}><span className="font-extrabold">Trips</span></Td>
                <Td align="right"><Money value={tripRevenue} bold dash={false} /></Td>
                <Td align="right"><Money value={tripCost} bold dash={false} /></Td>
                <Td align="right"><Money value={tripRevenue - tripCost} bold dash={false} /></Td>
                <Td align="right">
                  <span className="num font-extrabold">
                    {tripRevenue ? (((tripRevenue - tripCost) / tripRevenue) * 100).toFixed(1) : '0.0'}%
                  </span>
                </Td>
                <Td />
              </tr>
            </tfoot>
          </Table>
        </Card>
      )}

      <Card
        title={trips.length > 0 ? 'By invoice (not attached to a trip)' : 'By invoice'}
        padded={false}
        className="mb-5"
        subtitle="One row per customer invoice: what it was sold for, less every vendor bill, staff claim and agent commission recorded against it. Net of GST on both sides — output tax is collected for the government and input tax is reclaimed, so neither is a margin."
      >
        {sales.length === 0 ? (
          <EmptyState
            title="No sales in this window."
            hint="Raise a customer invoice, then name it on the vendor bills, expense claims and commissions you record against it. The margin appears here."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Invoice</Th><Th>Customer</Th><Th>Date</Th>
                <Th align="right">Revenue</Th>
                <Th align="right">Bills</Th><Th align="right">Claims</Th><Th align="right">Commission</Th>
                <Th align="right">Profit</Th><Th align="right">Margin</Th><Th width="140px">Share</Th><Th>Export</Th>
              </tr>
            </thead>
            <tbody>
              {[...sales].sort((a, b) => a.margin - b.margin).map((x) => (
                <tr key={x.document_id} className="hover:bg-canvas">
                  <Td>
                    <Link href={`/sales/invoices/${x.document_id}`}
                      className="font-semibold text-brand hover:underline">
                      {x.number ?? x.crm_number ?? '(draft)'}
                    </Link>
                    {x.state !== 'posted' && <span className="ml-2"><Chip state={x.state} /></span>}
                  </Td>
                  <Td><span className="text-ink-muted">{x.partner_name}</span></Td>
                  <Td><span className="num !text-left">{fmtDate(x.doc_date)}</span></Td>
                  <Td align="right"><Money value={x.revenue} /></Td>
                  <Td align="right"><Money value={x.bill_cost} /></Td>
                  <Td align="right"><Money value={x.expense_cost} /></Td>
                  <Td align="right"><Money value={x.commission_cost} /></Td>
                  <Td align="right">
                    <span className={`num font-bold ${x.profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                      {fmt(x.profit)}
                    </span>
                  </Td>
                  <Td align="right">
                    <span className={`num font-bold ${x.margin < 10 && x.revenue > 0 ? 'text-negative' : ''}`}>
                      {x.revenue ? `${x.margin.toFixed(1)}%` : '—'}
                    </span>
                  </Td>
                  <Td><Bar value={x.revenue} max={peakSale} color="var(--color-sec-analytics)" /></Td>
                  <Td>
                    {/* A download, not a client-side navigation — same reasoning as the trip export link above. */}
                    <a href={`/api/exports/sale/${x.document_id}`}
                      className="font-semibold text-brand hover:underline"
                      title="Download this invoice's margin in full — revenue, bills, claims and commission">
                      Excel
                    </a>
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-brand-soft">
                <Td colSpan={3}><span className="font-extrabold">Sales</span></Td>
                <Td align="right"><Money value={saleRevenue} bold dash={false} /></Td>
                <Td align="right">
                  <Money value={sales.reduce((t, x) => t + x.bill_cost, 0)} bold dash={false} />
                </Td>
                <Td align="right">
                  <Money value={sales.reduce((t, x) => t + x.expense_cost, 0)} bold dash={false} />
                </Td>
                <Td align="right">
                  <Money value={sales.reduce((t, x) => t + x.commission_cost, 0)} bold dash={false} />
                </Td>
                <Td align="right"><Money value={saleRevenue - saleCost} bold dash={false} /></Td>
                <Td align="right">
                  <span className="num font-extrabold">
                    {saleRevenue ? (((saleRevenue - saleCost) / saleRevenue) * 100).toFixed(1) : '0.0'}%
                  </span>
                </Td>
                <Td /><Td />
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>

      {/*
        BY BATCH — A DIFFERENT CUT OF THE SAME LINKS "BY INVOICE" READS,
        GROUPED ACROSS EVERY INVOICE RAISED AGAINST ONE DEPARTURE.

        Not nested inside the table above and not added into its totals: a
        batch's revenue is the sum of several of those very invoice rows, so
        counting both into one KPI would double the agency's own turnover. The
        card is shown only when at least one document has been tagged to a
        batch, same discipline as the Trips card above.
      */}
      {batches.length > 0 && (
        <Card
          title="By batch"
          padded={false}
          subtitle="One row per TripzoCRM departure: every invoice raised against it, less every vendor bill, staff claim and agent commission tagged to the batch or to one of its invoices. These rupees already appear in the invoice rows above — this is the same links, added up a different way."
        >
          <Table>
            <thead>
              <tr>
                <Th>Batch</Th><Th align="right">Invoices</Th>
                <Th align="right">Revenue</Th>
                <Th align="right">Bills</Th><Th align="right">Claims</Th><Th align="right">Commission</Th>
                <Th align="right">Profit</Th><Th align="right">Margin</Th><Th width="140px">Share</Th><Th>Export</Th>
              </tr>
            </thead>
            <tbody>
              {[...batches].sort((a, b) => a.margin - b.margin).map((x) => (
                <tr key={x.crm_batch_id} className="hover:bg-canvas">
                  <Td><span className="font-semibold">{x.batch_name ?? x.crm_batch_id}</span></Td>
                  <Td align="right"><span className="num">{x.invoices}</span></Td>
                  <Td align="right"><Money value={x.revenue} /></Td>
                  <Td align="right"><Money value={x.bill_cost} /></Td>
                  <Td align="right"><Money value={x.expense_cost} /></Td>
                  <Td align="right"><Money value={x.commission_cost} /></Td>
                  <Td align="right">
                    <span className={`num font-bold ${x.profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                      {fmt(x.profit)}
                    </span>
                  </Td>
                  <Td align="right">
                    <span className={`num font-bold ${x.margin < 10 && x.revenue > 0 ? 'text-negative' : ''}`}>
                      {x.revenue ? `${x.margin.toFixed(1)}%` : '—'}
                    </span>
                  </Td>
                  <Td><Bar value={x.revenue} max={Math.max(1, ...batches.map((b) => b.revenue))} color="var(--color-sec-analytics)" /></Td>
                  <Td>
                    <a href={`/api/exports/batch/${x.crm_batch_id}`}
                      className="font-semibold text-brand hover:underline"
                      title="Download this batch in full — every invoice, bill, staff claim and commission behind the margin">
                      Excel
                    </a>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
