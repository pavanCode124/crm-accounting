import Link from 'next/link';
import { fmtDate, titleise, isoDate } from '@/lib/accounting';
import { listPayments, allocationsOfPayment } from '@/server/accounting/payments';
import { listDocuments } from '@/server/accounting/documents';
import { bankAccountOptions, journalOptions, partnerOptions, bookingOptions } from '@/server/options';
import { registerPaymentAction, allocateAction, reversePaymentAction } from '@/app/actions';
import { fmt } from '@/lib/money';
import {
  Card, Table, Th, Td, Money, Chip, EmptyState, RefLink, Field, inputClass, btn, StatTile, PartnerDatalist,
} from './ui';

/**
 * Money received, or money paid.
 *
 * The two directions share this view because they are the same transaction
 * with the signs swapped, and because the thing an accountant does on either
 * screen is identical: find the unallocated money and put it against the right
 * document. The UNALLOCATED panel is therefore first — a receipt sitting
 * unapplied is the single most common reason a customer balance looks wrong.
 */
export async function PaymentsView({ orgId, direction }: { orgId: string; direction: 'inbound' | 'outbound' }) {
  const inbound = direction === 'inbound';
  // Listed by SIDE, not by direction, so a customer refund stays on the Sales
  // screen where the person looking for it expects to find it.
  const payments = await listPayments(orgId, { side: inbound ? 'customer' : 'supplier', limit: 120 });
  const unapplied = payments.filter((p) => p.unallocated > 0 && p.state !== 'cancelled');
  const openDocs = (await listDocuments(orgId, {
    docType: inbound ? 'out_invoice' : 'in_invoice', state: 'posted', limit: 200,
  })).filter((d) => d.residual > 0);

  const today = isoDate();
  const banks = await bankAccountOptions(orgId);
  const journals = await journalOptions(orgId, ['bank', 'cash']);
  const partners = await partnerOptions(orgId, inbound ? 'customer' : 'supplier');
  const bookings = await bookingOptions(orgId);
  const basePath = inbound ? '/sales' : '/purchases';

  const total = payments.filter((p) => p.state !== 'cancelled').reduce((s, p) => s + p.amount, 0);
  const floating = unapplied.reduce((s, p) => s + p.unallocated, 0);

  return (
    <>
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile label={inbound ? 'Received' : 'Paid'} value={total} hint={`${payments.length} payment(s)`} />
        <StatTile label="Unallocated" value={floating} tone={floating ? 'warn' : 'neutral'}
          hint="Money with no document against it yet" />
        <StatTile label={inbound ? 'Open invoices' : 'Open bills'} value={openDocs.reduce((s, d) => s + d.residual, 0)}
          hint={`${openDocs.length} document(s)`} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.7fr_1fr]">
        <div className="space-y-5">
          {unapplied.length > 0 && (
            <Card title="Unallocated money" subtitle="Apply it to a document, or leave it as a customer advance."
              padded={false}>
              <Table>
                <thead>
                  <tr><Th>Payment</Th><Th>Partner</Th><Th>Date</Th><Th align="right">Unallocated</Th><Th>Apply to</Th></tr>
                </thead>
                <tbody>
                  {unapplied.map((p) => {
                    const candidates = openDocs.filter((d) => d.partner_id === p.partner_id);
                    return (
                      <tr key={p.id}>
                        <Td>
                          <span className="font-bold">{p.number}</span>
                          {!!p.is_advance && <div><Chip state="partial" label="Advance" /></div>}
                        </Td>
                        <Td>{p.partner_name}</Td>
                        <Td>{fmtDate(p.pay_date)}</Td>
                        <Td align="right"><Money value={p.unallocated} bold dash={false} /></Td>
                        <Td>
                          {candidates.length === 0 ? (
                            <span className="text-[12.5px] text-ink-faint">Nothing open for this partner.</span>
                          ) : (
                            <form action={allocateAction} className="flex flex-wrap items-center gap-2">
                              <input type="hidden" name="payment_id" value={p.id} />
                              <input type="hidden" name="return_to" value={`${basePath}/payments`} />
                              <select name="document_id" className={`${inputClass} w-[200px]`}>
                                {candidates.map((d) => (
                                  <option key={d.id} value={d.id}>
                                    {d.number} · ₹{(d.residual / 100).toFixed(2)}
                                  </option>
                                ))}
                              </select>
                              <input name="amount" defaultValue={(p.unallocated / 100).toFixed(2)}
                                className={`${inputClass} w-[110px] text-right`} />
                              <button className={btn.ghost}>Apply</button>
                            </form>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </Card>
          )}

          <Card title={inbound ? 'Payments received' : 'Payments made'} padded={false}>
            {payments.length === 0 ? (
              <EmptyState title="No payments recorded yet." />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Number</Th><Th>Partner</Th><Th>Date</Th><Th>Method</Th>
                    <Th>Applied to</Th><Th align="right">Amount</Th><Th>Status</Th><Th />
                  </tr>
                </thead>
                <tbody>
                  {payments.map(async (p) => {
                    const allocs = await allocationsOfPayment(p.id);
                    return (
                      <tr key={p.id} className="hover:bg-canvas">
                        <Td><span className="font-bold">{p.number}</span></Td>
                        <Td>{p.partner_name}</Td>
                        <Td>{fmtDate(p.pay_date)}</Td>
                        <Td><span className="text-ink-muted">{titleise(p.method)}</span>
                          {p.reference && <div className="text-[11.5px] text-ink-faint">{p.reference}</div>}
                        </Td>
                        <Td>
                          {allocs.length === 0
                            ? <span className="text-ink-faint">{p.is_advance ? 'Advance' : '—'}</span>
                            : allocs.map((a) => (
                              <div key={a.id}>
                                <RefLink href={`${basePath}/${inbound ? 'invoices' : 'bills'}/${a.document_id}`}>
                                  {a.number}
                                </RefLink>
                                <span className="num ml-2 text-ink-faint">₹{(a.amount / 100).toFixed(2)}</span>
                              </div>
                            ))}
                        </Td>
                        <Td align="right">
                          <span className={`num font-bold ${p.direction === 'inbound' ? 'text-positive' : 'text-negative'}`}>
                            {p.direction === 'inbound' ? '+' : '−'}{fmt(p.amount)}
                          </span>
                        </Td>
                        <Td><Chip state={p.state} /></Td>
                        <Td align="right">
                          {p.state !== 'cancelled' && (
                            <form action={reversePaymentAction}>
                              <input type="hidden" name="id" value={p.id} />
                              <input type="hidden" name="date" value={today} />
                              <input type="hidden" name="return_to" value={`${basePath}/payments`} />
                              <button className="text-[12px] font-bold text-ink-faint hover:text-negative">Reverse</button>
                            </form>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        <Card title={inbound ? 'Receive payment' : 'Send payment'}
          subtitle={inbound
            ? 'Leave the invoice blank and tick Advance for money taken before the trip is invoiced.'
            : 'An advance to a supplier sits as an asset until their bill arrives.'}>
          <form action={registerPaymentAction} className="space-y-3">
            <input type="hidden" name="direction" value={direction} />
            <input type="hidden" name="side" value={inbound ? 'customer' : 'supplier'} />
            <input type="hidden" name="return_to" value={`${basePath}/payments`} />
            <Field label={inbound ? 'Customer' : 'Supplier'}>
              <input name="partner_name" list="payment-partner-options" required autoComplete="off"
                placeholder={inbound ? 'Who paid' : 'Who was paid'} className={inputClass} />
              <PartnerDatalist id="payment-partner-options" options={partners} />
            </Field>
            <Field label="Amount">
              <input name="amount" inputMode="decimal" required placeholder="0.00"
                className={`${inputClass} text-right`} />
            </Field>
            <Field label="Date">
              <input type="date" name="pay_date" defaultValue={today} className={inputClass} />
            </Field>
            <Field label={inbound ? 'Received into' : 'Paid from'}>
              <select name="bank_account_id" className={inputClass}>
                {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <input type="hidden" name="journal_id" value={journals[0]?.id ?? ''} />
            <Field label="Method">
              <select name="method" defaultValue="neft" className={inputClass}>
                {['neft', 'upi', 'bank', 'card', 'cheque', 'cash', 'other'].map((m) =>
                  <option key={m} value={m}>{titleise(m)}</option>)}
              </select>
            </Field>
            <Field label="Reference">
              <input name="reference" className={inputClass} placeholder="UTR / cheque no." />
            </Field>
            <Field label={inbound ? 'Against invoice' : 'Against bill'}>
              <select name="document_id" className={inputClass} defaultValue="">
                <option value="">— none (advance or on account) —</option>
                {openDocs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.number} · {d.partner_name} · ₹{(d.residual / 100).toFixed(2)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Trip">
              <select name="booking_id" className={inputClass} defaultValue="">
                <option value="">—</option>
                {bookings.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </Field>
            <label className="flex items-center gap-2 text-[13px] font-semibold">
              <input type="checkbox" name="is_advance" className="h-4 w-4" />
              This is an advance
            </label>
            <button className={`${btn.primary} w-full`}>
              {inbound ? 'Record receipt' : 'Record payment'}
            </button>
          </form>
          <p className="mt-3 text-[12px] text-ink-faint">
            An advance posts to {inbound ? 'Customer Advances, a liability' : 'Supplier Advances, an asset'} —
            not to {inbound ? 'receivables' : 'payables'} — and moves across when it is applied to a document.
          </p>
          <Link href="/banking/reconcile" className="mt-4 block text-[13px] font-bold text-brand hover:underline">
            Or reconcile from the bank statement →
          </Link>
        </Card>
      </div>
    </>
  );
}
