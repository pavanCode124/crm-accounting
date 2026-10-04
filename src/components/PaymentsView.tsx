import Link from 'next/link';
import { fmtDate, titleise, isoDate } from '@/lib/accounting';
import { listPayments, allocationsOfPayment } from '@/server/accounting/payments';
import { listDocuments } from '@/server/accounting/documents';
import { bankAccountOptions, partnerOptions, bookingOptions } from '@/server/options';
import {
  registerPaymentAction, allocateAction, reversePaymentAction, cancelAdvanceAction,
  settleCrmReceiptsAction,
} from '@/app/actions';
import { saleTaxOptions, defaultTaxOf } from '@/server/crm/packageTax';
import { GST_STATES, getOrganisation } from '@/server/accounting/organisation';
import { AdvanceReceiptFields } from './AdvanceReceiptFields';
import { fmt } from '@/lib/money';
import {
  Card, Table, Th, Td, Money, Chip, EmptyState, RefLink, Field, inputClass, btn, StatTile, PartnerDatalist,
} from './ui';

/**
 * The trip the money is for.
 *
 * Shown on both payment tables because "what was this advance against?" is the
 * first thing asked of a receipt that settles no invoice — on the Advance rows
 * the Applied-to column is empty by definition, so without this the screen
 * says nothing about why the money arrived. The ref links to the booking; the
 * title sits under it because BK-1023 means nothing on its own.
 */
