import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { one, resolveRange, type SearchParams } from '@/lib/range';
import { generalLedger } from '@/server/accounting/reports';
import { listAccounts, listJournals, listPartners } from '@/server/accounting/masters';
import { listAnalyticAccounts, listBookings } from '@/server/accounting/analytics';
import { fmtDate, titleise } from '@/lib/accounting';
import { fmt } from '@/lib/money';
import {
  PageHeader, Card, Table, Th, Td, Money, DrCrMoney, EmptyState, RefLink, inputClass, btn, StatTile,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * General Ledger — plan section 39.
 *
 * Every filter the plan asks for: account, date, journal, partner, booking and
 * analytic account. The running balance only means something when ONE account
 * is selected, so the column is shown then and suppressed otherwise rather
 * than printing a meaningless cumulative figure across unrelated accounts.
 */
export default async function GeneralLedgerPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const range = resolveRange(
    { range: await one(params, 'range'), from: await one(params, 'from'), to: await one(params, 'to') }, s.fyStartMonth,
  );
  const filters = {
    accountId: await one(params, 'account'),
    journalId: await one(params, 'journal'),
    partnerId: await one(params, 'partner'),
    bookingId: await one(params, 'booking'),
    analyticId: await one(params, 'analytic'),
  };

  const { lines, opening } = await generalLedger(s.orgId, { ...range, ...filters, limit: 2000 });
  const debit = lines.reduce((sum, l) => sum + l.debit, 0);
  const credit = lines.reduce((sum, l) => sum + l.credit, 0);
  const single = Boolean(filters.accountId);
  // Only meaningful when ONE account is selected — a cumulative figure across
  // unrelated accounts is arithmetic, not a balance.
  const closing = opening + debit - credit;

  const accounts = await listAccounts(s.orgId, { activeOnly: false });
  const journals = await listJournals(s.orgId);
  const partners = await listPartners(s.orgId);
  const analytics = await listAnalyticAccounts(s.orgId);
  const bookings = await listBookings(s.orgId, { limit: 200 });

  return (
    <>
      <PageHeader
        title="General Ledger"
        subtitle={`${fmtDate(range.from)} to ${fmtDate(range.to)} · every posted line, filtered`}
        accent="var(--color-sec-reports)"
      />

      <form method="get"
        className="no-print mb-5 grid gap-3 rounded-card border border-line bg-surface px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
        <Select name="account" label="Account" value={filters.accountId}
          options={accounts.map((a) => ({ id: a.id, label: `${a.code} ${a.name}` }))} />
        <Select name="journal" label="Journal" value={filters.journalId}
          options={journals.map((j) => ({ id: j.id, label: `${j.code} — ${j.name}` }))} />
        <Select name="partner" label="Partner" value={filters.partnerId}
          options={partners.map((p) => ({ id: p.id, label: p.name }))} />
        <Select name="analytic" label="Analytic" value={filters.analyticId}
          options={analytics.map((a) => ({ id: a.id, label: `${a.plan_name}: ${a.name}` }))} />
        <Select name="booking" label="Booking" value={filters.bookingId}
          options={bookings.map((b) => ({ id: b.id, label: `${b.ref} — ${b.title}` }))} />
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">From</span>
          <input type="date" name="from" defaultValue={range.from} className={inputClass} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">To</span>
          <input type="date" name="to" defaultValue={range.to} className={inputClass} />
        </label>
        <div className="flex items-end gap-2">
          <button className={btn.primary}>Apply</button>
          <Link href="/reports/general-ledger" className={btn.ghost}>Clear</Link>
        </div>
      </form>

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        {single && (
          <StatTile label="Opening balance" value={Math.abs(opening)} compact={false}
            hint={opening === 0 ? 'Nil' : opening > 0 ? 'Debit' : 'Credit'} />
        )}
        <StatTile label="Debits" value={debit} compact={false} />
        <StatTile label="Credits" value={credit} compact={false} />
        {single && (
          <StatTile label="Closing balance" value={Math.abs(opening + debit - credit)} compact={false}
            hint={closing === 0 ? 'Nil' : closing > 0 ? 'Debit' : 'Credit'} />
        )}
      </div>

      {/* An extract is a slice of the ledger, not the ledger: filter on one
          account or one partner and the two columns are not meant to agree.
          Said plainly, because two unequal totals with no explanation read
          like a broken report. */}
      {debit !== credit && lines.length > 0 && (
        <p className="mb-4 text-[13px] text-ink-muted">
          Debits and credits differ by <span className="num font-semibold">{fmt(Math.abs(debit - credit))}</span>.
          That is expected in a filtered extract — only the lines matching the filters above are counted,
          and the other side of those entries sits outside them. Clear the filters to see a ledger that balances.
        </p>
      )}

      <Card padded={false}>
        {lines.length === 0 ? (
          <EmptyState title="Nothing matches those filters."
            hint="Widen the date range, or clear a filter." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th width="105px">Date</Th><Th width="120px">Entry</Th><Th width="70px">Jnl</Th>
                {!single && <Th>Account</Th>}
                <Th>Partner</Th><Th>Narration</Th><Th>Source</Th>
                <Th align="right">Debit</Th><Th align="right">Credit</Th>
                {single && <Th align="right">Balance</Th>}
              </tr>
            </thead>
            <tbody>
              {single && (
                <tr className="bg-canvas">
                  <Td colSpan={8}><span className="font-bold">Opening balance b/f</span></Td>
                  <Td align="right"><DrCrMoney value={opening} bold /></Td>
                </tr>
              )}
              {lines.map((l) => (
                <tr key={l.id} className="hover:bg-canvas">
                  <Td>{fmtDate(l.entry_date)}</Td>
                  <Td><RefLink href={`/accounting/entries/${l.entry_id}`}>{l.entry_no}</RefLink></Td>
                  <Td><span className="text-ink-muted">{l.journal_code}</span></Td>
                  {!single && (
                    <Td>
                      <span className="num !text-left font-semibold">{l.account_code}</span>{' '}
                      <span className="text-ink-muted">{l.account_name}</span>
                    </Td>
                  )}
                  <Td><span className="text-ink-muted">{l.partner_name ?? '—'}</span></Td>
                  <Td><span className="text-ink-muted">{l.label ?? l.reference ?? '—'}</span></Td>
                  <Td>
                    {l.source_model === 'document' && l.source_id
                      ? <Link href={`/d/${l.source_id}`} className="text-[12.5px] font-bold text-brand hover:underline">
                        Document
                      </Link>
                      : <span className="text-[12.5px] text-ink-faint">{titleise(l.source_model ?? '—')}</span>}
                  </Td>
                  <Td align="right"><Money value={l.debit} /></Td>
                  <Td align="right"><Money value={l.credit} /></Td>
                  {single && <Td align="right"><DrCrMoney value={l.running ?? 0} /></Td>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-brand-soft">
                <Td colSpan={single ? 6 : 7}><span className="font-extrabold">Totals</span></Td>
                <Td align="right"><Money value={debit} bold dash={false} /></Td>
                <Td align="right"><Money value={credit} bold dash={false} /></Td>
                {single && (
                  <Td align="right"><DrCrMoney value={opening + debit - credit} bold /></Td>
                )}
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>
    </>
  );
}

function Select({ name, label, value, options }: {
  name: string; label: string; value?: string; options: Array<{ id: string; label: string }>;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">{label}</span>
      <select name={name} defaultValue={value ?? ''} className={inputClass}>
        <option value="">All</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  );
}
