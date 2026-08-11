import { AsyncKeyedLock } from '../../../src/utils/AsyncKeyedLock.js';

describe('AsyncKeyedLock', () => {
  it('serializes operations sharing a key', async () => {
    const lock = new AsyncKeyedLock();
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];

    const first = lock.runExclusive('agent', async () => {
      order.push('first-start');
      await firstBlocked;
      order.push('first-end');
    });
    const second = lock.runExclusive('agent', async () => {
      order.push('second');
    });

    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('releases the next operation after a failure', async () => {
    const lock = new AsyncKeyedLock();
    const failure = lock.runExclusive('agent', async () => {
      throw new Error('failed operation');
    });
    const next = lock.runExclusive('agent', async () => 'completed');

    await expect(failure).rejects.toThrow('failed operation');
    await expect(next).resolves.toBe('completed');
  });

  it('allows different keys to run concurrently', async () => {
    const lock = new AsyncKeyedLock();
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = false;

    const first = lock.runExclusive('agent-a', () => firstBlocked);
    const second = lock.runExclusive('agent-b', async () => {
      secondStarted = true;
    });

    await second;
    expect(secondStarted).toBe(true);
    releaseFirst?.();
    await first;
  });
});
