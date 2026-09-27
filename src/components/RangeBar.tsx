import { RANGES, type Range } from '@/lib/range';
import { inputClass, btn } from './ui';

/**
 * The period picker every report wears.
 *
 * A plain GET form: choosing a window navigates, which keeps the URL the whole
 * state of the report and keeps this a server component. The custom dates are
 * always visible rather than revealed by the dropdown, because a disclosure
 * that needs JavaScript to appear is one more thing to break on a page whose
 * job is to print correctly.
 */
export function RangeBar({ action, range, extra }: {
  action: string; range: Range; extra?: Record<string, string | undefined>;
}) {
  return (
    <form action={action} method="get"
      className="no-print mb-5 flex flex-wrap items-end gap-2 rounded-card border border-line bg-surface px-4 py-3">
      {Object.entries(extra ?? {}).map(([k, v]) =>
        v === undefined ? null : <input key={k} type="hidden" name={k} value={v} />)}
      <label className="block">
        <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">Period</span>
        <select name="range" defaultValue={range.key} className={`${inputClass} w-[210px]`}>
          {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">From</span>
        <input type="date" name="from" defaultValue={range.from} className={`${inputClass} w-[160px]`} />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">To</span>
        <input type="date" name="to" defaultValue={range.to} className={`${inputClass} w-[160px]`} />
      </label>
      <button type="submit" className={btn.ghost}>Apply</button>
    </form>
  );
}
