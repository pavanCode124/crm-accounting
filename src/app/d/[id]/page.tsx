import { redirect } from 'next/navigation';
import { ctx } from '@/server/bootstrap';
import { getDocument } from '@/server/accounting/documents';

export const dynamic = 'force-dynamic';

/**
 * Document resolver.
 *
 * A journal entry knows it came from a `document` but not which of the four
 * kinds, and the four live under different paths. Rather than teach every
 * caller the mapping — and get it wrong for vendor bills, which is exactly what
 * happens — every back-link points here and this looks it up once.
 */
export default async function ResolveDocument({ params }: { params: Promise<{ id: string }> }) {
  const s = await ctx();
  const { id } = await params;
  const doc = await getDocument(s.orgId, id);
  if (!doc) redirect('/sales/invoices');
  redirect(`${{
    out_invoice: '/sales/invoices',
    out_refund: '/sales/credit-notes',
    in_invoice: '/purchases/bills',
    in_refund: '/purchases/debit-notes',
  }[doc.doc_type]}/${id}`);
}
