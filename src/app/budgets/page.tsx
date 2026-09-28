import { ctx } from '@/server/bootstrap';
import { msg, one, type SearchParams } from '@/lib/range';
import { listBudgets } from '@/server/accounting/masters';
import { budgetWithActuals } from '@/server/accounting/analytics';
import { fmtDate } from '@/lib/accounting';
import { fmt } from '@/lib/money';
import {
  PageHeader, Card, Banner, Table, Th, Td, Money, Chip, StatTile, EmptyState, Bar, LinkButton,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Budgets — plan section 38.
 *
 * The ACTUAL column is read from the ledger over the budget's own window, not
 * typed in beside the plan. That is what makes variance worth looking at: it
 * cannot drift from the accounts, because it IS the accounts.
 */
export default async function BudgetsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const params = await searchParams;
  const m = msg(params);
  const budgets = listBudgets(s.orgId);
  const selected = one(params, 'id') ?? budgets[0]?.id;
  const detail = selected ? budgetWithActuals(s.orgId, selected) : null;

  return (
    <>
      <PageHeader
        title="Budgets"
        subtitle="What was planned against what the ledger actually recorded."
        accent="var(--color-sec-settings)"
        actions={<LinkButton href="/budgets/new" variant="primary">+ New Budget</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      {detail && (
        <div className="mb-5 grid gap-3 sm:grid-cols-4">
          <StatTile label="Planned" value={detail.planned} />
          <StatTile label="Actual" value={detail.actual} />
          <StatTile label="Remaining" value={detail.remaining}
            tone={detail.remaining < 0 ? 'negative' : 'positive'} />
          <StatTile label="Used"
            value={detail.planned ? `${((detail.actual / detail.planned) * 100).toFixed(1)}%` : '—'}
            tone={detail.planned && detail.actual > detail.planned ? 'negative' : 'neutral'} />
        </div>
      )}

      <div className="space-y-5">
          {budgets.length > 1 && (
            <Card padded={false}>
              <Table>
                <thead><tr><Th>Budget</Th><Th>Owner</Th><Th>From</Th><Th>To</Th><Th>State</Th></tr></thead>
                <tbody>
                  {budgets.map((b) => (
                    <tr key={b.id} className={`hover:bg-canvas ${b.id === selected ? 'bg-brand-soft' : ''}`}>
                      <Td>
                        <a href={`/budgets?id=${b.id}`} className="font-bold text-brand hover:underline">{b.name}</a>
                      </Td>
                      <Td>{b.owner ?? '—'}</Td>
                      <Td>{fmtDate(b.date_from)}</Td>
                      <Td>{fmtDate(b.date_to)}</Td>
                      <Td><Chip state={b.state} /></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}

          <Card title={detail ? detail.budget.name : 'Budget'} padded={false}
            subtitle={detail ? `${fmtDate(detail.budget.date_from)} to ${fmtDate(detail.budget.date_to)}` : undefined}>
            {!detail ? (
              <EmptyState title="No budget yet."
                hint="Create one with the button at the top of this page."
                action={<LinkButton href="/budgets/new" variant="primary">+ New Budget</LinkButton>} />
            ) : (
              <Table>
                <thead>
                  <tr><Th>Line</Th><Th align="right">Planned</Th><Th align="right">Actual</Th>
                    <Th align="right">Remaining</Th><Th align="right">Variance</Th><Th width="150px">Used</Th></tr>
                </thead>
                <tbody>
                  {detail.lines.map((l) => (
                    <tr key={l.id} className="hover:bg-canvas">
                      <Td>
                        <span className="font-semibold">
                          {l.account_code ? `${l.account_code} ${l.account_name}` : l.analytic_name ?? 'Unassigned'}
                        </span>
                        {l.analytic_name && l.account_code && (
                          <div className="text-[12px] text-ink-faint">{l.analytic_name}</div>
                        )}
                      </Td>
                      <Td align="right"><Money value={l.planned} /></Td>
                      <Td align="right"><Money value={l.actual} /></Td>
                      <Td align="right">
                        <span className={`num font-bold ${l.remaining < 0 ? 'text-negative' : 'text-positive'}`}>
                          {fmt(l.remaining)}
                        </span>
                      </Td>
                      <Td align="right"><span className="num">{l.variancePct.toFixed(1)}%</span></Td>
                      <Td>
                        <Bar value={l.actual} max={Math.max(l.planned, l.actual, 1)}
                          color={l.actual > l.planned ? 'var(--color-negative)' : 'var(--color-positive)'} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-brand-soft">
                    <Td><span className="font-extrabold">Total</span></Td>
                    <Td align="right"><Money value={detail.planned} bold dash={false} /></Td>
                    <Td align="right"><Money value={detail.actual} bold dash={false} /></Td>
                    <Td align="right"><Money value={detail.remaining} bold dash={false} /></Td>
                    <Td colSpan={2} />
                  </tr>
                </tfoot>
              </Table>
            )}
          </Card>
      </div>
    </>
  );
}
