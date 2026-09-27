import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { one, msg, type SearchParams } from '@/lib/range';
import { listBankAccounts, listBankTransactions, suggestMatches } from '@/server/accounting/banking';
import { listDocuments } from '@/server/accounting/documents';
import { accountOptions, partnerOptions } from '@/server/options';
import { fmtDate } from '@/lib/accounting';
import { fmt } from '@/lib/money';
import { reconcileAction } from '@/app/actions';
import { PageHeader, Card, Banner, EmptyState, inputClass, btn, Chip } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Bank reconciliation — plan section 18.
 *
 * One statement line at a time, with the best guesses ranked above it and a
 * person confirming every one. There is no auto-post: a suggestion that is
 * 90% right is 10% wrong, and a wrongly matched receipt is worse than an
 * unmatched one because nobody goes looking for it.
 *
 * Three ways out of every line, because there are only three things a bank
 * movement can be:
 *   1. a payment already keyed in       → match it
 *   2. money against a document         → create the payment and allocate
 *   3. neither                          → post it straight to an account
 */
export default async function ReconcilePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const params = await searchParams;
  const m = msg(params);
  const accounts = listBankAccounts(s.orgId);
  const accountId = one(params, 'account') ?? accounts[0]?.id;
  const txns = listBankTransactions(s.orgId, { bankAccountId: accountId, state: 'unreconciled', limit: 40 });

  const customers = partnerOptions(s.orgId, 'customer');
  const suppliers = partnerOptions(s.orgId, 'supplier');
  const glAccounts = accountOptions(s.orgId);
  const openInvoices = listDocuments(s.orgId, { docType: 'out_invoice', state: 'posted', limit: 200 })
    .filter((d) => d.residual > 0);
  const openBills = listDocuments(s.orgId, { docType: 'in_invoice', state: 'posted', limit: 200 })
    .filter((d) => d.residual > 0);
  const returnTo = `/banking/reconcile?account=${accountId}`;

  return (
    <>
      <PageHeader
        title="Reconciliation"
        subtitle="Every line the bank reported, explained once and then left alone."
        accent="var(--color-sec-banking)"
        actions={
          <form method="get" className="flex items-center gap-2">
            <select name="account" defaultValue={accountId} className={`${inputClass} w-[220px]`}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <button className={btn.ghost}>Switch</button>
          </form>
        }
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      {txns.length === 0 ? (
        <Card>
          <EmptyState
            title="Everything is reconciled."
            hint="Import the next statement and the lines will appear here."
            action={<Link href={`/banking/${accountId}`} className={btn.primary}>Import a statement</Link>}
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {txns.map((t) => {
            const inbound = t.amount > 0;
            const suggestions = suggestMatches(s.orgId, t.id);
            const partners = inbound ? customers : suppliers;
            const docs = inbound ? openInvoices : openBills;

            return (
              <Card key={t.id} padded={false}>
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-4">
                  <div>
                    <div className={`text-[22px] font-extrabold num !text-left ${inbound ? 'text-positive' : 'text-negative'}`}>
                      {inbound ? '+' : '−'}{fmt(Math.abs(t.amount))}
                    </div>
                    <div className="mt-1 text-[13.5px] font-semibold">{t.description}</div>
                    <div className="text-[12px] text-ink-faint">
                      {fmtDate(t.txn_date)}{t.reference ? ` · ${t.reference}` : ''}
                    </div>
                  </div>
                  <Chip state="unreconciled" label={inbound ? 'Money in' : 'Money out'} />
                </div>

                {suggestions.length > 0 && (
                  <div className="border-b border-line px-5 py-4">
                    <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">
                      Suggested
                    </div>
                    <div className="space-y-2">
                      {suggestions.map((sg) => (
                        <form key={`${sg.kind}-${sg.id}`} action={reconcileAction}
                          className="flex flex-wrap items-center gap-3 rounded-[10px] border border-line px-3.5 py-2.5">
                          <input type="hidden" name="txn_id" value={t.id} />
                          <input type="hidden" name="return_to" value={returnTo} />
                          {sg.kind === 'payment' ? (
                            <>
                              <input type="hidden" name="mode" value="payment" />
                              <input type="hidden" name="payment_id" value={sg.id} />
                            </>
                          ) : (
                            <>
                              <input type="hidden" name="mode" value="create" />
                              <input type="hidden" name="partner_id" value={sg.partnerId ?? ''} />
                              <input type="hidden" name="document_id" value={sg.id} />
                            </>
                          )}
                          <span className="font-bold">{sg.label}</span>
                          <span className="text-[13px] text-ink-muted">{sg.partnerName}</span>
                          <span className="num text-[13px]">{fmt(sg.amount)}</span>
                          <span className="text-[12px] text-ink-faint">{sg.reason}</span>
                          <span className="ml-auto flex items-center gap-3">
                            <span className="text-[11px] font-bold text-ink-faint">{sg.score}% match</span>
                            <button className={btn.primary}>Match</button>
                          </span>
                        </form>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid gap-4 px-5 py-4 lg:grid-cols-2">
                  <form action={reconcileAction} className="space-y-2.5">
                    <input type="hidden" name="txn_id" value={t.id} />
                    <input type="hidden" name="mode" value="create" />
                    <input type="hidden" name="return_to" value={returnTo} />
                    <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">
                      Record as a {inbound ? 'customer receipt' : 'supplier payment'}
                    </div>
                    <select name="partner_id" required className={inputClass}>
                      <option value="">Choose {inbound ? 'customer' : 'supplier'}…</option>
                      {partners.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                    <select name="document_id" className={inputClass} defaultValue="">
                      <option value="">— no document (advance / on account) —</option>
                      {docs.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.number} · {d.partner_name} · ₹{(d.residual / 100).toFixed(2)}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-2 text-[13px] font-semibold">
                      <input type="checkbox" name="is_advance" className="h-4 w-4" /> Treat as an advance
                    </label>
                    <button className={btn.ghost}>Create payment and reconcile</button>
                  </form>

                  <form action={reconcileAction} className="space-y-2.5">
                    <input type="hidden" name="txn_id" value={t.id} />
                    <input type="hidden" name="mode" value="account" />
                    <input type="hidden" name="return_to" value={returnTo} />
                    <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-faint">
                      Or post straight to an account
                    </div>
                    <select name="account_id" required className={inputClass}>
                      <option value="">Choose account…</option>
                      {glAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                    </select>
                    <input name="label" className={inputClass} defaultValue={t.description ?? ''} />
                    <button className={btn.ghost}>Post and reconcile</button>
                    <p className="text-[12px] text-ink-faint">
                      For bank charges, interest, a loan drawdown — anything with no partner behind it.
                    </p>
                  </form>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
