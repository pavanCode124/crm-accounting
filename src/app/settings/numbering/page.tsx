import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { listSequences } from '@/server/accounting/masters';
import { can, formatDocNumber } from '@/lib/accounting';
import { saveNumberingAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, inputClass, btn,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Document numbering.
 *
 * -------------------------------------------------------------------------
 * WHY AN AGENCY HAS TO OWN THIS
 * -------------------------------------------------------------------------
 * The invoice number is not cosmetic. It is the reference the customer quotes,
 * the key the GST return is filed against, and the thing an auditor runs a
 * continuity check on. An agency migrating onto this product is already at
 * INV-04417 and cannot restart at 1; one that files under a group format needs
 * "TRZ/25-26/" rather than "INV". Both are configuration, and both used to be
 * literals in the seed.
 *
 * -------------------------------------------------------------------------
 * THE COUNTER ONLY GOES FORWARD
 * -------------------------------------------------------------------------
 * Enforced in `updateSequence`, and worth stating on screen because people try
 * it. Winding back reissues a number that is already printed on a document in
 * somebody's inbox and in a filed return — two documents, one reference, which
 * is the single thing a statutory series exists to prevent. Forward merely
 * leaves a gap, which is explainable.
 */

/** The series the product creates, named as an accountant would name them. */
const LABELS: Record<string, string> = {
  pay_in: 'Receipts from customers',
  pay_out: 'Payments to suppliers',
  expense: 'Employee expense claims',
  settlement: 'Channel settlement cycles',
};

function labelFor(code: string): string {
  if (LABELS[code]) return LABELS[code];
  // Journal series are `j_<code>` — created with the journal, so a bank account
  // added last week has one and no static table could have listed it.
  if (code.startsWith('j_')) return `${code.slice(2).toUpperCase()} journal`;
  return code;
}

export default async function NumberingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  const sequences = await listSequences(s.orgId);
  const mayConfigure = can(s.role, 'coa.configure');

  return (
    <>
      <PageHeader
        title="Document Numbering"
        subtitle="The series behind every invoice, bill, receipt and journal entry."
        accent="var(--color-sec-settings)"
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}
      <Banner tone="info">
        A counter can be moved forward — useful when migrating from another system mid-year — but never
        back. Reusing a number would put two different documents under one reference.
      </Banner>

      <form action={saveNumberingAction}>
        <Card title="Series" padded={false}
          subtitle="Numbers already issued keep the prefix they were issued with; the change applies to the next one.">
          <Table>
            <thead>
              <tr>
                <Th>Series</Th><Th>Prefix</Th><Th align="right">Digits</Th>
                <Th align="right">Next number</Th><Th>Next document will be</Th>
              </tr>
            </thead>
            <tbody>
              {sequences.map((q) => (
                <tr key={q.code} className="hover:bg-canvas">
                  <Td>
                    <span className="font-semibold">{labelFor(q.code)}</span>
                    <div className="text-[11.5px] text-ink-faint">{q.code}</div>
                    <input type="hidden" name="seq_code" value={q.code} />
                  </Td>
                  <Td>
                    <input name="seq_prefix" defaultValue={q.prefix} disabled={!mayConfigure}
                      maxLength={20} className={`${inputClass} w-[150px]`} />
                  </Td>
                  <Td align="right">
                    <input name="seq_padding" type="number" min={1} max={10} defaultValue={q.padding}
                      disabled={!mayConfigure} className={`${inputClass} w-[80px] text-right`} />
                  </Td>
                  <Td align="right">
                    <input name="seq_next" type="number" min={q.next_no} defaultValue={q.next_no}
                      disabled={!mayConfigure} className={`${inputClass} w-[110px] text-right`} />
                  </Td>
                  <Td>
                    {/* The SAME formatter the posting routines call, so the
                        preview cannot promise a shape the ledger will not
                        produce — including the derived separator. */}
                    <span className="num !text-left font-bold">
                      {formatDocNumber(q.prefix, q.padding, q.next_no)}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {mayConfigure && (
            <div className="px-5 py-4">
              <button className={btn.primary}>Save numbering</button>
            </div>
          )}
        </Card>
      </form>
    </>
  );
}
