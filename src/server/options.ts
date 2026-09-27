import 'server-only';
import { all } from './db';
import { listAccounts, listJournals, listPartners, listPaymentTerms, listProducts } from './accounting/masters';
import { listTaxes, listWithholdingTaxes } from './accounting/tax';
import { listAnalyticAccounts, listBookings } from './accounting/analytics';
import type { DocFormProps } from '@/components/DocumentForm';
import type { DocType } from '@/lib/accounting';

/**
 * The dropdown contents every form needs, assembled in one place.
 *
 * A form is only as good as what it offers: a vendor-bill screen that lists
 * revenue accounts invites a posting nobody notices for a month. The account
 * and tax lists are therefore filtered BY WHAT THE DOCUMENT IS, here, rather
 * than left to each page to remember.
 */
export function documentFormOptions(orgId: string, docType: DocType, canPost: boolean): DocFormProps {
  const isBill = docType.startsWith('in_');

  /*
   * PRIMARY kinds first, and that ordering is the point rather than a nicety.
   * The list is sorted by account code, so offering assets alongside expenses
   * on a bill puts "120000 Customer Advances" at the top — which is what the
   * first line silently defaults to. The accounts a travel agency actually
   * bills to lead; the rest are still reachable, just not the default.
   */
  const primaryKinds = isBill ? ['expense_direct', 'expense_operating'] : ['income', 'income_other'];
  const secondaryKinds = isBill
    ? ['asset_current', 'asset_fixed', 'asset_prepaid']
    : ['liability_current'];

  return {
    docType,
    canPost,
    partners: listPartners(orgId, { side: isBill ? 'supplier' : 'customer' })
      .map((p) => ({ id: p.id, label: p.name })),
    journals: listJournals(orgId, isBill ? 'purchase' : 'sale')
      .map((j) => ({ id: j.id, label: `${j.code} — ${j.name}` })),
    accounts: [...listAccounts(orgId, { kinds: primaryKinds }), ...listAccounts(orgId, { kinds: secondaryKinds })]
      .map((a) => ({ id: a.id, label: `${a.code} ${a.name}` })),
    taxes: listTaxes(orgId, isBill ? 'purchase' : 'sale')
      .map((t) => ({ id: t.id, label: t.name, rateBps: t.rate_bps, priceIncluded: !!t.price_included })),
    withholdingTaxes: listWithholdingTaxes(orgId)
      .map((t) => ({ id: t.id, label: t.name, rateBps: t.rate_bps, priceIncluded: false })),
    analytics: listAnalyticAccounts(orgId)
      .map((a) => ({ id: a.id, label: `${a.plan_name}: ${a.name}` })),
    // `hint` carries the booking's analytic account, so picking a trip on the
    // form tags the lines without a second round trip.
    bookings: listBookings(orgId, { limit: 100 })
      .map((b) => ({ id: b.id, label: `${b.ref} — ${b.title}`, hint: b.analytic_id ?? '' })),
    paymentTerms: listPaymentTerms(orgId).map((t) => ({ id: t.id, label: t.name })),
    products: listProducts(orgId).map((p) => ({
      id: p.id, name: p.name, price: p.sale_price,
      accountId: p.income_account_id, taxId: p.sale_tax_id,
    })),
  };
}

export function bankAccountOptions(orgId: string) {
  return all<{ id: string; name: string; journal_id: string | null }>(
    'SELECT id, name, journal_id FROM bank_accounts WHERE org_id=? AND active=1 ORDER BY is_cash, name', orgId,
  );
}

export function journalOptions(orgId: string, types?: string[]) {
  const rows = listJournals(orgId);
  return (types ? rows.filter((j) => types.includes(j.type)) : rows)
    .map((j) => ({ id: j.id, label: `${j.code} — ${j.name}`, type: j.type }));
}

export function accountOptions(orgId: string, kinds?: string[]) {
  return listAccounts(orgId, { kinds }).map((a) => ({ id: a.id, label: `${a.code} ${a.name}`, kind: a.kind }));
}

export function analyticOptions(orgId: string, planCode?: string) {
  return listAnalyticAccounts(orgId, planCode)
    .map((a) => ({ id: a.id, label: `${a.plan_name}: ${a.name}` }));
}

export function bookingOptions(orgId: string) {
  return listBookings(orgId, { limit: 200 })
    .map((b) => ({ id: b.id, label: `${b.ref} — ${b.title}`, analyticId: b.analytic_id }));
}

export function partnerOptions(orgId: string, side?: 'customer' | 'supplier') {
  return listPartners(orgId, { side }).map((p) => ({ id: p.id, label: p.name }));
}
