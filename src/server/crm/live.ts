import 'server-only';
import { crmGet, rows, describeShape, CrmError, CRM_BACKEND_URL } from './client';
import { crmSession } from './identity';

/**
 * LIVE reads from TripzoCRM, on the signed-in visitor's own authority.
 *
 * -------------------------------------------------------------------------
 * LIVE, NOT SYNCED, AND THE DIFFERENCE IS THE POINT
 * -------------------------------------------------------------------------
 * `sync.ts` next door IMPORTS CRM records and turns them into ledger postings:
 * a CRM invoice becomes a document, a payment becomes a receipt, and from that
 * moment the books own their copy. That is correct for anything the ledger has
 * to answer for — a trial balance cannot depend on an HTTP call succeeding, and
 * a figure already filed in a return must not change because somebody edited a
 * row in the CRM afterwards.
 *
 * This module is the other half, and it is deliberately NOT that. Packages and
 * open invoices are not ledger facts; they are what the CRM currently says, and
 * the accountant needs to see the current answer rather than the last imported
 * one. A package re-priced this morning has to appear in this afternoon's
 * invoice at the new price, and a stale copy would be worse than no copy.
 *
 * So: nothing here is written to the database, nothing here is cached beyond
 * the request, and every function returns exactly what the backend said.
 *
 * -------------------------------------------------------------------------
 * WHY NO DIRECT DATABASE ACCESS
 * -------------------------------------------------------------------------
 * The CRM's tables live in the same Postgres this ledger does, so reading
 * `public.packages` directly would work and would be faster. It is still wrong:
 * the backend is where row-level access, organization scoping and impersonation
 * are decided, and a SELECT that goes round it is a SELECT that has to
 * re-implement all three — correctly, forever, as they change. Going through
 * /api/* means an agent sees their agency's packages for exactly the same
 * reason they do on their phone, with no second copy of the rule.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------
// Narrower than what the endpoints return, on purpose — these are the fields
// this product uses. Ported field-for-field from tripzo-crm-mobile's
// src/lib/catalog.ts and src/lib/invoices.ts so the two clients cannot drift
// in their reading of the same payload.

export interface CrmPackage {
  id: string;
  package_name: string;
  package_number?: string | null;
  package_code?: string | null;
  slug?: string | null;
  price?: number | string | null;
  original_price?: number | string | null;
  currency?: string | null;
  days?: number | null;
  nights?: number | null;
  destinations?: string[] | null;
  is_visible?: boolean | null;
  updated_at?: string | null;
}

/**
 * Nobody signed in, or the CRM unreachable, must not take a screen down.
 *
 * Every caller here feeds a PANEL beside the ledger's own content — a package
 * picker on the invoice form, a list of what the CRM is showing. The ledger
 * itself does not depend on any of it, so a failure degrades to "no live data"
 * with the reason available to the screen, rather than to a 500 on a page whose
 * other half was perfectly fine.
 *
 * The one thing it must never do is degrade SILENTLY into an empty list that
 * reads as "this agency has no packages". Hence the shape: the error travels
 * with the result, and every screen prints it.
 */
export interface Live<T> {
  rows: T[];
  /** Null when the read succeeded — including when it legitimately found nothing. */
  error: string | null;
  /** False when nobody is signed in to the CRM, so the screen can say so differently. */
  connected: boolean;
  /**
   * What was asked for and what came back, for a screen that got nothing.
   *
   * AN EMPTY LIST HAS TWO CAUSES AND THEY LOOK IDENTICAL: the agency really has
   * no invoices, or this code read the wrong key out of a response shape it did
   * not expect. A screen that cannot tell them apart sends somebody to read
   * server logs; one that prints the endpoint it called and the shape it got
   * answers the question on the spot.
   *
   * Shown only when `rows` is empty, and it carries KEYS AND TYPES, never
   * values — see `describeShape`.
   */
  probe: { path: string; shape: string } | null;
}

