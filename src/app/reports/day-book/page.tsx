import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { one, resolveRange, type SearchParams } from '@/lib/range';
import { dayBook } from '@/server/accounting/books';
import { listJournals } from '@/server/accounting/masters';
import { fmtDate, titleise } from '@/lib/accounting';
import { RangeBar } from '@/components/RangeBar';
import {
  PageHeader, Card, Table, Th, Td, Money, Chip, EmptyState, RefLink, StatTile, inputClass, btn,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The Day Book — the journal register, in journal-entry form.
 *
 * WHY THIS IS NOT THE GENERAL LEDGER. The GL is a flat list of LINES: correct,
 * filterable, and impossible to read a transaction out of, because the two
 * halves of one entry may be forty rows apart. The Day Book is grouped by
 * ENTRY, so each transaction appears as it was written — every debit, then
 * every credit, then the narration underneath.
 *
 * The indented credit rows and the "To" prefix are the convention every
 * accounting text uses (Tulsian, ch. 4; and the same form in Piper's "Financial
 * Accounting for Decision Makers"): debits flush left, credits indented and
 * prefixed, so the shape of an entry is legible before a single figure is read.
 */
export default async function DayBookPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const range = resolveRange(
    { range: await one(params, 'range'), from: await one(params, 'from'), to: await one(params, 'to') }, s.fyStartMonth,
  );
  const journalId = await one(params, 'journal');

  const entries = await dayBook(s.orgId, range, { journalId, limit: 400 });
  const journals = await listJournals(s.orgId);
  const debit = entries.reduce((sum, e) => sum + e.debit, 0);
  const credit = entries.reduce((sum, e) => sum + e.credit, 0);

  return (
    <>
      <PageHeader
        title="Day Book"
        subtitle={`${fmtDate(range.from)} to ${fmtDate(range.to)} · every posted transaction, as a journal entry`}
        accent="var(--color-sec-reports)"
      />

      <RangeBar action="/reports/day-book" range={range} extra={{ journal: journalId }} />

      <form method="get"
        className="no-print mb-5 flex flex-wrap items-end gap-2 rounded-card border border-line bg-surface px-4 py-3">
        <input type="hidden" name="range" value={range.key} />
        <input type="hidden" name="from" value={range.from} />
        <input type="hidden" name="to" value={range.to} />
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">Journal</span>
          <select name="journal" defaultValue={journalId ?? ''} className={`${inputClass} w-[240px]`}>
            <option value="">All journals</option>
            {journals.map((j) => <option key={j.id} value={j.id}>{j.code} — {j.name}</option>)}
          </select>
        </label>
        <button className={btn.ghost}>Filter</button>
        <Link href="/reports/day-book" className={btn.ghost}>Clear</Link>
      </form>

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile label="Transactions" value={String(entries.length)} />
        <StatTile label="Total debits" value={debit} compact={false} />
        <StatTile label="Total credits" value={credit} compact={false} />
      </div>

      <Card padded={false}>
        {entries.length === 0 ? (
          <EmptyState title="No transactions in this window."
            hint="Widen the date range, or clear the journal filter." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th width="105px">Date</Th>
                <Th width="130px">Entry</Th>
                <Th>Particulars</Th>
                <Th width="80px">L.F.</Th>
                <Th align="right" width="130px">Debit</Th>
                <Th align="right" width="130px">Credit</Th>
              </tr>
            </thead>
            {/*
              One <tbody> per entry rather than one long body. It groups the
              rows semantically, and it is what lets the border below sit
              between TRANSACTIONS instead of between lines — the visual rule
              a hand-written day book draws under each completed entry.
            */}
            {entries.map((e) => {
              const debits = e.lines.filter((l) => l.debit > 0);
              const credits = e.lines.filter((l) => l.credit > 0);
              const rows = [...debits, ...credits];
              return (
                <tbody key={e.id} className="border-b-[3px] border-line">
                  {rows.map((l, i) => {
                    const isCredit = l.credit > 0;
                    return (
                      <tr key={l.id} className="hover:bg-canvas">
                        {/* Date and entry number are written once, on the first
                            line of the entry, exactly as in a bound day book. */}
                        <Td>{i === 0 ? fmtDate(e.entry_date) : ''}</Td>
                        <Td>
                          {i === 0 && (
                            <RefLink href={`/accounting/entries/${e.id}`}>{e.entry_no ?? 'Draft'}</RefLink>
                          )}
                        </Td>
                        <Td>
                          <span className={isCredit ? 'pl-8' : ''}>
                            {isCredit && <span className="text-ink-faint">To </span>}
                            <Link href={`/reports/ledger-account?account=${l.account_id}&from=${range.from}&to=${range.to}`}
                              className="font-semibold text-brand hover:underline">
                              {l.account_name}
                            </Link>
                            {l.partner_name && (
                              <span className="text-ink-muted"> — {l.partner_name}</span>
                            )}
                            {l.label && (
                              <span className="block text-[12px] text-ink-faint">{l.label}</span>
                            )}
                          </span>
                        </Td>
                        {/* Ledger Folio: the account code. The column an
                            accountant uses to jump from the day book to the
                            ledger, and here it is also the link that does it. */}
                        <Td><span className="num !text-left text-[12.5px] text-ink-muted">{l.account_code}</span></Td>
                        <Td align="right"><Money value={l.debit} /></Td>
                        <Td align="right"><Money value={l.credit} /></Td>
                      </tr>
                    );
                  })}
                  <tr className="bg-canvas">
                    <Td />
                    <Td />
                    <Td colSpan={2}>
                      <span className="text-[12.5px] italic text-ink-muted">
                        ({e.narration ?? e.reference ?? 'being the above transaction'})
                      </span>
                      <span className="ml-2 inline-flex items-center gap-1.5 align-middle">
                        <Chip state={e.state} />
                        <span className="text-[11.5px] text-ink-faint">
                          {e.journal_code} · {titleise(e.source_model ?? 'manual')}
                        </span>
                      </span>
                    </Td>
                    <Td align="right"><Money value={e.debit} bold dash={false} /></Td>
                    <Td align="right"><Money value={e.credit} bold dash={false} /></Td>
                  </tr>
                </tbody>
              );
            })}
            <tfoot>
              <tr className="bg-brand-soft">
                <Td colSpan={4}><span className="font-extrabold">Total for the period</span></Td>
                <Td align="right"><Money value={debit} bold dash={false} /></Td>
                <Td align="right"><Money value={credit} bold dash={false} /></Td>
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>

      {entries.length === 400 && (
        <p className="mt-3 text-[12.5px] text-ink-faint">
          Showing the first 400 transactions of this window. Narrow the range or pick a journal
          to see the rest.
        </p>
      )}
    </>
  );
}
