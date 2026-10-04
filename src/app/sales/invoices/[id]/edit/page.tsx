import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { DocumentEdit } from '@/components/DocumentEdit';

export const dynamic = 'force-dynamic';

/**
 * Edit an invoice — AND THIS IS THE SCREEN THE WORKFLOW TURNS ON.
 *
 * An invoice raised in TripzoCRM carries what was sold and for how much, and
 * nothing a ledger can post: no journal, no revenue account per line, no tax
 * row, no HSN, no trip to tag the margin to. The import fills in what it can
 * infer and leaves the rest, deliberately, because inferring a chart of
 * accounts is not something a mapping table should be trusted to finish.
 *
 * This is where the accountant finishes it. Saving a DRAFT rewrites its lines
 * and recomputes its totals and tax split; saving a POSTED one goes through
 * `amendDocument`, which replaces the journal entry in place so the general
 * ledger, the trial balance, the day book, the ageing and the tax report all
 * carry the new figures and none of them carry the old ones — with the audit log
 * keeping what it used to say. `DocumentEdit` owns both paths and refuses where
 * it cannot be safe: a locked period, a reconciled bank line, a credit note
 * already raised, a settlement larger than the new total.
 *
 * NONE OF IT TOUCHES TRIPZOCRM. The CRM's copy of the invoice is what the agent
 * raised; this is the agency's book of account about it. The two are allowed to
 * differ, the difference is visible on the document, and reconciling it is the
 * work rather than a fault.
 */
export default async function InvoiceEditPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<SearchParams>;
}) {
  const s = await ctx();
  const { id } = await params;
  return (
    <DocumentEdit
      orgId={s.orgId}
      docId={id}
      basePath="/sales/invoices"
      role={s.role}
      message={await msg(await searchParams)}
    />
  );
}
