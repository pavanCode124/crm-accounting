/**
 * Tag already-posted tax lines with the booking their document belongs to.
 *
 * Until this was fixed, `postDocument` put the trip on the revenue, cost and
 * partner lines but not on the GST or TDS lines it derived from them. Filter
 * the General Ledger by a booking and those lines fell out, so the extract came
 * up short by exactly the tax — the entry was right, the slice of it was not.
 *
 * Amounts, accounts, dates and states are untouched: this writes `booking_id`
 * on lines where it is NULL and the entry came from a document that has a
 * booking. Lines already carrying a booking are left alone, so running it twice
 * changes nothing the second time.
 *
 *   node scripts/tag-tax-lines.mjs           # report what would change
 *   node scripts/tag-tax-lines.mjs --apply   # write it
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

const SELECT = `
  SELECT je.entry_no, a.code, a.name, l.debit, l.credit, d.booking_id
    FROM journal_entry_lines l
    JOIN journal_entries je ON je.id = l.entry_id
    JOIN documents d ON d.id = je.source_id AND je.source_model = 'document'
    LEFT JOIN accounts a ON a.id = l.account_id
   WHERE l.booking_id IS NULL AND d.booking_id IS NOT NULL
   ORDER BY je.entry_no`;

const UPDATE = `
  UPDATE journal_entry_lines l
     SET booking_id = d.booking_id
    FROM journal_entries je, documents d
   WHERE je.id = l.entry_id
     AND je.source_model = 'document' AND d.id = je.source_id
     AND l.booking_id IS NULL AND d.booking_id IS NOT NULL`;

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`SET search_path = "${schema.replace(/"/g, '""')}"`);
  const { rows } = await client.query(SELECT);
  if (!rows.length) {
    console.log('Nothing to tag — every document line already carries its booking.');
  } else {
    console.table(rows);
    if (apply) {
      const r = await client.query(UPDATE);
      console.log(`Tagged ${r.rowCount} line(s).`);
    } else {
      console.log(`${rows.length} line(s) would be tagged. Re-run with --apply to write it.`);
    }
  }
} finally {
  await client.end();
}
