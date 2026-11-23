import { expect, jest } from '@jest/globals';
import { DangerZoneEnforcer } from '../../src/security/DangerZoneEnforcer.js';
import type { IDangerZoneBlockStore } from '../../src/state/IDangerZoneBlockStore.js';
import { latch } from './blockDrain.js';

export const firstUseCases = ['check', 'block', 'unblock', 'release', 'clear', 'flush', 'list', 'has blocks'] as const;
type FirstUse = typeof firstUseCases[number];

function invoke(enforcer: DangerZoneEnforcer, operation: FirstUse) {
  switch (operation) {
    case 'check': return enforcer.check('stored');
    case 'block': return enforcer.block('new', 'Review required', []);
    case 'unblock': return enforcer.unblock('stored', 'code');
    case 'release': return enforcer.releaseChallenge('code');
    case 'clear': return enforcer.clearAll('admin');
    case 'flush': return enforcer.flush();
    case 'list': return enforcer.getBlockedAgents();
    case 'has blocks': return enforcer.hasBlockedAgents();
  }
}

export async function verifyFirstUse(store: IDangerZoneBlockStore, operation: FirstUse) {
  const block = { reason: 'Review required', verificationId: 'code', blockedAt: new Date(0).toISOString() };
  await store.apply({ kind: 'put', name: 'stored', block }, { stored: block });
  const enforcer = new DangerZoneEnforcer(store);
  enforcer.setAdminToken('admin');
  const release = latch(), load = store.load.bind(store);
  const reads = jest.spyOn(store, 'load').mockImplementationOnce(async () => { await release.promise; return load(); });
  let answered = false;
  const pending = Promise.resolve(invoke(enforcer, operation)).then(value => { answered = true; return value; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(reads).toHaveBeenCalledTimes(1);
    expect(answered).toBe(false);
  } finally { release.resolve(); }
  const result = await pending;
  if (operation === 'check') expect(result).toMatchObject({ blocked: true, verificationId: 'code' });
  else if (operation === 'release') expect(result).toMatchObject({ released: true, agentName: 'stored' });
  else if (operation === 'list') expect(result).toEqual(['stored']);
  else expect(result).toBe(true);
  const restored = new DangerZoneEnforcer(store);
  await restored.initialize();
  if (operation === 'block') expect((await restored.check('new')).blocked).toBe(true);
  const removed = ['unblock', 'release', 'clear'].includes(operation);
  expect((await restored.check('stored')).blocked).toBe(!removed);
}

export async function verifyConcurrentFirstUse(store: IDangerZoneBlockStore) {
  const enforcer = new DangerZoneEnforcer(store);
  const release = latch(), load = store.load.bind(store);
  const reads = jest.spyOn(store, 'load').mockImplementationOnce(async () => { await release.promise; return load(); });
  const calls = [enforcer.check('new'), enforcer.block('new', 'Review required', []), enforcer.flush(), enforcer.getBlockedAgents()];
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(reads).toHaveBeenCalledTimes(1);
  } finally { release.resolve(); }
  const [checked, blocked, flushed, names] = await Promise.all(calls);
  expect(checked).toMatchObject({ blocked: true });
  expect(blocked).toBe(true);
  expect(flushed).toBe(true);
  expect(names).toEqual(['new']);
  expect(reads).toHaveBeenCalledTimes(1);
}
