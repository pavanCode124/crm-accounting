import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { listJournals } from '@/server/accounting/masters';
import { accountOptions } from '@/server/options';
import { JOURNAL_TYPES, titleise } from '@/lib/accounting';
import { saveJournalAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, Chip, Field, inputClass, btn,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Journals — plan section 8.
 *
 * A journal is two things at once: the BOOK an entry is written in, and the
 * numbering series it takes its number from. That is why every journal owns a
 * sequence: invoice numbers and payment numbers must never interleave, and a
 * gap in one series is a question an auditor asks.
 */
export default async function JournalsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const m = msg(await searchParams);
  const journals = listJournals(s.orgId);
  const accounts = accountOptions(s.orgId, ['asset_cash']);

  return (
    <>
      <PageHeader
        title="Journals"
        subtitle="Where each kind of entry is written, and which account a bank or cash journal moves."
        accent="var(--color-sec-accounting)"
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Card padded={false}>
          <Table>
            <thead>
              <tr><Th width="80px">Code</Th><Th>Name</Th><Th>Type</Th>
                <Th>Default account</Th><Th align="right">Posted entries</Th></tr>
            </thead>
            <tbody>
              {journals.map((j) => (
                <tr key={j.id} className="hover:bg-canvas">
                  <Td><span className="font-bold">{j.code}</span></Td>
                  <Td><span className="font-semibold">{j.name}</span></Td>
                  <Td><Chip state="draft" label={titleise(j.type)} /></Td>
                  <Td><span className="text-ink-muted">{j.default_account_name ?? '—'}</span></Td>
                  <Td align="right"><span className="num">{j.entries ?? 0}</span></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card title="Add a journal" subtitle="Its own numbering series is created with it.">
          <form action={saveJournalAction} className="space-y-3">
            <Field label="Code" hint="Three letters, used as the prefix on every entry number.">
              <input name="code" required maxLength={5} className={inputClass} placeholder="ADJ" />
            </Field>
            <Field label="Name"><input name="name" required className={inputClass} /></Field>
            <Field label="Type">
              <select name="type" className={inputClass} defaultValue="general">
                {JOURNAL_TYPES.map((t) => <option key={t} value={t}>{titleise(t)}</option>)}
              </select>
            </Field>
            <Field label="Default account"
              hint="Bank and cash journals need one — it is the account the money moves through.">
              <select name="default_account_id" className={inputClass} defaultValue="">
                <option value="">—</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </Field>
            <button className={`${btn.primary} w-full`}>Add journal</button>
          </form>
        </Card>
      </div>
    </>
  );
}
