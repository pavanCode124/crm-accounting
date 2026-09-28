import { ctx } from '@/server/bootstrap';
import { msg, one, type SearchParams } from '@/lib/range';
import { listAssets, assetSchedule, listDeferrals } from '@/server/accounting/assets';
import { fmtDate, isoDate, titleise } from '@/lib/accounting';
import { runDepreciationAction, runDeferralsAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Table, Th, Td, Money, Chip, StatTile, EmptyState, btn, Bar, Tabs, LinkButton,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Fixed assets and deferrals — plan sections 33 to 35.
 *
 * Both are the same idea: one amount recognised a slice at a time, on a
 * schedule that is AGREED ONCE and then followed. The schedule is stored, not
 * recomputed on every view, so changing a useful life later cannot silently
 * rewrite entries that have already been posted and filed.
 *
 * The two tabs are separate components rather than one long ternary. That is
 * not only readability: a single JSX expression holding both trees is large
 * enough to make the TypeScript checker's inference pathological, which showed
 * up as the compiler running out of memory on this one file.
 */
export default async function AssetsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = ctx();
  const params = await searchParams;
  const m = msg(params);
  const tab = one(params, 'tab') ?? 'assets';
  const assets = listAssets(s.orgId);
  const deferrals = listDeferrals(s.orgId);
  const today = isoDate();

  const gross = assets.reduce((sum, a) => sum + a.purchase_value, 0);
  const net = assets.reduce((sum, a) => sum + a.book_value, 0);
  const pendingDeferral = deferrals.reduce((sum, d) => sum + (d.amount - d.recognised), 0);

  return (
    <>
      <PageHeader
        title="Assets & Deferrals"
        subtitle="Things the agency owns, and costs that belong to months other than the one they were paid in."
        accent="var(--color-sec-settings)"
        actions={
          <LinkButton href={`/assets/new?tab=${tab}`} variant="primary">
            {tab === 'deferrals' ? '+ New Deferral' : '+ New Asset'}
          </LinkButton>
        }
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatTile label="Asset cost" value={gross} />
        <StatTile label="Net book value" value={net} />
        <StatTile label="Depreciated to date" value={gross - net} />
        <StatTile label="Still to recognise" value={pendingDeferral} />
      </div>

      <Tabs
        tabs={[
          { label: 'Fixed assets', href: '/assets?tab=assets', count: assets.length },
          { label: 'Deferrals', href: '/assets?tab=deferrals', count: deferrals.length },
        ]}
        active={`/assets?tab=${tab}`}
      />

      {tab === 'assets'
        ? <AssetsTab orgId={s.orgId} assets={assets} today={today} />
        : <DeferralsTab deferrals={deferrals} today={today} />}
    </>
  );
}

type AssetRow = ReturnType<typeof listAssets>[number];
type DeferralRow = ReturnType<typeof listDeferrals>[number];

function AssetsTab({ orgId, assets, today }: { orgId: string; assets: AssetRow[]; today: string }) {
  const running = assets.filter((a) => a.state === 'running').slice(0, 2);

  return (
      <div className="space-y-5">
        <Card
          title="Fixed assets"
          padded={false}
          actions={
            <form action={runDepreciationAction}>
              <input type="hidden" name="up_to" value={today} />
              <button className={btn.primary}>Post depreciation due</button>
            </form>
          }
        >
          {assets.length === 0 && <EmptyState title="No assets recorded." />}
          {assets.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <Th>Asset</Th><Th>Bought</Th><Th>Method</Th><Th align="right">Cost</Th>
                  <Th align="right">Depreciated</Th><Th align="right">Book value</Th>
                  <Th>State</Th><Th width="140px">Life used</Th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={a.id} className="hover:bg-canvas">
                    <Td><span className="font-semibold">{a.name}</span></Td>
                    <Td>{fmtDate(a.purchase_date)}</Td>
                    <Td>
                      <span className="text-ink-muted">
                        {titleise(a.method.replace('_', ' '))} · {a.life_months}m
                      </span>
                    </Td>
                    <Td align="right"><Money value={a.purchase_value} dash={false} /></Td>
                    <Td align="right"><Money value={a.depreciated} /></Td>
                    <Td align="right"><Money value={a.book_value} bold dash={false} /></Td>
                    <Td><Chip state={a.state} /></Td>
                    <Td>
                      <Bar value={a.depreciated} max={Math.max(a.purchase_value, 1)}
                        color="var(--color-sec-settings)" />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        {running.map((a) => (
          <Card key={a.id} title={`Schedule — ${a.name}`} padded={false}
            subtitle="Posted slices cannot be changed; pending ones move if the schedule is regenerated.">
            <Table>
              <thead>
                <tr>
                  <Th width="60px">#</Th><Th>Due</Th><Th align="right">Amount</Th>
                  <Th align="right">Cumulative</Th><Th align="right">Remaining</Th><Th>State</Th>
                </tr>
              </thead>
              <tbody>
                {assetSchedule(a.id).slice(0, 14).map((l) => (
                  <tr key={l.id}>
                    <Td><span className="num !text-left">{l.seq}</span></Td>
                    <Td>{fmtDate(l.due_date)}</Td>
                    <Td align="right"><Money value={l.amount} dash={false} /></Td>
                    <Td align="right"><Money value={l.cumulative} /></Td>
                    <Td align="right"><Money value={l.remaining} /></Td>
                    <Td>
                      <Chip state={l.state === 'posted' ? 'posted' : 'draft'}
                        label={l.state === 'posted' ? 'Posted' : 'Pending'} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ))}
      </div>
  );
}

function DeferralsTab({ deferrals, today }: {
  deferrals: DeferralRow[]; today: string;
}) {
  return (
      <Card
        title="Deferrals"
        padded={false}
        actions={
          <form action={runDeferralsAction}>
            <input type="hidden" name="up_to" value={today} />
            <button className={btn.primary}>Recognise due slices</button>
          </form>
        }
      >
        {deferrals.length === 0 && (
          <EmptyState
            title="Nothing deferred."
            hint="An annual insurance premium or a year of software, spread across the months it covers."
          />
        )}
        {deferrals.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th><Th>Kind</Th><Th>From</Th><Th align="right">Months</Th>
                <Th align="right">Amount</Th><Th align="right">Recognised</Th>
                <Th align="right">Remaining</Th><Th width="140px">Progress</Th>
              </tr>
            </thead>
            <tbody>
              {deferrals.map((d) => (
                <tr key={d.id} className="hover:bg-canvas">
                  <Td><span className="font-semibold">{d.name}</span></Td>
                  <Td><Chip state="draft" label={titleise(d.kind)} /></Td>
                  <Td>{fmtDate(d.date_from)}</Td>
                  <Td align="right"><span className="num">{d.months}</span></Td>
                  <Td align="right"><Money value={d.amount} dash={false} /></Td>
                  <Td align="right"><Money value={d.recognised} /></Td>
                  <Td align="right"><Money value={d.amount - d.recognised} bold /></Td>
                  <Td><Bar value={d.recognised} max={Math.max(d.amount, 1)} color="var(--color-brand)" /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
  );
}
