import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { listPeriods, listFiscalYears } from '@/server/accounting/periods';
import { fmtDate, isoDate, fiscalYearOf, can } from '@/lib/accounting';
import { setPeriodStateAction, closeYearAction, createFiscalYearAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, Money, Chip, Field, inputClass, btn,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Accounting periods — plan section 36.
 *
 * Locking a period is the control that makes a filed return stay filed. The
 * posting engine refuses to write into a locked or closed period, so this
 * screen is not advisory: once September is locked, nothing will post into
 * September, from any screen, by any role, without it being reopened here and
 * that reopening appearing in the audit trail.
 */
export default async function PeriodsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  const periods = await listPeriods(s.orgId);
  const years = await listFiscalYears(s.orgId);
  const today = isoDate();
  const nextFy = fiscalYearOf(today, s.fyStartMonth);
  const mayClose = can(s.role, 'period.close');

  return (
    <>
      <PageHeader
        title="Accounting Periods"
        subtitle="Open, locked, closed — and what the engine will accept a posting into."
        accent="var(--color-sec-accounting)"
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}
      {!mayClose && (
        <Banner tone="info">
          Your role can see the period calendar but not change it. Closing a period is the
          accountant&rsquo;s signature.
        </Banner>
      )}

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Card title="Periods" padded={false}>
          <Table>
            <thead>
              <tr><Th>Period</Th><Th>Year</Th><Th>From</Th><Th>To</Th>
                <Th align="right">Entries</Th><Th align="right">Turnover</Th>
                <Th>State</Th><Th width="190px" /></tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.id} className={`hover:bg-canvas ${p.state === 'open' ? '' : 'opacity-80'}`}>
                  <Td><span className="font-semibold">{p.name}</span></Td>
                  <Td><span className="text-ink-muted">{p.fy_name}</span></Td>
                  <Td>{fmtDate(p.date_from)}</Td>
                  <Td>{fmtDate(p.date_to)}</Td>
                  <Td align="right"><span className="num">{p.entries}</span></Td>
                  <Td align="right"><Money value={p.total} /></Td>
                  <Td><Chip state={p.state} /></Td>
                  <Td>
                    {mayClose && p.state !== 'closed' && (
                      <div className="flex gap-1.5 no-print">
                        {p.state === 'open' ? (
                          <form action={setPeriodStateAction}>
                            <input type="hidden" name="id" value={p.id} />
                            <input type="hidden" name="state" value="locked" />
                            <button className="text-[12px] font-bold text-warn hover:underline">Lock</button>
                          </form>
                        ) : (
                          <form action={setPeriodStateAction}>
                            <input type="hidden" name="id" value={p.id} />
                            <input type="hidden" name="state" value="open" />
                            <button className="text-[12px] font-bold text-brand hover:underline">Reopen</button>
                          </form>
                        )}
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <div className="space-y-5">
          <Card title="Fiscal years">
            <ul className="space-y-3 text-[13.5px]">
              {years.map((y) => (
                <li key={y.id} className="flex items-center justify-between gap-3 border-b border-line pb-3 last:border-0">
                  <span>
                    <span className="block font-bold">{y.name}</span>
                    <span className="text-[12px] text-ink-faint">
                      {fmtDate(y.date_from)} — {fmtDate(y.date_to)}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Chip state={y.state} />
                    {mayClose && y.state === 'open' && (
                      <form action={closeYearAction}>
                        <input type="hidden" name="id" value={y.id} />
                        <button className="text-[12px] font-bold text-negative hover:underline">Close year</button>
                      </form>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-[12px] text-ink-faint">
              Closing a year zeroes every income and expense account against retained earnings and
              locks the twelve periods inside it.
            </p>
          </Card>

          {mayClose && (
            <Card title="Open a new fiscal year">
              <form action={createFiscalYearAction} className="space-y-3">
                <Field label="Starts on" hint="Twelve monthly periods are created from this date.">
                  <input type="date" name="start" defaultValue={nextFy.from} className={inputClass} />
                </Field>
                <button className={`${btn.primary} w-full`}>Create year and periods</button>
              </form>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
