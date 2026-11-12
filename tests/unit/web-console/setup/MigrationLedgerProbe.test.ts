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
  isDatabaseBehindRelease,
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

  const MISMATCH_ADVICE = ' Every migration in this release has been applied, but the ledger does not match it entry for entry: a migration file changed after it was applied, or the ledger was edited. Compare the schema before relying on it.';

  it('reports a mismatch, not a missing migration, when an applied migration was reworded afterwards', () => {
    // The case a long-lived database hits: the file changed after it was
    // applied, and the migrator never re-applies, so the old hash stays.
    const ledger = ledgerOf(release);
    ledger[1] = { ...ledger[1], hash: hash(99) };
    const result = compareMigrationLedger(release, ledger);
    expect(result).toEqual({
      id: 'production_database_migrations', state: 'failed', code: 'migrations_mismatch',
      detail: 'Applied migration 2 does not match 0001_second in this release.' + MISMATCH_ADVICE,
    });
    expect(isDatabaseBehindRelease(result)).toBe(false);
  });

  it('reports a mismatch when an applied migration carries a different timestamp', () => {
    const ledger = ledgerOf(release);
    ledger[2] = { ...ledger[2], createdAt: '3001' };
    expect(compareMigrationLedger(release, ledger)).toMatchObject({
      code: 'migrations_mismatch', detail: expect.stringContaining('Applied migration 3 does not match 0002_third in this release.'),
    });
  });

  it('reports a mismatch when the ledger has the right migrations in the wrong positions', () => {
    const [first, second, third] = ledgerOf(release);
    expect(compareMigrationLedger(release, [second, first, third])).toMatchObject({
      state: 'failed', code: 'migrations_mismatch',
      detail: expect.stringContaining('Applied migration 1 does not match 0000_first in this release.'),
    });
  });

  it('reports a mismatch, not a missing migration, when the ledger is shorter but as new as this release', () => {
    // A ledger that was squashed or renumbered: fewer rows, nothing left to apply.
    const result = compareMigrationLedger(release, [ledgerOf(release)[0], { hash: hash(9), createdAt: '3000' }]);
    expect(result).toMatchObject({ code: 'migrations_mismatch' });
    expect(isDatabaseBehindRelease(result)).toBe(false);
  });

  it('says the database is behind whenever this release has a migration newer than the ledger, as the migrator would', () => {
    // An earlier entry also differs. Being behind is what matters, and wins.
    const ledger = ledgerOf(release.slice(0, 2));
    ledger[0] = { ...ledger[0], hash: hash(99) };
    const result = compareMigrationLedger(release, ledger);
    expect(result).toEqual({
      id: 'production_database_migrations', state: 'failed', code: 'migrations_incomplete',
      detail: '2 of 3 migrations in this release are applied. First missing: 0002_third.',
    });
    expect(isDatabaseBehindRelease(result)).toBe(true);
  });

  it('ignores a ledger timestamp that is not a number when deciding whether the database is behind', () => {
    const ledger = [...ledgerOf(release.slice(0, 1)), { hash: hash(2), createdAt: 'not-a-number' }];
    expect(compareMigrationLedger(release, ledger)).toMatchObject({
      code: 'migrations_incomplete', detail: '1 of 3 migrations in this release are applied. First missing: 0001_second.',
    });
  });

  it('only a database that is behind counts as behind', () => {
    expect(isDatabaseBehindRelease(compareMigrationLedger(release, ledgerOf(release)))).toBe(false);
    expect(isDatabaseBehindRelease(compareMigrationLedger(release, []))).toBe(true);
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

  const postgresError = (code: string, message: string) => Object.assign(new Error(message), { code });
  const databaseFailing = (failure: unknown): DatabaseInstance =>
    ({ execute: jest.fn(() => Promise.reject(failure)) }) as unknown as DatabaseInstance;

  it('reports a ledger the role may not read as pending, not failed, and says what to grant', async () => {
    const result = await probeMigrationLedger(databaseFailing(postgresError('42501', 'permission denied for schema drizzle')), release);
    expect(result).toEqual({
      id: 'production_database_migrations', state: 'pending', code: 'migration_ledger_unreadable',
      detail: 'The server\'s database role is not permitted to read the applied-migration ledger, so the schema is not verified. ' +
        'Grant it USAGE on schema drizzle and SELECT on drizzle.__drizzle_migrations.',
    });
  });

  it.each([
    ['42P01', 'relation "drizzle.__drizzle_migrations" does not exist'],
    ['3F000', 'schema "drizzle" does not exist'],
  ])('reports a database with no ledger as pending, under its own code (%s)', async (code, driverMessage) => {
    const result = await probeMigrationLedger(databaseFailing(postgresError(code, driverMessage)), release);
    expect(result).toEqual({
      id: 'production_database_migrations', state: 'pending', code: 'migration_ledger_missing',
      detail: 'This database has no applied-migration ledger (drizzle.__drizzle_migrations), so the schema is not verified. ' +
        'The ledger is written when this release\'s migrations are applied; a schema created any other way has none.',
    });
  });

  it('names any other PostgreSQL failure by its error class', async () => {
    const result = await probeMigrationLedger(databaseFailing(postgresError('57P03', 'the database system is starting up')), release);
    expect(result).toMatchObject({
      state: 'pending', code: 'migration_ledger_unreadable',
      detail: 'The applied-migration ledger could not be read (PostgreSQL error 57P03), so the schema is not verified.',
    });
  });

  it('reads the error class through the wrapper the query builder puts around driver errors', async () => {
    const wrapped = new Error('Failed query: SELECT hash …', { cause: postgresError('42501', 'permission denied') });
    await expect(probeMigrationLedger(databaseFailing(wrapped), release))
      .resolves.toMatchObject({ detail: expect.stringContaining('not permitted to read') });
  });

  it('never puts the driver message in the result, since it can carry connection details', async () => {
    const leaky = new Error('connect ECONNREFUSED db.internal.example:5432 user=dollhouse_app');
    const result = await probeMigrationLedger(databaseFailing(leaky), release);
    expect(result.detail).toBe('The applied-migration ledger could not be read (the database did not answer), so the schema is not verified.');
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
