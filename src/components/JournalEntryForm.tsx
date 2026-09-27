'use client';

import { useMemo, useState } from 'react';
import { saveJournalEntryAction } from '@/app/actions';
import { Card, Field, inputClass, btn } from './ui';
import { fmt, toMinor } from '@/lib/money';

/**
 * The manual journal entry.
 *
 * The running difference is shown live and the post button is DISABLED while
 * the entry is out of balance. The server refuses an unbalanced entry anyway —
 * that is the real control — but making it impossible to submit one turns a
 * rejection into a correction, which is the difference between a form that
 * fights you and a form that helps.
 */

export interface Opt { id: string; label: string }

interface Line {
  key: number; accountId: string; label: string; partnerId: string; analyticId: string;
  debit: string; credit: string;
}

let nextKey = 1;
const blank = (): Line => ({
  key: nextKey++, accountId: '', label: '', partnerId: '', analyticId: '', debit: '', credit: '',
});

export function JournalEntryForm({ journals, accounts, partners, analytics, canPost }: {
  journals: Opt[]; accounts: Opt[]; partners: Opt[]; analytics: Opt[]; canPost: boolean;
}) {
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const today = new Date().toISOString().slice(0, 10);

  const update = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const totals = useMemo(() => {
    const debit = lines.reduce((s, l) => s + toMinor(l.debit || '0'), 0);
    const credit = lines.reduce((s, l) => s + toMinor(l.credit || '0'), 0);
    return { debit, credit, diff: debit - credit };
  }, [lines]);

  const balanced = totals.diff === 0 && totals.debit > 0;

  return (
    <form action={saveJournalEntryAction} className="space-y-5">
      <Card title="Entry">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Journal">
            <select name="journal_id" required className={inputClass}>
              {journals.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}
            </select>
          </Field>
          <Field label="Date">
            <input type="date" name="date" defaultValue={today} className={inputClass} />
          </Field>
          <Field label="Reference">
            <input name="reference" className={inputClass} placeholder="Adjustment / accrual" />
          </Field>
          <Field label="Narration" wide>
            <input name="narration" className={inputClass}
              placeholder="Why this entry exists — the auditor reads this first." />
          </Field>
        </div>
      </Card>

      <Card title="Lines" padded={false}>
        <div className="scroll-x">
          <table className="w-full min-w-[960px] border-collapse text-[13px]">
            <thead>
              <tr className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">
                <th className="border-b border-line px-3 py-2 text-left w-[240px]">Account</th>
                <th className="border-b border-line px-3 py-2 text-left">Label</th>
                <th className="border-b border-line px-3 py-2 text-left w-[180px]">Partner</th>
                <th className="border-b border-line px-3 py-2 text-left w-[180px]">Analytic</th>
                <th className="border-b border-line px-3 py-2 text-right w-[140px]">Debit</th>
                <th className="border-b border-line px-3 py-2 text-right w-[140px]">Credit</th>
                <th className="border-b border-line px-3 py-2 w-[40px]" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td className="border-b border-line px-2 py-1.5">
                    <select name="line_account" value={l.accountId}
                      onChange={(e) => update(l.key, { accountId: e.target.value })} className={inputClass}>
                      <option value="">—</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                    </select>
                  </td>
                  <td className="border-b border-line px-2 py-1.5">
                    <input name="line_label" value={l.label}
                      onChange={(e) => update(l.key, { label: e.target.value })} className={inputClass} />
                  </td>
                  <td className="border-b border-line px-2 py-1.5">
                    <select name="line_partner" value={l.partnerId}
                      onChange={(e) => update(l.key, { partnerId: e.target.value })} className={inputClass}>
                      <option value="">—</option>
                      {partners.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                  </td>
                  <td className="border-b border-line px-2 py-1.5">
                    <select name="line_analytic" value={l.analyticId}
                      onChange={(e) => update(l.key, { analyticId: e.target.value })} className={inputClass}>
                      <option value="">—</option>
                      {analytics.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                    </select>
                  </td>
                  <td className="border-b border-line px-2 py-1.5">
                    <input name="line_debit" value={l.debit} inputMode="decimal"
                      onChange={(e) => update(l.key, { debit: e.target.value, credit: '' })}
                      className={`${inputClass} text-right`} />
                  </td>
                  <td className="border-b border-line px-2 py-1.5">
                    <input name="line_credit" value={l.credit} inputMode="decimal"
                      onChange={(e) => update(l.key, { credit: e.target.value, debit: '' })}
                      className={`${inputClass} text-right`} />
                  </td>
                  <td className="border-b border-line px-2 py-1.5 text-center">
                    <button type="button" onClick={() =>
                      setLines((ls) => (ls.length > 2 ? ls.filter((x) => x.key !== l.key) : ls))}
                      className="text-ink-faint hover:text-negative">×</button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-canvas">
                <td className="px-3 py-2.5 font-bold" colSpan={4}>Totals</td>
                <td className="num px-3 py-2.5 font-bold">{fmt(totals.debit)}</td>
                <td className="num px-3 py-2.5 font-bold">{fmt(totals.credit)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
          <button type="button" className={btn.ghost} onClick={() => setLines((ls) => [...ls, blank()])}>
            + Add line
          </button>
          <span className={`text-[13px] font-bold ${balanced ? 'text-positive' : 'text-negative'}`}>
            {totals.diff === 0
              ? (totals.debit === 0 ? 'Nothing entered yet' : 'Balanced')
              : `Out of balance by ${fmt(Math.abs(totals.diff))}`}
          </span>
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={btn.ghost}>Save as draft</button>
          {canPost && (
            <button type="submit" name="post_now" value="true" className={btn.primary} disabled={!balanced}>
              Post entry
            </button>
          )}
          <p className="text-[12.5px] text-ink-faint">
            A posted entry can never be edited or deleted — only reversed, which leaves both on record.
          </p>
        </div>
      </Card>
    </form>
  );
}
