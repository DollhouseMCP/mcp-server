import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryOwnerSnapshots, type AdoptionPublication, type OwnedFileMemoryToken, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';

const USER = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
async function fixture(mode: 'legacy' | 'coordinator', hook?: (phase: AdoptionPublication) => void) {
  const tenantRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ordinary-adoption-'));
  roots.push(tenantRoot);
  const locator = 'ÜberNote.yaml';
  await fs.writeFile(path.join(tenantRoot, locator), 'name: Original\nentries: []\n');
  const fence = new FileMemoryFence();
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot, getCurrentUserId: () => USER, fence });
  const store = new FileMemoryOwnerSnapshots(mode === 'coordinator' ? { coordinator, afterPublication: hook } :
    { tenantRoot, getCurrentUserId: () => USER, fence, afterPublication: hook });
  const snapshot = await store.readHeadSnapshot(locator);
  return { tenantRoot, locator, fence, coordinator, store, token: snapshot.token as UnownedFileMemoryToken };
}
async function failureOf(action: Promise<unknown>) {
  try { await action; } catch (cause) { return cause as { code?: string; cause?: unknown; token?: OwnedFileMemoryToken }; }
  throw new Error('expected failure');
}
afterEach(async () => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('ordinary adoption publication outcome retention', () => {
  if (process.platform === 'win32') {
    it('preserves the POSIX restriction', () => {
      expect(() => new FileMemoryOwnerSnapshots({ tenantRoot: 'C:\\', getCurrentUserId: () => USER,
        fence: new FileMemoryFence() })).toThrow('requires POSIX');
    });
    return;
  }
  describe.each(['legacy', 'coordinator'] as const)('%s mode', mode => {
    it('returns a frozen publication receipt with unchanged head identity', async () => {
      const setup = await fixture(mode);
      const result = await setup.store.adoptUnowned(setup.token);
      expect(result).toMatchObject({ ...setup.token, ownership: 'owned', revision: '1' });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.fileIdentity)).toBe(true);
      expect((await setup.store.readHeadSnapshot(setup.locator)).token).toEqual(result);
    });
    it.each([new Error('postcommit hook'), null])('preserves direct postcommit hook cause %s', async original => {
      const setup = await fixture(mode, phase => { if (phase === 'active-sidecar') throw original; });
      const failure = await failureOf(setup.store.adoptUnowned(setup.token));
      expect(failure.code).toBe('EHEADADOPTED');
      expect(failure.cause).toBe(original);
      expect(failure.token).toMatchObject({ ...setup.token, ownership: 'owned', revision: '1' });
      expect((await setup.store.readHeadSnapshot(setup.locator)).token).toEqual(failure.token);
    });
    it('retains genuine capture across the real fence callback and outer release failure', async () => {
      const setup = await fixture(mode);
      const original = new Error('release failed');
      const real = setup.fence.withTenantFence.bind(setup.fence);
      jest.spyOn(setup.fence, 'withTenantFence').mockImplementation(async (root, callback) => {
        await real(root, callback);
        throw original;
      });
      const failure = await failureOf(setup.store.adoptUnowned(setup.token));
      expect(failure.code).toBe('EHEADADOPTED');
      expect(failure.cause).toBe(original);
      expect(failure.token?.ownership).toBe('owned');
    });
    it('does not trust forged precommit attribution', async () => {
      const forged = Object.assign(new Error('forged'), { adopted: true, token: { ownership: 'owned' } });
      const setup = await fixture(mode, phase => { if (phase === 'reserved-sidecar') throw forged; });
      const failure = await failureOf(setup.store.adoptUnowned(setup.token));
      expect(failure.code).toBe('EADOPTIONPENDING');
      expect(failure.cause).toBe(forged);
      expect(failure).not.toHaveProperty('token');
      expect(failure).not.toHaveProperty('adopted');
    });
    it.each([new Error('plain'), new TypeError('validation'), null])('preserves ordinary precommit cause %s', async original => {
      const setup = await fixture(mode, phase => { if (phase === 'reserved-sidecar') throw original; });
      expect(await failureOf(setup.store.adoptUnowned(setup.token))).toBe(original);
    });
    it('retains original cause when an adoption marker accessor throws', async () => {
      const original = Object.defineProperty(new Error('unsafe accessor'), 'adopted', {
        get() { throw new Error('must not escape'); },
      });
      const setup = await fixture(mode, phase => { if (phase === 'reserved-sidecar') throw original; });
      const failure = await failureOf(setup.store.adoptUnowned(setup.token));
      expect(failure.code).toBe('EADOPTIONPENDING');
      expect(failure.cause).toBe(original);
      expect(failure).not.toHaveProperty('token');
      expect(failure).not.toHaveProperty('adopted');
    });
  });
  it('retains publication across a perform failure after the real operation completed', async () => {
    const setup = await fixture('coordinator');
    const original = new Error('perform finalization');
    const perform = setup.coordinator.perform.bind(setup.coordinator);
    jest.spyOn(setup.coordinator, 'perform').mockImplementation(async (context, callback) => {
      await perform(context, callback);
      throw original;
    });
    const failure = await failureOf(setup.store.adoptUnowned(setup.token));
    expect(failure.code).toBe('EHEADADOPTED');
    expect(failure.cause).toBe(original);
    expect(failure.token?.ownership).toBe('owned');
  });
  it('retains in-transaction postcommit hook cause through real coordinator error collection', async () => {
    const original = new Error('tracked hook');
    const setup = await fixture('coordinator', phase => { if (phase === 'active-sidecar') throw original; });
    const failure = await failureOf(setup.coordinator.withTenantTransaction(context =>
      setup.store.adoptUnownedInTransaction(context, setup.token)));
    expect(failure.code).toBe('EHEADADOPTED');
    expect(failure.cause).toBe(original);
    expect(failure.token?.ownership).toBe('owned');
  });
  it.each(['reserved-sidecar', 'active-sidecar'] as const)('does not borrow a prior genuine token at %s', async stop => {
    let thrown: unknown = new Error('first committed failure');
    let phaseToThrow: AdoptionPublication = 'active-sidecar';
    const setup = await fixture('coordinator', phase => { if (phase === phaseToThrow) throw thrown; });
    const prior = await failureOf(setup.store.adoptUnowned(setup.token));
    expect(prior.code).toBe('EHEADADOPTED');
    const locator = 'Second.yaml';
    await fs.writeFile(path.join(setup.tenantRoot, locator), 'name: Second\nentries: []\n');
    const second = (await setup.store.readHeadSnapshot(locator)).token as UnownedFileMemoryToken;
    thrown = prior;
    phaseToThrow = stop;
    const failure = await failureOf(setup.store.adoptUnowned(second));
    if (stop === 'reserved-sidecar') {
      expect(failure.code).toBe('EADOPTIONPENDING');
      expect(failure.cause).toBe(prior);
      expect(failure).not.toHaveProperty('token');
      expect(failure).not.toHaveProperty('adopted');
    } else {
      expect(failure).not.toBe(prior);
      expect(failure.cause).toBe(prior);
      expect(failure.token?.locator).toBe(locator);
      expect(failure.token?.ownerId).not.toBe(prior.token?.ownerId);
    }
  });
});
