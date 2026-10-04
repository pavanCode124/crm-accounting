import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { Fragment } from 'react';
import { fmtDate, isoDate, can, titleise } from '@/lib/accounting';
import { fmt, fromMinor, bpsToPct, bpsOrDash } from '@/lib/money';
import {
  getSettlement, settlementDocuments, settlementCharges, CHARGE_KINDS,
} from '@/server/accounting/settlements';
import { journalEntry } from '@/server/accounting/reports';
import { auditFor } from '@/server/accounting/audit';
import { bankAccountOptions } from '@/server/options';
import {
  postSettlementAction, reverseSettlementAction, refillSettlementAction,
  removeSettlementOrderAction, saveSettlementChargeAction, saveSettlementAction,
} from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, Money, Chip, DefList, EmptyState,
  Field, inputClass, btn, RefLink,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * One payout cycle, from every angle.
 *
 * The screen is arranged as the channel's own statement is, because that is
 * what it is checked against: the breakup first, then the orders behind it,
 * then the charges that are not per order. The ledger entry it produced sits at
 * the bottom with a link both ways, like every other posted record here (plan
 * section 49, Rule 3).
 */
export default async function SettlementPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const s = await ctx();
  const { id } = await params;
  const m = await msg(await searchParams);

  const settlement = await getSettlement(s.orgId, id);
  if (!settlement) return <Banner tone="error">That settlement no longer exists.</Banner>;

  const docs = await settlementDocuments(s.orgId, id);
  const charges = await settlementCharges(s.orgId, id);
  const trail = await auditFor(s.orgId, 'settlement', id);
  const entry = settlement.entry_id ? await journalEntry(s.orgId, settlement.entry_id) : null;
  const banks = await bankAccountOptions(s.orgId);

  const draft = settlement.state === 'draft';
  const mayEdit = draft && can(s.role, 'payment.create');
  const mayPost = can(s.role, 'payment.approve');
  const today = isoDate();

  const forward = docs.filter((d) => d.kind !== 'return');
  const returned = docs.filter((d) => d.kind === 'return');
  const chargeOf = (code: string) => charges.find((c) => c.code === code);

  return (
    <>
      <PageHeader
        title={settlement.number ?? 'Settlement cycle (draft)'}
        subtitle={`${settlement.partner_name} · ${fmtDate(settlement.cycle_from)} – ${fmtDate(settlement.cycle_to)}`}
        accent="var(--color-sec-sales)"
        actions={
          <>
            <Chip state={settlement.state} label={settlement.state === 'cancelled' ? 'Reversed' : undefined} />
            <a href={`/api/exports/settlement/${settlement.id}`} className={btn.ghost}>
              Export to Excel
            </a>
          </>
        }
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="grid gap-5 lg:grid-cols-[1.7fr_1fr]">
        <div className="space-y-5">
          {/*
            THE BREAKUP, IN THE ORDER THE CHANNELS PRINT IT.

            Not the order a developer would choose — order-level charges, then
            additions, then other deductions, then one-off adjustments — because
            this table is read side by side with the channel's own PDF. A tidier
            grouping of ours would turn a line-by-line comparison into a search.
          */}
          <Card title="Payout breakup" padded={false}
            subtitle="Read against the channel's own statement, line for line.">
            <Table>
              <thead>
                <tr>
                  <Th>Particular</Th>
                  <Th align="right" width="150px">Delivered</Th>
                  <Th align="right" width="150px">Cancelled / returned</Th>
                  <Th align="right" width="150px">Total</Th>
                </tr>
              </thead>
              <tbody>
                <BreakupRow label="Customer payable"
                  forward={forward.reduce((t, d) => t + d.gross, 0)}
                  returned={returned.reduce((t, d) => t + d.gross, 0)} bold />

                <SectionRow label="Order level deductions" />
                <BreakupRow label={`Commission${settlement.commission_bps ? ` (${bpsToPct(settlement.commission_bps)})` : ''}`}
                  forward={forward.reduce((t, d) => t + d.commission, 0)}
                  returned={returned.reduce((t, d) => t + d.commission, 0)} />
                <BreakupRow label="GST on commission" indent
                  forward={forward.reduce((t, d) => t + d.commission_gst, 0)}
                  returned={returned.reduce((t, d) => t + d.commission_gst, 0)} />
                <BreakupRow label="Shipping"
                  forward={forward.reduce((t, d) => t + d.shipping, 0)}
                  returned={returned.reduce((t, d) => t + d.shipping, 0)} />
                <BreakupRow label="GST on shipping" indent
                  forward={forward.reduce((t, d) => t + d.shipping_gst, 0)}
                  returned={returned.reduce((t, d) => t + d.shipping_gst, 0)} />
                <BreakupRow label="Return charge"
                  forward={forward.reduce((t, d) => t + d.return_fee, 0)}
                  returned={returned.reduce((t, d) => t + d.return_fee, 0)} />
                <BreakupRow label="GST on return charge" indent
                  forward={forward.reduce((t, d) => t + d.return_gst, 0)}
                  returned={returned.reduce((t, d) => t + d.return_gst, 0)} />
                <BreakupRow label={`TCS${settlement.tcs_bps ? ` (${bpsToPct(settlement.tcs_bps)})` : ''}`}
                  forward={forward.reduce((t, d) => t + d.tcs, 0)}
                  returned={returned.reduce((t, d) => t + d.tcs, 0)} />
                <BreakupRow label={`TDS 194-O${settlement.tds_bps ? ` (${bpsToPct(settlement.tds_bps)})` : ''}`}
                  forward={forward.reduce((t, d) => t + d.tds, 0)}
                  returned={returned.reduce((t, d) => t + d.tds, 0)} />

                {(['additions', 'deductions', 'one_time'] as const).map((block) => {
                  const kinds = CHARGE_KINDS.filter((k) => k.block === block);
                  const label = block === 'additions' ? 'Other additions'
                    : block === 'deductions' ? 'Other deductions' : 'One-timer adjustments';
                  // Only the rows that carry a figure, here — unlike the
                  // exported workbook, which prints every catalogue row at nil
                  // so two cycles line up. On screen the reader can scroll and
                  // the empty rows are noise; in the file the reader is
                  // comparing columns across months and the blanks are the
                  // alignment.
                  const present = kinds.filter((k) => chargeOf(k.code));
                  if (!present.length) return null;
                  return (
                    <Fragment key={block}>
                      <SectionRow label={label} />
                      {present.map((k) => {
                        const row = chargeOf(k.code)!;
                        return (
                          <Fragment key={k.code}>
                            <BreakupRow label={k.label} forward={row.amount} returned={0} />
                            {k.gst && row.gst_amount !== 0 && (
                              <BreakupRow label={`GST on ${k.label}`} indent
                                forward={row.gst_amount} returned={0} />
                            )}
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                {/*
                  THE LAST FOUR ROWS, exactly as a channel statement closes.

                  "This cycle" and "net payout" are the same figure here and are
                  still both shown, because they are not the same figure on the
                  channel's statement: it carries a balance forward, so its
                  "till date" differs from what it actually remitted. Printing
                  both, and the carry-forward between them, is what lets the two
                  documents be compared row for row — and if they diverge, the
                  row where they diverge is the answer.
                */}
                <tr className="bg-canvas">
                  <Td><span className="font-bold">Amount calculated from this cycle</span></Td>
                  <Td colSpan={2} />
                  <Td align="right"><Money value={settlement.net_payout} bold dash={false} /></Td>
                </tr>
                <tr>
                  <Td><span className="text-ink-muted">Unsettled from the previous cycle</span></Td>
                  <Td colSpan={2} />
                  <Td align="right"><Money value={settlement.previous_unsettled} /></Td>
                </tr>
                <tr>
                  <Td><span className="text-ink-muted">Amount calculated till date</span></Td>
                  <Td colSpan={2} />
                  <Td align="right">
                    <Money value={settlement.net_payout + settlement.previous_unsettled} dash={false} />
                  </Td>
                </tr>
                <tr className="bg-canvas">
                  <Td><span className="font-bold">Net payout in this cycle</span></Td>
                  <Td colSpan={2} />
                  <Td align="right"><Money value={settlement.net_payout} bold dash={false} /></Td>
                </tr>
              </tfoot>
            </Table>
          </Card>

          <Card
            title="Orders in the cycle"
            subtitle={`${forward.length} delivered, ${returned.length} cancelled or returned.`}
            padded={false}
            actions={mayEdit ? (
              <form action={refillSettlementAction}>
                <input type="hidden" name="id" value={settlement.id} />
                <button className={btn.ghost} title="Re-read the ledger for posted, unsettled invoices in this window">
                  Refresh from the ledger
                </button>
              </form>
            ) : undefined}
          >
            {docs.length === 0 ? (
              <EmptyState
                title="No orders in this window."
                hint="Only POSTED invoices and credit notes for this channel, dated inside the cycle and still owing something, are pulled in — an invoice already settled in an earlier cycle is deliberately left out."
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th width="130px">Invoice</Th>
                    <Th>Order ref</Th>
                    <Th width="100px">Date</Th>
                    <Th align="right" width="130px">Gross</Th>
                    <Th align="right" width="120px">Commission</Th>
                    <Th align="right" width="110px">Logistics</Th>
                    <Th align="right" width="110px">TCS + TDS</Th>
                    <Th align="right" width="130px">Payout</Th>
                    <Th align="right" width="120px">Still owing</Th>
                    {mayEdit && <Th width="60px" />}
                  </tr>
                </thead>
                <tbody>
                  {docs.map((d) => (
                    <tr key={d.id} className="hover:bg-canvas">
                      <Td>
                        <RefLink href={`/d/${d.document_id}`}>{d.number ?? 'Draft'}</RefLink>
                        {d.kind === 'return' && (
                          <div className="text-[11px] font-bold text-warn">Return</div>
                        )}
                      </Td>
                      <Td><span className="num !text-left text-ink-muted">{d.order_ref ?? '—'}</span></Td>
                      <Td>{fmtDate(d.doc_date)}</Td>
                      <Td align="right"><Money value={d.gross} dash={false} /></Td>
                      <Td align="right"><Money value={d.commission + d.commission_gst} /></Td>
                      <Td align="right"><Money value={d.shipping + d.shipping_gst + d.return_fee + d.return_gst} /></Td>
                      <Td align="right"><Money value={d.tcs + d.tds} /></Td>
                      <Td align="right"><Money value={d.payout} bold dash={false} /></Td>
                      <Td align="right"><Money value={d.residual} /></Td>
                      {mayEdit && (
                        <Td align="right">
                          <form action={removeSettlementOrderAction}>
                            <input type="hidden" name="settlement_id" value={settlement.id} />
                            <input type="hidden" name="row_id" value={d.id} />
                            <button className="text-[12px] font-bold text-ink-faint hover:text-negative"
                              title="Take this order out of the cycle. It stays on the ledger and will be offered in the next one.">
                              Remove
                            </button>
                          </form>
                        </Td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {/*
            THE CYCLE-LEVEL CHARGES, as one form per catalogue row.

            One form each rather than one big form, because each is saved
            independently and a single submit would make a typo in one figure
            re-save the other nineteen. Twenty small posts is also what makes
            each one its own audit row, which is what an auditor asking "when
            did the storage charge change" needs.
          */}
          <Card title="Cycle charges"
            subtitle="Storage, advertising, recall and one-off notes — the charges the channel levies on the cycle rather than on any order. Leave a figure blank and the row is not recorded at all.">
            {!mayEdit && charges.length === 0 && (
              <p className="text-[13px] text-ink-faint">No cycle charges were recorded.</p>
            )}
            {mayEdit ? (
              <div className="space-y-5">
                {(['additions', 'deductions', 'one_time'] as const).map((block) => (
                  <div key={block}>
                    <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-ink-faint">
                      {block === 'additions' ? 'Other additions'
                        : block === 'deductions' ? 'Other deductions' : 'One-timer adjustments'}
                    </h3>
                    <div className="space-y-2">
                      {CHARGE_KINDS.filter((k) => k.block === block).map((k) => {
                        const row = chargeOf(k.code);
                        return (
                          <form key={k.code} action={saveSettlementChargeAction}
                            className="flex flex-wrap items-center gap-2">
                            <input type="hidden" name="settlement_id" value={settlement.id} />
                            <input type="hidden" name="code" value={k.code} />
                            {row && <input type="hidden" name="id" value={row.id} />}
                            <span className="min-w-[230px] flex-1 text-[13px]">
                              {k.label}
                              <span className="ml-1.5 text-[11px] font-bold uppercase text-ink-faint">
                                {k.section === 'addition' ? 'add' : 'deduct'}
                              </span>
                            </span>
                            <input name="amount" inputMode="decimal"
                              defaultValue={row?.amount ? fromMinor(row.amount).toFixed(2) : ''}
                              placeholder="0.00" className={`${inputClass} w-[130px] text-right`} />
                            {k.gst && (
                              <input name="gst_amount" inputMode="decimal"
                                defaultValue={row?.gst_amount ? fromMinor(row.gst_amount).toFixed(2) : ''}
                                title={`GST. Blank takes the cycle's ${bpsToPct(settlement.charge_gst_bps)}.`}
                                placeholder={`GST @ ${bpsToPct(settlement.charge_gst_bps)}`}
                                className={`${inputClass} w-[130px] text-right`} />
                            )}
                            <button className={btn.ghost}>Save</button>
                          </form>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              charges.length > 0 && (
                <dl className="space-y-2 text-[13.5px]">
                  {charges.map((c) => (
                    <div key={c.id} className="flex justify-between gap-6">
                      <dt className="text-ink-muted">
                        {c.label}
                        <span className="ml-1.5 text-[11px] font-bold uppercase text-ink-faint">
                          {c.section === 'addition' ? 'add' : 'deduct'}
                        </span>
                      </dt>
                      <dd><Money value={c.amount + c.gst_amount} dash={false} /></dd>
                    </div>
                  ))}
                </dl>
              )
            )}
          </Card>

          {entry && (
            <Card title="Journal entry" subtitle="What this cycle did to the general ledger." padded={false}
              actions={
                <Link href={`/accounting/entries/${settlement.entry_id}`}
                  className="text-[13px] font-bold text-brand hover:underline">Open →</Link>
              }>
              <Table>
                <thead><tr><Th>Account</Th><Th>Label</Th><Th align="right">Debit</Th><Th align="right">Credit</Th></tr></thead>
                <tbody>
                  {entry.lines.map((l) => (
                    <tr key={l.id}>
                      <Td>
                        <Link href={`/reports/general-ledger?account=${l.account_id}`}
                          className="font-semibold text-brand hover:underline">{l.account_code}</Link>{' '}
                        <span className="text-ink-muted">{l.account_name}</span>
                      </Td>
                      <Td><span className="text-ink-muted">{l.label ?? '—'}</span></Td>
                      <Td align="right"><Money value={l.debit} /></Td>
                      <Td align="right"><Money value={l.credit} /></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}

          <Card title="Audit trail" subtitle="Every action on this cycle, in order.">
            <ol className="space-y-2.5 text-[13px]">
              {trail.map((a) => (
                <li key={a.id} className="flex gap-3">
                  <span className="num w-[120px] shrink-0 !text-left text-ink-faint">
                    {new Date(a.at).toLocaleString('en-IN', {
                      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                  <span>
                    <span className="font-semibold">{titleise(a.action)}</span>
                    {a.summary ? ` — ${a.summary}` : ''}
                    <span className="text-ink-faint"> · {a.user_name}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="The cycle">
            <DefList rows={[
              ['Channel',
                <Link key="p" href={`/sales/customers/${settlement.partner_id}`}
                  className="text-brand hover:underline">{settlement.partner_name}</Link>],
              ['Window', `${fmtDate(settlement.cycle_from)} – ${fmtDate(settlement.cycle_to)}`],
              ['Payout date', fmtDate(settlement.pay_date)],
              ['Bank UTR', settlement.utr ?? '—'],
              ['Paid into', settlement.bank_account_name ?? '—'],
              ['Commission', bpsOrDash(settlement.commission_bps)],
              ['GST on charges', bpsOrDash(settlement.charge_gst_bps)],
              ['Shipping per order', fmt(settlement.shipping_charge)],
              ['Return charge', fmt(settlement.return_charge)],
              ['TCS', bpsOrDash(settlement.tcs_bps)],
              ['TDS', bpsOrDash(settlement.tds_bps)],
            ]} />
            {settlement.note && (
              <p className="mt-4 border-t border-line pt-4 text-[13px] text-ink-muted">{settlement.note}</p>
            )}
          </Card>

          <Card title="Payout">
            <dl className="space-y-2 text-[14px]">
              <SummaryRow label="Collected for us" value={settlement.customer_payable} bold />
              <SummaryRow label="Additions" value={settlement.additions} />
              <SummaryRow label="Deductions" value={-settlement.deductions} />
              <SummaryRow label="Net payout" value={settlement.net_payout} bold />
            </dl>

            <div className="mt-5 flex flex-col gap-2 no-print">
              {draft && mayPost && (
                <form action={postSettlementAction}>
                  <input type="hidden" name="id" value={settlement.id} />
                  <button className={`${btn.primary} w-full`}>Post to the ledger</button>
                </form>
              )}
              {draft && !mayPost && (
                <p className="text-[12px] text-ink-faint">
                  Posting a settlement books the commission, the GST and the tax withheld and
                  discharges every invoice in the cycle, so it needs payment-approval rights.
                </p>
              )}
              {settlement.state === 'posted' && mayPost && (
                <form action={reverseSettlementAction} className="space-y-2">
                  <input type="hidden" name="id" value={settlement.id} />
                  <input type="date" name="date" defaultValue={today} className={inputClass} />
                  <input name="reason" placeholder="Why is this being reversed?" className={inputClass} />
                  <button className={`${btn.danger} w-full`}>Reverse</button>
                </form>
              )}
              {settlement.state === 'posted' && (
                <p className="text-[12px] text-ink-faint">
                  Reversing releases every invoice in the cycle back to unsettled and reverses the
                  entry. Nothing is deleted — both halves stay on the ledger.
                </p>
              )}
            </div>
          </Card>

          {mayEdit && (
            <Card title="Terms and dates"
              subtitle="Changing a rate re-costs every order in the cycle.">
              <form action={saveSettlementAction} className="space-y-3">
                <input type="hidden" name="id" value={settlement.id} />
                <input type="hidden" name="partner_name" value={settlement.partner_name ?? ''} />
                <Field label="Cycle from">
                  <input type="date" name="cycle_from" defaultValue={settlement.cycle_from} className={inputClass} />
                </Field>
                <Field label="Cycle to">
                  <input type="date" name="cycle_to" defaultValue={settlement.cycle_to} className={inputClass} />
                </Field>
                <Field label="Payout date">
                  <input type="date" name="pay_date" defaultValue={settlement.pay_date ?? today} className={inputClass} />
                </Field>
                <Field label="Bank UTR">
                  <input name="utr" defaultValue={settlement.utr ?? ''} className={inputClass} />
                </Field>
                <Field label="Paid into">
                  <select name="bank_account_id" className={inputClass}
                    defaultValue={settlement.bank_account_id ?? ''}>
                    {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Commission %">
                    <input name="commission_pct" inputMode="decimal"
                      defaultValue={(settlement.commission_bps / 100).toString()}
                      className={`${inputClass} text-right`} />
                  </Field>
                  <Field label="Charge GST %">
                    <input name="charge_gst_pct" inputMode="decimal"
                      defaultValue={(settlement.charge_gst_bps / 100).toString()}
                      className={`${inputClass} text-right`} />
                  </Field>
                  <Field label="Shipping / order">
                    <input name="shipping_charge" inputMode="decimal"
                      defaultValue={fromMinor(settlement.shipping_charge).toFixed(2)}
                      className={`${inputClass} text-right`} />
                  </Field>
                  <Field label="Return / order">
                    <input name="return_charge" inputMode="decimal"
                      defaultValue={fromMinor(settlement.return_charge).toFixed(2)}
                      className={`${inputClass} text-right`} />
                  </Field>
                  <Field label="TCS %">
                    <input name="tcs_pct" inputMode="decimal"
                      defaultValue={(settlement.tcs_bps / 100).toString()}
                      className={`${inputClass} text-right`} />
                  </Field>
                  <Field label="TDS %">
                    <input name="tds_pct" inputMode="decimal"
                      defaultValue={(settlement.tds_bps / 100).toString()}
                      className={`${inputClass} text-right`} />
                  </Field>
                </div>
                <Field label="Unsettled from the previous cycle">
                  <input name="previous_unsettled" inputMode="decimal"
                    defaultValue={fromMinor(settlement.previous_unsettled).toFixed(2)}
                    className={`${inputClass} text-right`} />
                </Field>
                <Field label="Note">
                  <textarea name="note" rows={2} defaultValue={settlement.note ?? ''} className={inputClass} />
                </Field>
                <button className={`${btn.ghost} w-full`}>Save and re-cost</button>
              </form>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function SectionRow({ label }: { label: string }) {
  return (
    <tr className="bg-canvas">
      <Td colSpan={4}>
        <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-faint">{label}</span>
      </Td>
    </tr>
  );
}

function BreakupRow({ label, forward, returned, indent, bold }: {
  label: string; forward: number; returned: number; indent?: boolean; bold?: boolean;
}) {
  return (
    <tr>
      <Td>
        <span className={`${indent ? 'pl-4 text-ink-muted' : ''} ${bold ? 'font-bold' : ''}`}>{label}</span>
      </Td>
      <Td align="right"><Money value={forward} bold={bold} /></Td>
      <Td align="right"><Money value={returned} bold={bold} /></Td>
      <Td align="right"><Money value={forward + returned} bold /></Td>
    </tr>
  );
}

function SummaryRow({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className="flex justify-between gap-6">
      <dt className={bold ? 'font-bold' : 'text-ink-muted'}>{label}</dt>
      <dd><Money value={value} bold={bold} dash={false} /></dd>
    </div>
  );
}
