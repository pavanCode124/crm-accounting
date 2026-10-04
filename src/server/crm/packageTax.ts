import 'server-only';
import { all, one, run, nowIso } from '../db';
import { roundHalfUp } from '@/lib/money';
import type { Actor } from '../accounting/engine';
import { audit } from '../accounting/audit';

/**
 * The GST a TripzoCRM package is sold at — the agency's answer, kept in the
 * agency's own database.
 *
 * -------------------------------------------------------------------------
 * TWO DATABASES, ONE SEAM
 * -------------------------------------------------------------------------
 * The catalogue belongs to TripzoCRM: what a package is called, where it goes,
 * and what it costs. The RATE does not, and could not — it is a classification
 * of the agency's own supply, made under the agency's own GSTIN, and it is the
 * agency that answers for it in a return. So the package stays live from the
 * CRM and the rate is a row in this ledger's `crm_package_tax`, joined by the
 * CRM's id at read time. Nothing is copied in either direction.
 *
 * -------------------------------------------------------------------------
 * THE CATALOGUE PRICE IS INCLUSIVE OF GST
 * -------------------------------------------------------------------------
 * A traveller is quoted one figure and pays that figure. ₹47,200 against an
 * 18% package is ₹40,000 of consideration and ₹7,200 of tax — it is NOT ₹47,200
 * plus 18%, which would charge the customer ₹8,496 nobody quoted them, and it
 * is NOT ₹47,200 less 18%, which is ₹38,704 and understates the base by ₹1,296
 * on every sale. Backing the tax out is a DIVISION, and `splitInclusive` is the
 * only place in this product that does it for a package price.
 */

/** A tax a package can be sold at, as the dropdown offers it. */
export interface PackageTaxOption {
  id: string;
  name: string;
  rateBps: number;
}

/**
 * The sale taxes a package can carry.
 *
 * PARENTS ONLY. A CGST+SGST pair is ONE choice on an invoice and TWO postings;
 * offering the 9% halves separately would let somebody sell a package at half
 * the rate it is due at, and the tax engine already splits the parent when it
 * posts. Percentage taxes only, for the same reason `splitAdvanceTax` refuses a
 * fixed one: a flat ₹500 tax has no base to back out of an inclusive price.
 */
export async function saleTaxOptions(orgId: string): Promise<PackageTaxOption[]> {
  const rows = await all<{ id: string; name: string; rate_bps: number }>(
    `SELECT t.id, t.name, t.rate_bps
       FROM taxes t
      WHERE t.org_id = ? AND t.active = 1 AND t.computation = 'percent'
        AND t.scope IN ('sale', 'none') AND t.tax_group <> 'tds'
        AND NOT EXISTS (SELECT 1 FROM tax_children c WHERE c.child_id = t.id)
      ORDER BY t.rate_bps, t.name`,
    orgId,
  );
  return rows.map((t) => ({ id: t.id, name: t.name, rateBps: t.rate_bps }));
}

/**
 * The rate a package falls to when nobody has chosen one: 18%.
 *
 * 18% because that is what a tour operator's package attracts when the input
 * credit is taken (SAC 9985 / Heading 9985, the 5%-without-credit option being
 * a choice the agency makes deliberately rather than a default it drifts into).
 * Resolved against the agency's OWN tax rows rather than written as a number
 * here — plan section 20, rates are configuration — so an agency that has set
 * up its GST differently gets its own 18% row, and one that has none gets the
 * lowest rate it does have rather than a crash.
 */
export function defaultTaxOf(options: PackageTaxOption[]): PackageTaxOption | null {
  return options.find((t) => t.rateBps === 1800) ?? options[0] ?? null;
}

/** Which tax each package has been put on — CRM package id → tax id. */
export async function packageTaxMap(orgId: string): Promise<Map<string, string>> {
  const rows = await all<{ crm_package_id: string; tax_id: string }>(
    'SELECT crm_package_id, tax_id FROM crm_package_tax WHERE org_id = ?', orgId,
  );
  return new Map(rows.map((r) => [r.crm_package_id, r.tax_id]));
}

/**
 * Put a package on a rate.
 *
 * AUDITED, because it changes what every invoice raised from that package will
 * charge from now on. It does NOT change anything already raised: a document
 * line's tax split is stored on the line, so this is a decision about the next
 * invoice and never a restatement of the last one.
 */
export async function setPackageTax(
  orgId: string, packageId: string, taxId: string, packageName: string | null, actor: Actor = {},
) {
  const tax = await one<{ name: string }>(
    'SELECT name FROM taxes WHERE id = ? AND org_id = ? AND active = 1', taxId, orgId,
  );
  if (!tax) throw new Error('That tax does not exist, or has been retired.');

  await run(
    `INSERT INTO crm_package_tax (org_id, crm_package_id, tax_id, package_name, updated_by, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT (org_id, crm_package_id)
     DO UPDATE SET tax_id = EXCLUDED.tax_id, package_name = EXCLUDED.package_name,
                   updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    orgId, packageId, taxId, packageName, actor.id ?? null, nowIso(),
  );
  await audit(orgId, actor, 'modified', 'package_tax', packageId,
    `${packageName ?? packageId} set to ${tax.name}`);
}

/**
 * Back the GST out of a GST-INCLUSIVE price.
 *
 * In MINOR UNITS in and out, so the rounding happens once and in paise. The
 * catalogue is quoted in rupees, so callers coming from the CRM multiply by 100
 * on the way in — which is the only conversion on that path, and it is here
 * rather than scattered over three screens.
 *
 * ROUNDING GOES TO THE BASE, never to the tax, for the same reason
 * `splitAdvanceTax` does it that way: the tax figure is the one that gets filed
 * and reconciled, and the base is what is left of a price the customer has
 * already been quoted. `net + tax === gross` holds to the paisa, always.
 */
export function splitInclusive(gross: number, rateBps: number): { net: number; tax: number } {
  if (!gross || rateBps <= 0) return { net: gross, tax: 0 };
  const net = roundHalfUp((gross * 10000) / (10000 + rateBps));
  return { net, tax: gross - net };
}
