import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { journalEntry } from '@/server/accounting/reports';
import { auditFor } from '@/server/accounting/audit';
import { fmtDate, isoDate, titleise } from '@/lib/accounting';
import { postEntryAction, reverseEntryAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, Money, Chip, DefList, btn, inputClass,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * One journal entry.
 *
 * Both directions of Rule 3 meet here: every line links out to that account's
 * ledger, and the header links back to the document that caused the entry.
 */
export default async function EntryPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<SearchParams>;
}) {
  const s = ctx();
  const { id } = await params;
  const m = msg(await searchParams);
  const data = journalEntry(s.orgId, id);
  if (!data) return <Banner tone="error">That entry no longer exists.</Banner>;

  const { entry, lines } = data;
  const trail = auditFor('journal_entry', id);
  const debit = lines.reduce((sum, l) => sum + l.debit, 0);
  const credit = lines.reduce((sum, l) => sum + l.credit, 0);
  const today = isoDate();

  return (
    <>
      <PageHeader
        title={entry.entry_no ?? 'Draft entry'}
        subtitle={`${entry.journal_code} — ${entry.journal_name} · ${fmtDate(entry.entry_date)}`}
        accent="var(--color-sec-accounting)"
        actions={<Chip state={entry.state} />}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="grid gap-5 lg:grid-cols-[1.7fr_1fr]">
        <Card title="Lines" padded={false}>
          <Table>
            <thead>
              <tr><Th>Account</Th><Th>Partner</Th><Th>Label</Th><Th>Analytic</Th>
                <Th align="right">Debit</Th><Th align="right">Credit</Th></tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="hover:bg-canvas">
                  <Td>
                    <Link href={`/reports/general-ledger?account=${l.account_id}`}
                      className="font-bold text-brand hover:underline">{l.account_code}</Link>
                    <div className="text-[12.5px] text-ink-muted">{l.account_name}</div>
                  </Td>
                  <Td><span className="text-ink-muted">{l.partner_name ?? '—'}</span></Td>
                  <Td><span className="text-ink-muted">{l.label ?? '—'}</span></Td>
                  <Td><span className="text-ink-muted">{l.analytic_names ?? '—'}</span></Td>
                  <Td align="right"><Money value={l.debit} /></Td>
                  <Td align="right"><Money value={l.credit} /></Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-canvas">
                <Td colSpan={4}><span className="font-bold">Totals</span></Td>
                <Td align="right"><Money value={debit} bold dash={false} /></Td>
                <Td align="right"><Money value={credit} bold dash={false} /></Td>
              </tr>
            </tfoot>
          </Table>
        </Card>

        <div className="space-y-5">
          <Card title="Entry">
            <DefList rows={[
              ['Journal', `${entry.journal_code} — ${entry.journal_name}`],
              ['Date', fmtDate(entry.entry_date)],
              ['Reference', entry.reference ?? '—'],
              ['Narration', entry.narration ?? '—'],
              ['Source', entry.source_model && entry.source_id
                ? <Link key="src" href={sourceHref(entry.source_model, entry.source_id)}
                  className="text-brand hover:underline">{titleise(entry.source_model)}</Link>
                : titleise(entry.source_model ?? 'manual')],
              ...(entry.reversal_of
                ? [['Reverses', <Link key="rv" href={`/accounting/entries/${entry.reversal_of}`}
                  className="text-brand hover:underline">the original entry</Link>] as [string, React.ReactNode]]
                : []),
              ['Balanced', debit === credit ? 'Yes' : `No — out by ₹${((debit - credit) / 100).toFixed(2)}`],
            ]} />

            <div className="mt-5 space-y-3 no-print">
              {entry.state === 'draft' && (
                <form action={postEntryAction}>
                  <input type="hidden" name="id" value={id} />
                  <button className={`${btn.primary} w-full`}>Post this entry</button>
                </form>
              )}
              {entry.state === 'posted' && (
                <form action={reverseEntryAction} className="space-y-2">
                  <input type="hidden" name="id" value={id} />
                  <input type="date" name="date" defaultValue={today} className={inputClass} />
                  <input name="reason" placeholder="Reason for the reversal" className={inputClass} />
                  <button className={`${btn.danger} w-full`}>Reverse</button>
                </form>
              )}
            </div>
          </Card>

          <Card title="Audit trail">
            <ol className="space-y-2.5 text-[13px]">
              {trail.map((a) => (
                <li key={a.id}>
                  <span className="num !text-left text-ink-faint">
                    {new Date(a.at).toLocaleString('en-IN', {
                      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>{' '}
                  <span className="font-semibold">{titleise(a.action)}</span>
                  {a.summary ? ` — ${a.summary}` : ''}
                  <span className="text-ink-faint"> · {a.user_name}</span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}

function sourceHref(model: string, id: string): string {
  switch (model) {
    case 'document': return `/d/${id}`;
    case 'payment': return '/sales/payments';
    case 'expense': return '/expenses';
    case 'asset': case 'deferral': return '/assets';
    case 'commission': return '/commissions';
    case 'bank_transaction': return '/banking/reconcile';
    case 'opening': return '/accounting/opening-balances';
    default: return '/accounting/entries';
  }
}
