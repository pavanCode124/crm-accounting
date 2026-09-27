import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { msg, one, type SearchParams } from '@/lib/range';
import { accountsWithBalances } from '@/server/accounting/reports';
import {
  ACCOUNT_KINDS, ACCOUNT_GROUPS, kindLabel, kindGroup, kindSign, drCr, isoDate, type AccountKind,
} from '@/lib/accounting';
import { saveAccountAction, archiveAccountAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, Money, Chip, Field, inputClass, btn, StatTile,
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
  const s = ctx();
  const params = await searchParams;
  const m = msg(params);
  const group = one(params, 'group');
  const accounts = accountsWithBalances(s.orgId, isoDate());
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

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Card padded={false}>
          <Table>
            <thead>
              <tr><Th width="90px">Code</Th><Th>Name</Th><Th>Type</Th>
                <Th align="center" width="60px">Nature</Th>
                <Th align="right" width="130px">Debit</Th>
                <Th align="right" width="130px">Credit</Th>
                <Th width="80px" /></tr>
            </thead>
            <tbody>
              {shown.map((a) => {
                const { debit, credit } = drCr(a.balance);
                return (
                  <tr key={a.id} className={`hover:bg-canvas ${a.active ? '' : 'opacity-55'}`}>
                    <Td><span className="num !text-left font-bold">{a.code}</span></Td>
                    <Td>
                      <Link href={`/reports/ledger-account?account=${a.id}`} className="font-semibold text-brand hover:underline">
                        {a.name}
                      </Link>
                      {!a.active && <span className="ml-2"><Chip state="closed" label="Archived" /></span>}
                      {!!a.reconcilable && <span className="ml-2"><Chip state="draft" label="Reconcilable" /></span>}
                    </Td>
                    <Td><span className="text-ink-muted">{kindLabel(a.kind)}</span></Td>
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
                    <Td align="right">
                      <form action={archiveAccountAction}>
                        <input type="hidden" name="id" value={a.id} />
                        <button className="text-[12px] font-bold text-ink-faint hover:text-negative">Archive</button>
                      </form>
                    </Td>
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
                <Td colSpan={4}>
                  <span className="font-extrabold">
                    {group ? `Total — ${group} accounts` : 'Total — all accounts'}
                  </span>
                </Td>
                <Td align="right"><Money value={totalDebit} bold dash={false} /></Td>
                <Td align="right"><Money value={totalCredit} bold dash={false} /></Td>
                <Td />
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

        <Card title="Add an account"
          subtitle="The type decides which statement it lands on, and how its balance is read.">
          <form action={saveAccountAction} className="space-y-3">
            <Field label="Code" hint="Four to six digits, following the ranges already in use.">
              <input name="code" required className={inputClass} placeholder="512000" />
            </Field>
            <Field label="Name"><input name="name" required className={inputClass} /></Field>
            <Field label="Type">
              <select name="kind" className={inputClass} defaultValue="expense_direct">
                {(Object.keys(ACCOUNT_KINDS) as AccountKind[]).map((k) => (
                  <option key={k} value={k}>{ACCOUNT_KINDS[k].label} ({ACCOUNT_KINDS[k].group})</option>
                ))}
              </select>
            </Field>
            <label className="flex items-center gap-2 text-[13px] font-semibold">
              <input type="checkbox" name="reconcilable" className="h-4 w-4" />
              Reconcilable
            </label>
            <p className="text-[12px] text-ink-faint">
              Tick it for receivables, payables and advances — accounts whose lines are matched off
              against each other rather than against a bank statement.
            </p>
            <Field label="Description"><input name="description" className={inputClass} /></Field>
            <button className={`${btn.primary} w-full`}>Add account</button>
          </form>
        </Card>
      </div>
    </>
  );
}
