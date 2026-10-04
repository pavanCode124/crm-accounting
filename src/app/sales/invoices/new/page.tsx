import { ctx } from '@/server/bootstrap';
import { can } from '@/lib/accounting';
import { documentFormOptions } from '@/server/options';
import { msg, one, type SearchParams } from '@/lib/range';
import { PageHeader, Banner } from '@/components/ui';
import { DocumentForm } from '@/components/DocumentForm';

export const dynamic = 'force-dynamic';

/**
 * Raise an invoice IN THE BOOKS.
 *
 * -------------------------------------------------------------------------
 * IT SAVES HERE, NOT IN TRIPZOCRM, AND THAT IS THE WHOLE CHANGE
 * -------------------------------------------------------------------------
 * This screen used to carry a "Save to TripzoCRM" button and post the invoice
 * into the agency's operational system. It does not any more: the button says
 * Save, and what it saves is a document in this ledger's own Postgres. An
 * accounting application has no business writing to the CRM — the data flows
 * one way, and `crmFetch` has no method parameter to send a change through even
 * by accident.
 *
 * The package dropdown is still the agency's LIVE TripzoCRM catalogue, because
 * reading is the half that was never in question: a package re-priced this
 * morning has to be the price that reaches this afternoon's invoice. What the
 * line then carries — the name, the price, the HSN and the tax — is COPIED onto
 * it, exactly as a local product's figures are, and the invoice is answerable
 * for those figures from then on. The CRM is consulted to fill the form; it is
 * never consulted to decide what an issued invoice said.
 *
 * And unlike the CRM's own form, this one has the columns an invoice actually
 * needs to be accounted for: a journal, a revenue account and a tax row per
 * line, an HSN, a trip to tag the margin to. Those are the fields the import
 * leaves blank for the accountant to fill, and they are the reason the books
 * can be produced at all.
 */
export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const m = await msg(params);
  const options = await documentFormOptions(s.orgId, 'out_invoice', can(s.role, 'invoice.post'));

  return (
    <>
      <PageHeader
        title="New Customer Invoice"
        subtitle="Lines carry their own revenue account and tax; the receivable side is worked out for you."
        accent="var(--color-sec-sales)"
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {options.journals.length === 0 && (
        <Banner tone="warn">
          No sales journal is configured, so this invoice has nowhere to post. Add one under
          Accounting → Journals first.
        </Banner>
      )}
      <DocumentForm
        {...options}
        defaults={{
          partnerName: await one(params, 'customer'),
          bookingId: await one(params, 'booking'),
          journalId: options.journals[0]?.id,
        }}
      />
    </>
  );
}
