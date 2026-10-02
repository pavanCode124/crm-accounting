/**
 * Money, in one place.
 *
 * Amounts travel through this app as INTEGER MINOR UNITS — paise, cents — and
 * are only ever turned into a decimal string at the edge of the screen. There
 * is no `number` of rupees anywhere in the ledger, because the moment there is,
 * someone adds three of them and the trial balance is out by a paisa that
 * nobody can find.
 *
 * The rounding rule is half-up on the absolute value, which is what Indian tax
 * practice expects and what keeps -0.5 and 0.5 rounding to the same magnitude.
 */

export const MINOR = 100;

export function toMinor(input: string | number): number {
  const n = typeof input === 'number' ? input : parseFloat(input.replace(/,/g, ''));
  if (!isFinite(n)) return 0;
  return Math.round(n * MINOR);
}

export function fromMinor(minor: number): number {
  return minor / MINOR;
}

/** Half-up rounding of a scaled integer, e.g. tax computed in basis points. */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Apply a basis-point rate to a minor-unit amount.
 * 18% of 150000 paise = pct(150000, 1800) = 27000 paise, exactly.
 */
export function pct(amountMinor: number, bps: number): number {
  return roundHalfUp((amountMinor * bps) / 10000);
}

/**
 * Indian digit grouping: 12,34,567.00 rather than 1,234,567.00.
 *
 * Intl does this correctly for en-IN, but only if we hand it a Number — which
 * is safe HERE and nowhere else, because this is the last step before a string
 * on a screen and nothing downstream does arithmetic on the result.
 */
const INR = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INR0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export function fmt(minor: number, opts: { decimals?: boolean; sign?: boolean } = {}): string {
  const { decimals = true, sign = false } = opts;
  const v = fromMinor(minor);
  const body = decimals ? INR.format(Math.abs(v)) : INR0.format(Math.abs(v));
  const neg = minor < 0;
  const prefix = neg ? '-' : sign && minor > 0 ? '+' : '';
  return `${prefix}₹${body}`;
}

/** Blank instead of ₹0.00 — a ledger column of zeros is unreadable. */
export function fmtOrDash(minor: number): string {
  return minor === 0 ? '—' : fmt(minor);
}

/**
 * The compact form the dashboard tiles use: ₹42.5L, ₹1.2Cr.
 *
 * Lakh/crore rather than K/M, because this is what the agency's own accountant
 * says out loud, and a finance screen that speaks a different dialect from its
 * reader gets double-checked on a calculator every time.
 */
export function fmtCompact(minor: number): string {
  const v = Math.abs(fromMinor(minor));
  const neg = minor < 0 ? '-' : '';
  if (v >= 1e7) return `${neg}₹${(v / 1e7).toFixed(v / 1e7 >= 100 ? 0 : 2)}Cr`;
  if (v >= 1e5) return `${neg}₹${(v / 1e5).toFixed(v / 1e5 >= 100 ? 0 : 2)}L`;
  if (v >= 1e3) return `${neg}₹${(v / 1e3).toFixed(1)}K`;
  return `${neg}₹${v.toFixed(0)}`;
}

/** Quantities are stored x1000 so 2.5 nights and 1/3 of a room are exact. */
export function qtyFromMilli(milli: number): number {
  return milli / 1000;
}
export function qtyToMilli(q: string | number): number {
  const n = typeof q === 'number' ? q : parseFloat(q);
  return isFinite(n) ? Math.round(n * 1000) : 0;
}

export function bpsToPct(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

/**
 * A rate on a summary panel, where nil means "this was not charged".
 *
 * "0%" and "—" say different things about a commission: the first is a rate
 * that was agreed and came to nothing, the second is a charge that does not
 * apply to this channel at all. On a panel of six rates, five of them usually
 * nil, the dash is what lets the reader find the one that matters.
 */
export function bpsOrDash(bps: number): string {
  return bps ? bpsToPct(bps) : '—';
}

/**
 * Margin as a percentage of revenue, to one decimal.
 * Revenue of zero is 0% and not NaN — a trip that sold nothing has no margin,
 * and "NaN%" on a dashboard destroys trust in every other number beside it.
 */
export function marginPct(revenue: number, profit: number): string {
  if (revenue === 0) return '0.0%';
  return `${((profit / revenue) * 100).toFixed(1)}%`;
}

/** Convert a foreign amount into company currency at a 1e6-scaled rate. */
export function convert(amountMinor: number, rateE6: number): number {
  return roundHalfUp((amountMinor * rateE6) / 1_000_000);
}
