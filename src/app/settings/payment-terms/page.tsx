import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { listPaymentTerms } from '@/server/accounting/masters';
import { can } from '@/lib/accounting';
import { savePaymentTermAction, archivePaymentTermAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, Field, inputClass, btn, Chip, EmptyState,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Payment terms.
 *
 * `days` is not a note. It is what the due date is computed from, which is what
 * the AR ageing buckets on, which is what the collections call is made off — so
 * a term is a chain that ends in somebody phoning a customer. An agency selling
 * to corporates on 45 days, to other agents on 15 and to walk-ins on receipt
 * needs all three, and a product that ships two of them silently ages the third
 * group into the wrong column.
 *
 * Terms are ARCHIVED, never deleted: a posted invoice still points at the term
 * it was raised on, and its due date has to keep meaning something next year.
 */
export default async function PaymentTermsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  const terms = await listPaymentTerms(s.orgId, { includeArchived: true });
  const mayConfigure = can(s.role, 'coa.configure');

  return (
    <>
      <PageHeader
        title="Payment Terms"
        subtitle="What “due” means per customer — and therefore what the ageing report calls overdue."
        accent="var(--color-sec-settings)"
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <Card title="Terms" padded={false}>
          {terms.length === 0 ? (
            <EmptyState title="No payment terms yet." hint="Start with Immediate and 30 days." />
          ) : (
            <Table>
              <thead>
                <tr><Th>Name</Th><Th align="right">Days</Th><Th>Note</Th>
                  <Th align="right">Documents</Th><Th /></tr>
              </thead>
              <tbody>
                {terms.map((t) => (
                  <tr key={t.id} className={`hover:bg-canvas ${t.active ? '' : 'opacity-55'}`}>
                    <Td>
                      <span className="font-semibold">{t.name}</span>
                      {!t.active && <span className="ml-2"><Chip state="cancelled" label="Archived" /></span>}
                    </Td>
                    <Td align="right"><span className="num">{t.days}</span></Td>
                    <Td><span className="text-ink-muted">{t.note ?? '—'}</span></Td>
                    <Td align="right"><span className="num text-ink-faint">{t.used ?? 0}</span></Td>
                    <Td align="right">
                      {mayConfigure && !!t.active && (
                        <form action={archivePaymentTermAction}>
                          <input type="hidden" name="id" value={t.id} />
                          <button className="text-[12px] font-bold text-ink-faint hover:text-negative">
                            Archive
                          </button>
                        </form>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="px-5 py-4 text-[12.5px] text-ink-faint">
            A document keeps the term it was raised on. Archiving stops a term being offered and changes
            nothing already posted.
          </p>
        </Card>

        {mayConfigure && (
          <Card title="Add a term">
            <form action={savePaymentTermAction} className="space-y-3">
              <Field label="Name" hint="How it reads on the invoice.">
                <input name="name" required className={inputClass} placeholder="45 days nett" />
              </Field>
              <Field label="Days" hint="0 means due on the invoice date. The due date is the invoice date plus this.">
                <input name="days" type="number" min={0} max={3650} defaultValue={30}
                  className={`${inputClass} text-right`} />
              </Field>
              <Field label="Note">
                <input name="note" className={inputClass} placeholder="Corporate accounts only" />
              </Field>
              <button className={`${btn.primary} w-full`}>Add term</button>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}
