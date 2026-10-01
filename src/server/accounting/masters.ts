import 'server-only';
import { all, one, run, scalar, tx, id, nowIso } from '../db';
import { audit } from './audit';
import type { Actor } from './engine';

/**
 * Configuration records: accounts, journals, partners, taxes, products,
 * bookings, budgets.
 *
 * Reads and simple writes only — nothing here posts. Anything that moves the
 * ledger lives in the services beside this file, so that "what can change a
 * balance" stays a short list.
 */

// ------------------------------------------------------------------ accounts
export interface AccountRow {
  id: string; code: string; name: string; kind: string; currency: string | null;
  reconcilable: number; active: number; description: string | null;
}

export async function listAccounts(orgId: string, opts: { kinds?: string[]; activeOnly?: boolean } = {}): Promise<AccountRow[]> {
  const clauses = ['org_id = ?'];
  const params: Array<string | number> = [orgId];
  if (opts.activeOnly !== false) clauses.push('active = 1');
  if (opts.kinds?.length) {
    clauses.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`);
    params.push(...opts.kinds);
  }
  return await all<AccountRow>(
    `SELECT * FROM accounts WHERE ${clauses.join(' AND ')} ORDER BY code`, ...params,
  );
}

export async function getAccount(orgId: string, accountId: string): Promise<AccountRow | null> {
  return await one<AccountRow>('SELECT * FROM accounts WHERE id=? AND org_id=?', accountId, orgId);
}

export async function upsertAccount(orgId: string, a: {
  id?: string; code: string; name: string; kind: string; reconcilable?: boolean;
  currency?: string | null; description?: string | null; active?: boolean;
}, actor: Actor = {}) {
  return await tx(async () => {
    if (a.id) {
      await run(
        `UPDATE accounts SET code=?, name=?, kind=?, reconcilable=?, currency=?, description=?, active=?
           WHERE id=? AND org_id=?`,
        a.code, a.name, a.kind, a.reconcilable ? 1 : 0, a.currency ?? null,
        a.description ?? null, a.active === false ? 0 : 1, a.id, orgId,
      );
      await audit(orgId, actor, 'modified', 'account', a.id, `${a.code} ${a.name}`);
      return a.id;
    }
    const accountId = id('acc');
    await run(
      `INSERT INTO accounts (id, org_id, code, name, kind, currency, reconcilable, active, description)
       VALUES (?,?,?,?,?,?,?,1,?)`,
      accountId, orgId, a.code, a.name, a.kind, a.currency ?? null,
      a.reconcilable ? 1 : 0, a.description ?? null,
    );
    await audit(orgId, actor, 'created', 'account', accountId, `${a.code} ${a.name}`);
    return accountId;
  });
}

/**
 * Flip "Allow Reconciliation" on one account.
 *
 * -------------------------------------------------------------------------
 * WHAT THE FLAG MEANS HERE
 * -------------------------------------------------------------------------
 * A reconcilable account is one whose lines are matched OFF AGAINST EACH
 * OTHER: a receivable that an receipt settles, a payable that a supplier
 * payment clears, an advance that an invoice consumes. It is the flag that
 * makes "this invoice still owes ₹40,000" a sentence the ledger can support,
 * because the residual is the unmatched part of the control account's lines
 * for that document.
 *
 * It is NOT bank reconciliation. A bank account is reconciled against a
 * STATEMENT — a different mechanism, on a different screen, and marking the
 * bank account reconcilable here changes nothing about it.
 *
 * -------------------------------------------------------------------------
 * WHY THIS IS A TOGGLE AND NOT A FIELD ON THE EDIT FORM
 * -------------------------------------------------------------------------
 * It is the one property of an account that gets set wrong and then sits there
 * — a new "Advances from Agents" account, created in a hurry, unreconcilable,
 * and discovered when the first advance refuses to apply. A switch on the list
 * lets someone scan the whole chart and fix it in the column where the mistake
 * is visible, which is the only place anyone would notice it.
 *
 * -------------------------------------------------------------------------
 * THE ONE REFUSAL
 * -------------------------------------------------------------------------
 * Turning it OFF on an account that still carries an unsettled document is
 * refused, and named. The flag is what allocation stands on; removing it under
 * a live receivable would leave invoices that can never be settled and an
 * ageing report with no way to clear its oldest column. Settle them, or move
 * the partner to a different control account first.
 */
export async function setAccountReconcilable(
  orgId: string, accountId: string, on: boolean, actor: Actor = {},
): Promise<void> {
  const account = await one<{ code: string; name: string }>(
    'SELECT code, name FROM accounts WHERE id=? AND org_id=?', accountId, orgId,
  );
  if (!account) throw new Error('Unknown account.');

  if (!on) {
    // Documents settle against the control account their PARTNER resolves to,
    // which is the partner override where there is one and the org default
    // otherwise — so both are checked, rather than assuming every receivable
    // lands on the setting.
    const open = await scalar(
      `SELECT COUNT(*) FROM documents d
         JOIN partners p ON p.id = d.partner_id
        WHERE d.org_id = ? AND d.state = 'posted' AND d.residual > 0
          AND (
            COALESCE(p.receivable_account_id, (SELECT value FROM org_settings WHERE org_id=d.org_id AND key='account.receivable')) = ?
            OR
            COALESCE(p.payable_account_id, (SELECT value FROM org_settings WHERE org_id=d.org_id AND key='account.payable')) = ?
          )`,
      orgId, accountId, accountId,
    );
    if (open > 0) {
      throw new Error(
        `${account.code} ${account.name} still carries ${open} unsettled document(s). ` +
        'Reconciliation cannot be switched off while anything is waiting to be matched against it.',
      );
    }
  }

  await run('UPDATE accounts SET reconcilable=? WHERE id=? AND org_id=?', on ? 1 : 0, accountId, orgId);
  await audit(orgId, actor, 'modified', 'account', accountId,
    `${account.code} ${account.name} — reconciliation ${on ? 'allowed' : 'not allowed'}`);
}

/*
 * ARCHIVING AN ACCOUNT WAS REMOVED, deliberately.
 *
 * It offered two outcomes that both turned out to be wrong for this product. An
 * account with no postings was DELETED outright, which is a destructive button
 * sitting on every row of a table people scroll through daily. An account with
 * postings was flagged inactive — and an inactive account still carries its
 * balance, still appears on the trial balance and the balance sheet (it must:
 * its lines are real), but silently refuses new postings. So the chart showed a
 * greyed-out row with money on it and no explanation, and the only way to post
 * to it again was a button that no longer existed.
 *
 * A chart of accounts is small and slow-moving. An account that should not be
 * used is handled by not using it, and renaming it if that needs saying out
 * loud. `accounts.active` survives in the schema because the posting engine
 * still honours it and a future release may want a considered version of this,
 * but nothing in the product sets it to 0 any more — see the repair statement
 * in src/server/db.ts.
 */

// ------------------------------------------------------------------ journals
export interface JournalRow {
  id: string; code: string; name: string; type: string; currency: string | null;
  default_account_id: string | null; sequence_code: string; active: number;
  default_account_name?: string | null; entries?: number;
}

export async function listJournals(orgId: string, type?: string): Promise<JournalRow[]> {
  return await all<JournalRow>(
    `SELECT j.*, a.name AS default_account_name,
            (SELECT COUNT(*) FROM journal_entries e WHERE e.journal_id = j.id AND e.state='posted') AS entries
       FROM journals j LEFT JOIN accounts a ON a.id = j.default_account_id
      WHERE j.org_id = ? AND j.active = 1 AND (?::text IS NULL OR j.type = ?)
      ORDER BY j.type, j.code`,
    orgId, type ?? null, type ?? null,
  );
}

export async function upsertJournal(orgId: string, j: {
  id?: string; code: string; name: string; type: string;
  defaultAccountId?: string | null; currency?: string | null;
}, actor: Actor = {}) {
  return await tx(async () => {
    if (j.id) {
      await run('UPDATE journals SET code=?, name=?, type=?, default_account_id=?, currency=? WHERE id=? AND org_id=?',
        j.code, j.name, j.type, j.defaultAccountId ?? null, j.currency ?? null, j.id, orgId);
      await audit(orgId, actor, 'modified', 'journal', j.id, j.name);
      return j.id;
    }
    const journalId = id('jrn');
    const seqCode = `j_${j.code.toLowerCase()}`;
    await run(
      `INSERT INTO journals (id, org_id, code, name, type, currency, default_account_id, sequence_code, active)
       VALUES (?,?,?,?,?,?,?,?,1)`,
      journalId, orgId, j.code, j.name, j.type, j.currency ?? null, j.defaultAccountId ?? null, seqCode,
    );
    await run('INSERT INTO sequences (org_id, code, prefix, padding, next_no) VALUES (?,?,?,?,1)',
      orgId, seqCode, j.code.toUpperCase(), 5);
    await audit(orgId, actor, 'created', 'journal', journalId, j.name);
    return journalId;
  });
}

// ------------------------------------------------------------------ partners
export interface PartnerRow {
  id: string; name: string; is_customer: number; is_supplier: number; partner_type: string;
  email: string | null; phone: string | null; gstin: string | null; pan: string | null;
  address: string | null; credit_limit: number; tds_section: string | null;
  payment_terms_id: string | null; active: number;
  receivable?: number; payable?: number;
}

export async function listPartners(orgId: string, opts: {
  side?: 'customer' | 'supplier'; search?: string; limit?: number;
} = {}): Promise<PartnerRow[]> {
  const clauses = ['p.org_id = ?', 'p.active = 1'];
  const params: Array<string | number> = [orgId];
  if (opts.side === 'customer') clauses.push('p.is_customer = 1');
  if (opts.side === 'supplier') clauses.push('p.is_supplier = 1');
  if (opts.search) {
    clauses.push('(p.name LIKE ? OR p.email LIKE ? OR p.phone LIKE ? OR p.gstin LIKE ?)');
    const like = `%${opts.search}%`;
    params.push(like, like, like, like);
  }
  return await all<PartnerRow>(
    `SELECT p.*,
            COALESCE((SELECT SUM(CASE WHEN d.doc_type='out_invoice' THEN d.residual ELSE -d.residual END)
                        FROM documents d WHERE d.partner_id=p.id AND d.state='posted'
                          AND d.doc_type IN ('out_invoice','out_refund')),0) AS receivable,
            COALESCE((SELECT SUM(CASE WHEN d.doc_type='in_invoice' THEN d.residual ELSE -d.residual END)
                        FROM documents d WHERE d.partner_id=p.id AND d.state='posted'
                          AND d.doc_type IN ('in_invoice','in_refund')),0) AS payable
       FROM partners p WHERE ${clauses.join(' AND ')}
      ORDER BY p.name LIMIT ${opts.limit ?? 300}`,
    ...params,
  );
}

export async function getPartner(orgId: string, partnerId: string): Promise<PartnerRow | null> {
  return await one<PartnerRow>('SELECT * FROM partners WHERE id=? AND org_id=?', partnerId, orgId);
}

export async function upsertPartner(orgId: string, p: {
  id?: string; name: string; isCustomer?: boolean; isSupplier?: boolean;
  partnerType?: string; email?: string | null; phone?: string | null;
  gstin?: string | null; pan?: string | null; address?: string | null;
  creditLimit?: number; tdsSection?: string | null; paymentTermsId?: string | null;
  crmLeadId?: string | null;
}, actor: Actor = {}) {
  return await tx(async () => {
    if (p.id) {
      await run(
        `UPDATE partners SET name=?, is_customer=?, is_supplier=?, partner_type=?, email=?, phone=?,
                gstin=?, pan=?, address=?, credit_limit=?, tds_section=?, payment_terms_id=?
           WHERE id=? AND org_id=?`,
        p.name, p.isCustomer ? 1 : 0, p.isSupplier ? 1 : 0, p.partnerType ?? 'b2c',
        p.email ?? null, p.phone ?? null, p.gstin ?? null, p.pan ?? null, p.address ?? null,
        p.creditLimit ?? 0, p.tdsSection ?? null, p.paymentTermsId ?? null, p.id, orgId,
      );
      await audit(orgId, actor, 'modified', 'partner', p.id, p.name);
      return p.id;
    }
    const partnerId = id('prt');
    await run(
      `INSERT INTO partners (id, org_id, name, is_customer, is_supplier, partner_type, crm_lead_id,
                             email, phone, gstin, pan, address, credit_limit, tds_section,
                             payment_terms_id, active, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      partnerId, orgId, p.name, p.isCustomer ? 1 : 0, p.isSupplier ? 1 : 0,
      p.partnerType ?? 'b2c', p.crmLeadId ?? null, p.email ?? null, p.phone ?? null,
      p.gstin ?? null, p.pan ?? null, p.address ?? null, p.creditLimit ?? 0,
      p.tdsSection ?? null, p.paymentTermsId ?? null, nowIso(),
    );
    await audit(orgId, actor, 'created', 'partner', partnerId, p.name);
    return partnerId;
  });
}

