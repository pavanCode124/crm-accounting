import { ctx } from '@/server/bootstrap';
import { can } from '@/lib/accounting';
import { msg, type SearchParams } from '@/lib/range';
import { accountOptions, journalOptions, partnerOptions, analyticOptions } from '@/server/options';
import { PageHeader, Banner } from '@/components/ui';
import { JournalEntryForm } from '@/components/JournalEntryForm';

export const dynamic = 'force-dynamic';

export default async function NewEntryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  return (
    <>
      <PageHeader
        title="Manual Journal Entry"
        subtitle="Accruals, adjustments, corrections — anything with no document behind it."
        accent="var(--color-sec-accounting)"
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      <JournalEntryForm
        journals={await journalOptions(s.orgId)}
        accounts={await accountOptions(s.orgId)}
        partners={await partnerOptions(s.orgId)}
        analytics={await analyticOptions(s.orgId)}
        canPost={can(s.role, 'journal.post')}
      />
    </>
  );
}
