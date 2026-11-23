import { expect, jest } from '@jest/globals';
import { DangerZoneEnforcer } from '../../src/security/DangerZoneEnforcer.js';
import type { IDangerZoneBlockStore } from '../../src/state/IDangerZoneBlockStore.js';

export const conflictCases = ['replacement', 'removed', 'older put'] as const;

export async function verifyDeclinedWrite(
  store: IDangerZoneBlockStore, otherStore: IDangerZoneBlockStore,
  scenario: typeof conflictCases[number], emulateConditional = false,
) {
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
  try {
  const first = new DangerZoneEnforcer(store), other = new DangerZoneEnforcer(otherStore);
  await first.initialize();
  await first.block('agent', 'Review required', [], 'original');
  const apply = store.apply.bind(store);
  const load = store.load.bind(store);
  let reconciliationFence: Promise<boolean> | undefined;
  let following: Promise<boolean> | undefined;
  const attempts = jest.spyOn(store, 'apply').mockImplementationOnce(async (...args) => {
    await other.initialize();
    if (scenario === 'removed') await other.unblock('agent', 'original');
    else {
      // Ensure the other owner's timestamp is strictly newer than the attempted put.
      clock.mockReturnValue(now + 1);
      await other.block('agent', 'New review required', [], 'replacement');
    }
    // File stores do not perform conditional writes; inject that contract outcome
    // while retaining real file reads/writes and an independent authoritative owner.
    jest.spyOn(store, 'load').mockImplementationOnce(refresh => {
      reconciliationFence = first.flush();
      return load(refresh);
    });
    following = first.block('later', 'Review required', []);
    return emulateConditional ? false : apply(...args);
  });
  const result = scenario === 'older put'
    ? await first.block('agent', 'Earlier review', [], 'earlier')
    : await first.unblock('agent', 'original');
  expect(result).toBe(false);
  expect(reconciliationFence).toBeDefined();
  expect(await reconciliationFence).toBe(false);
  expect((await first.check('unrelated')).blocked).toBe(false);
  const expected = scenario === 'removed' ? { blocked: false } : { blocked: true, verificationId: 'replacement' };
  expect(await first.check('agent')).toMatchObject(expected);
  const verifyAfter = async (elapsed: number) => {
    clock.mockReturnValue(now + elapsed);
    expect((await first.check('unrelated')).blocked).toBe(false);
    expect(await first.check('agent')).toMatchObject(expected);
  };
  await verifyAfter(1100);
  await verifyAfter(2200);
  await verifyAfter(3300);
  expect(attempts).toHaveBeenCalledTimes(2);
  expect(following).toBeDefined();
  expect(await following).toBe(true);
  expect(await first.flush()).toBe(true);
  const restored = new DangerZoneEnforcer(otherStore);
  await restored.initialize();
  expect(await restored.check('agent')).toMatchObject(expected);
  expect((await restored.check('later')).blocked).toBe(true);
  } finally { clock.mockRestore(); }
}