/**
 * A customer or supplier field that is TYPED rather than chosen from a
 * dropdown, resolved to a partner record on submit.
 *
 * A trip's traveller, or a one-off supplier, should not have to exist as a
 * partner master before the first invoice or payment can be raised against
 * them — so a name with no case-insensitive match on this side becomes a new
 * partner here, rather than blocking the document. Matched BY SIDE, not by
 * name alone: a name that already exists as a supplier does not silently
 * become a customer too just because it was typed into an invoice.
 */
export async function resolvePartnerByName(
  orgId: string, rawName: string, side: 'customer' | 'supplier', actor: Actor = {},
): Promise<string> {
  const name = rawName.trim();
  if (!name) throw new Error(`${side === 'customer' ? 'Customer' : 'Supplier'} is required.`);
  const flagCol = side === 'customer' ? 'is_customer' : 'is_supplier';
  const existing = await one<{ id: string }>(
    `SELECT id FROM partners WHERE org_id=? AND ${flagCol}=1 AND LOWER(name)=LOWER(?)`,
    orgId, name,
  );
  if (existing) return existing.id;
  return await upsertPartner(orgId, { name, isCustomer: side === 'customer', isSupplier: side === 'supplier' }, actor);
}

/**
 * The same lookup for an OPTIONAL partner tag (a manual journal line's
 * analytic-style attribution) — match only, either side. A typo here should
 * leave the line untagged rather than mint a partner record nobody meant to
 * create, so unlike `resolvePartnerByName` this never creates one.
 */
