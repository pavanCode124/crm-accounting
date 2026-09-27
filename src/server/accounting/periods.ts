import 'server-only';
import { all, one, run, tx, id } from '../db';
import { addMonths, addDays, fiscalYearOf, isoDate } from '@/lib/accounting';
import { postEntry, profitForPeriod, PostingError, type Actor, type PostingLine } from './engine';
import { requireSetting } from './settings';
import { audit } from './audit';

/**
 * Fiscal years, periods, opening balances and the year-end close
 * (plan sections 36, 37).
 *
 * Locking is the only thing standing between a filed return and someone
 * "just fixing" a posted invoice three months later. The engine refuses to
 * write into a non-open period, so the lock is enforced at the one place
 * everything passes through rather than in each screen.
 */

export function createFiscalYear(orgId: string, startDate: string, actor: Actor = {}) {
  return tx(() => {
    const fy = fiscalYearOf(startDate, Number(startDate.slice(5, 7)));
    const yearId = id('fy');
    run(
      'INSERT INTO fiscal_years (id, org_id, name, date_from, date_to, state) VALUES (?,?,?,?,?,?)',
      yearId, orgId, fy.name, fy.from, fy.to, 'open',
    );
    // Twelve monthly periods. Monthly rather than quarterly because Indian GST
    // and TDS are filed monthly, and a period you cannot lock at filing time
    // is a period that never gets locked.
    for (let i = 0; i < 12; i += 1) {
      const from = addMonths(fy.from, i);
      const to = addDays(addMonths(fy.from, i + 1), -1);
      const label = new Date(`${from}T00:00:00Z`).toLocaleDateString('en-IN', {
        month: 'short', year: 'numeric', timeZone: 'UTC',
      });
      run(
        `INSERT INTO accounting_periods (id, org_id, fiscal_year_id, name, date_from, date_to, state)
         VALUES (?,?,?,?,?,?,'open')`,
        id('per'), orgId, yearId, label, from, to,
      );
    }
    audit(orgId, actor, 'created', 'fiscal_year', yearId, fy.name);
    return yearId;
  });
}

export function listPeriods(orgId: string) {
  return all<{
    id: string; name: string; date_from: string; date_to: string; state: string;
    fy_name: string; fy_state: string; entries: number; total: number;
  }>(
    `SELECT p.id, p.name, p.date_from, p.date_to, p.state,
            f.name AS fy_name, f.state AS fy_state,
            (SELECT COUNT(*) FROM journal_entries e
              WHERE e.org_id = p.org_id AND e.state='posted'
                AND e.entry_date BETWEEN p.date_from AND p.date_to) AS entries,
            COALESCE((SELECT SUM(l.debit) FROM journal_entry_lines l
                       WHERE l.org_id = p.org_id AND l.state='posted'
                         AND l.entry_date BETWEEN p.date_from AND p.date_to),0) AS total
       FROM accounting_periods p JOIN fiscal_years f ON f.id = p.fiscal_year_id
      WHERE p.org_id = ? ORDER BY p.date_from`, orgId,
  );
}

export function setPeriodState(orgId: string, periodId: string, state: 'open' | 'locked' | 'closed', actor: Actor = {}) {
  const p = one<{ name: string; state: string }>(
    'SELECT name, state FROM accounting_periods WHERE id=? AND org_id=?', periodId, orgId,
  );
  if (!p) throw new PostingError('Unknown period.');
  run('UPDATE accounting_periods SET state=? WHERE id=? AND org_id=?', state, periodId, orgId);
  audit(orgId, actor, state === 'open' ? 'reopened' : state, 'accounting_period', periodId,
    `${p.name}: ${p.state} → ${state}`);
}

// ---------------------------------------------------------------------------
// Opening balances (plan section 37)
// ---------------------------------------------------------------------------

export interface OpeningLine { accountId: string; debit: number; credit: number; label?: string }

/**
 * Post the migration entry from Tally, Zoho, QuickBooks or a spreadsheet.
 *
 * The imbalance is NOT silently plugged. If debits and credits differ the
 * engine refuses the entry and the difference is reported — which is the whole
 * value of the exercise, because an opening trial balance that does not balance
 * means the old system's closing balances were read wrong, and burying that in
 * a suspense account carries the error into every report that follows.
 *
 * `balancingAccountId` exists for the legitimate case: an agency that genuinely
 * only knows its assets and liabilities and wants the remainder booked to
 * capital, as an explicit, visible choice.
 */
