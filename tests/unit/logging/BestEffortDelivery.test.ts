import { jest, describe, it, expect } from '@jest/globals';
import { BestEffortDelivery, BestEffortListeners } from '../../../src/logging/BestEffortDelivery.js';

describe('BestEffortDelivery', () => {
  it('counts failures and reports once per failure streak', () => {
    const report = jest.fn();
    let now = 0;
    const guard = new BestEffortDelivery('fixture', report, () => now);
    const fail = () => { throw new Error('unavailable'); };
    expect(guard.run(fail)).toEqual({ delivered: false });
    guard.run(fail);
    expect(guard.failureCount).toBe(2);
    expect(report).toHaveBeenCalledTimes(1);
    expect(guard.run(() => 42)).toEqual({ delivered: true, value: 42 });
    guard.run(fail);
    expect(report).toHaveBeenCalledTimes(1);
    now = 60_000;
    guard.run(() => 42);
    guard.run(fail);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith('fixture', 2, 'Error');
  });

  it.each(['sync', 'thenable', 'async'])('reports only the error type for %s failure', async mode => {
    const report = jest.fn();
    const guard = new BestEffortDelivery('fixture', report);
    const error = new TypeError('secret user payload');
    if (mode === 'sync') guard.run(() => { throw error; });
    else if (mode === 'async') await guard.runAsync(async () => { throw error; });
    else guard.run(() => ({ then: (_resolve: unknown, reject: (reason: unknown) => void) => reject(error) }));
    await new Promise(resolve => setImmediate(resolve));
    expect(report).toHaveBeenCalledWith('fixture', 0, 'TypeError');
    expect(JSON.stringify(report.mock.calls)).not.toContain('secret user payload');
  });

  it.each(['hostile', 'overlong', 'odd', 'trailing-newline', 'non-string', 'non-error'])('sanitizes %s error names', async kind => {
    const report = jest.fn();
    const guard = new BestEffortDelivery('fixture', report);
    const error = new Error('secret');
    Object.defineProperty(error, 'name', { get: () => {
      if (kind === 'hostile') throw new Error('secret getter');
      if (kind === 'overlong') return 'x'.repeat(65);
      if (kind === 'trailing-newline') return 'Error\n';
      return kind === 'non-string' ? {} : 'Error\nsecret';
    } });
    await guard.runAsync(async () => { throw kind === 'non-error' ? { name: 'SecretPayload' } : error; });
    expect(report).toHaveBeenCalledWith('fixture', 0, kind === 'non-error' ? 'non-error' : 'Error');
    expect(guard.failureCount).toBe(1);
  });

  it('reports a continuously failing listener once until success starts a new streak', () => {
    const report = jest.fn();
    let now = 0;
    const guard = new BestEffortDelivery('fixture', report, () => now);
    let failing = true;
    const listener = guard.wrap(() => { if (failing) throw new Error('unavailable'); });
    for (let attempt = 0; attempt < 10; attempt++) {
      listener();
      now += 60_000;
    }
    expect(report).toHaveBeenCalledTimes(1);
    failing = false;
    listener();
    failing = true;
    listener();
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('isolates diagnostic failures and asynchronous delivery failures', async () => {
    const guard = new BestEffortDelivery('fixture', () => { throw new Error('unavailable'); });
    await expect(guard.runAsync(() => { throw new Error('sync'); })).resolves.toBeUndefined();
    await expect(guard.runAsync(async () => { throw new Error('async'); })).resolves.toBeUndefined();
    expect(guard.failureCount).toBe(2);
  });

  it('counts rejected promises and thenables without waiting on the emit path', async () => {
    const report = jest.fn();
    const guard = new BestEffortDelivery('fixture', report);
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const delivery = guard.run(async () => { throw new Error('unavailable'); });
      expect(delivery.delivered).toBe(true);
      guard.wrap(() => Promise.reject(new Error('unavailable')))();
      guard.run(() => ({ then: (_resolve: unknown, reject: (error: Error) => void) => reject(new Error('unavailable')) }));
      await new Promise(resolve => setImmediate(resolve));
      expect(guard.failureCount).toBe(3);
      expect(report).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('resets asynchronous failure health only after successful resolution', async () => {
    let now = 0;
    const report = jest.fn();
    const guard = new BestEffortDelivery('fixture', report, () => now);
    const fail = () => { throw new Error('unavailable'); };
    guard.run(fail);
    let complete!: () => void;
    guard.run(() => new Promise<void>(resolve => { complete = resolve; }));
    now = 60_000;
    guard.run(fail);
    expect(report).toHaveBeenCalledTimes(1);
    complete();
    await new Promise(resolve => setImmediate(resolve));
    guard.run(fail);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('reads a stateful then accessor once', async () => {
    const guard = new BestEffortDelivery('fixture', jest.fn());
    let reads = 0;
    const then = jest.fn((_resolve: unknown, reject: (error: Error) => void) => reject(new Error('unavailable')));
    const value = { get then() { reads++; return reads === 1 ? then : undefined; } };
    guard.run(() => value);
    await new Promise(resolve => setImmediate(resolve));
    expect(reads).toBe(1);
    expect(then).toHaveBeenCalledTimes(1);
    expect(guard.failureCount).toBe(1);
  });

  it.each(['getter', 'method'])('counts synchronous then %s errors', async source => {
    const guard = new BestEffortDelivery('fixture', jest.fn());
    const value = { get then() {
      if (source === 'getter') throw new Error('unavailable');
      return () => { throw new Error('unavailable'); };
    } };
    expect(() => guard.run(() => value)).not.toThrow();
    await new Promise(resolve => setImmediate(resolve));
    expect(guard.failureCount).toBe(1);
  });

  it('preserves independent subscriptions and exact removal', () => {
    const listeners = new BestEffortListeners<[string]>('fixture');
    const first = jest.fn();
    const second = jest.fn();
    const subscription = listeners.add(first);
    listeners.add(second);
    subscription.remove();
    listeners.emit('value');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('value');
  });
});
