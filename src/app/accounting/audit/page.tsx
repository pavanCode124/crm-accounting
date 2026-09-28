import { ctx } from '@/server/bootstrap';
import { auditRecent } from '@/server/accounting/audit';
import { titleise } from '@/lib/accounting';
import { one, type SearchParams } from '@/lib/range';
import { PageHeader, Card, Table, Th, Td, EmptyState } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The audit trail (plan section 45), on a page of its own.
 *
 * It used to be a card on the Finance Overview, eight rows deep, where it was
 * the wrong thing in the wrong place twice over. Wrong place, because a feed of
 * "who touched what" is a thing you consult when a figure looks odd, not a
 * thing you read every morning beside the totals. Wrong shape, because it was
 * laid out as a flex row whose timestamp sat in a fixed 92px box with
 * `white-space: nowrap` — and "27 Sept, 10:10 pm" does not fit in 92px, so
 * every single row's timestamp overflowed its box and printed on top of the
 * summary beside it.
 *
 * THE FIX IS THE TABLE, not a wider box. Four columns that size themselves to
 * their content cannot collide, however long a summary or a username turns out
 * to be — which is the whole reason ledgers have always been ruled into
 * columns.
 */
export default async function AuditTrailPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const model = await one(params, 'model');

  const rows = (await auditRecent(s.orgId, 300))
    .filter((r) => !model || r.model === model);

  // The models actually present, so the filter never offers an empty result.
  const models = [...new Set((await auditRecent(s.orgId, 300)).map((r) => r.model))].sort();

  return (
    <>
      <PageHeader
        title="Audit Trail"
        subtitle="Every financial action, as it was recorded. Append-only — nothing here can be edited or removed."
        accent="var(--color-sec-accounting)"
      />

      <div className="mb-4 flex flex-wrap gap-1.5 no-print">
        <FilterChip label="Everything" href="/accounting/audit" on={!model} />
        {models.map((m) => (
          <FilterChip key={m} label={titleise(m)} href={`/accounting/audit?model=${m}`} on={model === m} />
        ))}
      </div>

      <Card padded={false}>
        {rows.length === 0 ? (
          <EmptyState title="Nothing recorded yet." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th width="170px">When</Th>
                <Th width="130px">Action</Th>
                <Th>What</Th>
                <Th width="170px">Record</Th>
                <Th width="150px">By</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="hover:bg-canvas">
                  {/*
                    `whitespace-nowrap` with NO fixed width. The column is as
                    wide as the longest timestamp in it and not one pixel
                    narrower, which is exactly the guarantee the old fixed box
                    could not make.
                  */}
                  <Td>
                    <span className="num !text-left whitespace-nowrap text-ink-faint">
                      {new Date(a.at).toLocaleString('en-IN', {
                        day: '2-digit', month: 'short', year: '2-digit',
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </span>
                  </Td>
                  <Td><span className="font-semibold">{titleise(a.action)}</span></Td>
                  <Td><span className="text-ink-muted">{a.summary ?? '—'}</span></Td>
                  <Td>
                    <span className="text-[12px] text-ink-faint">
                      {titleise(a.model)}
                    </span>
                  </Td>
                  <Td><span className="text-ink-muted">{a.user_name}</span></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

function FilterChip({ label, href, on }: { label: string; href: string; on: boolean }) {
  return (
    <a href={href}
      className={`rounded-full border px-3 py-1 text-[12.5px] font-semibold ${
        on ? 'border-brand bg-brand-soft text-brand' : 'border-line text-ink-muted hover:bg-canvas'}`}>
      {label}
    </a>
  );
}
