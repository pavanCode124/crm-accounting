import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { listJournals } from '@/server/accounting/masters';
import { titleise } from '@/lib/accounting';
import {
  PageHeader, Card, Banner, Table, Th, Td, Chip, LinkButton,
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

  return (
    <>
      <PageHeader
        title="Journals"
        subtitle="Where each kind of entry is written, and which account a bank or cash journal moves."
        accent="var(--color-sec-accounting)"
        actions={<LinkButton href="/accounting/journals/new" variant="primary">+ New Journal</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

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
    </>
  );
}
