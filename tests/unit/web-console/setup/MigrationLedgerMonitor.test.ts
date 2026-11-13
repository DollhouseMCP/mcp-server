import { describe, expect, it, jest } from '@jest/globals';

import { MigrationLedgerMonitor } from '../../../../src/web-console/setup/MigrationLedgerMonitor.js';
import {
  MIGRATION_LEDGER_PROBE_TIMED_OUT,
  RELEASE_MIGRATIONS_UNAVAILABLE,
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
    const { monitor } = setup([RELEASE_MIGRATIONS_UNAVAILABLE]);
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
    const { monitor, probe, advance } = setup([RELEASE_MIGRATIONS_UNAVAILABLE, PASSED]);
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
    const { monitor, onChange, advance } = setup([INCOMPLETE, INCOMPLETE, PASSED]);
    await monitor.current();
    advance(1000); await monitor.current();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(INCOMPLETE);

    advance(1000); await monitor.current();
    advance(1000); await monitor.current();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(PASSED);
  });

  it('keeps the replica in service when the ledger does not match this release entry for entry', async () => {
    const { monitor, onChange } = setup([MISMATCH]);
    expect(await monitor.isSafeToServe()).toBe(true);
    expect(await monitor.current()).toEqual(MISMATCH);
    expect(onChange).toHaveBeenCalledWith(MISMATCH);
  });

  it('treats a mismatch as final, like a pass: the database is not behind and cannot become so', async () => {
    const { monitor, probe, onChange, advance } = setup([MISMATCH, INCOMPLETE]);
    await monitor.current();
    advance(60_000);
    expect(await monitor.current()).toEqual(MISMATCH);
    expect(await monitor.isSafeToServe()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('moves from behind to a mismatch once the migrations land, and then serves', async () => {
    const { monitor, advance } = setup([INCOMPLETE, MISMATCH]);
    expect(await monitor.isSafeToServe()).toBe(false);
    advance(1000);
    expect(await monitor.isSafeToServe()).toBe(true);
    expect(await monitor.current()).toEqual(MISMATCH);
  });

  describe('when the ledger read does not return', () => {
    // A probe the test settles by hand, behind a short real timeout.
    function stalled(first?: MigrationLedgerResult) {
      let clock = 0;
      const finish: Array<(result: MigrationLedgerResult) => void> = [];
      let calls = 0;
      const probe = jest.fn(() => (first && calls++ === 0)
        ? Promise.resolve(first)
        : new Promise<MigrationLedgerResult>(resolve => { finish.push(resolve); }));
      const onChange = jest.fn();
      const monitor = new MigrationLedgerMonitor({ probe, recheckMs: 1000, probeTimeoutMs: 20, now: () => clock, onChange });
      return { monitor, probe, onChange, finish, advance: (ms: number) => { clock += ms; } };
    }
    const settle = () => new Promise<void>(resolve => { setImmediate(resolve); });

    it('answers as unverified within the timeout, and keeps the replica in service', async () => {
      const { monitor, onChange } = stalled();
      const started = Date.now();
      expect(await monitor.isSafeToServe()).toBe(true);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(await monitor.current()).toEqual(MIGRATION_LEDGER_PROBE_TIMED_OUT);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(MIGRATION_LEDGER_PROBE_TIMED_OUT);
    });

    it('gives every caller that arrived together the same timeout answer from one probe', async () => {
      const { monitor, probe } = stalled();
      expect(await Promise.all([monitor.current(), monitor.current(), monitor.isSafeToServe()]))
        .toEqual([MIGRATION_LEDGER_PROBE_TIMED_OUT, MIGRATION_LEDGER_PROBE_TIMED_OUT, true]);
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it('starts no second probe while the first is still out, and answers at once', async () => {
      const { monitor, probe, advance } = stalled();
      await monitor.current();
      for (let poll = 0; poll < 5; poll++) {
        advance(1000);
        // Already settled: it wins a race against the next turn of the event loop.
        expect(await Promise.race([monitor.current(), settle().then(() => 'still waiting')]))
          .toEqual(MIGRATION_LEDGER_PROBE_TIMED_OUT);
      }
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it('uses the late answer when the probe finally returns, then probes normally again', async () => {
      const { monitor, probe, onChange, finish, advance } = stalled();
      await monitor.current();
      finish[0](INCOMPLETE);
      await settle();
      expect(await monitor.current()).toEqual(INCOMPLETE);
      expect(await monitor.isSafeToServe()).toBe(false);
      expect(onChange).toHaveBeenLastCalledWith(INCOMPLETE);

      advance(1000);
      const next = monitor.current();
      expect(probe).toHaveBeenCalledTimes(2);
      finish[1](PASSED);
      expect(await next).toEqual(PASSED);
    });

    it('does not let a slow re-check overturn a shortfall it has already verified', async () => {
      const { monitor, probe, onChange, finish, advance } = stalled(INCOMPLETE);
      expect(await monitor.isSafeToServe()).toBe(false);
      advance(1000);
      expect(await monitor.isSafeToServe()).toBe(false);
      expect(await monitor.current()).toEqual(INCOMPLETE);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenCalledTimes(1);

      finish[0](PASSED);
      await settle();
      expect(await monitor.isSafeToServe()).toBe(true);
    });
  });

  it('defaults to a two-second wait for the probe', async () => {
    jest.useFakeTimers();
    try {
      const monitor = new MigrationLedgerMonitor({ probe: () => new Promise<MigrationLedgerResult>(() => {}), now: () => 0 });
      const answer = monitor.current();
      let settled = false;
      void answer.then(() => { settled = true; });
      await jest.advanceTimersByTimeAsync(1999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(await answer).toEqual(MIGRATION_LEDGER_PROBE_TIMED_OUT);
    } finally {
      jest.useRealTimers();
    }
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
