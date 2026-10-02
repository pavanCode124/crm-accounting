import 'server-only';
import { one, run } from '../db';
import { audit } from './audit';
import type { Actor } from './engine';

/**
 * The agency itself.
 *
 * A multi-tenant ledger cannot keep the entity's own identity in a seed file.
 * The registered name, the GSTIN and the address are what every invoice prints;
 * the fiscal-year start is what every report's period arithmetic stands on; and
 * `state_code` is a POSTING INPUT rather than a label — it is one half of the
 * place-of-supply comparison that decides CGST+SGST against IGST on an Indian
 * invoice. An agency onboarding itself has to be able to set all of them
 * without anyone editing TypeScript.
 */

export interface OrganisationRow {
  id: string; name: string; legal_name: string | null; currency: string; country: string;
  gstin: string | null; pan: string | null; fy_start_month: number; address: string | null;
  city: string | null;
  email: string | null; phone: string | null; website: string | null; state_code: string | null;
  invoice_terms: string | null; invoice_footer: string | null; created_at: string;
}

export async function getOrganisation(orgId: string): Promise<OrganisationRow | null> {
  return await one<OrganisationRow>('SELECT * FROM organizations WHERE id = ?', orgId);
}

/**
 * GST state codes — the first two digits of a GSTIN, and the place of supply.
 *
 * Held here rather than typed free-hand because the comparison that chooses
 * between an intra-state and an inter-state tax is an exact string match: "07"
 * and "7" are the same state to a person and two different states to the
 * engine. Offering a closed list is what keeps that from being a data-entry
 * question.
 */
export const GST_STATES: Array<[string, string]> = [
  ['01', 'Jammu & Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'],
  ['04', 'Chandigarh'], ['05', 'Uttarakhand'], ['06', 'Haryana'], ['07', 'Delhi'],
  ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'], ['15', 'Mizoram'],
  ['16', 'Tripura'], ['17', 'Meghalaya'], ['18', 'Assam'], ['19', 'West Bengal'],
  ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'], ['26', 'Dadra & Nagar Haveli and Daman & Diu'], ['27', 'Maharashtra'],
  ['29', 'Karnataka'], ['30', 'Goa'], ['31', 'Lakshadweep'], ['32', 'Kerala'],
  ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman & Nicobar Islands'],
  ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'], ['97', 'Other Territory'],
];

export function stateName(code: string | null): string | null {
  if (!code) return null;
  return GST_STATES.find(([c]) => c === code)?.[1] ?? code;
}

/** A GSTIN is 15 characters: 2 state + 10 PAN + 1 entity + Z + 1 check. */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export interface OrganisationInput {
  name: string;
  legalName?: string | null;
  gstin?: string | null;
  pan?: string | null;
  stateCode?: string | null;
  country?: string | null;
  currency?: string;
  fyStartMonth?: number;
  address?: string | null;
  city?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  invoiceTerms?: string | null;
  invoiceFooter?: string | null;
}

/**
 * Save the agency's own record.
 *
 * TWO FIELDS ARE REFUSED ONCE THE BOOKS HAVE MOVED, and the refusals are the
 * only interesting part of this function.
 *
 * The CURRENCY is the unit every stored amount is already denominated in.
 * Changing it does not convert anything — it relabels a million paise as a
 * million cents, silently, across every posted entry. So it is editable until
 * the first entry posts and refused after.
 *
 * The FISCAL YEAR START decides which year an entry falls in, and fiscal years
 * are already rows with opening balances and a closing entry behind them.
 * Moving it under an existing year would leave entries outside every period
 * they are supposed to belong to. Editable until the first fiscal year exists.
 *
 * Everything else — name, GSTIN, address, terms — is presentation or a
 * forward-looking posting input, and changes freely.
 */
export async function updateOrganisation(orgId: string, o: OrganisationInput, actor: Actor = {}) {
  const current = await getOrganisation(orgId);
  if (!current) throw new Error('Unknown organisation.');

  const name = o.name.trim();
  if (!name) throw new Error('The agency needs a name.');

  const gstin = (o.gstin ?? '').trim().toUpperCase() || null;
  if (gstin && !GSTIN_RE.test(gstin)) {
    throw new Error(`"${gstin}" is not a valid GSTIN. It is 15 characters: 2-digit state code, PAN, entity number, Z, check digit.`);
  }
  const pan = (o.pan ?? '').trim().toUpperCase() || null;
  if (pan && !PAN_RE.test(pan)) {
    throw new Error(`"${pan}" is not a valid PAN. It is 10 characters: AAAAA9999A.`);
  }

  let stateCode = (o.stateCode ?? '').trim() || null;
  // A GSTIN carries its own state in its first two digits. If the two disagree
  // one of them is a typo, and the GSTIN is the one that was copied off a
  // certificate — so it wins, and the person is told which it chose.
  if (gstin) {
    const fromGstin = gstin.slice(0, 2);
    if (stateCode && stateCode !== fromGstin) {
      throw new Error(
        `The GSTIN begins ${fromGstin} (${stateName(fromGstin)}) but the state is set to ` +
        `${stateCode} (${stateName(stateCode)}). They have to agree — the pair decides CGST+SGST against IGST.`,
      );
    }
    stateCode = fromGstin;
  }
  if (gstin && pan && gstin.slice(2, 12) !== pan) {
    throw new Error('The GSTIN embeds the PAN at characters 3–12, and this pair does not match.');
  }

  const currency = (o.currency ?? current.currency).trim().toUpperCase() || current.currency;
  if (currency !== current.currency) {
    const posted = await one<{ id: string }>(
      "SELECT id FROM journal_entries WHERE org_id = ? AND state = 'posted' LIMIT 1", orgId,
    );
    if (posted) {
      throw new Error(
        `The books are already kept in ${current.currency} and entries have been posted. Changing the ` +
        'company currency relabels every stored amount without converting it, so it is refused once ' +
        'anything is on the ledger. Foreign-currency invoices carry their own rate, per document.',
      );
    }
  }

  let fyStartMonth = o.fyStartMonth ?? current.fy_start_month;
  if (!(fyStartMonth >= 1 && fyStartMonth <= 12)) fyStartMonth = current.fy_start_month;
  if (fyStartMonth !== current.fy_start_month) {
    const fy = await one<{ id: string }>('SELECT id FROM fiscal_years WHERE org_id = ? LIMIT 1', orgId);
    if (fy) {
      throw new Error(
        'Fiscal years have already been opened on the current start month. Moving it would leave ' +
        'posted entries outside every period they belong to, so it is refused. Close and recreate the ' +
        'years under Accounting → Accounting Periods if the agency genuinely changed its year end.',
      );
    }
  }

  await run(
    `UPDATE organizations SET name=?, legal_name=?, gstin=?, pan=?, state_code=?, country=?,
            currency=?, fy_start_month=?, address=?, city=?, email=?, phone=?, website=?,
            invoice_terms=?, invoice_footer=?
       WHERE id=?`,
    name, (o.legalName ?? '').trim() || null, gstin, pan, stateCode,
    (o.country ?? current.country ?? 'IN').trim().toUpperCase() || 'IN',
    currency, fyStartMonth, (o.address ?? '').trim() || null, (o.city ?? '').trim() || null,
    (o.email ?? '').trim() || null, (o.phone ?? '').trim() || null, (o.website ?? '').trim() || null,
    (o.invoiceTerms ?? '').trim() || null, (o.invoiceFooter ?? '').trim() || null,
    orgId,
  );
  await audit(orgId, actor, 'modified', 'organisation', orgId, name);
  return orgId;
}
