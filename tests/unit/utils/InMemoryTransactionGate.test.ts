import { describe, expect, it } from '@jest/globals';

import { InMemoryTransactionGate } from '../../../src/utils/InMemoryTransactionGate.js';

describe('InMemoryTransactionGate', () => {
  it('allows transaction-owned reads and mutations to reenter without deadlocking', async () => {
    const gate = new InMemoryTransactionGate();

    await expect(gate.runTransaction(() => gate.runMutation(() => gate.runRead(
      () => Promise.resolve('reentrant'),
    )))).resolves.toBe('reentrant');
  });

  it('does not let detached work retain transaction ownership after commit', async () => {
    const gate = new InMemoryTransactionGate();
    let releaseDetached!: () => void;
    const detachedTrigger = new Promise<void>(resolve => { releaseDetached = resolve; });
    let detachedRead!: Promise<string>;

    await gate.runTransaction(async () => {
      detachedRead = detachedTrigger.then(() => gate.runRead(() => Promise.resolve('visible')));
    });

    let releaseBlockingTransaction!: () => void;
    let signalBlockingTransaction!: () => void;
    const blockingTransactionEntered = new Promise<void>(resolve => { signalBlockingTransaction = resolve; });
    const blockingTransactionHold = new Promise<void>(resolve => { releaseBlockingTransaction = resolve; });
    const blockingTransaction = gate.runTransaction(async () => {
      signalBlockingTransaction();
      await blockingTransactionHold;
    });
    await blockingTransactionEntered;

    let detachedSettled = false;
    releaseDetached();
    void detachedRead.then(() => { detachedSettled = true; });
    await Promise.resolve();
    expect(detachedSettled).toBe(false);

    releaseBlockingTransaction();
    await blockingTransaction;
    await expect(detachedRead).resolves.toBe('visible');
  });
});