export async function findPartnerIdByName(orgId: string, rawName: string): Promise<string | null> {
  const name = rawName.trim();
  if (!name) return null;
  const existing = await one<{ id: string }>(
    `SELECT id FROM partners WHERE org_id=? AND LOWER(name)=LOWER(?)`, orgId, name,
  );
  return existing?.id ?? null;
}

// ------------------------------------------------------------------ products
export async function listProducts(orgId: string) {
  return await all<{
    id: string; name: string; code: string | null; category: string;
    sale_price: number; cost_price: number; income_account_id: string | null;
    expense_account_id: string | null; sale_tax_id: string | null; purchase_tax_id: string | null;
  }>('SELECT * FROM products WHERE org_id=? AND active=1 ORDER BY category, name', orgId);
}

export async function upsertProduct(orgId: string, p: {
  id?: string; name: string; code?: string | null; category: string;
  salePrice?: number; costPrice?: number; incomeAccountId?: string | null;
  expenseAccountId?: string | null; saleTaxId?: string | null; purchaseTaxId?: string | null;
}, actor: Actor = {}) {
  return await tx(async () => {
    if (p.id) {
      await run(
        `UPDATE products SET name=?, code=?, category=?, sale_price=?, cost_price=?,
                income_account_id=?, expense_account_id=?, sale_tax_id=?, purchase_tax_id=?
           WHERE id=? AND org_id=?`,
        p.name, p.code ?? null, p.category, p.salePrice ?? 0, p.costPrice ?? 0,
        p.incomeAccountId ?? null, p.expenseAccountId ?? null,
        p.saleTaxId ?? null, p.purchaseTaxId ?? null, p.id, orgId,
      );
      return p.id;
    }
    const productId = id('prd');
    await run(
      `INSERT INTO products (id, org_id, name, code, category, sale_price, cost_price,
                             income_account_id, expense_account_id, sale_tax_id, purchase_tax_id, active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
      productId, orgId, p.name, p.code ?? null, p.category, p.salePrice ?? 0, p.costPrice ?? 0,
      p.incomeAccountId ?? null, p.expenseAccountId ?? null, p.saleTaxId ?? null, p.purchaseTaxId ?? null,
    );
    await audit(orgId, actor, 'created', 'product', productId, p.name);
    return productId;
  });
}

// ------------------------------------------------------------------ bookings
/**
 * Create a booking AND its trip analytic account, together.
 *
 * Always together: a booking with no analytic account is a trip whose costs
 * cannot be tagged, and it is discovered three invoices later when the margin
 * report shows nothing. The CRM sync path calls this too.
 */
export async function createBooking(orgId: string, b: {
  ref: string; title: string; partnerId?: string | null; customerName?: string | null;
  destination?: string | null;
  packageName?: string | null; agentName?: string | null; branch?: string | null;
  pax?: number; startDate?: string | null; endDate?: string | null;
  sellValue?: number; status?: string;
}, actor: Actor = {}): Promise<string> {
  return await tx(async () => {
    const plan = await one<{ id: string }>("SELECT id FROM analytic_plans WHERE org_id=? AND code='TRIPS'", orgId);
    if (!plan) throw new Error('The Trips analytic plan is missing. Run the seed.');

    const bookingId = id('bkg');
    const analyticId = id('ana');
    await run(
      `INSERT INTO analytic_accounts (id, org_id, plan_id, code, name, booking_id, partner_id, active)
       VALUES (?,?,?,?,?,?,?,1)`,
      analyticId, orgId, plan.id, b.ref, `${b.destination ?? b.title} ${b.ref}`,
      bookingId, b.partnerId ?? null,
    );
    await run(
      `INSERT INTO bookings (id, org_id, ref, title, partner_id, customer_name, destination, package_name,
                             agent_name, branch, pax, start_date, end_date, sell_value, status,
                             analytic_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      bookingId, orgId, b.ref, b.title, b.partnerId ?? null, b.customerName ?? null, b.destination ?? null,
      b.packageName ?? null, b.agentName ?? null, b.branch ?? null, b.pax ?? 1,
      b.startDate ?? null, b.endDate ?? null, b.sellValue ?? 0, b.status ?? 'confirmed',
      analyticId, nowIso(),
    );
    await audit(orgId, actor, 'created', 'booking', bookingId, `${b.ref} — ${b.title}`);
    return bookingId;
  });
}

export async function getBooking(orgId: string, bookingId: string) {
  return await one<{
    id: string; ref: string; title: string; partner_id: string | null; customer_name: string | null;
    destination: string | null;
    package_name: string | null; agent_name: string | null; pax: number; status: string;
    start_date: string | null; end_date: string | null; sell_value: number; analytic_id: string | null;
  }>('SELECT * FROM bookings WHERE id=? AND org_id=?', bookingId, orgId);
}

export async function setBookingStatus(orgId: string, bookingId: string, status: string, actor: Actor = {}) {
  await run('UPDATE bookings SET status=? WHERE id=? AND org_id=?', status, bookingId, orgId);
  await audit(orgId, actor, 'modified', 'booking', bookingId, `Status → ${status}`);
}

// ------------------------------------------------------------------- budgets
export async function listBudgets(orgId: string) {
  return await all<{ id: string; name: string; owner: string | null; date_from: string; date_to: string; state: string }>(
    'SELECT * FROM budgets WHERE org_id=? ORDER BY date_from DESC', orgId,
  );
}

export async function createBudget(orgId: string, b: {
  name: string; owner?: string | null; dateFrom: string; dateTo: string;
  lines: Array<{ accountId?: string | null; analyticId?: string | null; planned: number }>;
}, actor: Actor = {}) {
  return await tx(async () => {
    const budgetId = id('bud');
    await run('INSERT INTO budgets (id, org_id, name, owner, date_from, date_to, state) VALUES (?,?,?,?,?,?,?)',
      budgetId, orgId, b.name, b.owner ?? null, b.dateFrom, b.dateTo, 'confirmed');
    for (const l of b.lines) {
      await run('INSERT INTO budget_lines (id, org_id, budget_id, account_id, analytic_id, planned) VALUES (?,?,?,?,?,?)',
        id('bdl'), orgId, budgetId, l.accountId ?? null, l.analyticId ?? null, l.planned);
    }
    await audit(orgId, actor, 'created', 'budget', budgetId, b.name);
    return budgetId;
  });
}

// ------------------------------------------------------------- payment terms
export async function listPaymentTerms(orgId: string) {
  return await all<{ id: string; name: string; days: number; note: string | null }>(
    'SELECT * FROM payment_terms WHERE org_id=? ORDER BY days', orgId,
  );
}

export async function listUsers(orgId: string) {
  return await all<{ id: string; name: string; email: string | null; role: string }>(
    'SELECT id, name, email, role FROM users WHERE org_id=? AND active=1 ORDER BY name', orgId,
  );
}
