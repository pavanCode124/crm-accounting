import 'server-only';
import { all } from './db';
import { listAccounts, listJournals, listPartners, listPaymentTerms, listProducts } from './accounting/masters';
import { listTaxes, listWithholdingTaxes } from './accounting/tax';
import { listAnalyticAccounts, listBookings } from './accounting/analytics';
import { GST_STATES } from './accounting/organisation';
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
export async function documentFormOptions(orgId: string, docType: DocType, canPost: boolean): Promise<DocFormProps> {
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
    partners: (await listPartners(orgId, { side: isBill ? 'supplier' : 'customer' }))
      .map((p) => ({ id: p.id, label: p.name })),
    journals: (await listJournals(orgId, isBill ? 'purchase' : 'sale'))
      .map((j) => ({ id: j.id, label: `${j.code} — ${j.name}` })),
    accounts: [...await listAccounts(orgId, { kinds: primaryKinds }), ...await listAccounts(orgId, { kinds: secondaryKinds })]
      .map((a) => ({ id: a.id, label: `${a.code} ${a.name}` })),
    taxes: (await listTaxes(orgId, isBill ? 'purchase' : 'sale'))
      .map((t) => ({ id: t.id, label: t.name, rateBps: t.rate_bps, priceIncluded: !!t.price_included })),
    withholdingTaxes: (await listWithholdingTaxes(orgId))
      .map((t) => ({ id: t.id, label: t.name, rateBps: t.rate_bps, priceIncluded: false })),
    analytics: (await listAnalyticAccounts(orgId))
      .map((a) => ({ id: a.id, label: `${a.plan_name}: ${a.name}` })),
    // `hint` carries the booking's analytic account, so picking a trip on the
    // form tags the lines without a second round trip.
    bookings: (await listBookings(orgId, { limit: 100 }))
      .map((b) => ({ id: b.id, label: `${b.ref} — ${b.title}`, hint: b.analytic_id ?? '' })),
    paymentTerms: (await listPaymentTerms(orgId)).map((t) => ({ id: t.id, label: t.name })),
    products: (await listProducts(orgId)).map((p) => ({
      id: p.id, name: p.name, price: p.sale_price,
      accountId: p.income_account_id, taxId: p.sale_tax_id,
      // Carried so choosing a product fills the HSN and the MRP along with the
      // price. The HSN is mandatory on the invoice and nobody remembers it per
      // line; a product that knows its own is the only way the column gets
      // filled in practice rather than in principle.
      hsnCode: p.hsn_code, mrp: p.mrp,
    })),
    // The closed list of GST state codes, from the one place that holds it.
    states: GST_STATES,
  };
}

/**
 * The accounts a money form offers, DEFAULT FIRST.
 *
 * `journal_id` comes back with each one because the journal is not the form's
 * to choose: a receipt into petty cash belongs in the cash journal, and the
 * form that sent one fixed journal for every account put cash receipts in the
 * bank book under a bank entry number. The account decides; the form passes
 * the account; the action looks the journal up. See `journalOfBankAccount`.
 */
export async function bankAccountOptions(orgId: string) {
  return await all<{
    id: string; name: string; journal_id: string | null; is_cash: number;
    is_default: number; currency: string; bank_name: string | null; account_no: string | null;
  }>(
    `SELECT id, name, journal_id, is_cash, is_default, currency, bank_name, account_no
       FROM bank_accounts WHERE org_id=? AND active=1
      ORDER BY is_default DESC, is_cash, name`, orgId,
  );
}

/**
 * The journal a bank account posts through, resolved on the server.
 *
 * Falls back to the org's default bank/cash journal only when an account has
 * none — which `upsertBankAccount` makes impossible for anything created since
 * this screen existed, and which the seeded accounts all satisfy. The fallback
 * is there so a hand-inserted row degrades to a posting in the right kind of
 * book rather than to an exception at the moment someone receives money.
 */
export async function journalOfBankAccount(orgId: string, bankAccountId: string | null): Promise<string | null> {
  if (!bankAccountId) return null;
  const rows = await all<{ journal_id: string | null; is_cash: number }>(
    'SELECT journal_id, is_cash FROM bank_accounts WHERE id=? AND org_id=?', bankAccountId, orgId,
  );
  const row = rows[0];
  if (!row) return null;
  if (row.journal_id) return row.journal_id;
  const fallback = await all<{ id: string }>(
    `SELECT id FROM journals WHERE org_id=? AND active=1 AND type=? ORDER BY code LIMIT 1`,
    orgId, row.is_cash ? 'cash' : 'bank',
  );
  return fallback[0]?.id ?? null;
}

export async function journalOptions(orgId: string, types?: string[]) {
  const rows = await listJournals(orgId);
  return (types ? rows.filter((j) => types.includes(j.type)) : rows)
    .map((j) => ({ id: j.id, label: `${j.code} — ${j.name}`, type: j.type }));
}

export async function accountOptions(orgId: string, kinds?: string[]) {
  return (await listAccounts(orgId, { kinds })).map((a) => ({ id: a.id, label: `${a.code} ${a.name}`, kind: a.kind }));
}

export async function analyticOptions(orgId: string, planCode?: string) {
  return (await listAnalyticAccounts(orgId, planCode))
    .map((a) => ({ id: a.id, label: `${a.plan_name}: ${a.name}` }));
}

export async function bookingOptions(orgId: string) {
  return (await listBookings(orgId, { limit: 200 }))
    .map((b) => ({ id: b.id, label: `${b.ref} — ${b.title}`, analyticId: b.analytic_id }));
}

export async function partnerOptions(orgId: string, side?: 'customer' | 'supplier') {
  return (await listPartners(orgId, { side })).map((p) => ({ id: p.id, label: p.name }));
}
