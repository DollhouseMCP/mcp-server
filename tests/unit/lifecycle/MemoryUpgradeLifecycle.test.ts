import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { MemoryUpgradeLifecycle, MemoryWriteOutcomeError } from '../../../src/lifecycle/MemoryUpgradeLifecycle.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('Memory upgrade lifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('closes admission synchronously and waits for every admitted original write', async () => {
    const lifecycle = new MemoryUpgradeLifecycle();
    const stored = deferred<void>();
    const request = lifecycle.runRequest(() => lifecycle.runWrite(() => stored.promise));
    const drain = lifecycle.quiesceAndDrain(100);
    await expect(lifecycle.runRequest(async () => 'late')).rejects.toMatchObject({ code: 'EMEMORYDRAIN' });
    await Promise.resolve();
    expect(lifecycle.getSummary().admitted).toBe(1);
    stored.resolve();
    await request;
    await drain;
    expect(lifecycle.getSummary()).toMatchObject({ state: 'drained', admitted: 0, writes: 0 });
  });

  it('never lets an older success clear a newer failed attempt, even for identical bytes', async () => {
    const lifecycle = new MemoryUpgradeLifecycle();
    const owner = {};
    const identity = { owner, target: 'owned-target', candidate: 'complete candidate', candidateDigest: 'same-digest' };
    const older = deferred<void>();
    const first = lifecycle.runWrite(() => older.promise, identity);
    await expect(lifecycle.runWrite(async () => { throw new MemoryWriteOutcomeError('refused-before-write', new Error('newer failed')); }, identity)).rejects.toThrow('newer failed');
    older.resolve();
    await first;
    expect(lifecycle.getSummary().failedWrites).toBe(1);
    // Only a later, exact known save reconciles this settled failure.
    await lifecycle.runWrite(async () => {}, identity);
    expect(lifecycle.getSummary().failedWrites).toBe(0);
    await lifecycle.quiesceAndDrain();
  });

  it('does not reconcile a different owner, target or candidate', async () => {
    const lifecycle = new MemoryUpgradeLifecycle();
    const identity = { owner: {}, target: 'a', candidate: 'first', candidateDigest: 'first' };
    await expect(lifecycle.runWrite(async () => { throw new MemoryWriteOutcomeError('refused-before-write', new Error('failed')); }, identity)).rejects.toThrow();
    for (const other of [{ ...identity, owner: {} }, { ...identity, target: 'b' },
      { ...identity, target: 'other-target', candidate: 'different', candidateDigest: 'different' }]) {
      await lifecycle.runWrite(async () => {}, other);
      expect(lifecycle.getSummary().failedWrites).toBe(1);
    }
    await lifecycle.runWrite(async () => {}, identity);
    await lifecycle.quiesceAndDrain();
  });

  it('retains unknown outcomes and refuses exact replay or drain', async () => {
    const lifecycle = new MemoryUpgradeLifecycle();
    const identity = { owner: {}, target: 'a', candidate: 'snapshot', candidateDigest: 'digest' };
    await expect(lifecycle.runWrite(async () => { throw new MemoryWriteOutcomeError('unknown', new Error('private cause')); }, identity)).rejects.toThrow('reconciliation');
    let replayed = false;
    await expect(lifecycle.runWrite(async () => { replayed = true; }, identity)).rejects.toThrow('without replay');
    expect(replayed).toBe(false);
    await expect(lifecycle.quiesceAndDrain()).rejects.toThrow();
    expect(lifecycle.getSummary()).toMatchObject({ state: 'refused', failedWrites: 1 });
  });

  it('retains disposed owners and refuses release until their obligations are known complete', async () => {
    const lifecycle = new MemoryUpgradeLifecycle();
    let retained = true;
    const owner = { flushPendingSaves: async () => { retained = false; }, hasRetainedMemoryWork: () => retained };
    lifecycle.registerOwner(owner);
    expect(() => lifecycle.releaseOwner(owner)).toThrow('retain');
    await lifecycle.quiesceAndDrain();
    lifecycle.releaseOwner(owner);
    expect(lifecycle.getSummary().owners).toBe(0);
  });

  it('a deadline leaves original promises and the owner intact and permits no late admission', async () => {
    const lifecycle = new MemoryUpgradeLifecycle();
    const stored = deferred<void>();
    const request = lifecycle.runRequest(() => lifecycle.runWrite(() => stored.promise));
    const drain = lifecycle.quiesceAndDrain(10);
    const refusal = expect(drain).rejects.toMatchObject({ code: 'EMEMORYDRAIN' });
    await jest.advanceTimersByTimeAsync(10);
    await refusal;
    expect(lifecycle.getSummary()).toMatchObject({ state: 'refused', admitted: 1, writes: 1 });
    await expect(lifecycle.runRequest(async () => {})).rejects.toThrow('not admitted');
    stored.resolve();
    await request;
    await lifecycle.quiesceAndDrain(100);
  });

  it('expired request context cannot authorize an unregistered late timer write', async () => {
    const lifecycle = new MemoryUpgradeLifecycle();
    let late!: () => Promise<unknown>;
    await lifecycle.runRequest(async () => {
      const resource = new (await import('node:async_hooks')).AsyncResource('retained-test-context');
      late = () => resource.runInAsyncScope(() => lifecycle.runWrite(async () => {}));
    });
    await lifecycle.quiesceAndDrain();
    await expect(late()).rejects.toMatchObject({ code: 'EMEMORYDRAIN' });
  });
});
