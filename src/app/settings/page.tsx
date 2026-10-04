import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { AUTH_REQUIRED } from '@/server/auth';
import { msg, type SearchParams } from '@/lib/range';
import { allSettings, type SettingKey } from '@/server/accounting/settings';
import { getOrganisation, stateName } from '@/server/accounting/organisation';
import { listBankAccounts } from '@/server/accounting/banking';
import { listPaymentTerms, listAnalyticPlans } from '@/server/accounting/masters';
import { listTaxes } from '@/server/accounting/tax';
import { settlementAccountsReady } from '@/server/accounting/settlements';
import { scalar } from '@/server/db';
import { can, titleise } from '@/lib/accounting';
import { resetAction } from '@/app/actions';
import {
  PageHeader, Card, Banner, Field, inputClass, btn, DefList, Chip,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The configuration READINESS screen.
 *
 * -------------------------------------------------------------------------
 * WHY A CHECKLIST RATHER THAN A FORM
 * -------------------------------------------------------------------------
 * Settings stopped being one page the moment this product had to serve more
 * than the agency it was seeded for. Ten screens is the right shape for the
 * job — but ten screens is also how an agency goes live with no cash account,
 * no GSTIN and three unset posting defaults, and finds out one at a time, each
 * time from an error in the middle of someone's work.
 *
 * So the landing screen answers one question: WHAT IS STILL UNSET. Each row is
 * a thing that breaks something specific, named, with the screen that fixes it
 * one click away. It is deliberately read-only: a hub that also edits is a hub
 * people skim past.
 */

interface Check {
  label: string;
  ok: boolean;
  detail: string;
  href: string;
  /** A blocker stops work outright; a gap degrades a report or a document. */
  severity: 'blocker' | 'gap';
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const m = await msg(await searchParams);
  const mayConfigure = can(s.role, 'coa.configure');

  const org = await getOrganisation(s.orgId);
  const current = await allSettings(s.orgId);
  const banks = await listBankAccounts(s.orgId);
  const terms = await listPaymentTerms(s.orgId);
  const taxes = await listTaxes(s.orgId);
  const plans = await listAnalyticPlans(s.orgId);
  const products = await scalar('SELECT COUNT(*) FROM products WHERE org_id=? AND active=1', s.orgId);
  const productsWithoutHsn = await scalar(
    `SELECT COUNT(*) FROM products
      WHERE org_id=? AND active=1 AND (hsn_code IS NULL OR hsn_code = '')`, s.orgId,
  );
  const channelReady = await settlementAccountsReady(s.orgId);
  const years = await scalar('SELECT COUNT(*) FROM fiscal_years WHERE org_id=?', s.orgId);

  /*
   * The keys a posting genuinely cannot proceed without. Not every key in
   * SettingKey — only those the common paths call `requireSetting` on, because
   * listing all thirty would make the page noise and hide the four that matter.
   */
  const criticalKeys: Array<[SettingKey, string]> = [
    ['account.receivable', 'customer invoices'],
    ['account.payable', 'vendor bills'],
    ['account.customer_advance', 'advances taken before a trip is invoiced'],
    ['account.supplier_advance', 'advances paid to suppliers'],
    ['journal.sale', 'posting an invoice'],
    ['journal.purchase', 'posting a bill'],
  ];
  const unsetCritical = criticalKeys.filter(([k]) => !current[k]);

  const branchCount = plans.find((p) => p.code === 'BRANCH')?.entries ?? 0;
  const agentCount = plans.find((p) => p.code === 'AGENT')?.entries ?? 0;

  const checks: Check[] = [
    {
      label: 'Agency identity',
      ok: !!org?.gstin && !!org?.address,
      detail: org?.gstin
        ? `${org.gstin} · ${stateName(org.state_code) ?? 'state not set'}`
        : 'No GSTIN or registered address — invoices print incomplete and the GST return cannot be filed.',
      href: '/settings/organisation',
      severity: 'gap',
    },
    {
      label: 'Place of supply',
      ok: !!org?.state_code,
      detail: org?.state_code
        ? `${org.state_code} — ${stateName(org.state_code)}`
        : 'Unset, so CGST+SGST against IGST cannot be decided per invoice.',
      href: '/settings/organisation',
      severity: 'gap',
    },
    {
      label: 'Bank accounts',
      ok: banks.some((b) => !b.is_cash),
      detail: banks.length
        ? `${banks.filter((b) => !b.is_cash).length} bank · ${banks.filter((b) => b.is_cash).length} cash`
        : 'No account for money to land in — no payment can be recorded at all.',
      href: '/settings/bank-accounts',
      severity: 'blocker',
    },
    {
      label: 'Cash account',
      ok: banks.some((b) => b.is_cash),
      detail: banks.some((b) => b.is_cash)
        ? banks.filter((b) => b.is_cash).map((b) => b.name).join(', ')
        : 'Guides, tips and local transport are paid in cash and have nowhere to go.',
      href: '/settings/bank-accounts',
      severity: 'gap',
    },
    {
      label: 'A default account',
      ok: banks.some((b) => b.is_default),
      detail: banks.find((b) => b.is_default)?.name
        ?? 'Every money form opens on whichever account happens to sort first.',
      href: '/settings/bank-accounts',
      severity: 'gap',
    },
    {
      label: 'Posting defaults',
      ok: unsetCritical.length === 0,
      detail: unsetCritical.length === 0
        ? 'Every account and journal the engine needs is set.'
        : `Unset: ${unsetCritical.map(([, what]) => what).join(', ')}.`,
      href: '/settings/accounts',
      severity: 'blocker',
    },
    {
      label: 'Fiscal years',
      ok: years > 0,
      detail: years > 0
        ? `${years} open, starting in ${new Date(2000, (org?.fy_start_month ?? 4) - 1, 1).toLocaleDateString('en-IN', { month: 'long' })}`
        : 'No year is open, so nothing can be posted into a period.',
      href: '/accounting/periods',
      severity: 'blocker',
    },
    {
      label: 'Taxes',
      ok: taxes.length > 0,
      detail: taxes.length ? `${taxes.length} rate(s) configured` : 'No GST or TDS rate is defined.',
      href: '/taxes',
      severity: 'gap',
    },
    {
      label: 'Payment terms',
      ok: terms.length > 0,
      detail: terms.length
        ? terms.map((t) => t.name).join(', ')
        : 'Every invoice falls due on its own date, and the ageing report has one bucket.',
      href: '/settings/payment-terms',
      severity: 'gap',
    },
    {
      label: 'Branches & agents',
      ok: branchCount > 0 && agentCount > 0,
      detail: `${branchCount} branch(es), ${agentCount} agent(s)`,
      href: '/settings/dimensions',
      severity: 'gap',
    },
    {
      label: 'Products & services',
      ok: products > 0,
      detail: products > 0
        ? `${products} on the list`
        : 'Every invoice line is typed from scratch, with its account chosen by hand each time.',
      href: '/settings/products',
      severity: 'gap',
    },
    /*
     * HSN COVERAGE, as a check of its own rather than folded into the one above.
     *
     * A list of products is a convenience; a product with no HSN is a DEFECT
     * that propagates — every invoice line it fills prints without the code
     * Rule 46 requires, and nobody notices until a return is scrutinised. It is
     * counted here because it is invisible everywhere else: the invoice looks
     * finished, the ledger balances, and the only symptom is a column that
     * happens to be empty.
     */
    {
      label: 'HSN / SAC codes',
      ok: productsWithoutHsn === 0,
      detail: products === 0
        ? 'Nothing on the product list to classify yet.'
        : productsWithoutHsn === 0
          ? `All ${products} carry a code.`
          : `${productsWithoutHsn} of ${products} have none, so an invoice line filled from them prints without the HSN a GST invoice requires.`,
      href: '/settings/products',
      severity: 'gap',
    },
    {
      label: 'Channel settlement accounts',
      ok: channelReady,
      detail: channelReady
        ? 'Commission, logistics, charges, recoveries and the TCS/TDS receivables are all set.'
        : 'A marketplace payout cannot be posted: the commission, GST and withheld-tax accounts are not all configured.',
      href: '/settings/accounts',
      severity: 'gap',
    },
  ];

  const blockers = checks.filter((c) => !c.ok && c.severity === 'blocker');
  const gaps = checks.filter((c) => !c.ok && c.severity === 'gap');

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="What this agency has configured, and what is still waiting."
        accent="var(--color-sec-settings)"
        actions={<Link href="/settings/organisation" className={btn.primary}>Agency details →</Link>}
      />
      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      {blockers.length > 0 ? (
        <Banner tone="error">
          {blockers.length} setting{blockers.length === 1 ? '' : 's'} will stop work outright:{' '}
          {blockers.map((b) => b.label).join(', ')}.
        </Banner>
      ) : gaps.length > 0 ? (
        <Banner tone="warn">
          Ready to post. {gaps.length} optional setting{gaps.length === 1 ? '' : 's'} would make the
          reports more useful.
        </Banner>
      ) : (
        <Banner tone="ok">Fully configured.</Banner>
      )}

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <Card title="Configuration" padded={false}
          subtitle="Each row names what breaks without it, not just that it is empty.">
          <ul className="divide-y divide-line">
            {checks.map((c) => (
              <li key={c.label} className="flex items-start gap-3 px-5 py-3">
                <span className={`mt-0.5 text-[15px] font-bold ${
                  c.ok ? 'text-positive' : c.severity === 'blocker' ? 'text-negative' : 'text-warn'}`}>
                  {c.ok ? '✓' : c.severity === 'blocker' ? '✕' : '!'}
                </span>
                <span className="flex-1">
                  <Link href={c.href} className="text-[13.5px] font-bold text-brand hover:underline">
                    {c.label}
                  </Link>
                  <span className="block text-[12.5px] text-ink-muted">{c.detail}</span>
                </span>
                {!c.ok && (
                  <Chip state={c.severity === 'blocker' ? 'cancelled' : 'partial'}
                    label={c.severity === 'blocker' ? 'Blocks posting' : 'Optional'} />
                )}
              </li>
            ))}
          </ul>
        </Card>

        <div className="space-y-5">
          <Card title="This agency">
            <DefList rows={[
              ['Name', org?.name ?? s.orgName],
              ['Legal name', org?.legal_name ?? '—'],
              ['GSTIN', org?.gstin ?? '—'],
              ['Place of supply', stateName(org?.state_code ?? null) ?? '—'],
              ['Currency', s.currency],
              ['Fiscal year starts', new Date(2000, s.fyStartMonth - 1, 1)
                .toLocaleDateString('en-IN', { month: 'long' })],
              ['Signed in as', `${s.userName} · ${titleise(s.role)}`],
              /*
                WHICH TRIPZOCRM AGENCY THESE BOOKS BELONG TO, stated on screen.
                One deployment now holds one ledger per agency, so "whose books
                am I looking at" is a real question with a wrong answer
                available — and the only honest way to answer it is from the
                session, which is the same value every query on every screen is
                filtered by. Without it, an accountant who signs in to the
                wrong account sees a plausible set of books and no way to tell.

                The CRM's organisation id is shown alongside the name because
                two agencies can share a name and ids are what the join is
                actually made on; it is also the first thing to compare against
                `organizations.crm_org_id` when something looks wrong.
              */
              ...(s.crm ? [
                ['TripzoCRM agency', s.crm.orgName ?? s.crm.orgId ?? '—'] as [string, string],
                ['CRM organisation id', s.crm.orgId ?? '—'] as [string, string],
                ['CRM account', s.crm.email ?? '—'] as [string, string],
              ] : []),
            ]} />
          </Card>

          {/*
            RESET IS A DEMO FACILITY, AND ON A CONNECTED DEPLOYMENT IT IS NOT
            OFFERED AT ALL.

            It truncates the whole accounting schema, which now holds one set of
            books per TripzoCRM agency — so on a real deployment it would wipe
            every OTHER agency's ledger as well as this one's, from a button
            that reads as though it belongs to the agency pressing it. The
            server action refuses it too (`resetAndSeed`), because hiding a
            button is a courtesy and refusing the request is the control; this
            branch is here so nobody is invited to press it and then told no.
          */}
          {mayConfigure && (AUTH_REQUIRED ? (
            <Card title="Reset the books"
              subtitle="Not available on a deployment connected to TripzoCRM.">
              <p className="text-[13px] text-ink-muted">
                This ledger holds real agencies&rsquo; books, one set per TripzoCRM organisation, in
                a single database. A reset would destroy all of them — including other
                agencies&rsquo; — so it is offered only on a demo deployment. Remove the individual
                records you meant to, or reverse the entries that posted them.
              </p>
            </Card>
          ) : (
            <Card title="Reset the books"
              subtitle="Wipes every transaction and re-seeds the demo agency. There is no undo.">
              <form action={resetAction} className="space-y-3">
                <Field label="Type RESET to confirm">
                  <input name="confirm" className={inputClass} placeholder="RESET" />
                </Field>
                <button className={btn.danger}>Reset and re-seed</button>
              </form>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
