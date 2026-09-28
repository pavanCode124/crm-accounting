import Link from 'next/link';
import { fmtDate, isoDate, titleise } from '@/lib/accounting';
import { fmt } from '@/lib/money';
import { listPartners, getPartner, listPaymentTerms } from '@/server/accounting/masters';
import { listDocuments } from '@/server/accounting/documents';
import { listPayments } from '@/server/accounting/payments';
import { partnerBalance, partnerLedger } from '@/server/accounting/reports';
import { listBookings } from '@/server/accounting/analytics';
import { savePartnerAction } from '@/app/actions';
import {
  Card, Table, Th, Td, Money, Chip, EmptyState, RefLink, StatTile, Field, inputClass, btn, Tabs, DefList,
} from './ui';

/**
 * Customers and suppliers.
 *
 * ONE partner master with two faces (plan section 9: do not create a second
 * customer master). The list a page shows is a filter on `is_customer` /
 * `is_supplier`, and an agency that is both — a reseller who also sells you
 * hotel rooms — appears in both with one balance sheet position each.
 */

export async function PartnerList({ orgId, side, basePath, search }: {
  orgId: string; side: 'customer' | 'supplier'; basePath: string; search?: string;
}) {
  const partners = await listPartners(orgId, { side, search });
  const isCustomer = side === 'customer';
  const total = partners.reduce((s, p) => s + (isCustomer ? (p.receivable ?? 0) : (p.payable ?? 0)), 0);

  return (
    <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
      <Card padded={false}>
        {partners.length === 0 ? (
          <EmptyState title="Nobody here yet." hint="Add one with the form beside this list." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th><Th>Type</Th><Th>Contact</Th><Th>GSTIN</Th>
                <Th align="right">{isCustomer ? 'Receivable' : 'Payable'}</Th>
                {isCustomer && <Th align="right">Credit limit</Th>}
              </tr>
            </thead>
            <tbody>
              {partners.map((p) => {
                const balance = isCustomer ? (p.receivable ?? 0) : (p.payable ?? 0);
                const over = isCustomer && p.credit_limit > 0 && balance > p.credit_limit;
                return (
                  <tr key={p.id} className="hover:bg-canvas">
                    <Td><RefLink href={`${basePath}/${p.id}`}>{p.name}</RefLink></Td>
                    <Td><Chip state="draft" label={titleise(p.partner_type)} /></Td>
                    <Td>
                      <span className="text-ink-muted">{p.email ?? p.phone ?? '—'}</span>
                    </Td>
                    <Td><span className="num !text-left text-ink-muted">{p.gstin ?? '—'}</span></Td>
                    <Td align="right"><Money value={balance} bold /></Td>
                    {isCustomer && (
                      <Td align="right">
                        <Money value={p.credit_limit} />
                        {over && <div className="text-[11px] font-bold text-negative">Over limit</div>}
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-canvas">
                <Td colSpan={4}><span className="font-bold">{partners.length} {side}(s)</span></Td>
                <Td align="right"><Money value={total} bold dash={false} /></Td>
                {isCustomer && <Td />}
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>

      <Card title={`New ${side}`}>
        <form action={savePartnerAction} className="space-y-3">
          <input type="hidden" name="side" value={side} />
          <Field label="Name"><input name="name" required className={inputClass} /></Field>
          <Field label="Type">
            <select name="partner_type" className={inputClass} defaultValue={isCustomer ? 'b2c' : 'b2b'}>
              {(isCustomer ? ['b2c', 'b2b', 'agency', 'reseller'] : ['b2b', 'agency']).map((t) =>
                <option key={t} value={t}>{t.toUpperCase()}</option>)}
            </select>
          </Field>
          <Field label="Email"><input name="email" type="email" className={inputClass} /></Field>
          <Field label="Phone"><input name="phone" className={inputClass} /></Field>
          <Field label="GSTIN"><input name="gstin" className={inputClass} placeholder="36AABCW1234F1Z5" /></Field>
          <Field label="PAN"><input name="pan" className={inputClass} /></Field>
          <Field label="Payment terms">
            <select name="payment_terms_id" className={inputClass} defaultValue="">
              <option value="">—</option>
              {(await listPaymentTerms(orgId)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          {isCustomer ? (
            <Field label="Credit limit" hint="Shown on the customer's page; it does not block an invoice.">
              <input name="credit_limit" inputMode="decimal" className={`${inputClass} text-right`} />
            </Field>
          ) : (
            <Field label="TDS section" hint="Offered by default when a bill for this supplier is raised.">
              <select name="tds_section" className={inputClass} defaultValue="">
                <option value="">None</option>
                {['194C', '194H', '194J'].map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </Field>
          )}
          <button className={`${btn.primary} w-full`}>Add {side}</button>
        </form>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export async function PartnerDetail({ orgId, partnerId, side, basePath, tab = 'overview' }: {
  orgId: string; partnerId: string; side: 'customer' | 'supplier'; basePath: string; tab?: string;
}) {
  const p = await getPartner(orgId, partnerId);
  if (!p) return <EmptyState title="That partner no longer exists." />;

  const isCustomer = side === 'customer';
  const bal = await partnerBalance(orgId, partnerId);
  const docTypes = isCustomer ? (['out_invoice', 'out_refund'] as const) : (['in_invoice', 'in_refund'] as const);
  const docs = await listDocuments(orgId, { partnerId, docType: [...docTypes] });
  const payments = await listPayments(orgId, { partnerId, limit: 100 });
  const bookings = isCustomer ? (await listBookings(orgId)).filter((b) => b.partner_name === p.name) : [];
  const ledger = await partnerLedger(orgId, partnerId, { from: '1900-01-01', to: isoDate() });

  const base = `${basePath}/${partnerId}`;
  const tabs = [
    { label: 'Overview', href: base },
    { label: isCustomer ? 'Invoices' : 'Bills', href: `${base}?tab=documents`, count: docs.length },
    { label: 'Payments', href: `${base}?tab=payments`, count: payments.length },
    ...(isCustomer ? [{ label: 'Bookings', href: `${base}?tab=bookings`, count: bookings.length }] : []),
    { label: 'Ledger', href: `${base}?tab=ledger`, count: ledger.lines.length },
  ];

  return (
    <>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Outstanding" value={isCustomer ? bal.receivable : bal.payable}
          tone={bal.overdue > 0 ? 'warn' : 'neutral'} hint={`${bal.openDocs} open document(s)`} />
        <StatTile label="Overdue" value={bal.overdue} tone={bal.overdue > 0 ? 'negative' : 'neutral'} />
        <StatTile label={isCustomer ? 'Total invoiced' : 'Total purchased'} value={bal.invoiced} />
        <StatTile label="Unapplied advances" value={bal.advances} hint="Money held with no document against it" />
      </div>

      <Tabs tabs={tabs} active={tab === 'overview' ? base : `${base}?tab=${tab}`} />

      {tab === 'overview' && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="Details">
            <DefList rows={[
              ['Type', titleise(p.partner_type)],
              ['Email', p.email ?? '—'],
              ['Phone', p.phone ?? '—'],
              ['GSTIN', p.gstin ?? '—'],
              ['PAN', p.pan ?? '—'],
              ['Address', p.address ?? '—'],
              ...(isCustomer
                ? [['Credit limit', fmt(p.credit_limit)] as [string, string]]
                : [['TDS section', p.tds_section ?? '—'] as [string, string]]),
            ]} />
            <div className="mt-5 flex gap-2">
              <Link className={btn.primary}
                href={`${isCustomer ? '/sales/invoices/new' : '/purchases/bills/new'}?partner=${p.id}`}>
                {isCustomer ? '+ Invoice' : '+ Bill'}
              </Link>
              <Link className={btn.ghost} href={`${isCustomer ? '/sales' : '/purchases'}/payments`}>
                Record payment
              </Link>
            </div>
          </Card>
          <Card title="Statement summary" subtitle="Everything this partner owes or is owed, from the ledger.">
            <DefList rows={[
              ['Receivable', <Money key="r" value={bal.receivable} />],
              ['Payable', <Money key="p" value={bal.payable} />],
              ['Overdue', <Money key="o" value={bal.overdue} />],
              ['Paid to date', <Money key="pd" value={bal.paid} />],
              ['Open documents', String(bal.openDocs)],
            ]} />
            <Link href={`/reports/general-ledger?partner=${p.id}`}
              className="mt-4 block text-[13px] font-bold text-brand hover:underline">
              Full ledger extract →
            </Link>
          </Card>
        </div>
      )}

      {tab === 'documents' && (
        <Card padded={false}>
          <Table>
            <thead>
              <tr><Th>Number</Th><Th>Date</Th><Th>Due</Th><Th align="right">Total</Th>
                <Th align="right">Outstanding</Th><Th>Status</Th></tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="hover:bg-canvas">
                  <Td>
                    <RefLink href={`${docPath(d.doc_type)}/${d.id}`}>{d.number ?? 'Draft'}</RefLink>
                  </Td>
                  <Td>{fmtDate(d.doc_date)}</Td>
                  <Td>{fmtDate(d.due_date)}</Td>
                  <Td align="right"><Money value={d.total} dash={false} /></Td>
                  <Td align="right"><Money value={d.residual} bold /></Td>
                  <Td><Chip state={d.state === 'posted' ? d.payment_state : d.state} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {tab === 'payments' && (
        <Card padded={false}>
          <Table>
            <thead><tr><Th>Number</Th><Th>Date</Th><Th>Method</Th><Th align="right">Amount</Th>
              <Th align="right">Unallocated</Th><Th>Status</Th></tr></thead>
            <tbody>
              {payments.map((pay) => (
                <tr key={pay.id}>
                  <Td><span className="font-bold">{pay.number}</span></Td>
                  <Td>{fmtDate(pay.pay_date)}</Td>
                  <Td>{titleise(pay.method)}{pay.is_advance ? ' · advance' : ''}</Td>
                  <Td align="right"><Money value={pay.amount} dash={false} /></Td>
                  <Td align="right"><Money value={pay.unallocated} /></Td>
                  <Td><Chip state={pay.state} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {tab === 'bookings' && (
        <Card padded={false}>
          <Table>
            <thead><tr><Th>Ref</Th><Th>Trip</Th><Th>Departs</Th><Th align="right">Value</Th><Th>Status</Th></tr></thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id}>
                  <Td><RefLink href={`/bookings/${b.id}`}>{b.ref}</RefLink></Td>
                  <Td>{b.title}</Td>
                  <Td>{fmtDate(b.start_date)}</Td>
                  <Td align="right"><Money value={b.sell_value} /></Td>
                  <Td><Chip state={b.status} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {tab === 'ledger' && (
        <Card padded={false} title="Partner ledger" subtitle="Every posted line carrying this partner.">
          <Table>
            <thead><tr><Th>Date</Th><Th>Entry</Th><Th>Account</Th><Th>Label</Th>
              <Th align="right">Debit</Th><Th align="right">Credit</Th><Th align="right">Running</Th></tr></thead>
            <tbody>
              {ledger.lines.map((l) => (
                <tr key={l.id}>
                  <Td>{fmtDate(l.entry_date)}</Td>
                  <Td><RefLink href={`/accounting/entries/${l.entry_id}`}>{l.entry_no}</RefLink></Td>
                  <Td><span className="text-ink-muted">{l.account_code} {l.account_name}</span></Td>
                  <Td><span className="text-ink-muted">{l.label ?? l.reference ?? '—'}</span></Td>
                  <Td align="right"><Money value={l.debit} /></Td>
                  <Td align="right"><Money value={l.credit} /></Td>
                  <Td align="right"><Money value={l.running ?? 0} bold dash={false} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}

function docPath(docType: string): string {
  return {
    out_invoice: '/sales/invoices',
    out_refund: '/sales/credit-notes',
    in_invoice: '/purchases/bills',
    in_refund: '/purchases/debit-notes',
  }[docType] ?? '/sales/invoices';
}
