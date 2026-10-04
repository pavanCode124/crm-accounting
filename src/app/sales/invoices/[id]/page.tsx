import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { DocumentDetail } from '@/components/DocumentDetail';

export const dynamic = 'force-dynamic';

/**
 * One invoice, as the books hold it.
 *
 * The same component as a vendor bill, a credit note and a debit note, for the
 * same reason the four share one table: the posting, tax and residual logic is
 * identical and four copies of it would drift. What differs is the side and the
 * labels, and `DocumentDetail` reads both off the document type.
 *
 * Its TripzoCRM provenance — the CRM invoice number, what has been collected
 * over there, what the two systems each say the total is — is shown by the
 * detail component itself when the document came from an import, so an
 * accountant never has to go and look it up.
 */
export default async function InvoicePage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<SearchParams>;
}) {
  const s = await ctx();
  const { id } = await params;
  return (
    <DocumentDetail
      orgId={s.orgId}
      docId={id}
      basePath="/sales/invoices"
      role={s.role}
      message={await msg(await searchParams)}
    />
  );
}
