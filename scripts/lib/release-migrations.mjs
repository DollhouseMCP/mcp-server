import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The migrations this release ships, in journal order, each with the content
 * hash and timestamp the migrator records in the applied-migration ledger.
 *
 * The build writes this list into dist so the running server, which does not
 * ship the SQL files, can tell whether its database has every migration it
 * was built against.
 */
export function buildReleaseMigrations(migrationsDir) {
  const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8'));
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error('Migration journal has no entries');
  }
  return journal.entries.map(entry => {
    if (typeof entry.tag !== 'string' || !/^[a-z0-9_]+$/.test(entry.tag) || !Number.isSafeInteger(entry.when)) {
      throw new Error('Migration journal entry is malformed');
    }
    const sql = readFileSync(join(migrationsDir, `${entry.tag}.sql`));
    return { tag: entry.tag, when: entry.when, hash: createHash('sha256').update(sql).digest('hex') };
  });
}
