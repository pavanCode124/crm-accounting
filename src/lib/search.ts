/**
 * Query tokens.
 *
 * One LIKE over the whole raw string is why "rahul mumbai" and "trip
 * profitability" both returned nothing: no single column holds both words.
 * Splitting lets each term be matched separately and ANDed, which is what a
 * reader typing two words means — narrow it, not "find this exact phrase".
 *
 * Capped at six because the clause count grows with it and nobody searching a
 * ledger means anything by the seventh word.
 *
 * Case is left ALONE: callers matching against the database use ILIKE, and
 * lowercasing here would silently break any caller that does not.
 */
export function searchTokens(q: string): string[] {
  return q.trim().split(/\s+/).filter(Boolean).slice(0, 6);
}
