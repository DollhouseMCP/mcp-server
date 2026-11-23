import { expect, jest } from '@jest/globals';
import { DangerZoneEnforcer } from '../../src/security/DangerZoneEnforcer.js';
import type { IDangerZoneBlockStore } from '../../src/state/IDangerZoneBlockStore.js';

export function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

export const admissionPhases = ['initial-read', 'load-to-drain', 'refresh', 'ready', 'held-apply', 'retry', 'reset', 'reset-drain'] as const;
export type AdmissionPhase = typeof admissionPhases[number];

/** Pause after a real query completes, before its caller advances to the next stage. */
export function pauseQueryResult<T extends object>(query: T, pause: () => Promise<void>): T {
  return new Proxy(query, {
    get(target, key) {
      if (key === 'then') {
        return (...args: Parameters<Promise<unknown>['then']>) => Promise.resolve(target)
          .then(async result => { await pause(); return result; }).then(...args);
      }
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args);
        return typeof result === 'object' && result !== null ? pauseQueryResult(result, pause) : result;
      };
    },
  });
}

export async function verifyResetStage(
  store: IDangerZoneBlockStore, count: number, install: (pause: () => Promise<void>) => void,
) {
  const block = { reason: 'Review required', blockedAt: new Date(0).toISOString() };
  await store.apply({ kind: 'put', name: 'older', block }, { older: block });
  const enforcer = new DangerZoneEnforcer(store);
  jest.spyOn(store, 'load').mockResolvedValueOnce({ status: 'invalid', cause: new Error('Invalid') });
  await enforcer.initialize();
  const entered = latch(), release = latch();
  install(async () => { entered.resolve(); await release.promise; });
  enforcer.setAdminToken('admin');
  const resetting = enforcer.clearAll('admin');
  await entered.promise;
  const names = Array.from({ length: count }, (_, index) => `arrival-${index}`);
  const receipts = names.map(name => enforcer.block(name, 'Review required', []));
  const flushing = enforcer.flush();
  release.resolve();
  expect(await resetting).toBe(true);
  expect(await Promise.all(receipts)).toEqual(names.map(() => true));
  expect(await flushing).toBe(true);
  const restored = new DangerZoneEnforcer(store);
  await restored.initialize();
  expect((await restored.getBlockedAgents()).sort((left, right) => left.localeCompare(right))).toEqual(names);
}

async function holdRead(
  store: IDangerZoneBlockStore, enforcer: DangerZoneEnforcer, phase: AdmissionPhase,
  entered: ReturnType<typeof latch>, release: ReturnType<typeof latch>,
) {
  const load = store.load.bind(store);
  jest.spyOn(store, 'load').mockImplementationOnce(async refresh => {
    if (phase === 'load-to-drain') {
      const result = await load(refresh);
      entered.resolve(); await release.promise; return result;
    }
    entered.resolve(); await release.promise; return load(refresh);
  });
  if (phase === 'retry') {
    expect(await enforcer.block('retained', 'Review required', [])).toBe(false);
    expect(await enforcer.flush()).toBe(false);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 1001);
  }
  return phase === 'initial-read' || phase === 'load-to-drain' ? enforcer.initialize() : enforcer.refresh();
}

async function startAdmission(
  store: IDangerZoneBlockStore, enforcer: DangerZoneEnforcer, phase: AdmissionPhase,
  entered: ReturnType<typeof latch>, release: ReturnType<typeof latch>,
) {
  const apply = store.apply.bind(store), reset = store.reset.bind(store);
  let operation: Promise<unknown> = Promise.resolve();
  let earlier: Promise<boolean> | undefined;
  if (phase === 'retry' || phase.startsWith('reset')) {
    // Give reset real evidence to preserve, even when the owner's read is unavailable.
    await store.apply({ kind: 'put', name: 'older', block: { reason: 'Review required', blockedAt: new Date(0).toISOString() } },
      { older: { reason: 'Review required', blockedAt: new Date(0).toISOString() } });
    jest.spyOn(store, 'load').mockResolvedValueOnce({ status: 'unreadable', cause: new Error('Unavailable') });
  }
  if (phase !== 'initial-read' && phase !== 'load-to-drain') await enforcer.initialize();
  if (phase === 'ready') {
    entered.resolve();
  } else if (phase === 'held-apply') {
    jest.spyOn(store, 'apply').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return apply(...args);
    });
    earlier = enforcer.block('earlier', 'Review required', []);
  } else if (phase.startsWith('reset')) {
    if (phase === 'reset') {
      jest.spyOn(store, 'reset').mockImplementationOnce(async () => {
        entered.resolve(); await release.promise; return reset();
      });
    } else {
      jest.spyOn(store, 'apply').mockImplementationOnce(async (...args) => {
        entered.resolve(); await release.promise; return apply(...args);
      });
    }
    enforcer.setAdminToken('admin');
    operation = enforcer.clearAll('admin');
    if (phase === 'reset-drain') earlier = enforcer.block('earlier', 'Review required', []);
  } else operation = holdRead(store, enforcer, phase, entered, release);
  return { operation, earlier };
}