async function live<T>(key: string, path: string): Promise<Live<T>> {
  const session = await crmSession();
  if (!session) return { rows: [], error: null, connected: false, probe: null };
  try {
    const body = await crmGet<unknown>(session, path);
    const found = rows<T>(body, key);
    return {
      rows: found,
      error: null,
      connected: true,
      // Built only when there is nothing to show: on the normal path this is a
      // walk over the response's keys for a string nobody will read.
      probe: found.length ? null : { path: `${CRM_BACKEND_URL}${path}`, shape: describeShape(body) },
    };
  } catch (e) {
    return {
      rows: [],
      error: e instanceof CrmError ? `${e.message} (HTTP ${e.status})` : 'TripzoCRM could not be reached.',
      connected: true,
      probe: { path: `${CRM_BACKEND_URL}${path}`, shape: 'the request failed' },
    };
  }
}

/**
 * The organisation's packages, newest first.
 *
 * `limit` defaults high because the main caller is the invoice form's package
 * dropdown, which wants the whole catalogue in one go rather than a page of it:
 * a dropdown that silently omits the package someone is looking for is worse
 * than a slightly larger response.
 */
export function livePackages(query?: string, limit = 200): Promise<Live<CrmPackage>> {
  const params = new URLSearchParams({ page: '1', limit: String(limit) });
  if (query?.trim()) params.set('query', query.trim());
  return live<CrmPackage>('packages', `/api/packages?${params}`);
}

/**
 * What a package costs, as a number.
 *
 * The endpoint types `price` loosely — some rows carry a string, some a number,
 * some null — and `Number(null)` is 0 while `Number(undefined)` is NaN. Both
 * end up on an invoice line if nobody looks, so they are resolved here rather
 * than at each of the three call sites.
 */
export function packagePrice(pkg: CrmPackage): number {
  const n = Number(pkg.price ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** "5D / 4N", or "" when the package does not state a duration. */
export function packageDuration(pkg: CrmPackage): string {
  const days = Number(pkg.days ?? 0);
  const nights = Number(pkg.nights ?? Math.max(days - 1, 0));
  return days ? `${days}D / ${nights}N` : '';
}

// ---------------------------------------------------------------------------
// Batches — a dated departure of a package, with seats
// ---------------------------------------------------------------------------

/**
 * One departure of a package: `package_batches` in TripzoCRM's own database,
 * read through `/api/batches` exactly as the mobile app does — never a direct
 * table read (see the module note above) and never synced into this ledger.
 *
 * NARROWER THAN WHAT THE ENDPOINT RETURNS, on purpose, same discipline as
 * `CrmPackage`: these are the fields a document form's Batch dropdown and the
 * TripzoCRM → Batches screen actually use.
 *
 * NO SNAPSHOT FALLBACK, unlike packages. A batch field is optional everywhere
 * it appears — unlike the package catalogue, nothing in this product requires
 * one to raise a document — so "empty while the CRM cannot be reached" is an
 * acceptable degrade, the same one the Trip/booking and linked-invoice
 * dropdowns already have.
 */
export interface CrmBatch {
  id: string;
  package_id: string;
  batch_name?: string | null;
  batch_code?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  seats_total?: number | null;
  seats_booked?: number | null;
  seats_available?: number | null;
  status?: string | null;          // open | closed | cancelled
  package_name?: string | null;
  destinations?: string[] | null;
}

/**
 * The organisation's batches, newest-departure-first as the CRM returns them.
 *
 * `/api/batches` answers a bare array when scoped by `package_id` and
 * `{ rows, total, page, limit }` otherwise — `rows()` in `client.ts` already
 * tries `'rows'` among its fallback keys, so both shapes land correctly
 * without this function having to know which one came back.
 */
export function liveBatches(query?: string, limit = 200): Promise<Live<CrmBatch>> {
  const params = new URLSearchParams({ page: '1', limit: String(limit) });
  if (query?.trim()) params.set('q', query.trim());
  return live<CrmBatch>('batches', `/api/batches?${params}`);
}

/**
 * What identifies a batch to the person picking one off a dropdown: its own
 * name, the package it is a departure of, and when it leaves — because "which
 * package/invoice this is for" is precisely the thing a bare id cannot say.
 */
export function batchLabel(b: CrmBatch): string {
  const name = (b.batch_name?.trim() || b.batch_code?.trim()) || 'Batch';
  const pkg = b.package_name?.trim();
  const date = b.start_date
    ? new Date(b.start_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : '';
  const seats = b.seats_total
    ? `${b.seats_booked ?? 0}/${b.seats_total} seats`
    : '';
  return [name, pkg, date, seats].filter(Boolean).join(' — ');
}
