import { addDays, addMonths, fiscalYearOf, isoDate } from './accounting';

/**
 * The date window every report and the dashboard share.
 *
 * Kept in the QUERY STRING rather than in component state, so a report is a
 * URL: it can be bookmarked, sent to the accountant, and opened again next
 * month at the same window. It also means the filter bar is a plain GET form
 * and no report page needs to be a client component.
 */

export const RANGES = [
  { key: 'last30', label: 'Last 30 days' },
  { key: 'last90', label: 'Last 90 days' },
  { key: 'mtd', label: 'This month' },
  { key: 'qtd', label: 'This quarter' },
  { key: 'fytd', label: 'Financial year to date' },
  { key: 'fy', label: 'Full financial year' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom…' },
] as const;

export type RangeKey = (typeof RANGES)[number]['key'];

export interface Range { from: string; to: string; key: string; label: string }

export function resolveRange(
  params: { range?: string; from?: string; to?: string } = {},
  fyStartMonth = 4,
): Range {
  const today = isoDate();
  const key = (params.range ?? (params.from || params.to ? 'custom' : 'fytd')) as RangeKey;
  const fy = fiscalYearOf(today, fyStartMonth);
  const label = RANGES.find((r) => r.key === key)?.label ?? 'Custom';

  switch (key) {
    case 'last30': return { from: addDays(today, -29), to: today, key, label };
    case 'last90': return { from: addDays(today, -89), to: today, key, label };
    case 'mtd': return { from: `${today.slice(0, 7)}-01`, to: today, key, label };
    case 'qtd': {
      // Quarters follow the FISCAL year, not the calendar one: Apr–Jun is Q1 for
      // an Indian agency, and a "this quarter" that started in January would
      // never tie to anything they file.
      const monthsIn = ((Number(today.slice(5, 7)) - fyStartMonth) + 12) % 12;
      return { from: addMonths(fy.from, Math.floor(monthsIn / 3) * 3), to: today, key, label };
    }
    case 'fy': return { from: fy.from, to: fy.to, key, label };
    case 'all': return { from: '1900-01-01', to: today, key, label };
    case 'custom': return {
      from: params.from || fy.from,
      to: params.to || today,
      key: 'custom',
      label: 'Custom',
    };
    case 'fytd':
    default: return { from: fy.from, to: today, key: 'fytd', label: 'Financial year to date' };
  }
}

/** The equivalent window one year earlier, for a comparison column. */
export function priorYear(r: Range): Range {
  return {
    from: addMonths(r.from, -12),
    to: addMonths(r.to, -12),
    key: `${r.key}_ly`,
    label: `${r.label} (last year)`,
  };
}

/** Next.js 15 hands searchParams in as a promise; this is the shape they take. */
export type SearchParams = Record<string, string | string[] | undefined>;

export async function one(params: SearchParams, key: string): Promise<string | undefined> {
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

/** The `?ok=` / `?error=` banner a server action redirects back with. */
export async function msg(params: SearchParams): Promise<{ ok?: string; error?: string }> {
  return { ok: await one(params, 'ok'), error: await one(params, 'error') };
}
