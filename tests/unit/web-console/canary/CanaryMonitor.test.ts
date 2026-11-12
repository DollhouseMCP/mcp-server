import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import {
  CANARY_PASS_MAX_AGE_MS,
  CANARY_SCHEDULE_TASK_LABEL,
  CanaryMonitor,
  MIN_CANARY_INTERVAL_MS,
  hasNoCurrentCanaryResult,
  type CanaryMonitorOptions,
} from '../../../../src/web-console/canary/CanaryMonitor.js';
import type { CanaryResult } from '../../../../src/web-console/canary/CanaryRun.js';

const PASSED: CanaryResult = {
  id: 'approval_execution_projection', state: 'passed', code: 'canary_passed', detail: 'Created, read back and removed.',
};
const FAILED: CanaryResult = {
  id: 'approval_execution_projection', state: 'failed', code: 'canary_approval_not_readable', detail: 'The console did not list it.',
};
const TIMED_OUT: CanaryResult = {
  id: 'approval_execution_projection', state: 'pending', code: 'canary_timed_out', detail: 'Nothing is verified.',
};

function setUp(overrides: Partial<CanaryMonitorOptions> = {}) {
  let time = new Date('2026-11-12T09:00:00.000Z').getTime();
  const clock = { advance: (ms: number) => { time += ms; } };
  const log = { info: jest.fn<(message: string) => void>(), warn: jest.fn<(message: string) => void>() };
  const run = jest.fn<() => Promise<CanaryResult>>().mockResolvedValue(PASSED);
  const sweep = jest.fn<(now: Date) => Promise<number>>().mockResolvedValue(0);
  const monitor = new CanaryMonitor({ run, sweep, log, now: () => new Date(time), ...overrides });
  return { monitor, run, sweep, log, clock };
}

