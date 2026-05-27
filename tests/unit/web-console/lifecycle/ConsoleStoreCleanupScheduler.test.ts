import { describe, expect, it, jest, afterEach } from '@jest/globals';

jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const {
  CONSOLE_STORE_CLEANUP_TASK_LABEL,
  ConsoleStoreCleanupScheduler,
  DEFAULT_CONSOLE_STORE_CLEANUP_INTERVAL_MS,
} = await import('../../../../src/web-console/lifecycle/index.js');
const { LifecycleService } = await import('../../../../src/lifecycle/LifecycleService.js');

const NOW = new Date('2026-05-26T12:00:00.000Z');

function stores(overrides: {
  readonly sessions?: jest.Mock<(before?: Date) => Promise<number>>;
  readonly login?: jest.Mock<(before?: Date) => Promise<number>>;
  readonly idempotency?: jest.Mock<(before?: Date) => Promise<number>>;
} = {}) {
  return {
    sessionStore: { sweepExpired: overrides.sessions ?? jest.fn(() => Promise.resolve(1)) },
    loginTransactionStore: { sweepExpired: overrides.login ?? jest.fn(() => Promise.resolve(2)) },
    idempotencyStore: { sweepExpired: overrides.idempotency ?? jest.fn(() => Promise.resolve(3)) },
  };
}

describe('ConsoleStoreCleanupScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('registers one periodic cleanup task with the configured lifecycle service', () => {
    const lifecycle = { registerPeriodicTask: jest.fn() };
    const scheduler = new ConsoleStoreCleanupScheduler({
      stores: stores(),
      intervalMs: 30_000,
      now: () => NOW,
      reportError: jest.fn(),
    });

    scheduler.register(lifecycle);

    expect(lifecycle.registerPeriodicTask).toHaveBeenCalledWith(
      30_000,
      expect.any(Function),
      CONSOLE_STORE_CLEANUP_TASK_LABEL,
    );
  });

  it('sweeps all console stores with the same cutoff time', async () => {
    const cleanupStores = stores();
    const scheduler = new ConsoleStoreCleanupScheduler({
      stores: cleanupStores,
      now: () => NOW,
    });

    const result = await scheduler.runOnce();

    expect(result).toEqual({
      before: NOW,
      removed: {
        consoleSessions: 1,
        loginTransactions: 2,
        idempotencyRecords: 3,
      },
      errors: [],
    });
    expect(cleanupStores.sessionStore.sweepExpired).toHaveBeenCalledWith(NOW);
    expect(cleanupStores.loginTransactionStore.sweepExpired).toHaveBeenCalledWith(NOW);
    expect(cleanupStores.idempotencyStore.sweepExpired).toHaveBeenCalledWith(NOW);
  });

  it('skips overlapping cleanup runs', async () => {
    let releaseSessionSweep: (() => void) | undefined;
    const sessions = jest.fn(() => new Promise<number>(resolve => {
      releaseSessionSweep = () => resolve(1);
    }));
    const cleanupStores = stores({ sessions });
    const scheduler = new ConsoleStoreCleanupScheduler({
      stores: cleanupStores,
      now: () => NOW,
    });

    const first = scheduler.runOnce();
    await Promise.resolve();
    await expect(scheduler.runOnce()).resolves.toBeNull();
    releaseSessionSweep?.();
    await expect(first).resolves.toMatchObject({ removed: { consoleSessions: 1 } });

    expect(cleanupStores.sessionStore.sweepExpired).toHaveBeenCalledTimes(1);
    expect(cleanupStores.loginTransactionStore.sweepExpired).toHaveBeenCalledTimes(1);
    expect(cleanupStores.idempotencyStore.sweepExpired).toHaveBeenCalledTimes(1);
  });

  it('reports individual store failures and continues later sweeps', async () => {
    const failure = new Error('session cleanup failed');
    const reportError = jest.fn();
    const cleanupStores = stores({
      sessions: jest.fn(() => Promise.reject(failure)),
    });
    const scheduler = new ConsoleStoreCleanupScheduler({
      stores: cleanupStores,
      now: () => NOW,
      reportError,
    });

    const result = await scheduler.runOnce();

    expect(result).toEqual({
      before: NOW,
      removed: {
        consoleSessions: 0,
        loginTransactions: 2,
        idempotencyRecords: 3,
      },
      errors: [{ store: 'consoleSessions', error: failure }],
    });
    expect(reportError).toHaveBeenCalledWith({ store: 'consoleSessions', error: failure });
    expect(cleanupStores.loginTransactionStore.sweepExpired).toHaveBeenCalledTimes(1);
    expect(cleanupStores.idempotencyStore.sweepExpired).toHaveBeenCalledTimes(1);
  });

  it('aggregates multiple store failures even without an error reporter for manual runs', async () => {
    const sessionFailure = new Error('session cleanup failed');
    const idempotencyFailure = new Error('idempotency cleanup failed');
    const cleanupStores = stores({
      sessions: jest.fn(() => Promise.reject(sessionFailure)),
      idempotency: jest.fn(() => Promise.reject(idempotencyFailure)),
    });
    const scheduler = new ConsoleStoreCleanupScheduler({
      stores: cleanupStores,
      now: () => NOW,
    });

    const result = await scheduler.runOnce();

    expect(result).toEqual({
      before: NOW,
      removed: {
        consoleSessions: 0,
        loginTransactions: 2,
        idempotencyRecords: 0,
      },
      errors: [
        { store: 'consoleSessions', error: sessionFailure },
        { store: 'idempotencyRecords', error: idempotencyFailure },
      ],
    });
    expect(cleanupStores.loginTransactionStore.sweepExpired).toHaveBeenCalledTimes(1);
  });

  it('requires an error reporter before scheduled registration', () => {
    const lifecycle = { registerPeriodicTask: jest.fn() };
    const scheduler = new ConsoleStoreCleanupScheduler({
      stores: stores(),
      now: () => NOW,
    });

    expect(() => scheduler.register(lifecycle)).toThrow('requires reportError');
    expect(lifecycle.registerPeriodicTask).not.toHaveBeenCalled();
  });

  it('uses the default hourly interval and LifecycleService disposal clears the timer', async () => {
    jest.useFakeTimers();
    const lifecycle = new LifecycleService();
    const cleanupStores = stores();
    const scheduler = new ConsoleStoreCleanupScheduler({
      stores: cleanupStores,
      now: () => NOW,
      reportError: jest.fn(),
    });

    scheduler.register(lifecycle);
    jest.advanceTimersByTime(DEFAULT_CONSOLE_STORE_CLEANUP_INTERVAL_MS);
    await Promise.resolve();
    expect(cleanupStores.sessionStore.sweepExpired).toHaveBeenCalledTimes(1);

    lifecycle.dispose();
    jest.advanceTimersByTime(DEFAULT_CONSOLE_STORE_CLEANUP_INTERVAL_MS * 2);
    await Promise.resolve();
    expect(cleanupStores.sessionStore.sweepExpired).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid cleanup interval %s',
    intervalMs => {
      expect(() => new ConsoleStoreCleanupScheduler({
        stores: stores(),
        intervalMs,
      })).toThrow('positive integer');
    },
  );
});