function TripCell({ id, ref_, title }: { id?: string | null; ref_?: string | null; title?: string | null }) {
  if (!id || !ref_) return <span className="text-ink-faint">—</span>;
  return (
    <>
      <Link href={`/bookings/${id}`} className="font-semibold text-ink-muted hover:underline">{ref_}</Link>
      {title && <div className="max-w-[180px] truncate text-[11.5px] text-ink-faint" title={title}>{title}</div>}
    </>
  );
}

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
  /*
   * AN ADVANCE WITH MONEY STILL ON IT AND NO CANCELLATION AGAINST IT YET.
   *
   * `cancelled_by_doc_id` is what stops a second cancellation being processed
   * against the same receipt — two cancellation charges on one advance would
   * invoice the traveller twice for calling off one trip — and it is read here
   * so the form disappears rather than appearing and then refusing.
   */
  const cancellable = inbound
    ? payments.filter((p) => p.is_advance && p.unallocated > 0
      && (p.state === 'posted' || p.state === 'reconciled') && !p.cancelled_by_doc_id)
    : [];
  const openDocs = (await listDocuments(orgId, {
    docType: inbound ? 'out_invoice' : 'in_invoice', state: 'posted', limit: 200,
  })).filter((d) => d.residual > 0);

  const today = isoDate();
  const banks = await bankAccountOptions(orgId);
  /*
   * THE SAME TAX LIST THE PACKAGES SCREEN OFFERS, and deliberately so. An
   * advance is money against a package, and the rate it is taxed at has to be
   * the rate that package is sold at — Circular 178/10/2022-GST paragraph 11.3
   * makes the same point about the cancellation charge at the other end of the
   * story. Two lists would let the two drift.
   */
  const taxes = inbound ? await saleTaxOptions(orgId) : [];
  const defaultTax = defaultTaxOf(taxes);
  const org = inbound ? await getOrganisation(orgId) : null;
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
              padded={false}
              /*
                MATCHING IS NOT ALLOCATION BY HAND, AND THE BUTTON SAYS SO.

                Every receipt fetched from TripzoCRM already knows its invoice.
                Posting one now settles it there without being asked, but a
                ledger that was syncing before that was true has receipts and
                invoices posted on both sides of a match nobody recorded — and
                no amount of ordinary work brings those together, because nobody
                posts an invoice twice. This is how that backlog clears.

                Inbound only: an outbound payment has no CRM receipt behind it.
              */
              actions={inbound ? (
                <form action={settleCrmReceiptsAction}>
                  <input type="hidden" name="return_to" value={`${basePath}/payments`} />
                  <button className={btn.ghost}
                    title="Allocate every fetched receipt to the invoice TripzoCRM recorded it against, where both are posted. Allocates only what each side still has outstanding.">
                    Match TripzoCRM receipts
                  </button>
                </form>
              ) : undefined}>
              <Table>
                <thead>
                  <tr>
                    <Th>Payment</Th><Th>Partner</Th><Th>Trip</Th><Th>Date</Th>
                    <Th align="right">Unallocated</Th><Th>Apply to</Th>
                  </tr>
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
                        <Td><TripCell id={p.trip_id} ref_={p.trip_ref} title={p.trip_title} /></Td>
                        <Td>{fmtDate(p.pay_date)}</Td>
                        <Td align="right"><Money value={p.unallocated} bold dash={false} /></Td>
                        <Td>
                          {/*
                            WHAT THE MONEY ALREADY SAYS IT IS FOR, said before
                            the dropdown rather than instead of it.

                            A receipt fetched from TripzoCRM was taken against
                            one invoice, and this column used to offer it to
                            every open invoice that customer had with nothing on
                            screen to say which was right — one list of ledger
                            numbers, none of which the agent who took the money
                            has ever seen. Where the target is posted the money
                            is settled against it automatically and the row is
                            not here at all; what remains is the honest
                            "not yet", and this says so by name.
                          */}
                          {p.target_document_id && (
                            <div className="mb-1 text-[12px] text-ink-faint">
                              {p.target_state === 'posted'
                                ? `Taken against ${p.target_number ?? 'an invoice'}`
                                : `Taken against ${p.target_crm_number ?? 'an invoice'} in TripzoCRM, which is not posted here yet`}
                              {p.target_crm_number && p.target_state === 'posted'
                                ? ` · TripzoCRM ${p.target_crm_number}`
                                : ''}
                            </div>
                          )}
                          {candidates.length === 0 ? (
                            <span className="text-[12.5px] text-ink-faint">Nothing open for this partner.</span>
                          ) : (
                            <form action={allocateAction} className="flex flex-wrap items-center gap-2">
                              <input type="hidden" name="payment_id" value={p.id} />
                              <input type="hidden" name="return_to" value={`${basePath}/payments`} />
                              {/*
                                PRESELECTED TO THE DOCUMENT THE MONEY NAMES, when
                                that document is one of the open ones. The
                                dropdown is still free — an accountant moving a
                                receipt somewhere else is doing their job — but
                                the default is no longer "whichever invoice sorts
                                first".
                              */}
                              <select name="document_id" className={`${inputClass} w-[220px]`}
                                defaultValue={candidates.some((d) => d.id === p.target_document_id)
                                  ? p.target_document_id! : undefined}>
                                {candidates.map((d) => (
                                  <option key={d.id} value={d.id}>
                                    {d.number}
                                    {d.crm_invoice_number ? ` · ${d.crm_invoice_number}` : ''}
                                    {' · ₹'}{(d.residual / 100).toFixed(2)}
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

          {/*
            =================================================================
            CANCELLING A TRIP AGAINST THE ADVANCE TAKEN FOR IT
            =================================================================
            WHY THIS NEEDS A SCREEN OF ITS OWN, rather than being a credit note.

            A credit note reduces an INVOICE. At this point there is no invoice:
            money arrived, the GST inside it was paid to the government under
            section 13(2), and the trip then never ran. What has to happen is
            two different things at two different rates of recovery, and neither
            is a reduction of anything:

              * what the agency KEEPS is a taxable supply in its own right.
                Circular 178/10/2022-GST paragraphs 11.2-11.4: allowing a
                booking to be cancelled against a fee is not the declared
                service of "tolerating an act" under Schedule II paragraph 5(e)
                — it is naturally bundled with the tour operator service and is
                assessed AT THE SAME RATE as it. So it is invoiced, with its own
                number and its own tax.
              * what the agency GIVES BACK is returned under a refund voucher,
                section 31(3)(e), and the GST that was paid on that part comes
                back with it — at the rate the receipt carried, not today's.

            Doing it by hand means three journal entries, a pro-rata tax split
            and a number series most people do not know exists. `cancelAdvance`
            does all of it in one transaction and shows its working.
          */}
          {inbound && cancellable.length > 0 && (
            <Card title="Cancel a trip against its advance"
              subtitle="The retained charge is invoiced with GST at the package's own rate; the rest is refunded and its share of the advance tax comes back."
              padded={false}>
              <div className="divide-y divide-line">
                {cancellable.map((p) => (
                  <form key={p.id} action={cancelAdvanceAction} className="space-y-3 px-5 py-4">
                    <input type="hidden" name="payment_id" value={p.id} />
                    <input type="hidden" name="return_to" value={`${basePath}/payments`} />
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <div>
                        <span className="font-bold">{p.number}</span>
                        <span className="ml-2 text-ink-muted">{p.partner_name}</span>
                        {p.trip_ref && <span className="ml-2 text-[12px] text-ink-faint">{p.trip_ref}</span>}
                      </div>
                      <div className="text-[12.5px] text-ink-muted">
                        {/*
                          THE GST ALREADY PAID, NAMED. It is the figure the whole
                          screen exists to put right, and the one nobody can see
                          anywhere else — it is inside a receipt, not on an
                          invoice. Printing it is what makes the arithmetic below
                          checkable instead of trusted.
                        */}
                        On account <span className="num font-semibold">{fmt(p.unallocated)}</span>
                        {p.advance_tax_amount > 0 && (
                          <> · GST already paid <span className="num font-semibold">{fmt(p.advance_tax_amount)}</span></>
                        )}
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <Field label="Cancellation charge"
                        hint="Inclusive of GST — the figure the policy produces.">
                        <input name="charge_amount" inputMode="decimal" required placeholder="0.00"
                          className={`${inputClass} text-right`} />
                      </Field>
                      <Field label="GST on the charge"
                        hint="The package's own rate, per Circular 178 para 11.3.">
                        <select name="tax_id" className={inputClass}
                          defaultValue={p.advance_tax_id ?? defaultTax?.id ?? ''}>
                          <option value="">— none —</option>
                          {taxes.map((t) => (
                            <option key={t.id} value={t.id}>
                              {(t.rateBps / 100).toFixed(t.rateBps % 100 ? 2 : 0)}% — {t.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Date">
                        <input type="date" name="date" defaultValue={today} className={inputClass} />
                      </Field>
                      <Field label="Refund from"
                        hint="Blank with Refund unticked leaves the balance on account.">
                        <select name="bank_account_id" className={inputClass}
                          defaultValue={p.bank_account_id ?? banks.find((b) => b.is_default)?.id ?? ''}>
                          <option value="">—</option>
                          {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                      </Field>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Reason">
                        <input name="reason" placeholder="Cancelled on medical grounds"
                          className={inputClass} />
                      </Field>
                      <Field label="Refund reference">
                        <input name="reference" placeholder="UTR" className={inputClass} />
                      </Field>
                    </div>

                    <div className="flex flex-wrap items-center gap-4">
                      {/*
                        TICKED BY DEFAULT, because a cancellation normally ends
                        with the traveller's money going back and a refund
                        voucher is what section 31(3)(e) requires when it does.
                        Unticked, the balance stays on account — which is the
                        honest record of a trip being moved rather than dropped,
                        and no voucher is issued because nothing was returned.
                      */}
                      <label className="flex items-center gap-2 text-[13px] font-semibold">
                        <input type="checkbox" name="refund" defaultChecked className="h-4 w-4" />
                        Refund the balance
                      </label>
                      <button className={btn.danger}>Cancel and settle</button>
                    </div>
                  </form>
                ))}
              </div>
              <p className="border-t border-line px-5 py-4 text-[12.5px] text-ink-faint">
                The charge becomes a posted tax invoice, the advance is applied to it (GSTR-1 Table
                11B), and the balance leaves under a refund voucher in its own series (Rule 51),
                reversing its pro-rata share of the tax the receipt carried. All in one transaction:
                it either all happens or none of it does.
              </p>
            </Card>
          )}

          <Card title={inbound ? 'Payments received' : 'Payments made'} padded={false}>
            {payments.length === 0 ? (
              <EmptyState title="No payments recorded yet." />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Number</Th><Th>Partner</Th><Th>Trip</Th><Th>Date</Th><Th>Method</Th>
                    <Th>Applied to</Th><Th align="right">Amount</Th><Th>Status</Th><Th />
                  </tr>
                </thead>
                <tbody>
                  {payments.map(async (p) => {
                    const allocs = await allocationsOfPayment(orgId, p.id);
                    return (
                      <tr key={p.id} className="hover:bg-canvas">
                        <Td><span className="font-bold">{p.number}</span></Td>
                        <Td>{p.partner_name}</Td>
                        <Td><TripCell id={p.trip_id} ref_={p.trip_ref} title={p.trip_title} /></Td>
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
                          {/*
                            THE SPLIT, UNDER THE RECEIPT. The bank figure is
                            gross and the liability to the traveller is not —
                            the GST inside it is owed to the government, this
                            month, and showing only the total is how an agency
                            ends up thinking it holds the whole of it. A refund
                            voucher reads the same way with the signs reversed.
                          */}
                          {p.advance_tax_amount > 0 && (
                            <div className="text-[11px] text-ink-faint">
                              {fmt(p.amount - p.advance_tax_amount)} + GST {fmt(p.advance_tax_amount)}
                            </div>
                          )}
                          {p.cancelled_by_doc_id && (
                            <div className="text-[11px] font-semibold text-ink-faint">Cancelled</div>
                          )}
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
            {/*
              ON THE CUSTOMER SIDE THE AMOUNT AND THE ADVANCE TICK TRAVEL
              TOGETHER, because ticking the box changes what the amount MEANS:
              an ordinary receipt is money against an invoice that has already
              charged its tax, and an advance is a gross figure with this
              month's GST inside it. The block that appears says so and shows
              the split. On the supplier side nothing changes — an advance paid
              out buys no input credit until the bill arrives (section 16(2)) —
              so that form keeps the plain field.
            */}
            {inbound ? (
              <AdvanceReceiptFields
                taxes={taxes}
                states={GST_STATES}
                defaultTaxId={defaultTax?.id ?? ''}
                defaultState={org?.state_code ?? ''}
              />
            ) : (
              <>
                <Field label="Amount">
                  <input name="amount" inputMode="decimal" required placeholder="0.00"
                    className={`${inputClass} text-right`} />
                </Field>
                <label className="flex items-center gap-2 text-[13px] font-semibold">
                  <input type="checkbox" name="is_advance" className="h-4 w-4" />
                  This is an advance
                </label>
              </>
            )}
            <Field label="Date">
              <input type="date" name="pay_date" defaultValue={today} className={inputClass} />
            </Field>
            {/*
              * Grouped, and the whole list rather than a chosen three. These
              * come from Settings → Bank & Cash, so an agency with eleven
              * accounts sees eleven. Banks and cash are separated because they
              * answer different questions — "which bank did it hit" and "whose
              * float was it" — and a flat list of both invites the wrong pick.
              *
              * No hidden journal field: the journal is resolved from the chosen
              * account on the server, so cash receipts can no longer be stamped
              * into a bank journal. See registerPaymentAction.
              */}
            <Field label={inbound ? 'Received into' : 'Paid from'}
              hint={banks.length === 0 ? 'No accounts configured yet — add one under Settings → Bank & Cash.' : undefined}>
              <select name="bank_account_id" className={inputClass}
                defaultValue={banks.find((b) => b.is_default)?.id ?? banks[0]?.id ?? ''}>
                <optgroup label="Bank">
                  {banks.filter((b) => !b.is_cash).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}{b.account_no ? ` · ••••${b.account_no.slice(-4)}` : ''}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Cash">
                  {banks.filter((b) => b.is_cash).map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </optgroup>
              </select>
            </Field>
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
