import { ctx } from '@/server/bootstrap';
import { msg, type SearchParams } from '@/lib/range';
import { getConnection } from '@/server/crm/connection';
import { CRM_BACKEND_URL, CRM_CONFIGURED } from '@/server/crm/client';
import { scalar } from '@/server/db';
import { crmConnectAction, crmSyncAction, crmDisconnectAction, crmForgetLinksAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Field, inputClass, btn, StatTile, DefList, LinkButton,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Settings → CRM Sync.
 *
 * The screen that stops this app inventing its own agency. Everything the
 * books are about — who the customers are, what was invoiced, what has been
 * paid — belongs to TripzoCRM; this is where an accountant points the ledger at
 * it and presses the button.
 *
 * WHY THERE IS A PASSWORD BOX HERE AT ALL. The CRM backend authenticates a
 * PERSON, not an application: it resolves the caller's organisation from their
 * Supabase token and there is no service account to issue instead. So the
 * accountant signs in as themselves. The password is posted once, exchanged
 * for a token, and never stored — see src/server/crm/client.ts. What is kept
 * is the token and its refresh token, both revocable from the CRM.
 */
export default async function CrmSyncPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const m = msg(await searchParams);
  const conn = getConnection(s.orgId);

  const imported = {
    partners: scalar("SELECT COUNT(*) FROM crm_links WHERE org_id=? AND kind='partner'", s.orgId),
    bookings: scalar("SELECT COUNT(*) FROM crm_links WHERE org_id=? AND kind='booking'", s.orgId),
    documents: scalar("SELECT COUNT(*) FROM crm_links WHERE org_id=? AND kind='document'", s.orgId),
    payments: scalar("SELECT COUNT(*) FROM crm_links WHERE org_id=? AND kind='payment'", s.orgId),
  };

  return (
    <>
      <PageHeader
        title="CRM Sync"
        subtitle="Pull this agency's real customers, suppliers, trips, invoices and receipts from TripzoCRM as DRAFTS. A sync types; an accountant posts."
        accent="var(--color-sec-settings)"
        actions={<LinkButton href="/settings">Back to settings</LinkButton>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      {!CRM_CONFIGURED && (
        <Banner tone="warn">
          <code>TRIPZO_SUPABASE_ANON_KEY</code> is not set. Copy it from{' '}
          <code>tripzo-crm-mobile/.env</code> into this app&apos;s <code>.env.local</code>, then restart the
          dev server. The key is public by design — it is inlined into the mobile bundle — but it is not
          committed here.
        </Banner>
      )}

      <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-5">
          {conn ? (
            <Card title="Connected" subtitle={`Signed in to ${CRM_BACKEND_URL}`}>
              <DefList rows={[
                ['Signed in as', conn.email],
                ['Agency', conn.crm_org_name ?? s.orgName],
                ['Last sync', conn.last_sync_at
                  ? new Date(conn.last_sync_at).toLocaleString('en-IN')
                  : 'Never'],
                ['Last result', conn.last_result ?? '—'],
              ]} />

              <div className="mt-5 flex flex-wrap items-center gap-2">
                <form action={crmSyncAction}>
                  <button className={btn.primary}>Sync now</button>
                </form>
                <form action={crmDisconnectAction}>
                  <button className={btn.ghost}>Disconnect</button>
                </form>
              </div>

              <p className="mt-3 text-[12px] text-ink-faint">
                A sync imports what is not already here and leaves what is. Re-running it is safe —
                every CRM record is matched to what it became last time, so nothing arrives twice.
              </p>
              <div className="mt-4">
                <Banner tone="info">
                  <strong>A sync posts nothing.</strong> Invoices and receipts land as drafts in{' '}
                  <a href="/accounting/review" className="font-bold text-brand hover:underline">
                    Accounting → Review &amp; Post
                  </a>
                  , where you check the accounts, the tax and the trip each one is tagged to, and post
                  it yourself. Until you do, none of it is in a balance, a report or a return.
                </Banner>
              </div>
            </Card>
          ) : (
            <Card title="Connect to TripzoCRM"
              subtitle="Your own CRM sign-in. The password is exchanged for a token and never stored.">
              <form action={crmConnectAction} className="space-y-4">
                <Field label="CRM email">
                  <input name="email" type="email" required autoComplete="username"
                    className={inputClass} placeholder="you@wandertravels.in" />
                </Field>
                <Field label="Password" hint="Used for this one sign-in call. Not written to the database or the audit log.">
                  <input name="password" type="password" required autoComplete="current-password"
                    className={inputClass} />
                </Field>
                <button className={btn.primary} disabled={!CRM_CONFIGURED}>Connect</button>
              </form>
            </Card>
          )}

          <Card title="What a sync brings across">
            <ol className="space-y-3 text-[13.5px]">
              <Step n={1} title="The agency">
                Its name replaces whatever this app was seeded with — that is the string on the
                masthead and every report header.
              </Step>
              <Step n={2} title="Suppliers and leads">
                Suppliers become payable partners; leads become customers. A lead that has reached a
                trip also becomes a booking, with the analytic account that lets costs be tagged to it.
              </Step>
              <Step n={3} title="Invoices, as drafts">
                Posted and sent CRM invoices only. A CRM draft is a proposal and a cancelled invoice
                never happened; neither belongs in a ledger, and both are counted as skipped rather
                than quietly dropped. What does come across arrives with the customer, the trip, the
                dates, the lines and the amounts already filled in — and sits in Review &amp; Post
                until you read it.
              </Step>
              <Step n={4} title="Receipts, as drafts">
                Each payment arrives unposted, with the invoice it was taken on written into its
                note. Post the invoice, post the receipt, then allocate the one to the other — three
                deliberate acts, because a debtor that clears itself is a debtor nobody checked.
              </Step>
              <Step n={5} title="Nothing else, ever">
                No journal entry, no tax posting and no balance moves because of a sync. The only
                thing that writes to these books is somebody pressing Post.
              </Step>
            </ol>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Imported so far" subtitle="Records this app has linked to a CRM record.">
            <div className="grid grid-cols-2 gap-3">
              <StatTile label="Partners" value={String(imported.partners)} />
              <StatTile label="Bookings" value={String(imported.bookings)} />
              <StatTile label="Invoices" value={String(imported.documents)} />
              <StatTile label="Payments" value={String(imported.payments)} />
            </div>
          </Card>

          <Card title="Clear import history">
            <p className="mb-3 text-[13px] text-ink-muted">
              Forgets which CRM record became which local record, so the next sync imports everything
              again.
            </p>
            {/*
              Said plainly, because the obvious assumption about a button like
              this is the dangerous one. It is not an undo: the postings the
              earlier import made are still in the ledger and will still be,
              afterwards, alongside the new ones.
            */}
            <Banner tone="warn">
              This does not delete anything already posted. A posted entry is never deleted in this
              system — so re-importing creates a <strong>second</strong> copy of every invoice, not a
              replacement. Use it only on books you intend to reset.
            </Banner>
            <form action={crmForgetLinksAction} className="space-y-3">
              <Field label="Type FORGET to confirm">
                <input name="confirm" className={inputClass} placeholder="FORGET" />
              </Field>
              <button className={btn.danger}>Clear import history</button>
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-canvas text-[12px] font-bold text-ink-muted">
        {n}
      </span>
      <span>
        <span className="font-bold">{title}. </span>
        <span className="text-ink-muted">{children}</span>
      </span>
    </li>
  );
}
