import { describe, expect, it, jest } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { DatabaseInstance } from '../../../../src/database/connection.js';
import {
  loadReleaseMigrations,
  parseReleaseMigrations,
  readReleaseMigrationsFromSource,
  type ReleaseMigration,
} from '../../../../src/database/releaseMigrations.js';
import {
  compareMigrationLedger,
  probeMigrationLedger,
  type AppliedMigration,
} from '../../../../src/web-console/setup/MigrationLedgerProbe.js';
// The build script uses this module to write the list a built server reads.
import { buildReleaseMigrations } from '../../../../scripts/lib/release-migrations.mjs';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../../src/database/migrations/', import.meta.url));
const hash = (seed: number) => seed.toString(16).padStart(64, '0');
const release: readonly ReleaseMigration[] = [
  { tag: '0000_first', when: 1000, hash: hash(1) },
  { tag: '0001_second', when: 2000, hash: hash(2) },
  { tag: '0002_third', when: 3000, hash: hash(3) },
];
const ledgerOf = (migrations: readonly ReleaseMigration[]): AppliedMigration[] =>
  migrations.map(migration => ({ hash: migration.hash, createdAt: String(migration.when) }));
const databaseReturning = (rows: unknown): DatabaseInstance =>
  ({ execute: jest.fn(() => Promise.resolve(rows)) }) as unknown as DatabaseInstance;

describe('compareMigrationLedger', () => {
  it('passes when the ledger is exactly this release', () => {
    expect(compareMigrationLedger(release, ledgerOf(release))).toEqual({
      id: 'production_database_migrations', state: 'passed', code: 'migrations_applied', detail: 'All 3 migrations in this release are applied.',
    });
  });

  it('passes when a later release has already applied newer migrations', () => {
    const newer = [...ledgerOf(release), { hash: hash(4), createdAt: '4000' }, { hash: hash(5), createdAt: '5000' }];
    expect(compareMigrationLedger(release, newer)).toEqual({
      id: 'production_database_migrations', state: 'passed', code: 'migrations_applied',
      detail: 'All 3 migrations in this release are applied, with 2 newer applied by a later release.',
    });
  });

  it.each([
    [0, 'an empty ledger', '0000_first'],
    [1, 'one applied', '0001_second'],
    [2, 'all but the last applied', '0002_third'],
  ])('fails with %i of 3 applied (%s) and names the first missing migration', (applied, _label, missing) => {
    expect(compareMigrationLedger(release, ledgerOf(release.slice(0, applied)))).toEqual({
      id: 'production_database_migrations', state: 'failed', code: 'migrations_incomplete',
      detail: `${applied} of 3 migrations in this release are applied. First missing: ${missing}.`,
    });
  });

  it('fails when an applied migration has different content from this release', () => {
    const ledger = ledgerOf(release);
    ledger[1] = { ...ledger[1], hash: hash(99) };
    expect(compareMigrationLedger(release, ledger)).toEqual({
      id: 'production_database_migrations', state: 'failed', code: 'migrations_mismatch',
      detail: 'Applied migration 2 does not match 0001_second in this release.',
    });
  });

  it('fails when an applied migration carries a different timestamp', () => {
    const ledger = ledgerOf(release);
    ledger[2] = { ...ledger[2], createdAt: '3001' };
    expect(compareMigrationLedger(release, ledger).detail)
      .toBe('Applied migration 3 does not match 0002_third in this release.');
  });

  it('fails when the ledger has the right migrations in the wrong positions', () => {
    const [first, second, third] = ledgerOf(release);
    expect(compareMigrationLedger(release, [second, first, third])).toMatchObject({
      state: 'failed', code: 'migrations_mismatch', detail: 'Applied migration 1 does not match 0000_first in this release.',
    });
  });
});

describe('probeMigrationLedger', () => {
  it('reads the ledger once, in applied order, and compares it', async () => {
    const database = databaseReturning(ledgerOf(release));
    await expect(probeMigrationLedger(database, release)).resolves.toMatchObject({ state: 'passed' });
    expect(database.execute).toHaveBeenCalledTimes(1);
  });

  it('reports an incomplete ledger as failed', async () => {
    await expect(probeMigrationLedger(databaseReturning(ledgerOf(release.slice(0, 2))), release))
      .resolves.toMatchObject({ state: 'failed', detail: expect.stringContaining('First missing: 0002_third') });
  });

  it('reports an unreadable ledger as pending, not failed, and hands the error to the caller', async () => {
    const failure = new Error('permission denied for schema drizzle');
    const database = { execute: jest.fn(() => Promise.reject(failure)) } as unknown as DatabaseInstance;
    const onUnreadable = jest.fn();
    const result = await probeMigrationLedger(database, release, onUnreadable);
    expect(result).toEqual({
      id: 'production_database_migrations', state: 'pending', code: 'migration_ledger_unreadable',
      detail: 'The applied-migration ledger could not be read, so the schema is not verified. ' +
        'Grant the server\'s database role SELECT on the drizzle schema.',
    });
    expect(result.detail).not.toContain('permission denied');
    expect(onUnreadable).toHaveBeenCalledWith(failure);
  });
});

describe('release migration list', () => {
  it('derives the same list from source as the build script writes into dist', async () => {
    const fromSource = await readReleaseMigrationsFromSource(MIGRATIONS_FOLDER);
    expect(fromSource).toEqual(buildReleaseMigrations(MIGRATIONS_FOLDER));
    expect(parseReleaseMigrations(JSON.parse(JSON.stringify(buildReleaseMigrations(MIGRATIONS_FOLDER))))).toEqual(fromSource);
  });

  it('loads every migration in the journal, in order, with a content hash', async () => {
    const migrations = await loadReleaseMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(62);
    expect(migrations[0].tag.startsWith('0000_')).toBe(true);
    expect(migrations.every(migration => /^[0-9a-f]{64}$/.test(migration.hash))).toBe(true);
    expect(migrations.map(migration => migration.when)).toEqual([...migrations.map(migration => migration.when)].sort((a, b) => a - b));
    expect(new Set(migrations.map(migration => migration.tag)).size).toBe(migrations.length);
  });

  it('is shipped in the npm package, which otherwise carries only compiled code from dist/database', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../../../package.json', import.meta.url), 'utf8')) as { files: string[] };
    expect(manifest.files).toContain('dist/database/release-migrations.json');
  });

  it.each([
    ['an empty list', []],
    ['a non-list', { tag: '0000_first' }],
    ['a missing hash', [{ tag: '0000_first', when: 1000 }]],
    ['a short hash', [{ tag: '0000_first', when: 1000, hash: 'abc' }]],
    ['an unsafe tag', [{ tag: '../0000_first', when: 1000, hash: hash(1) }]],
    ['a fractional timestamp', [{ tag: '0000_first', when: 1000.5, hash: hash(1) }]],
    ['timestamps out of order', [{ tag: '0000_first', when: 2000, hash: hash(1) }, { tag: '0001_second', when: 1000, hash: hash(2) }]],
    ['a repeated timestamp', [{ tag: '0000_first', when: 1000, hash: hash(1) }, { tag: '0001_second', when: 1000, hash: hash(2) }]],
  ])('rejects %s', (_label, value) => {
    expect(() => parseReleaseMigrations(value)).toThrow(/Release migration/);
  });
});
