'use client';

import { useMemo, useState } from 'react';
import { Card, Field, inputClass, btn } from './ui';
import { fmt, toMinor } from '@/lib/money';

/**
 * The opening-balance sheet.
 *
 * The difference is shown as you type, in the currency people are reading —
 * "out by ₹1,250.00", not "unbalanced". Balancing an opening entry is a
 * search for one transposed figure, and naming the exact difference is what
 * turns that search from an hour into a minute.
 */

export interface Opt { id: string; label: string }

interface Row { key: number; accountId: string; debit: string; credit: string }

let nextKey = 1;
const blank = (): Row => ({ key: nextKey++, accountId: '', debit: '', credit: '' });

export function OpeningBalanceForm({ accounts, defaultDate, action }: {
  accounts: Opt[]; defaultDate: string; action: (formData: FormData) => void | Promise<void>;
}) {
  const [rows, setRows] = useState<Row[]>([blank(), blank(), blank(), blank()]);
  const [plug, setPlug] = useState(false);

  const update = (key: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const totals = useMemo(() => {
    const debit = rows.reduce((s, r) => s + toMinor(r.debit || '0'), 0);
    const credit = rows.reduce((s, r) => s + toMinor(r.credit || '0'), 0);
    return { debit, credit, diff: debit - credit };
  }, [rows]);

  return (
    <Card title="Enter the opening figures"
      subtitle="Assets as debits, liabilities and capital as credits — exactly as the old system closed.">
      <form action={action} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Opening date" hint="Usually the first day of the fiscal year.">
            <input type="date" name="date" defaultValue={defaultDate} className={inputClass} />
          </Field>
        </div>

        <div className="scroll-x">
          <table className="w-full min-w-[620px] border-collapse text-[13px]">
            <thead>
              <tr className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">
                <th className="border-b border-line px-3 py-2 text-left">Account</th>
                <th className="border-b border-line px-3 py-2 text-right w-[160px]">Debit</th>
                <th className="border-b border-line px-3 py-2 text-right w-[160px]">Credit</th>
                <th className="border-b border-line px-3 py-2 w-[40px]" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="border-b border-line px-2 py-1.5">
                    <select name="line_account" value={r.accountId}
                      onChange={(e) => update(r.key, { accountId: e.target.value })} className={inputClass}>
                      <option value="">—</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                    </select>
                  </td>
                  <td className="border-b border-line px-2 py-1.5">
                    <input name="line_debit" value={r.debit} inputMode="decimal"
                      onChange={(e) => update(r.key, { debit: e.target.value, credit: '' })}
                      className={`${inputClass} text-right`} />
                  </td>
                  <td className="border-b border-line px-2 py-1.5">
                    <input name="line_credit" value={r.credit} inputMode="decimal"
                      onChange={(e) => update(r.key, { credit: e.target.value, debit: '' })}
                      className={`${inputClass} text-right`} />
                  </td>
                  <td className="border-b border-line px-2 py-1.5 text-center">
                    <button type="button" className="text-ink-faint hover:text-negative"
                      onClick={() => setRows((rs) => (rs.length > 2 ? rs.filter((x) => x.key !== r.key) : rs))}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-canvas">
                <td className="px-3 py-2.5 font-bold">Totals</td>
                <td className="num px-3 py-2.5 font-bold">{fmt(totals.debit)}</td>
                <td className="num px-3 py-2.5 font-bold">{fmt(totals.credit)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <button type="button" className={btn.ghost} onClick={() => setRows((rs) => [...rs, blank()])}>
            + Add row
          </button>
          <span className={`text-[13px] font-bold ${totals.diff === 0 ? 'text-positive' : 'text-negative'}`}>
            {totals.diff === 0 ? 'Balanced' : `Out by ${fmt(Math.abs(totals.diff))}`}
          </span>
        </div>

        {totals.diff !== 0 && (
          <div className="rounded-[10px] border border-warn/30 bg-warn-soft px-4 py-3 text-[13px]">
            <p className="font-bold text-warn">These figures do not balance.</p>
            <p className="mt-1 text-warn">
              Almost always this is a transposed digit or a missing account, and finding it now is
              far cheaper than finding it in a report next quarter. If the difference is genuinely
              capital you cannot otherwise account for, book it deliberately:
            </p>
            <label className="mt-2.5 flex items-center gap-2 font-semibold text-warn">
              <input type="checkbox" checked={plug} onChange={(e) => setPlug(e.target.checked)}
                className="h-4 w-4" />
              Carry the difference to a named account
            </label>
            {plug && (
              <select name="balancing_account_id" className={`${inputClass} mt-2.5`}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            )}
          </div>
        )}

        <button className={btn.primary} disabled={totals.debit === 0}>Post opening balances</button>
      </form>
    </Card>
  );
}
