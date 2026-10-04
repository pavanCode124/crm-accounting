import { ctx } from '@/server/bootstrap';
import { one, msg, type SearchParams } from '@/lib/range';
import { livePackages, packagePrice, packageDuration, type CrmPackage } from '@/server/crm/live';
import { mirroredPackages, packagesFetchedAt } from '@/server/crm/mirror';
import { saleTaxOptions, defaultTaxOf, packageTaxMap, splitInclusive } from '@/server/crm/packageTax';
import { fetchPackagesAction } from '@/app/actions';
import { PackageGstSelect } from '@/components/PackageGstSelect';
import {
  PageHeader, Card, Table, Th, Td, Chip, EmptyState, Banner, StatTile, inputClass, btn,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The agency's packages, LIVE from TripzoCRM, priced and classified.
 *
 * -------------------------------------------------------------------------
 * TWO DATABASES ON ONE SCREEN, AND THE SPLIT IS THE POINT
 * -------------------------------------------------------------------------
 * Everything to the left of the GST column comes from TripzoCRM and is stored
 * nowhere here: the name, the code, the destinations, the price. It is the
 * catalogue as the CRM holds it right now, which is the only version worth
 * showing an accountant — a package re-priced this morning has to be the price
 * that reaches this afternoon's invoice.
 *
 * The GST column is the other half, and it lives in THIS ledger's own database.
 * A rate is not a property of a package; it is the agency's classification of
 * its own supply, made under its own GSTIN and answered for in its own return.
 * Two agencies reselling the same itinerary can legitimately be on different
 * rates, so the CRM is the wrong place to hold it and is never told.
 *
 * -------------------------------------------------------------------------
 * THE CATALOGUE PRICE INCLUDES THE GST
 * -------------------------------------------------------------------------
 * A traveller is quoted one figure and pays it. So the Price column is what the
 * customer pays, and the two columns beside it are that figure taken apart —
 * the taxable value and the tax inside it — rather than anything added on top.
 * This is the same arithmetic the invoice form does when a package is picked,
 * shown here so it can be checked before an invoice depends on it.
 */
export default async function CrmPackagesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const m = await msg(params);
  const query = await one(params, 'query');

  const [live, taxes, mapped, snapshot, snapshotAt] = await Promise.all([
    livePackages(query), saleTaxOptions(s.orgId), packageTaxMap(s.orgId),
    mirroredPackages(s.orgId), packagesFetchedAt(s.orgId),
  ]);
  const { error, connected } = live;

  /*
   * -------------------------------------------------------------------------
   * LIVE FIRST, THE SNAPSHOT SECOND, AND THE SCREEN SAYS WHICH
   * -------------------------------------------------------------------------
   * The CRM is the catalogue's owner and a package re-priced this morning has
   * to be the price that reaches this afternoon's invoice, so a live answer
   * always wins. When it does not answer — a cold start, an expired token, a
   * deploy in progress — this falls back to `crm_packages`, the copy taken on
   * the last fetch, rather than showing an agency its own catalogue as empty.
   *
   * "THIS AGENCY HAS NO PACKAGES" AND "THE CRM DID NOT ANSWER" MUST NOT LOOK
   * THE SAME. That is the whole reason the fallback is accompanied by a banner
   * naming the moment the snapshot was taken: a price that is three days old is
   * usable, and quietly passing it off as current is not.
   *
   * The snapshot is NOT merged into a live answer. Merging would resurrect a
   * package deliberately hidden or deleted over there, for ever, on a screen
   * whose GST column decides what future invoices charge.
   *
   * SEARCH STILL HAPPENS ON THE CRM when it answers; on the snapshot it is
   * applied here, over the name and the code, because there is no second system
   * to ask.
   */
  const usingSnapshot = !live.rows.length && snapshot.length > 0;
  const needle = (query ?? '').trim().toLowerCase();
  const rows: CrmPackage[] = usingSnapshot
    ? snapshot
      .filter((p) => !needle
        || (p.package_name ?? '').toLowerCase().includes(needle)
        || (p.package_code ?? '').toLowerCase().includes(needle))
      .map((p) => ({
        id: p.crm_id,
        package_name: p.package_name ?? 'Unnamed package',
        package_number: p.package_number,
        package_code: p.package_code,
        // The snapshot stores paise, like every money column in this database.
        // This page works in the CRM's whole rupees, so it converts back here.
        price: p.price / 100,
        currency: p.currency,
        days: p.days,
        nights: p.nights,
        destinations: parseDestinations(p.destinations),
        is_visible: p.is_visible !== 0,
      }))
    : live.rows;
  const fallback = defaultTaxOf(taxes);
  const byId = new Map(taxes.map((t) => [t.id, t]));
  const taxFor = (packageId: string) => byId.get(mapped.get(packageId) ?? '') ?? fallback;

  /*
   * CRM PRICES ARE IN RUPEES; THE LEDGER'S ARE IN PAISE.
   *
   * Every money figure in this product is minor units, and `StatTile` formats a
   * number on that assumption — so handing it a CRM price of 45000 would print
   * ₹450.00 for a ₹45,000 package. These tiles therefore pass STRINGS they have
   * formatted themselves, which is the honest way to say "this figure did not
   * come from the ledger and is not in the ledger's units".
   */
  const priced = rows.filter((p) => packagePrice(p) > 0);
  const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;
  const paise = (n: number) => `₹${(n / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

  // What the agency is carrying in GST inside its own list prices, which is the
  // figure nobody computes by hand and everybody is surprised by.
  const gstInside = priced.reduce((t, p) => {
    const rate = taxFor(p.id)?.rateBps ?? 0;
    return t + splitInclusive(Math.round(packagePrice(p) * 100), rate).tax;
  }, 0);
  const unclassified = rows.filter((p) => !mapped.has(p.id)).length;

  return (
    <>
      <PageHeader
        title="Packages"
        subtitle="Live from TripzoCRM, priced inclusive of the GST the agency sells them at."
        accent="var(--color-sec-sales)"
        actions={
          /*
           * FETCH IS A VERB HERE, NOT A SYNC. Nothing is imported and nothing
           * is stored — the screen already reads the CRM on every render. The
           * button is for the person who has just changed a price over there
           * and wants to see it over here without wondering whether what they
           * are looking at is a cached segment from an hour ago.
           */
          <form action={fetchPackagesAction}>
            <button className={btn.primary}>Fetch from TripzoCRM</button>
          </form>
        }
      />

      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      {!connected && (
        <Banner tone="warn">
          Not signed in to TripzoCRM, so there is no catalogue to show. Sign out and back in with
          your CRM account.
        </Banner>
      )}
      {error && (
        <Banner tone="error">
          TripzoCRM did not answer: {error}. The ledger is unaffected — this is a connection problem
          rather than a data one.
        </Banner>
      )}
      {usingSnapshot && (
        <Banner tone="warn">
          Showing the <strong>snapshot</strong> this app took on its last fetch
          {snapshotAt ? ` (${new Date(snapshotAt).toLocaleString('en-IN')})` : ''}, because TripzoCRM
          returned nothing just now. These prices were true then. Press <strong>Fetch from
          TripzoCRM</strong> once the CRM is reachable to confirm them — a GST rate chosen against a
          stale price still applies correctly, but a stale price put on an invoice is a figure the
          customer was never quoted.
        </Banner>
      )}
      {taxes.length === 0 && (
        <Banner tone="warn">
          No sales tax is configured, so there is nothing to put a package on. Add a GST rate under
          Taxes first — the rates are rows, never constants, and this column reads them.
        </Banner>
      )}
      {unclassified > 0 && taxes.length > 0 && (
        <Banner tone="info">
          {unclassified} package(s) have not been put on a rate yet, so they fall to{' '}
          {fallback ? `${(fallback.rateBps / 100).toFixed(0)}% — ${fallback.name}` : 'the default'}.
          That default is a guess the agency has not confirmed; choosing a rate turns it into an
          answer, and nothing already invoiced changes either way.
        </Banner>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile label="Packages" value={String(rows.length)}
          hint={`${unclassified} on the default rate`} />
        <StatTile label="Catalogue value"
          value={priced.length ? rupees(priced.reduce((t, p) => t + packagePrice(p), 0)) : '—'}
          hint="What the CRM is asking, GST included" />
        <StatTile label="GST inside it" value={priced.length ? paise(gstInside) : '—'}
          tone="warn" hint="Backed out of the list prices, not added to them" />
      </div>

      <Card
        title="Catalogue"
        subtitle="Searched on the CRM, not here. The GST column is this ledger's own."
        padded={false}
      >
        <form className="flex gap-2 border-b border-line px-5 py-3">
          <input
            name="query" defaultValue={query ?? ''} placeholder="Search packages…"
            className={`${inputClass} max-w-[320px]`}
          />
          <button className={btn.ghost}>Search</button>
        </form>

        {rows.length === 0 ? (
          <EmptyState title={
            error ? 'Nothing to show while the CRM is unreachable.'
              : query ? `No package matches "${query}".`
                : 'This agency has no packages in the CRM yet.'
          } />
        ) : (
          <div className="scroll-x">
            <Table>
              <thead>
                <tr>
                  <Th>Package</Th><Th>Code</Th><Th>Destinations</Th><Th>Duration</Th>
                  <Th align="right">Price (incl. GST)</Th>
                  <Th>GST</Th>
                  <Th align="right">Taxable value</Th>
                  <Th align="right">GST amount</Th>
                  <Th>Visible</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const tax = taxFor(p.id);
                  const gross = Math.round(packagePrice(p) * 100);
                  const split = splitInclusive(gross, tax?.rateBps ?? 0);
                  return (
                    <tr key={p.id} className="hover:bg-canvas">
                      <Td>
                        <span className="font-semibold">{p.package_name}</span>
                        {p.package_number && (
                          <div className="text-[11.5px] text-ink-faint">#{p.package_number}</div>
                        )}
                      </Td>
                      <Td><span className="num !text-left text-ink-muted">{p.package_code ?? '—'}</span></Td>
                      <Td>
                        <span className="text-ink-muted">
                          {p.destinations?.length ? p.destinations.join(', ') : '—'}
                        </span>
                      </Td>
                      <Td><span className="text-ink-muted">{packageDuration(p) || '—'}</span></Td>
                      <Td align="right">
                        <span className="num font-semibold">
                          {gross ? `${p.currency || 'INR'} ${packagePrice(p).toLocaleString('en-IN')}` : '—'}
                        </span>
                      </Td>
                      <Td>
                        {tax ? (
                          <PackageGstSelect
                            packageId={p.id}
                            packageName={p.package_name}
                            value={tax.id}
                            defaulted={!mapped.has(p.id)}
                            options={taxes}
                          />
                        ) : (
                          <span className="text-[12.5px] text-ink-faint">No tax configured</span>
                        )}
                      </Td>
                      <Td align="right"><span className="num">{gross ? paise(split.net) : '—'}</span></Td>
                      <Td align="right">
                        <span className="num font-semibold">{gross ? paise(split.tax) : '—'}</span>
                      </Td>
                      <Td>
                        {p.is_visible === false
                          ? <Chip state="draft" label="Hidden" />
                          : <Chip state="posted" label="Live" />}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
        <p className="border-t border-line px-5 py-4 text-[12.5px] text-ink-faint">
          Changing a rate here changes what the NEXT invoice charges. An invoice already raised keeps
          the rate it was raised under — a document line&rsquo;s tax split is stored on the line, never
          read back off this table — so nothing already filed moves.
        </p>
      </Card>
    </>
  );
}

/**
 * The snapshot's `destinations`, which is stored as JSON rather than a
 * delimited string.
 *
 * A destination legitimately contains a comma — "Paris, France" — and splitting
 * on one would turn one place into two on every row that has one. Anything that
 * does not parse as an array of strings reads as "no destinations recorded",
 * which is the honest answer and is not worth failing a page over.
 */
function parseDestinations(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