export function postOpeningBalances(orgId: string, opts: {
  date: string; lines: OpeningLine[]; balancingAccountId?: string | null;
}, actor: Actor = {}) {
  return tx(() => {
    const lines: PostingLine[] = opts.lines
      .filter((l) => l.debit !== 0 || l.credit !== 0)
      .map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, label: l.label ?? 'Opening balance' }));
    if (!lines.length) throw new PostingError('No opening balances were entered.');

    const debit = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const credit = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
    const diff = debit - credit;
    if (diff !== 0) {
      if (!opts.balancingAccountId) {
        throw new PostingError(
          `Opening balances are out by ${(Math.abs(diff) / 100).toFixed(2)}. ` +
          'Correct the figures, or choose an account to carry the difference.',
        );
      }
      lines.push({
        accountId: opts.balancingAccountId,
        ...(diff > 0 ? { credit: diff } : { debit: -diff }),
        label: 'Opening difference',
      });
    }

    const entryId = postEntry({
      orgId,
      journalId: requireSetting(orgId, 'journal.general'),
      date: opts.date,
      reference: 'Opening balances',
      narration: 'Opening balances carried in from the previous system',
      sourceModel: 'opening',
      lines,
    }, actor);
    audit(orgId, actor, 'posted', 'opening_balance', entryId,
      `${lines.length} account(s) as at ${opts.date}`);
    return entryId;
  });
}

// ---------------------------------------------------------------------------
// Year-end close
// ---------------------------------------------------------------------------

/**
 * Close a fiscal year.
 *
 * Every income and expense account is zeroed against retained earnings, so the
 * new year starts from nil and the balance sheet carries the profit as equity.
 * The entry is dated the last day of the year and every period in the year is
 * then locked, which is what makes the closed figures stable.
 */
export function closeFiscalYear(orgId: string, fiscalYearId: string, actor: Actor = {}) {
  return tx(() => {
    const fy = one<{ id: string; name: string; date_from: string; date_to: string; state: string }>(
      'SELECT * FROM fiscal_years WHERE id=? AND org_id=?', fiscalYearId, orgId,
    );
    if (!fy) throw new PostingError('Unknown fiscal year.');
    if (fy.state === 'closed') throw new PostingError('This year is already closed.');

    const balances = all<{ account_id: string; code: string; net: number }>(
      `SELECT l.account_id, a.code, COALESCE(SUM(l.debit - l.credit),0) AS net
         FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
        WHERE l.org_id=? AND l.state='posted' AND l.entry_date BETWEEN ? AND ?
          AND a.kind IN ('income','income_other','expense_direct','expense_operating','expense_depreciation')
        GROUP BY l.account_id HAVING net <> 0`,
      orgId, fy.date_from, fy.date_to,
    );
    if (!balances.length) throw new PostingError('This year has no profit and loss activity to close.');

    const retained = requireSetting(orgId, 'account.retained_earnings');
    const profit = profitForPeriod(orgId, fy.date_from, fy.date_to);

    const lines: PostingLine[] = balances.map((b) => ({
      accountId: b.account_id,
      // Zero the account: if it carries a debit balance, credit it away.
      ...(b.net > 0 ? { credit: b.net } : { debit: -b.net }),
      label: `Year-end close ${fy.name}`,
    }));
    lines.push({
      accountId: retained,
      ...(profit > 0 ? { credit: profit } : { debit: -profit }),
      label: `Profit for ${fy.name}`,
    });

    const entryId = postEntry({
      orgId,
      journalId: requireSetting(orgId, 'journal.general'),
      date: fy.date_to,
      reference: `Close ${fy.name}`,
      narration: `Year-end closing entry for ${fy.name}`,
      sourceModel: 'year_end',
      sourceId: fiscalYearId,
      lines,
    }, actor);

    run(`UPDATE fiscal_years SET state='closed' WHERE id=?`, fiscalYearId);
    run(`UPDATE accounting_periods SET state='closed' WHERE fiscal_year_id=?`, fiscalYearId);
    audit(orgId, actor, 'closed', 'fiscal_year', fiscalYearId,
      `${fy.name} closed — profit ${(profit / 100).toFixed(2)} to retained earnings`);
    return entryId;
  });
}

export function listFiscalYears(orgId: string) {
  return all<{ id: string; name: string; date_from: string; date_to: string; state: string }>(
    'SELECT * FROM fiscal_years WHERE org_id=? ORDER BY date_from DESC', orgId,
  );
}

/** The period a date falls in, if one is defined. Used to warn before posting. */
export function periodFor(orgId: string, date = isoDate()) {
  return one<{ id: string; name: string; state: string }>(
    'SELECT id, name, state FROM accounting_periods WHERE org_id=? AND date_from<=? AND date_to>=?',
    orgId, date, date,
  );
}
