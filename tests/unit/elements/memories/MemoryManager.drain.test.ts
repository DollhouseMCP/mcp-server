import { describe, expect, it } from '@jest/globals';
import { createHook } from 'node:async_hooks';
import { MemoryManager } from '../../../../src/elements/memories/MemoryManager.js';

function drainFixture() {
  const pending = new Set<Promise<void>>();
  const completed: number[] = [];
  const host = {
    upgradeSaveOperations: pending,
    hasRetainedMemoryWork: () => false,
    flushPendingSaves: MemoryManager.prototype.flushPendingSaves,
  } as unknown as MemoryManager;
  const enqueue = (id: number): (() => void) => {
    let finish!: () => void;
    const work = new Promise<void>(resolve => { finish = resolve; }).then(() => {
      pending.delete(work);
      completed.push(id);
    });
    pending.add(work);
    return finish;
  };
  return { enqueue, completed, flush: () => MemoryManager.prototype.flushPendingSaves.call(host) };
}

describe('MemoryManager pending save drain', () => {
  it('waits for saves arriving while an earlier batch is pending', async () => {
    const fixture = drainFixture();
    const first = fixture.enqueue(1);
    let drained = false;
    const drain = fixture.flush().then(() => { drained = true; });
    const second = fixture.enqueue(2);
    first();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fixture.completed).toEqual([1]);
    expect(drained).toBe(false);
    second();
    await drain;
    expect(fixture.completed).toEqual([1, 2]);
  });

  it('keeps unsettled promises bounded across continuously arriving batches', async () => {
    const fixture = drainFixture();
    const live = new Set<number>();
    let peak = 0;
    const hook = createHook({
      init(id, type) {
        if (type === 'PROMISE') {
          live.add(id);
          peak = Math.max(peak, live.size);
        }
      },
      promiseResolve(id) { live.delete(id); },
    });
    let finish = fixture.enqueue(0);
    hook.enable();
    try {
      const drain = fixture.flush();
      const batches = new Promise<void>(resolve => {
        const step = (id: number): void => {
          const previous = finish;
          if (id < 500) finish = fixture.enqueue(id);
          previous();
          if (id < 500) setImmediate(step, id + 1);
          else resolve();
        };
        setImmediate(step, 1);
      });
      await batches;
      await drain;
    } finally {
      hook.disable();
    }
    expect(fixture.completed).toHaveLength(500);
    expect(peak).toBeLessThan(40);
  });
});
