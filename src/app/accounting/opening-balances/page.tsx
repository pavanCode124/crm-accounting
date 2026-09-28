import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { accountsWithBalances } from '@/server/accounting/reports';
import { accountOptions } from '@/server/options';
import { fiscalYearOf, isoDate, kindLabel } from '@/lib/accounting';
import { openingBalancesAction } from '@/app/actions';
import { OpeningBalanceForm } from '@/components/OpeningBalanceForm';
import { PageHeader, Card, Banner, Table, Th, Td, Money } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Opening balances — plan section 37.
 *
 * The migration entry from Tally, Zoho or a spreadsheet. The one rule worth
 * insisting on is stated on the page itself: if the figures do not balance,
 * they are wrong, and the system says so rather than quietly plugging the
 * difference into a suspense account that then haunts every report.
 */
export default async function OpeningBalancesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  const fy = fiscalYearOf(isoDate(), s.fyStartMonth);
  const accounts = await accountOptions(s.orgId);
  const posted = (await accountsWithBalances(s.orgId, fy.from)).filter((a) => a.balance !== 0);

  return (
    <>
      <PageHeader
        title="Opening Balances"
        subtitle="Carry the closing position of the previous system into these books, as one balanced entry."
        accent="var(--color-sec-accounting)"
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <OpeningBalanceForm
          accounts={accounts}
          defaultDate={fy.from}
          action={openingBalancesAction}
        />

        <Card title={`Balances already carried as at ${fy.from}`} padded={false}
          subtitle="Everything posted on or before the first day of the year.">
          {posted.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px] text-ink-faint">
              Nothing carried in yet.
            </p>
          ) : (
            <Table>
              <thead><tr><Th>Account</Th><Th>Type</Th><Th align="right">Balance</Th></tr></thead>
              <tbody>
                {posted.map((a) => (
                  <tr key={a.id}>
                    <Td>
                      <span className="num !text-left font-bold">{a.code}</span>{' '}
                      <span>{a.name}</span>
                    </Td>
                    <Td><span className="text-ink-muted">{kindLabel(a.kind)}</span></Td>
                    <Td align="right"><Money value={a.natural} bold /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
