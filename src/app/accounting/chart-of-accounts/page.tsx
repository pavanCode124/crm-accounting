import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { msg, one, type SearchParams } from '@/lib/range';
import { accountsWithBalances } from '@/server/accounting/reports';
import {
  ACCOUNT_GROUPS, kindLabel, kindGroup, kindSign, drCr, isoDate,
} from '@/lib/accounting';
import { setReconcilableAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, Money, StatTile, LinkButton, ToggleSwitch,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The Chart of Accounts.
 *
 * Grouped by KIND rather than by code range, because the kind is what every
 * report keys off and the code is configuration — an agency that renumbers its
 * chart should see the same grouping afterwards. The balance beside each
 * account is a live SUM of its posted lines; there is no stored balance
 * anywhere for it to disagree with.
 */
export default async function ChartOfAccountsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const m = await msg(params);
  const group = await one(params, 'group');
  const accounts = await accountsWithBalances(s.orgId, isoDate());
  const shown = group ? accounts.filter((a) => kindGroup(a.kind) === group) : accounts;

  // Totalled over the rows ACTUALLY SHOWN, so the footer agrees with the table
  // above it rather than with a filter the reader has cleared.
  const totalDebit = shown.reduce((sum, a) => sum + drCr(a.balance).debit, 0);
  const totalCredit = shown.reduce((sum, a) => sum + drCr(a.balance).credit, 0);

  const byGroup = ACCOUNT_GROUPS.map((g) => ({
    key: g,
    label: `${g.charAt(0).toUpperCase()}${g.slice(1)}`,
    total: accounts.filter((a) => kindGroup(a.kind) === g).reduce((sum, a) => sum + a.natural, 0),
    count: accounts.filter((a) => kindGroup(a.kind) === g).length,
  }));

  return (
    <>
      <PageHeader
        title="Chart of Accounts"
        subtitle="Every account the ledger can post to, and what sits on it today."
        accent="var(--color-sec-accounting)"
        actions={
          <LinkButton href="/accounting/chart-of-accounts/new" variant="primary">
            + New Account
          </LinkButton>
        }
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="mb-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {byGroup.map((g) => (
          <StatTile key={g.key} label={g.label} value={g.total} hint={`${g.count} account(s)`}
            href={`/accounting/chart-of-accounts?group=${g.key}`} />
        ))}
      </div>

      {group && (
        <p className="mb-4 text-[13px]">
          Showing <strong>{group}</strong> accounts ·{' '}
          <Link href="/accounting/chart-of-accounts" className="font-bold text-brand hover:underline">show all</Link>
        </p>
      )}

      {/*
        ONE COLUMN, full width. The add-an-account form used to sit in a second
        column beside this table, permanently, costing a third of the window on
        every visit for something done a handful of times a year. It is a page
        now — see the button in the header.
      */}
      <Card padded={false}>
          <Table>
            <thead>
              <tr><Th width="90px">Code</Th><Th>Name</Th><Th>Type</Th>
                <Th align="center" width="150px">Allow Reconciliation</Th>
                <Th align="center" width="60px">Nature</Th>
                <Th align="right" width="150px">Debit</Th>
                <Th align="right" width="150px">Credit</Th></tr>
            </thead>
            <tbody>
              {shown.map((a) => {
                const { debit, credit } = drCr(a.balance);
                return (
                  <tr key={a.id} className="hover:bg-canvas">
                    <Td><span className="num !text-left font-bold">{a.code}</span></Td>
                    <Td>
                      <Link href={`/reports/ledger-account?account=${a.id}`} className="font-semibold text-brand hover:underline">
                        {a.name}
                      </Link>
                    </Td>
                    <Td><span className="text-ink-muted">{kindLabel(a.kind)}</span></Td>
                    {/*
                      ALLOW RECONCILIATION — a switch, not a badge.
                      It used to be a "Reconcilable" chip tucked beside the
                      account name, which told you the answer and gave you
                      nowhere to change it: the only way to set the flag was to
                      have ticked a box when the account was created, months
                      ago. A column of switches is also the only shape in which
                      the useful reading — "which of my control accounts can be
                      matched off?" — is a glance down one column rather than a
                      hunt through sixty rows of names.
                    */}
                    <Td align="center">
                      <form action={setReconcilableAction} className="inline-flex">
                        <input type="hidden" name="id" value={a.id} />
                        <input type="hidden" name="on" value={a.reconcilable ? '0' : '1'} />
                        <input type="hidden" name="return_to"
                          value={group ? `/accounting/chart-of-accounts?group=${group}` : '/accounting/chart-of-accounts'} />
                        <ToggleSwitch
                          on={!!a.reconcilable}
                          title={`${a.reconcilable ? 'Stop allowing' : 'Allow'} reconciliation on ${a.code} ${a.name}`}
                        />
                      </form>
                    </Td>
                    {/* The side this account is SUPPOSED to sit on, from its kind. A
                        payable showing a debit balance is not illegal, but it is
                        worth a second look, and the reader can only spot that if
                        the expected side is on the row beside the actual one. */}
                    <Td align="center">
                      <span className="text-[11px] font-bold text-ink-faint">
                        {kindSign(a.kind) === 1 ? 'Dr' : 'Cr'}
                      </span>
                    </Td>
                    <Td align="right"><Money value={debit} bold /></Td>
                    <Td align="right"><Money value={credit} bold /></Td>
                  </tr>
                );
              })}
            </tbody>
            {/*
              The proof line. Summed over EVERY account the two totals are equal
              by construction — that is double entry. Summed over a filtered
              group they are not, and should not be, so the footer says which it
              is showing rather than letting a reader assume the chart is broken.
            */}
            <tfoot>
              <tr className="bg-brand-soft">
                <Td colSpan={5}>
                  <span className="font-extrabold">
                    {group ? `Total — ${group} accounts` : 'Total — all accounts'}
                  </span>
                </Td>
                <Td align="right"><Money value={totalDebit} bold dash={false} /></Td>
                <Td align="right"><Money value={totalCredit} bold dash={false} /></Td>
              </tr>
              {!group && (
                <tr>
                  <Td colSpan={7}>
                    <span className={`text-[12px] font-bold ${
                      totalDebit === totalCredit ? 'text-positive' : 'text-negative'}`}>
                      {totalDebit === totalCredit
                        ? 'Debits equal credits — the chart is in balance.'
                        : 'Out of balance — the ledger has been written to outside the posting engine.'}
                    </span>
                  </Td>
                </tr>
              )}
            </tfoot>
          </Table>
      </Card>
    </>
  );
}
