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
 * Every journal entry, from every source.
 *
 * The `source` column is the point of this screen: an entry is never just an
 * entry, it is what an invoice, a payment, a depreciation run or a person did.
 * Rule 3 in reverse — from the ledger back to the document.
 */
export default async function EntriesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const params = await searchParams;
  const m = msg(params);
  const range = resolveRange(
    { range: one(params, 'range'), from: one(params, 'from'), to: one(params, 'to') }, s.fyStartMonth,
  );
  const journalId = one(params, 'journal');
  const state = one(params, 'state');

  const entries = all<{
    id: string; entry_no: string | null; entry_date: string; reference: string | null;
    narration: string | null; state: string; journal_code: string; journal_name: string;
    source_model: string | null; source_id: string | null; debit: number; credit: number;
  }>(
    // Both sides are fetched, not just one. On a posted entry they are equal and
    // the second column looks redundant — but a DRAFT entry is exactly where they
    // are not, and a register that prints a single "Amount" is the one place an
    // unbalanced draft can hide until someone tries to post it.
    `SELECT e.id, e.entry_no, e.entry_date, e.reference, e.narration, e.state,
            j.code AS journal_code, j.name AS journal_name, e.source_model, e.source_id,
            COALESCE((SELECT SUM(l.debit) FROM journal_entry_lines l WHERE l.entry_id = e.id),0) AS debit,
            COALESCE((SELECT SUM(l.credit) FROM journal_entry_lines l WHERE l.entry_id = e.id),0) AS credit
       FROM journal_entries e JOIN journals j ON j.id = e.journal_id
      WHERE e.org_id = ? AND e.entry_date BETWEEN ? AND ?
        AND (? IS NULL OR e.journal_id = ?) AND (? IS NULL OR e.state = ?)
      ORDER BY e.entry_date DESC, e.entry_no DESC LIMIT 300`,
    s.orgId, range.from, range.to, journalId ?? null, journalId ?? null, state ?? null, state ?? null,
  );

  const proof = ledgerTotals(s.orgId, range.from, range.to);
  const journals = listJournals(s.orgId);

  // These total the 300 rows on screen, which is NOT the same figure as `proof`
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
              <tr><Th width="130px">Entry</Th><Th width="110px">Date</Th><Th>Journal</Th>
                <Th>Narration</Th><Th>Source</Th>
                <Th align="right" width="130px">Debit</Th>
                <Th align="right" width="130px">Credit</Th>
                <Th width="90px">State</Th></tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="hover:bg-canvas">
                  <Td><RefLink href={`/accounting/entries/${e.id}`}>{e.entry_no ?? 'Draft'}</RefLink></Td>
                  <Td>{fmtDate(e.entry_date)}</Td>
                  <Td><span className="text-ink-muted">{e.journal_code}</span></Td>
                  <Td>
                    <span className="font-semibold">{e.narration ?? e.reference ?? '—'}</span>
                  </Td>
                  <Td>
                    {e.source_model && e.source_id
                      ? <Link href={sourceHref(e.source_model, e.source_id)}
                        className="text-[12.5px] font-bold text-brand hover:underline">
                        {titleise(e.source_model)}
                      </Link>
                      : <span className="text-[12.5px] text-ink-faint">{titleise(e.source_model ?? 'manual')}</span>}
                  </Td>
                  <Td align="right"><Money value={e.debit} dash={false} /></Td>
                  <Td align="right"><Money value={e.credit} dash={false} /></Td>
                  <Td>
                    <Chip state={e.state} />
                    {e.debit !== e.credit && (
                      <span className="ml-1.5"><Chip state="refused" label="Unbalanced" /></span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-brand-soft">
                <Td colSpan={5}><span className="font-extrabold">Totals (listed entries)</span></Td>
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
