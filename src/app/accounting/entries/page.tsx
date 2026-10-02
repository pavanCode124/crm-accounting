import { Fragment } from 'react';
import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { one, msg, resolveRange, type SearchParams } from '@/lib/range';
import { all } from '@/server/db';
import { listJournals } from '@/server/accounting/masters';
import { ledgerTotals } from '@/server/accounting/engine';
import { fmtDate, titleise } from '@/lib/accounting';
import { RangeBar } from '@/components/RangeBar';
import {
  PageHeader, Card, Banner, Table, Th, Td, Money, Chip, EmptyState, RefLink, LinkButton, StatTile, inputClass, btn,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Every journal entry, from every source — written the way a journal is written.
 *
 * The register shows the ENTRY and its LINES, not one amount per entry. A row
 * that prints a single total twice, once under Debit and once under Credit,
 * says nothing: on a balanced entry the two are equal by construction. What an
 * entry actually is, is the accounts it touched and the direction each was
 * touched in — the debited accounts first, then the credited ones prefixed
 * "To", then the narration. That is the form in every ledger and every
 * textbook, and it is the only form from which a reader can tell whether the
 * posting was right.
 *
 * The `source` link under each narration is the other half: an entry is never
 * just an entry, it is what an invoice, a payment, a depreciation run or a
 * person did. Rule 3 in reverse — from the ledger back to the document.
 */
export default async function EntriesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const m = await msg(params);
  const range = resolveRange(
    { range: await one(params, 'range'), from: await one(params, 'from'), to: await one(params, 'to') }, s.fyStartMonth,
  );
  // `one` maps an empty param to undefined, so "All journals" and the "All"
  // state arrive here as undefined and their guards drop out of the query.
  const journalId = await one(params, 'journal');
  const state = await one(params, 'state');

  const entries = await all<{
    id: string; entry_no: string | null; entry_date: string; reference: string | null;
    narration: string | null; state: string; journal_code: string; journal_name: string;
    source_model: string | null; source_id: string | null; debit: number; credit: number;
  }>(
    // The two totals are still fetched per entry, but only to prove the entry
    // balances — they are no longer what the row prints.
    `SELECT e.id, e.entry_no, e.entry_date, e.reference, e.narration, e.state,
            j.code AS journal_code, j.name AS journal_name, e.source_model, e.source_id,
            COALESCE((SELECT SUM(l.debit) FROM journal_entry_lines l WHERE l.entry_id = e.id),0) AS debit,
            COALESCE((SELECT SUM(l.credit) FROM journal_entry_lines l WHERE l.entry_id = e.id),0) AS credit
       FROM journal_entries e JOIN journals j ON j.id = e.journal_id
      WHERE e.org_id = ? AND e.entry_date BETWEEN ? AND ?
        AND (?::text IS NULL OR e.journal_id = ?) AND (?::text IS NULL OR e.state = ?)
      ORDER BY e.entry_date DESC, e.entry_no DESC LIMIT 100`,
    s.orgId, range.from, range.to, journalId ?? null, journalId ?? null, state ?? null, state ?? null,
  );

  // The lines for exactly the entries on screen, in one round trip rather than
  // one query per entry. Debits sort before credits within an entry because
  // that is the order a journal is read in: what was received, then what gave
  // it up.
  const lines = entries.length
    ? await all<{
      id: string; entry_id: string; account_id: string; account_code: string; account_name: string;
      partner_name: string | null; label: string | null; debit: number; credit: number;
    }>(
      `SELECT l.id, l.entry_id, l.account_id, a.code AS account_code, a.name AS account_name,
              p.name AS partner_name, l.label, l.debit, l.credit
         FROM journal_entry_lines l
         JOIN accounts a ON a.id = l.account_id
         LEFT JOIN partners p ON p.id = l.partner_id
        WHERE l.entry_id IN (${entries.map(() => '?').join(',')})
        ORDER BY l.entry_id, CASE WHEN l.debit > 0 THEN 0 ELSE 1 END, l.id`,
      ...entries.map((e) => e.id),
    )
    : [];

  const byEntry = new Map<string, typeof lines>();
  for (const l of lines) {
    const bucket = byEntry.get(l.entry_id);
    if (bucket) bucket.push(l); else byEntry.set(l.entry_id, [l]);
  }

  const proof = await ledgerTotals(s.orgId, range.from, range.to);
  const journals = await listJournals(s.orgId);

  // These total the entries on screen, which is NOT the same figure as `proof`
  // — that one is every posted line in the window, drafts excluded and no row
  // cap. The footer is labelled "listed entries" for exactly that reason.
  const listDebit = entries.reduce((sum, e) => sum + e.debit, 0);
  const listCredit = entries.reduce((sum, e) => sum + e.credit, 0);

  return (
    <>
      <PageHeader
        title="Journal Entries"
        subtitle="The ledger itself. Every balanced entry, and the document that caused it."
        accent="var(--color-sec-accounting)"
        actions={<LinkButton href="/accounting/entries/new" variant="primary">+ Manual Entry</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile label="Total debits" value={proof.debit} compact={false} />
        <StatTile label="Total credits" value={proof.credit} compact={false} />
        <StatTile label="Proof" value={proof.balanced ? 'Balanced' : 'Out of balance'}
          tone={proof.balanced ? 'positive' : 'negative'} hint="Debits less credits, over this window" />
      </div>

      <form method="get" className="no-print mb-5 flex flex-wrap items-end gap-2 rounded-card border border-line bg-surface px-4 py-3">
        <input type="hidden" name="range" value={range.key} />
        <input type="hidden" name="from" value={range.from} />
        <input type="hidden" name="to" value={range.to} />
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">Journal</span>
          <select name="journal" defaultValue={journalId ?? ''} className={`${inputClass} w-[220px]`}>
            <option value="">All journals</option>
            {journals.map((j) => <option key={j.id} value={j.id}>{j.code} — {j.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">State</span>
          <select name="state" defaultValue={state ?? ''} className={`${inputClass} w-[150px]`}>
            <option value="">All</option>
            <option value="draft">Draft</option>
            <option value="posted">Posted</option>
            <option value="reversed">Reversed</option>
          </select>
        </label>
        <button className={btn.ghost}>Filter</button>
      </form>

      <RangeBar action="/accounting/entries" range={range}
        extra={{ journal: journalId, state }} />

      <Card padded={false}>
        {entries.length === 0 ? (
          <EmptyState title="No entries in this window." />
        ) : (
          <Table>
            <thead>
              <tr><Th width="110px">Date</Th><Th width="150px">Entry</Th>
                <Th>Particulars</Th>
                <Th align="right" width="130px">Debit</Th>
                <Th align="right" width="130px">Credit</Th>
                <Th width="90px">State</Th></tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const own = byEntry.get(e.id) ?? [];
                // An entry with no lines should not exist, but a half-written
                // draft can be one, and it still has to be visible here.
                const rows: (typeof lines[number] | null)[] = own.length ? own : [null];
                // The narration row below the lines belongs to the same entry,
                // so the merged Date/Entry/State cells have to cover it too.
                const span = rows.length + 1;
                return (
                  <Fragment key={e.id}>
                    {rows.map((l, i) => (
                      <tr key={l?.id ?? e.id} className="hover:bg-canvas">
                        {i === 0 && <Td rowSpan={span}>{fmtDate(e.entry_date)}</Td>}
                        {i === 0 && (
                          <Td rowSpan={span}>
                            <RefLink href={`/accounting/entries/${e.id}`}>{e.entry_no ?? 'Draft'}</RefLink>
                            <div className="text-[12.5px] text-ink-muted">{e.journal_code}</div>
                          </Td>
                        )}
                        <Td>
                          {l === null ? <span className="text-ink-faint">No lines on this entry.</span> : (
                            // The credited account is indented and prefixed
                            // "To". The indent is not decoration: it is how a
                            // reader sees the direction of a posting at a glance.
                            <div className={l.credit > 0 ? 'pl-8' : ''}>
                              <span className="font-semibold">
                                {l.credit > 0 && <span className="text-ink-muted">To </span>}
                                {l.account_name}
                              </span>
                              <span className="ml-1.5 text-[12.5px] text-ink-muted">({l.account_code})</span>
                              {(l.partner_name || l.label) && (
                                <div className="text-[12.5px] text-ink-muted">
                                  {[l.partner_name, l.label].filter(Boolean).join(' · ')}
                                </div>
                              )}
                            </div>
                          )}
                        </Td>
                        <Td align="right">{l && l.debit > 0 ? <Money value={l.debit} dash={false} /> : null}</Td>
                        <Td align="right">{l && l.credit > 0 ? <Money value={l.credit} dash={false} /> : null}</Td>
                        {i === 0 && (
                          <Td rowSpan={span}>
                            <Chip state={e.state} />
                            {e.debit !== e.credit && (
                              <div className="mt-1"><Chip state="refused" label="Unbalanced" /></div>
                            )}
                          </Td>
                        )}
                      </tr>
                    ))}
                    <tr className="bg-canvas">
                      <Td colSpan={3}>
                        <span className="text-[12.5px] italic text-ink-muted">(Being {narration(e)})</span>
                        {e.source_model && e.source_id && (
                          <Link href={sourceHref(e.source_model, e.source_id)}
                            className="ml-2 text-[12.5px] font-bold text-brand hover:underline">
                            {titleise(e.source_model)} →
                          </Link>
                        )}
                      </Td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-brand-soft">
                <Td colSpan={3}><span className="font-extrabold">Totals (listed entries)</span></Td>
                <Td align="right"><Money value={listDebit} bold dash={false} /></Td>
                <Td align="right"><Money value={listCredit} bold dash={false} /></Td>
                <Td />
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>
    </>
  );
}

/**
 * The "(Being …)" line.
 *
 * A journal's narration is a sentence explaining the entry, and the stored
 * narration already reads as one. Where there is none the reference is the next
 * best thing a reader can act on, and the source model after that.
 */
function narration(e: { narration: string | null; reference: string | null; source_model: string | null }): string {
  return e.narration ?? e.reference ?? `${titleise(e.source_model ?? 'manual')} entry`;
}

/** Where an entry came from, as a link back to it. */
function sourceHref(model: string, id: string): string {
  switch (model) {
    case 'document': return `/d/${id}`;
    case 'payment': return `/sales/payments`;
    case 'expense': return `/expenses`;
    case 'asset': return `/assets`;
    case 'deferral': return `/assets`;
    case 'commission': return `/commissions`;
    case 'bank_transaction': return `/banking/reconcile`;
    default: return `/accounting/entries/${id}`;
  }
}
