import { describe, expect, it, jest } from '@jest/globals';

import type { DatabaseInstance } from '../../../../src/database/connection.js';
import type { ReleaseMigration } from '../../../../src/database/releaseMigrations.js';
import { createReleaseMigrationLedgerMonitor } from '../../../../src/web-console/setup/ReleaseMigrationLedgerMonitor.js';

const hash = (seed: number) => seed.toString(16).padStart(64, '0');
const release: readonly ReleaseMigration[] = [
  { tag: '0000_first', when: 1000, hash: hash(1) },
  { tag: '0001_second', when: 2000, hash: hash(2) },
];
const ledger = (count: number) => release.slice(0, count).map(entry => ({ hash: entry.hash, createdAt: String(entry.when) }));
const postgresError = (code: string, message: string) => Object.assign(new Error(message), { code });

function setup(execute: () => Promise<unknown>, loadRelease: () => Promise<readonly ReleaseMigration[]> = () => Promise.resolve(release)) {
  let clock = 0;
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const database = { execute: jest.fn(execute) } as unknown as DatabaseInstance;
  const monitor = createReleaseMigrationLedgerMonitor({ database, loadRelease, log, recheckMs: 1000, now: () => clock });
  return { monitor, log, database, advance: (ms: number) => { clock += ms; } };
}

describe('createReleaseMigrationLedgerMonitor', () => {
  it('logs a verified schema once, as information', async () => {
    const { monitor, log } = setup(() => Promise.resolve(ledger(2)));
    expect(await monitor.isSafeToServe()).toBe(true);
    await monitor.current();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith('[WebConsole] All 2 migrations in this release are applied.');
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs a database behind the release as an error, and says it is reporting not ready', async () => {
    const { monitor, log } = setup(() => Promise.resolve(ledger(1)));
    expect(await monitor.isSafeToServe()).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      '[WebConsole] Database is behind this release; reporting not ready. ' +
      '1 of 2 migrations in this release are applied. First missing: 0001_second.',
    );
  });

  it.each([
    ['42501', 'permission denied for schema drizzle', 'permission denied'],
    ['42P01', 'relation "drizzle.__drizzle_migrations" does not exist', 'the ledger does not exist in this database'],
    ['3F000', 'schema "drizzle" does not exist', 'the ledger does not exist in this database'],
    ['57P03', 'the database system is starting up', 'PostgreSQL error 57P03'],
  ])('warns once, with the reason and the grant, when the ledger cannot be read (%s)', async (code, driverMessage, reason) => {
    const { monitor, log, advance } = setup(() => Promise.reject(postgresError(code, driverMessage)));
    expect(await monitor.isSafeToServe()).toBe(true);
    advance(1000); await monitor.current();
    advance(1000); await monitor.current();

    expect(log.warn).toHaveBeenCalledTimes(1);
    const message = String(log.warn.mock.calls[0][0]);
    expect(message).toBe(
      `[WebConsole] Database migrations are NOT verified: the applied-migration ledger could not be read (${reason}). ` +
      'The server keeps serving. Grant its database role SELECT on the drizzle schema ' +
      '(GRANT USAGE ON SCHEMA drizzle and GRANT SELECT ON drizzle.__drizzle_migrations) so it can check.',
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('never puts the driver message in the log, since it can carry connection details', async () => {
    const leaky = new Error('connect ECONNREFUSED db.internal.example:5432 user=dollhouse_app');
    const { monitor, log } = setup(() => Promise.reject(leaky));
    await monitor.current();
    const message = String(log.warn.mock.calls[0][0]);
    expect(message).toContain('could not be read (the database did not answer)');
    expect(message).not.toContain('db.internal.example');
    expect(message).not.toContain('dollhouse_app');
  });

  it('warns that the build is incomplete when the release list cannot be loaded, and retries loading it', async () => {
    const loadRelease = jest.fn<() => Promise<readonly ReleaseMigration[]>>()
      .mockRejectedValueOnce(new Error('ENOENT: /app/dist/database/release-migrations.json'))
      .mockResolvedValue(release);
    const { monitor, log, database, advance } = setup(() => Promise.resolve(ledger(2)), loadRelease);

    expect((await monitor.current()).state).toBe('pending');
    expect(database.execute).not.toHaveBeenCalled();
    const message = String(log.warn.mock.calls[0][0]);
    expect(message).toContain('this release\'s migration list could not be loaded, which points to an incomplete build');
    expect(message).not.toContain('/app/dist');

    advance(1000);
    expect((await monitor.current()).state).toBe('passed');
    expect(loadRelease).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('reports recovery once the grant is in place', async () => {
    let readable = false;
    const { monitor, log, advance } = setup(() => readable
      ? Promise.resolve(ledger(2))
      : Promise.reject(postgresError('42501', 'permission denied')));
    await monitor.current();
    readable = true;
    advance(1000);
    expect((await monitor.current()).state).toBe('passed');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});
