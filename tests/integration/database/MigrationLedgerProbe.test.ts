/** The migration ledger probe against a really migrated PostgreSQL database. */

import { afterAll, describe, expect, it } from '@jest/globals';

import { loadReleaseMigrations } from '../../../src/database/releaseMigrations.js';
import { probeMigrationLedger } from '../../../src/web-console/setup/MigrationLedgerProbe.js';
import { closeTestDb, getTestAdminDb, getTestDb } from './test-db-helpers.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;

afterAll(async () => {
  await closeTestDb();
});

required('probeMigrationLedger on PostgreSQL', () => {
  it('passes for a database migrated by this release', async () => {
    const release = await loadReleaseMigrations();
    expect(await probeMigrationLedger(getTestAdminDb(), release)).toEqual({
      id: 'production_database_migrations',
      state: 'passed',
      detail: `All ${release.length} migrations in this release are applied.`,
    });
  });

  it('fails when this release has a migration the database has not had applied', async () => {
    const release = await loadReleaseMigrations();
    const next = { tag: '9999_not_applied_yet', when: release.at(-1)!.when + 1, hash: 'f'.repeat(64) };
    expect(await probeMigrationLedger(getTestAdminDb(), [...release, next])).toEqual({
      id: 'production_database_migrations',
      state: 'failed',
      detail: `${release.length} of ${release.length + 1} migrations in this release are applied. First missing: 9999_not_applied_yet.`,
    });
  });

  it('fails when an applied migration differs from the one this release ships', async () => {
    const release = [...await loadReleaseMigrations()];
    release[5] = { ...release[5], hash: 'e'.repeat(64) };
    expect(await probeMigrationLedger(getTestAdminDb(), release)).toEqual({
      id: 'production_database_migrations',
      state: 'failed',
      detail: `Applied migration 6 does not match ${release[5].tag} in this release.`,
    });
  });

  it('passes for an older release whose migrations are the start of the ledger', async () => {
    const release = await loadReleaseMigrations();
    const older = release.slice(0, 10);
    expect(await probeMigrationLedger(getTestAdminDb(), older)).toEqual({
      id: 'production_database_migrations',
      state: 'passed',
      detail: `All 10 migrations in this release are applied, with ${release.length - 10} newer applied by a later release.`,
    });
  });

  it('never reports a fault through the application role: it verifies or says it cannot read', async () => {
    const release = await loadReleaseMigrations();
    const result = await probeMigrationLedger(getTestDb(), release);
    expect(['passed', 'pending']).toContain(result.state);
  });

  it('writes nothing', async () => {
    const count = async () => (await getTestAdminDb().execute(
      'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
    ) as unknown as Array<{ n: number }>)[0].n;
    const before = await count();
    await probeMigrationLedger(getTestAdminDb(), await loadReleaseMigrations());
    expect(await count()).toBe(before);
  });
});