/** Exercise owner admission boundaries against the actual backend supplied by a suite. */
export async function verifyAdmission(store: IDangerZoneBlockStore, phase: AdmissionPhase, count: number, fail = false) {
  const enforcer = new DangerZoneEnforcer(store);
  const entered = latch(), release = latch();
  const { operation, earlier } = await startAdmission(store, enforcer, phase, entered, release);
  await entered.promise;
  if (fail) jest.spyOn(store, 'apply').mockRejectedValueOnce(new Error('Storage unavailable'));
  const names = Array.from({ length: count }, (_, index) => `arrival-${index}`);
  const receipts = names.map(name => enforcer.block(name, 'Review required', []));
  const flushing = enforcer.flush();
  release.resolve();
  expect(await Promise.all(receipts)).toEqual(names.map(() => !fail));
  if (earlier) expect(await earlier).toBe(true);
  await operation;
  if (fail) {
    expect(await flushing).toBe(false);
    expect(await enforcer.flush()).toBe(false);
    expect((await enforcer.check('other')).reason).toContain('unavailable');
    return;
  }
  // Retry includes an earlier false receipt, which this fence must not erase.
  expect(await flushing).toBe(phase !== 'retry');
  expect(await enforcer.flush()).toBe(true);
  const restored = new DangerZoneEnforcer(store);
  await restored.initialize();
  const restoredNames = await restored.getBlockedAgents();
  for (const name of names) expect(restoredNames).toContain(name);
  if (phase.startsWith('reset')) expect(restoredNames).not.toContain('older');
}
export async function verifyBlockDrain(store: IDangerZoneBlockStore, fail: boolean, phase: 'initial' | 'refresh' = 'refresh') {
  const enforcer = new DangerZoneEnforcer(store);
  if (phase === 'refresh') await enforcer.initialize();
  const read = latch();
  const originalLoad = store.load.bind(store);
  jest.spyOn(store, 'load').mockImplementationOnce(async () => { await read.promise; return originalLoad(phase === 'refresh'); });
  const entered = [latch(), latch(), latch()];
  const release = [latch(), latch(), latch()];
  const apply = store.apply.bind(store);
  let index = 0;
  jest.spyOn(store, 'apply').mockImplementation(async (...args) => {
    const current = index++;
    if (current < 3) { entered[current].resolve(); await release[current].promise; }
    if (fail && current === 1) throw new Error('Storage unavailable');
    return apply(...args);
  });
  const checking = phase === 'initial' ? enforcer.initialize() : enforcer.check('other');
  const first = enforcer.block('a', 'Review required', []);
  read.resolve();
  await entered[0].promise;
  const second = enforcer.block('b', 'Review required', []);
  release[0].resolve();
  // A drain must advance to the next apply before its completion is reported.
  await Promise.race([entered[1].promise, first]);
  expect(index).toBeGreaterThanOrEqual(2);
  const third = enforcer.block('c', 'Review required', []);
  release[1].resolve();
  if (!fail) {
    await entered[2].promise;
    release[2].resolve();
  }
  const results = await Promise.all([first, second, third]);
  await checking;
  expect(await enforcer.flush()).toBe(!fail);
  if (fail) {
    expect(results[1]).toBe(false);
    expect((await enforcer.check('other')).reason).toContain('unavailable');
  } else {
    expect(results).toEqual([true, true, true]);
    const restored = new DangerZoneEnforcer(store);
    await restored.initialize();
    expect((await restored.getBlockedAgents()).sort((left, right) => left.localeCompare(right))).toEqual(['a', 'b', 'c']);
  }
}
