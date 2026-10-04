import { ctx } from '@/server/bootstrap';
import { one, msg, type SearchParams } from '@/lib/range';
import { mirrorCounts } from '@/server/crm/mirror';
import { PageHeader, LinkButton, Banner } from '@/components/ui';
import { DocumentList, DocumentFilters } from '@/components/DocumentList';

export const dynamic = 'force-dynamic';

/**
 * Customer invoices — THE BOOK OF ACCOUNT, in this ledger's own database.
 *
 * ===========================================================================
 * THIS SCREEN BRIEFLY READ TRIPZOCRM LIVE, AND THAT IS WHY THE BOOKS WERE EMPTY
 * ===========================================================================
 * For one release it listed `/api/invoices` on every render and its New and
 * Edit screens wrote back to the CRM. The reasoning was that there is only one
 * invoice and it belongs to the CRM. The consequences were worse than the
 * problem:
 *
 *   NO INVOICE EVER REACHED THE LEDGER. A CRM invoice has no journal, no
 *   revenue account per line, no tax row and no HSN, so nothing was ever
 *   written to `documents` — and therefore no journal entry, no tax posting and
 *   no balance. Review & Post, the general ledger, the trial balance, the GST
 *   summary and every report built on them were empty, on a product whose whole
 *   purpose is to produce them.
 *
 *   AND THE ACCOUNTING APP WAS WRITING TO THE AGENCY'S OPERATIONAL SYSTEM. A
 *   mapping bug here could alter the record a customer's invoice is generated
 *   from, and nothing in the ledger could undo it.
 *
 * So the direction is fixed now. TripzoCRM is FETCHED — read-only, structurally
 * (see `crmFetch`) — mirrored into this database, and drafted into documents the
 * accountant completes with the books fields the CRM has no concept of. This
 * screen lists those documents: what has been billed, what has been collected,
 * and what is still owed, all of it reconciling to the trial balance behind it.
 *
 * The live CRM side has its own screen at /crm/invoices, which is where the
 * numbers legitimately differ and the difference is the work.
 */
export default async function InvoicesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const m = await msg(params);
  const filter = {
    search: await one(params, 'q'),
    state: await one(params, 'state'),
    paymentState: await one(params, 'payment'),
    from: await one(params, 'from'),
    to: await one(params, 'to'),
  };

  // Not a CRM call. This counts rows in the mirror, so a backend that is down
  // cannot take this screen with it — and the figure is still the true one,
  // because the mirror is what the importer works from.
  const crm = await mirrorCounts(s.orgId);
  const waiting = crm.invoices - crm.imported;

  return (
    <>
      <PageHeader
        title="Customer Invoices"
        subtitle="What has been billed, what has been collected, and what is still owed."
        accent="var(--color-sec-sales)"
        actions={<LinkButton href="/sales/invoices/new" variant="primary">+ New Invoice</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      {/*
        * SAID HERE RATHER THAN ONLY ON THE CRM SCREEN, because this is the list
        * somebody checks when an invoice they raised on their phone is missing.
        * "It is not in the books yet and here is the button" is the answer to
        * that question; an empty list with no explanation is not.
        */}
      {waiting > 0 && (
        <Banner tone="info">
          {waiting} TripzoCRM invoice{waiting === 1 ? '' : 's'} {waiting === 1 ? 'has' : 'have'} been
          fetched but {waiting === 1 ? 'is' : 'are'} not in the books yet.{' '}
          <a href="/crm/invoices" className="font-bold text-brand hover:underline">
            Review them under TripzoCRM → Invoices
          </a>{' '}
          — importing one drafts the document; posting it is still yours to do.
        </Banner>
      )}

      <DocumentFilters action="/sales/invoices" filter={filter} />
      <DocumentList
        orgId={s.orgId}
        docType="out_invoice"
        basePath="/sales/invoices"
        filter={filter}
        emptyHint="Raise an invoice against a booking and its revenue, tax and receivable are posted in one balanced entry. Invoices raised in TripzoCRM arrive under TripzoCRM → Invoices."
      />
    </>
  );
}
