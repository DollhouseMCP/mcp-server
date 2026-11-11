import { describe, expect, it, jest } from '@jest/globals';

import { MigrationLedgerMonitor } from '../../../../src/web-console/setup/MigrationLedgerMonitor.js';
import {
  MIGRATION_LEDGER_UNREADABLE,
  type MigrationLedgerResult,
} from '../../../../src/web-console/setup/MigrationLedgerProbe.js';

const PASSED: MigrationLedgerResult = {
  id: 'production_database_migrations', state: 'passed', code: 'migrations_applied',
  detail: 'All 3 migrations in this release are applied.',
};
const INCOMPLETE: MigrationLedgerResult = {
  id: 'production_database_migrations', state: 'failed', code: 'migrations_incomplete',
  detail: '2 of 3 migrations in this release are applied. First missing: 0002_third.',
};
const MISMATCH: MigrationLedgerResult = {
  id: 'production_database_migrations', state: 'failed', code: 'migrations_mismatch',
  detail: 'Applied migration 2 does not match 0001_second in this release.',
};

function setup(results: readonly MigrationLedgerResult[], recheckMs = 1000) {
  let clock = 0;
  let index = 0;
  const probe = jest.fn(() => Promise.resolve(results[Math.min(index++, results.length - 1)]));
  const onChange = jest.fn();
  const monitor = new MigrationLedgerMonitor({ probe, recheckMs, now: () => clock, onChange });
  return { monitor, probe, onChange, advance: (ms: number) => { clock += ms; } };
}

describe('MigrationLedgerMonitor', () => {
  it('probes once and then keeps a pass for the life of the process', async () => {
    const { monitor, probe, advance } = setup([PASSED, INCOMPLETE]);
    expect(await monitor.current()).toEqual(PASSED);
    advance(60 * 60 * 1000);
    expect(await monitor.current()).toEqual(PASSED);
    expect(await monitor.isSafeToServe()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('reports a database behind the release as unsafe to serve', async () => {
    const { monitor } = setup([INCOMPLETE]);
    expect(await monitor.isSafeToServe()).toBe(false);
    expect(await monitor.current()).toEqual(INCOMPLETE);
  });

  it('does not take the replica out of service when the ledger cannot be read', async () => {
    const { monitor } = setup([MIGRATION_LEDGER_UNREADABLE]);
    expect(await monitor.isSafeToServe()).toBe(true);
    expect((await monitor.current()).state).toBe('pending');
  });

  it('re-probes a failure no more than once per interval and recovers when migrations land', async () => {
    const { monitor, probe, advance } = setup([INCOMPLETE, INCOMPLETE, PASSED]);
    expect(await monitor.isSafeToServe()).toBe(false);
    advance(999);
    expect(await monitor.isSafeToServe()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);

    advance(1);
    expect(await monitor.isSafeToServe()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);

    advance(1000);
    expect(await monitor.isSafeToServe()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);

    advance(10_000);
    expect(await monitor.isSafeToServe()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('keeps re-probing an unreadable ledger at the interval until it can verify', async () => {
    const { monitor, probe, advance } = setup([MIGRATION_LEDGER_UNREADABLE, PASSED]);
    expect((await monitor.current()).state).toBe('pending');
    advance(500);
    expect((await monitor.current()).state).toBe('pending');
    advance(500);
    expect(await monitor.current()).toEqual(PASSED);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('shares one probe between callers that arrive together', async () => {
    let finish!: (result: MigrationLedgerResult) => void;
    const probe = jest.fn(() => new Promise<MigrationLedgerResult>(resolve => { finish = resolve; }));
    const monitor = new MigrationLedgerMonitor({ probe, now: () => 0 });
    const callers = [monitor.current(), monitor.current(), monitor.isSafeToServe()];
    expect(probe).toHaveBeenCalledTimes(1);
    finish(INCOMPLETE);
    expect(await Promise.all(callers)).toEqual([INCOMPLETE, INCOMPLETE, false]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('announces each change of answer once, not every poll', async () => {
    const { monitor, onChange, advance } = setup([INCOMPLETE, INCOMPLETE, MISMATCH, PASSED]);
    await monitor.current();
    advance(1000); await monitor.current();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(INCOMPLETE);

    advance(1000); await monitor.current();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(MISMATCH);

    advance(1000); await monitor.current();
    advance(1000); await monitor.current();
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenLastCalledWith(PASSED);
  });

  it('defaults to a fifteen-second interval', async () => {
    let clock = 0;
    const probe = jest.fn(() => Promise.resolve(INCOMPLETE));
    const monitor = new MigrationLedgerMonitor({ probe, now: () => clock });
    await monitor.current();
    clock = 14_999; await monitor.current();
    expect(probe).toHaveBeenCalledTimes(1);
    clock = 15_000; await monitor.current();
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
