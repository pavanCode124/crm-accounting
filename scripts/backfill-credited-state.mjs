/**
 * Relabel invoices and bills that were settled by a credit or debit note.
 *
 * `payment_state` was derived from the residual alone, so a document whose
 * balance had been CANCELLED read exactly like one that had been COLLECTED: a
 * ₹1,36,500 trip against which ₹60,000 arrived and ₹76,500 was credited showed
 * "Paid", and the agency had no way to see the difference from a list. The
 * derivation now returns 'credited' for these, but `payment_state` is a cache
 * that only rewrites when a document's allocations next change — so documents
 * settled before the fix keep the old label until this runs.
 *
 * Nothing but the label moves. Residual, the ledger, the allocations and the
 * documents themselves are untouched, and re-running changes nothing the second
 * time because the rows it targets no longer read 'paid'.
 *
 *   node scripts/backfill-credited-state.mjs           # report what would change
 *   node scripts/backfill-credited-state.mjs --apply   # write it
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// next loads .env.local for the app; a plain node script has to do it itself.
for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(path.join(process.cwd(), file), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // Absent is fine — the variables may come from the environment instead.
  }
}

const url = process.env.TRIPZO_DATABASE_URL ?? process.env.DATABASE_URL;
const schema = process.env.TRIPZO_DB_SCHEMA ?? 'accounting';
const apply = process.argv.includes('--apply');

if (!url) {
  console.error('TRIPZO_DATABASE_URL is not set. Nothing to do.');
  process.exit(1);
}

const WHERE = `
   d.state = 'posted'
   AND d.payment_state = 'paid'
   AND d.residual = 0
   AND d.doc_type IN ('out_invoice', 'in_invoice')
   AND EXISTS (SELECT 1 FROM payment_allocations a
                WHERE a.document_id = d.id AND a.credit_doc_id IS NOT NULL)`;

const SELECT = `
  SELECT d.number, p.name AS partner, d.total,
         COALESCE((SELECT SUM(a.amount) FROM payment_allocations a
                    WHERE a.document_id = d.id AND a.credit_doc_id IS NOT NULL), 0) AS credited,
         d.total - COALESCE((SELECT SUM(a.amount) FROM payment_allocations a
                    WHERE a.document_id = d.id AND a.credit_doc_id IS NOT NULL), 0) AS received
    FROM documents d
    LEFT JOIN partners p ON p.id = d.partner_id
   WHERE ${WHERE}
   ORDER BY d.number`;

const UPDATE = `UPDATE documents d SET payment_state = 'credited' WHERE ${WHERE}`;

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`SET search_path = "${schema.replace(/"/g, '""')}"`);
  const { rows } = await client.query(SELECT);
  if (!rows.length) {
    console.log('Nothing to relabel — no settled document was settled by a note.');
  } else {
    // Minor units are what the ledger stores; print rupees, which is what the
    // reader is checking against the screen.
    console.table(rows.map((r) => ({
      Document: r.number,
      Partner: r.partner,
      Total: Number(r.total) / 100,
      Received: Number(r.received) / 100,
      Credited: Number(r.credited) / 100,
    })));
    if (apply) {
      const r = await client.query(UPDATE);
      console.log(`Relabelled ${r.rowCount} document(s) as Credited.`);
    } else {
      console.log(`${rows.length} document(s) would be relabelled. Re-run with --apply to write it.`);
    }
  }
} finally {
  await client.end();
}
