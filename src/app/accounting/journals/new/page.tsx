import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { accountOptions } from '@/server/options';
import { JOURNAL_TYPES, titleise } from '@/lib/accounting';
import { saveJournalAction } from '@/app/actions';
import { PageHeader, Card, Banner, Field, inputClass, btn, LinkButton } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function NewJournalPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const m = msg(await searchParams);
  const accounts = accountOptions(s.orgId, ['asset_cash']);

  return (
    <>
      <PageHeader
        title="New Journal"
        subtitle="A journal is the book an entry is written in and the numbering series it takes its number from. Both are created here."
        accent="var(--color-sec-accounting)"
        actions={<LinkButton href="/accounting/journals">Cancel</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}

      <Card className="max-w-2xl">
        <form action={saveJournalAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Code" hint="Three to five letters, used as the prefix on every entry number.">
              <input name="code" required maxLength={5} className={inputClass} placeholder="ADJ" />
            </Field>
            <Field label="Name">
              <input name="name" required className={inputClass} placeholder="Adjustments" />
            </Field>
          </div>

          <Field label="Type">
            <select name="type" className={inputClass} defaultValue="general">
              {JOURNAL_TYPES.map((t) => <option key={t} value={t}>{titleise(t)}</option>)}
            </select>
          </Field>

          <Field label="Default account"
            hint="Bank and cash journals need one — it is the account the money moves through. General journals do not.">
            <select name="default_account_id" className={inputClass} defaultValue="">
              <option value="">—</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </Field>

          <div className="flex items-center gap-2 pt-1">
            <button className={btn.primary}>Create journal</button>
            <LinkButton href="/accounting/journals">Cancel</LinkButton>
          </div>
        </form>
      </Card>
    </>
  );
}
