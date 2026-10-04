import Link from 'next/link';
import { ctx } from '@/server/bootstrap';
import { msg, one, type SearchParams } from '@/lib/range';
import { fmtDate } from '@/lib/accounting';
import { listInvoices, STATUS_CHIP } from '@/server/crm/invoices';
import { mirroredInvoices, mirrorCounts } from '@/server/crm/mirror';
import {
  importFromCrmAction, redraftCrmInvoiceAction, redraftAllCrmInvoicesAction,
} from '@/app/actions';
import {
  PageHeader, Card, Table, Th, Td, Money, Chip, EmptyState, Banner, StatTile,
  inputClass, btn, LinkButton,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * A fetch is several hundred round trips to the CRM and a few hundred draft
 * documents, which is well past the ten seconds a serverless function gets by
 * default. The ceiling applies to the server actions invoked from this page as
 * well, and that is the one that matters — `importFromCrmAction` is the long
 * call, not the render.
 */
export const maxDuration = 60;

/**
 * TRIPZOCRM → INVOICES. The seam between the two systems, made visible.
 *
 * ===========================================================================
 * WHY THIS SCREEN EXISTS AT ALL
 * ===========================================================================
 * An agent raises an invoice on their phone. Hours or days later an accountant
 * needs it in the books, with a journal, a revenue account per line, a CGST and
 * SGST split and an HSN on every row — none of which the CRM holds or should.
 * Between those two facts sits a question nobody could previously answer: WHICH
 * CRM INVOICES ARE IN THE BOOKS, AND WHICH ARE NOT.
 *
 * Without it, the failure mode is the worst one available in accounting
 * software: an invoice quietly missing from the ledger. Nothing is wrong on
 * screen, the trial balance balances, every report runs — and the month's
 * revenue is short by one sale that nobody is looking for. This table's whole
 * purpose is to make that gap countable.
 *
 * ===========================================================================
 * THREE COLUMNS, THREE DIFFERENT KINDS OF TRUTH
 * ===========================================================================
 *   WHAT TRIPZOCRM SAYS       the live list, read on every render. The current
 *                             commercial record, which an agent may be editing
 *                             right now.
 *
 *   WHAT WAS FETCHED          the mirror in this database, with the moment it
 *                             was true. Immune to the CRM being down, and the
 *                             bytes the importer actually worked from.
 *
 *   WHAT THE BOOKS SAY        the ledger document, its state and its total.
 *                             Posted, this is the figure in the trial balance
 *                             and the GST return.
 *
 * The first two and the third are allowed to differ IN STATE — fetched but not
 * drafted, drafted but not posted — but never in MONEY. The importer carries
 * the CRM's own item amounts, discount and tax across unchanged, so a books
 * total that does not equal the CRM total is a bug rather than a reconciling
 * item, and `reconcileTotal` refuses the import instead of listing it here.
 *
 * ===========================================================================
 * NOTHING ON THIS PAGE WRITES TO TRIPZOCRM
 * ===========================================================================
 * Not the fetch, not the import, not a status. The CRM is read and mirrored;
 * every edit happens on the ledger document in this app's own Postgres.
 * `crmFetch` has no method or body parameter, so a write cannot be expressed
 * anywhere in this codebase — the guarantee is structural rather than a promise
 * in a comment.
 */
export default async function CrmInvoicesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const s = await ctx();
  const params = await searchParams;
  const m = await msg(params);
  const q = ((await one(params, 'q')) ?? '').trim().toLowerCase();
  const show = (await one(params, 'show')) ?? 'all';

  /*
   * THE MIRROR IS READ FIRST AND THE CRM SECOND, and that order is deliberate.
   * Everything this screen must be able to say — what was fetched, what reached
   * the books, what the two disagree about — comes out of this database. The
   * live read adds one fact on top: whether the CRM is holding an invoice that
   * has never been fetched at all. A backend that is down therefore costs this
   * screen that one column and nothing else, instead of emptying it.
   */
  const [mirror, counts, live] = await Promise.all([
    mirroredInvoices(s.orgId), mirrorCounts(s.orgId), listInvoices(),
  ]);

  const mirroredIds = new Set(mirror.map((r) => r.crm_id));
  const neverFetched = live.rows.filter((inv) => !mirroredIds.has(inv.id));
  const waiting = counts.invoices - counts.imported;

  const rows = mirror.filter((r) => {
    if (show === 'waiting' && r.document_id) return false;
    if (show === 'imported' && !r.document_id) return false;
    if (!q) return true;
    return [r.invoice_number, r.customer_name, r.doc_number]
      .some((v) => (v ?? '').toLowerCase().includes(q));
  });

  // Totals over the ROWS ON SCREEN, so a filtered view's tiles describe what it
  // is showing rather than the whole book — a tile that disagrees with the
  // table under it is worse than no tile.
  const crmTotal = rows.reduce((t, r) => t + r.total, 0);
  const collected = rows.reduce((t, r) => t + r.amount_paid, 0);

  return (
    <>
      <PageHeader
        title="TripzoCRM Invoices"
        subtitle="What the CRM has billed, what has been fetched into this database, and what has reached the books."
        accent="var(--color-sec-sales)"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/*
              RE-DRAFT ALL, BESIDE FETCH RATHER THAN INSTEAD OF IT, because the
              two answer different questions. Fetch asks TripzoCRM what is new.
              This asks the books to say again what the mirror ALREADY holds —
              which is what is wanted after the translation between the two was
              corrected, and it is the only way a document drafted under an
              older reading can be restated at all: the fetch skips every
              invoice already in the books, because importing one twice is a
              doubled sale.

              It replaces each DRAFT with what the CRM says, including anything
              chosen on it here, and does not touch a posted document.
            */}
            <form action={redraftAllCrmInvoicesAction}>
              <button
                className={btn.ghost}
                title="Rewrite every still-draft document from the fetched invoice it came from \u2014 its line amounts, its discount and its tax figure. Posted documents are left alone."
              >
                Re-draft drafts
              </button>
            </form>
            <form action={importFromCrmAction}>
              <input type="hidden" name="return_to" value="crm" />
              <button className={btn.primary}>Fetch &amp; import</button>
            </form>
          </div>
        }
      />

      {m.error && <Banner tone="error">{m.error}</Banner>}
      {m.ok && <Banner tone="ok">{m.ok}</Banner>}

      {/*
        * TWO DIFFERENT SENTENCES FOR THE SAME DISCONNECTION, because the right
        * next step differs. With nothing fetched there is nothing to look at
        * and signing in is the whole job. With a mirror already here the screen
        * is perfectly useful — it is showing exactly what the importer worked
        * from — and the only thing missing is anything raised since.
        */}
      {!live.connected && (
        <Banner tone="warn">
          {counts.invoices === 0
            ? 'Not signed in to TripzoCRM, so nothing has been fetched and nothing can be. '
              + 'Sign out and back in with your CRM account.'
            : 'Not signed in to TripzoCRM, so nothing newer can be fetched. What is below was '
              + 'fetched earlier and is still exactly what the importer worked from — sign out and '
              + 'back in with your CRM account to pick up anything raised since.'}
        </Banner>
      )}
      {live.error && (
        <Banner tone="error">
          TripzoCRM did not answer: {live.error}. The table below comes from this database and is
          unaffected — this is a connection problem, not a data one.
        </Banner>
      )}

      {/*
        * THE ONE THING ONLY THE LIVE READ CAN TELL US. An invoice in the CRM
        * that has never been fetched is invisible to every other screen in this
        * product, including this table, so it is called out above it.
        */}
      {neverFetched.length > 0 && (
        <Banner tone="info">
          {neverFetched.length} invoice{neverFetched.length === 1 ? '' : 's'} in TripzoCRM{' '}
          {neverFetched.length === 1 ? 'has' : 'have'} never been fetched
          {neverFetched.length <= 5 && (
            <> — {neverFetched.map((i) => i.invoice_number).filter(Boolean).join(', ')}</>
          )}
          . Press <strong>Fetch &amp; import</strong> to copy {neverFetched.length === 1 ? 'it' : 'them'}{' '}
          into this database and draft {neverFetched.length === 1 ? 'a document' : 'documents'} for{' '}
          {neverFetched.length === 1 ? 'it' : 'them'}.
        </Banner>
      )}

      {waiting > 0 && (
        <Banner tone="warn">
          {waiting} fetched invoice{waiting === 1 ? '' : 's'} {waiting === 1 ? 'has' : 'have'} no
          document in the books. Until {waiting === 1 ? 'it does' : 'they do'},{' '}
          {waiting === 1 ? 'that sale' : 'those sales'} {waiting === 1 ? 'is' : 'are'} in no balance,
          no report and no return. A cancelled CRM invoice is deliberately never drafted; anything
          else here is waiting on <strong>Fetch &amp; import</strong>, or on a warning from the last
          run that needs an account or a GST rate adding first.
        </Banner>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Fetched" value={String(counts.invoices)}
          hint={`${counts.packages} package(s) snapshotted`} />
        {/*
          * "Every fetched invoice is drafted" IS TRUE OF AN EMPTY SET AND READS
          * AS A LIE. A tile that congratulates somebody on a complete import
          * they have not run is the kind of reassurance that stops them running
          * it, so nothing is claimed until there is something to claim it about.
          */}
        <StatTile label="In the books" value={String(counts.imported)}
          tone={waiting > 0 ? 'warn' : counts.imported > 0 ? 'positive' : 'neutral'}
          hint={
            waiting > 0 ? `${waiting} still waiting`
              : counts.imported > 0 ? 'Every fetched invoice is drafted'
                : 'Nothing fetched yet'
          } />
        <StatTile label="Billed in the CRM" value={fmtRupees(crmTotal)}
          hint="What TripzoCRM says these invoices total" />
        <StatTile label="Collected in the CRM" value={fmtRupees(collected)}
          hint={`${counts.paid_imported} of ${counts.payments} receipt(s) drafted here`} />
      </div>

      <Card
        title="Fetched invoices"
        subtitle="Read from TripzoCRM, stored here, and matched to the document each one became."
        padded={false}
      >
        <form className="flex flex-wrap gap-2 border-b border-line px-5 py-3">
          <input
            name="q" defaultValue={q} placeholder="Invoice number, customer, document…"
            className={`${inputClass} max-w-[320px]`}
          />
          <select name="show" defaultValue={show} className={`${inputClass} max-w-[200px]`}>
            <option value="all">All fetched</option>
            <option value="waiting">Not in the books</option>
            <option value="imported">In the books</option>
          </select>
          <button className={btn.ghost}>Filter</button>
        </form>

        {rows.length === 0 ? (
          <EmptyState
            title={
              counts.invoices === 0
                ? 'Nothing has been fetched from TripzoCRM yet.'
                : q || show !== 'all'
                  ? 'No fetched invoice matches this filter.'
                  : 'Nothing to show.'
            }
            hint={
              counts.invoices === 0
                ? 'Press Fetch & import. Invoices are copied into this database and drafted as documents; '
                  + 'nothing is written back to the CRM and nothing is posted until you post it.'
                : undefined
            }
          />
        ) : (
          <div className="scroll-x">
            <Table>
              <thead>
                <tr>
                  <Th>CRM invoice</Th>
                  <Th>Customer</Th>
                  <Th>Issued</Th>
                  <Th>CRM status</Th>
                  <Th align="right">CRM total</Th>
                  <Th align="right">Collected</Th>
                  <Th>In the books</Th>
                  <Th align="right">Books total</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  /*
                   * NO DIFFERENCE COLUMN ANY MORE, because there is no longer a
                   * difference to state: the importer carries the CRM's own
                   * item amounts, discount and tax across unchanged, so the
                   * books total IS the CRM total. A column that reads "nil" on
                   * every row for ever is not a reconciliation, it is noise
                   * standing where a real check used to be — and the real check
                   * now lives in `reconcileTotal`, which refuses to import an
                   * invoice whose two totals disagree rather than drawing the
                   * disagreement on a screen nobody is obliged to read.
                   */
                  return (
                    <tr key={r.crm_id} className="hover:bg-canvas">
                      <Td>
                        <span className="font-semibold">{r.invoice_number ?? '—'}</span>
                        <div className="text-[11.5px] text-ink-faint">
                          Fetched {fmtDate(r.fetched_at.slice(0, 10))}
                        </div>
                      </Td>
                      <Td>{r.customer_name ?? '—'}</Td>
                      <Td>
                        <span className="num !text-left">
                          {r.issue_date ? fmtDate(r.issue_date) : '—'}
                        </span>
                      </Td>
                      <Td>
                        <Chip
                          state={STATUS_CHIP[(r.status ?? '').toLowerCase()] ?? 'draft'}
                          label={r.status ?? 'unknown'}
                        />
                        {(r.doc_type ?? '').toLowerCase() === 'refund' && (
                          <div className="text-[11.5px] text-ink-faint">Credit note</div>
                        )}
                      </Td>
                      <Td align="right"><Money value={r.total} bold /></Td>
                      <Td align="right"><Money value={r.amount_paid} /></Td>
                      <Td>
                        {r.document_id ? (
                          <Link
                            href={`/sales/invoices/${r.document_id}`}
                            className="font-bold text-brand hover:underline"
                          >
                            {r.doc_number ?? 'Draft'}
                          </Link>
                        ) : (
                          <Chip
                            state={(r.status ?? '').toLowerCase() === 'cancelled' ? 'cancelled' : 'draft'}
                            label={
                              (r.status ?? '').toLowerCase() === 'cancelled'
                                ? 'Not drafted'
                                : 'Waiting'
                            }
                          />
                        )}
                        {r.document_id && r.doc_state && (
                          <div className="mt-1">
                            <Chip state={r.doc_state} />
                          </div>
                        )}
                        {/*
                          RE-DRAFT, AND ONLY WHILE IT IS STILL A DRAFT.

                          A document drafted from an earlier reading of this
                          invoice — before the mapping was fixed, before a
                          revenue account existed, or before the agent edited it
                          over there — has no other way back: the fetch skips
                          every invoice already in the books, because importing
                          one twice is a doubled sale.

                          It replaces the draft with what the CRM says now,
                          including any GST slab or account somebody chose here,
                          which is why it is one row’s button rather than part of
                          the fetch. A POSTED document does not offer it at all;
                          there the correction is Edit, which amends the entry
                          and records that it did.
                        */}
                        {r.document_id && r.doc_state === 'draft' && (
                          <form action={redraftCrmInvoiceAction} className="mt-1">
                            <input type="hidden" name="crm_id" value={r.crm_id} />
                            <button
                              className="text-[12px] font-bold text-brand hover:underline"
                              title="Rewrite this draft from what TripzoCRM says now \u2014 its line amounts, its discount and its tax figure. Anything changed on the draft here is replaced."
                            >
                              Re-draft from CRM
                            </button>
                          </form>
                        )}
                      </Td>
                      <Td align="right">
                        {r.document_id ? <Money value={r.doc_total ?? 0} /> : <span className="num text-ink-faint">—</span>}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}

        <div className="border-t border-line px-5 py-4 text-[12.5px] text-ink-faint">
          <p>
            A document drafted here is a <strong>draft</strong>: it moves no balance, appears in no
            report and proves nothing until somebody opens it in{' '}
            <Link href="/accounting/review" className="font-bold text-brand hover:underline">
              Accounting → Review &amp; Post
            </Link>{' '}
            and posts it. Edit it first — the CRM carries no journal, no revenue account per line,
            no tax row and no HSN, and those are what the books are produced from.
          </p>
          <p className="mt-2">
            Re-running a fetch is safe. An invoice already in the books is matched to the document it
            became and skipped, so nothing arrives twice — and a doubled posting is the one mistake
            that leaves a ledger balanced and wrong.
          </p>
        </div>
      </Card>

      <div className="mt-5">
        <LinkButton href="/settings/crm-sync">Connection settings</LinkButton>
      </div>
    </>
  );
}

/**
 * Paise as a rupee figure for a tile.
 *
 * `StatTile` takes a string, and `Money` is a component rather than a
 * formatter, so this is the one place these four tiles format for themselves.
 * Indian digit grouping, because ₹12,34,567 and ₹1,234,567 are the same number
 * and only one of them is readable to the person checking it.
 */
function fmtRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
}