describe('CanaryMonitor', () => {
  let securityEvent: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    securityEvent = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});
  });

  afterEach(() => {
    securityEvent.mockRestore();
  });

  it('says the canary has not run, and runs nothing, until it is asked', () => {
    const { monitor, run } = setUp();

    const status = monitor.status();

    expect(status).toEqual({
      state: 'pending',
      code: 'canary_not_run',
      detail: 'The canary has not run on this server since it started. Run it from Operations, or switch the schedule on.',
      lastRun: null,
    });
    expect(hasNoCurrentCanaryResult(status)).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs when an admin asks, and remembers what it found, who asked and when', async () => {
    const { monitor, run, clock, log } = setUp();
    run.mockImplementation(() => { clock.advance(250); return Promise.resolve(PASSED); });

    const record = await monitor.run('admin');

    expect(record).toEqual({
      result: PASSED,
      trigger: 'admin',
      startedAt: new Date('2026-11-12T09:00:00.000Z'),
      finishedAt: new Date('2026-11-12T09:00:00.250Z'),
    });
    expect(monitor.status()).toEqual({ state: 'passed', code: 'canary_passed', detail: PASSED.detail, lastRun: record });
    expect(hasNoCurrentCanaryResult(monitor.status())).toBe(false);
    expect(log.info).toHaveBeenCalledWith('[WebConsoleCanary] admin run: canary_passed. Created, read back and removed.');
  });

  it('warns in the log when a run does not pass', async () => {
    const { monitor, log } = setUp({ run: () => Promise.resolve(FAILED) });

    await monitor.run('admin');

    expect(log.warn).toHaveBeenCalledWith('[WebConsoleCanary] admin run: canary_approval_not_readable. The console did not list it.');
    expect(monitor.status()).toMatchObject({ state: 'failed', code: 'canary_approval_not_readable' });
  });

  it('gives a second request the run already in progress, not a run of its own', async () => {
    let finish: (result: CanaryResult) => void = () => {};
    const { monitor, run } = setUp();
    run.mockImplementation(() => new Promise<CanaryResult>(resolve => { finish = resolve; }));

    const first = monitor.run('schedule');
    const second = monitor.run('admin');
    finish(PASSED);

    expect(await second).toBe(await first);
    expect((await second).trigger).toBe('schedule');
    expect(run).toHaveBeenCalledTimes(1);

    // Once that run is over, the next request starts a new one.
    run.mockResolvedValue(FAILED);
    expect((await monitor.run('admin')).result).toBe(FAILED);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('is free to run again after a run that threw', async () => {
    const { monitor, run } = setUp();
    run.mockRejectedValueOnce(new Error('boom'));

    await expect(monitor.run('admin')).rejects.toThrow('boom');
    expect(monitor.status().code).toBe('canary_not_run');
    expect((await monitor.run('admin')).result).toBe(PASSED);
  });

  it('records a scheduled run as a system event, because it has no admin to be audited as', async () => {
    const { monitor } = setUp();

    await monitor.run('schedule');

    expect(securityEvent).toHaveBeenCalledTimes(1);
    expect(securityEvent).toHaveBeenCalledWith({
      type: 'OPERATION_COMPLETED',
      severity: 'LOW',
      source: 'WebConsoleCanary',
      details: 'Scheduled canary run finished at 2026-11-12T09:00:00.000Z: canary_passed',
      additionalData: { check: 'approval_execution_projection', trigger: 'schedule', state: 'passed', code: 'canary_passed' },
    });
  });

  it.each([
    [FAILED, 'MEDIUM'],
    [TIMED_OUT, 'LOW'],
  ] as const)('records a scheduled run that did not pass as a failed operation (%#)', async (result, severity) => {
    const { monitor } = setUp({ run: () => Promise.resolve(result) });

    await monitor.run('schedule');

    expect(securityEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'OPERATION_FAILED', severity, additionalData: expect.objectContaining({ code: result.code, state: result.state }),
    }));
  });

  it('leaves an admin\'s run to the admin audit', async () => {
    const { monitor } = setUp();

    await monitor.run('admin');

    expect(securityEvent).not.toHaveBeenCalled();
  });

  it('stops counting a pass once it is a day old', async () => {
    const { monitor, clock } = setUp();
    const record = await monitor.run('admin');

    clock.advance(CANARY_PASS_MAX_AGE_MS);
    expect(monitor.status().code).toBe('canary_passed');

    clock.advance(1);
    const status = monitor.status();
    expect(status).toEqual({
      state: 'pending',
      code: 'canary_result_stale',
      detail: 'The canary last passed more than 24 hours ago, so that result is no longer current. Run it again, or switch the schedule on.',
      lastRun: record,
    });
    expect(hasNoCurrentCanaryResult(status)).toBe(true);
  });

  it('keeps reporting a fault it found, however old, until a later run clears it', async () => {
    const { monitor, run, clock } = setUp();
    run.mockResolvedValueOnce(FAILED);
    await monitor.run('admin');

    clock.advance(CANARY_PASS_MAX_AGE_MS * 3);
    expect(monitor.status()).toMatchObject({ state: 'failed', code: 'canary_approval_not_readable' });

    await monitor.run('admin');
    expect(monitor.status()).toMatchObject({ state: 'passed', code: 'canary_passed' });
  });

  describe('the schedule', () => {
    it('registers one periodic task that runs the canary as the schedule', async () => {
      const { monitor, run } = setUp();
      const lifecycle = { registerPeriodicTask: jest.fn<(intervalMs: number, task: () => Promise<void>, label: string) => unknown>() };

      monitor.register(lifecycle, MIN_CANARY_INTERVAL_MS);

      expect(lifecycle.registerPeriodicTask).toHaveBeenCalledTimes(1);
      const [intervalMs, task, label] = lifecycle.registerPeriodicTask.mock.calls[0];
      expect(intervalMs).toBe(MIN_CANARY_INTERVAL_MS);
      expect(label).toBe(CANARY_SCHEDULE_TASK_LABEL);
      // Registering runs nothing. The first run is one interval later.
      expect(run).not.toHaveBeenCalled();
      await task();
      expect(monitor.status().lastRun?.trigger).toBe('schedule');
    });

    it.each([0, -1, MIN_CANARY_INTERVAL_MS - 1, 1.5, Number.NaN])('refuses an interval of %s ms', intervalMs => {
      const { monitor } = setUp();
      const lifecycle = { registerPeriodicTask: jest.fn() };

      expect(() => monitor.register(lifecycle, intervalMs)).toThrow('Canary schedule interval');
      expect(lifecycle.registerPeriodicTask).not.toHaveBeenCalled();
    });
  });

  describe('the start-up sweep', () => {
    it('removes what an unfinished run left behind and says how much', async () => {
      const { monitor, sweep, log, run } = setUp();
      sweep.mockResolvedValue(2);

      await monitor.sweepLeftovers();

      expect(sweep).toHaveBeenCalledWith(new Date('2026-11-12T09:00:00.000Z'));
      expect(log.info).toHaveBeenCalledWith('[WebConsoleCanary] Removed 2 canary session(s) left by an unfinished run');
      expect(run).not.toHaveBeenCalled();
    });

    it('says nothing when there was nothing to remove', async () => {
      const { monitor, log } = setUp();

      await monitor.sweepLeftovers();

      expect(log.info).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('does not fail start-up, or repeat the driver\'s words, when the sweep cannot run', async () => {
      const { monitor, sweep, log } = setUp();
      sweep.mockRejectedValue(new Error('connect ECONNREFUSED db.internal.example:5432 user=dollhouse_app'));

      await expect(monitor.sweepLeftovers()).resolves.toBeUndefined();

      expect(log.warn).toHaveBeenCalledWith(
        '[WebConsoleCanary] Could not sweep canary leftovers at start-up; the next run sweeps again',
      );
    });
  });
});
