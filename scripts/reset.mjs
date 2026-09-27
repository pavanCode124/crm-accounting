/**
 * Delete the local books so the app re-seeds on its next request.
 *
 * Deliberately NOT a re-implementation of the seed: the seed lives in
 * src/server/seed.ts and runs through the same posting engine the screens use,
 * which is what makes the demo data trustworthy. Running it from plain Node
 * would need the bundler's path aliases, so the app seeds itself on first
 * request instead and this only clears the way.
 *
 * The Settings screen has the same button, with a typed confirmation.
 */
import { rmSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'data');
if (!existsSync(dir)) {
  console.log('No data directory — nothing to clear.');
  process.exit(0);
}

let removed = 0;
for (const file of readdirSync(dir)) {
  if (!file.startsWith('tripzo-finance.db')) continue;
  try {
    rmSync(path.join(dir, file), { force: true });
    removed += 1;
  } catch (err) {
    // On Windows the running dev server holds the file open, and the raw
    // EPERM says nothing useful about why.
    if (err?.code === 'EPERM' || err?.code === 'EBUSY') {
      console.error(
        `Could not delete ${file}: it is open. Stop the dev server first, ` +
        'or use Reset the books on the Settings screen, which works while it is running.',
      );
      process.exit(1);
    }
    throw err;
  }
}
console.log(removed
  ? `Cleared ${removed} database file(s). The books will be re-seeded on the next request.`
  : 'Nothing to clear.');
