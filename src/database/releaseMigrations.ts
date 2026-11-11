/**
 * The migrations this release was built against.
 *
 * Each entry carries the content hash and timestamp the migrator writes to
 * the applied-migration ledger (`drizzle.__drizzle_migrations`), so the list
 * can be compared with what a database has actually had applied.
 *
 * A built server reads the list the build wrote next to this module
 * (`release-migrations.json`); the runtime image does not ship the SQL files.
 * Run from source, it derives the same list from the migration folder.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ReleaseMigration {
  readonly tag: string;
  /** Journal timestamp; the ledger stores it as `created_at`. */
  readonly when: number;
  /** SHA-256 of the migration's SQL file, hex. */
  readonly hash: string;
}

const BUILT_MANIFEST = new URL('./release-migrations.json', import.meta.url);
const SOURCE_FOLDER = new URL('./migrations/', import.meta.url);
const TAG_PATTERN = /^[a-z0-9_]+$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export async function loadReleaseMigrations(): Promise<readonly ReleaseMigration[]> {
  const built = await readOptional(BUILT_MANIFEST);
  if (built !== null) return parseReleaseMigrations(JSON.parse(built));
  return readReleaseMigrationsFromSource(fileURLToPath(SOURCE_FOLDER));
}

/** Derives the list from a migration folder: its journal and SQL files. */
export async function readReleaseMigrationsFromSource(folder: string): Promise<readonly ReleaseMigration[]> {
  const journal = JSON.parse(await readFile(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries?: unknown;
  };
  if (!Array.isArray(journal.entries)) throw new Error('Migration journal has no entries');
  const migrations: ReleaseMigration[] = [];
  for (const entry of journal.entries as readonly { tag?: unknown; when?: unknown }[]) {
    if (typeof entry.tag !== 'string' || !TAG_PATTERN.test(entry.tag) || !Number.isSafeInteger(entry.when)) {
      throw new Error('Migration journal entry is malformed');
    }
    // The tag is restricted to [a-z0-9_] above, so it cannot leave the folder.
    const sql = await readFile(join(folder, `${entry.tag}.sql`));
    migrations.push({
      tag: entry.tag,
      when: entry.when as number,
      hash: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return parseReleaseMigrations(migrations);
}

export function parseReleaseMigrations(value: unknown): readonly ReleaseMigration[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Release migration list is empty');
  let previous = Number.NEGATIVE_INFINITY;
  return value.map((entry: unknown): ReleaseMigration => {
    const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const { tag, when, hash } = record;
    if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)
      || typeof when !== 'number' || !Number.isSafeInteger(when)
      || typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
      throw new Error('Release migration entry is malformed');
    }
    // The migrator applies in timestamp order; a list that is not strictly
    // increasing cannot be compared with the ledger position by position.
    if (when <= previous) throw new Error('Release migrations are not in strictly increasing order');
    previous = when;
    return { tag, when, hash };
  });
}

async function readOptional(url: URL): Promise<string | null> {
  try {
    return await readFile(url, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
