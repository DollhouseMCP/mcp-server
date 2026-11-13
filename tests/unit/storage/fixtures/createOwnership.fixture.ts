import { afterAll, afterEach, expect, it, jest } from '@jest/globals';
import * as actualFs from 'node:fs/promises';
import * as path from 'node:path';

const proofRoot = process.env.CREATE_OWNERSHIP_PROOF_ROOT!;
const mode = process.env.CREATE_OWNERSHIP_PROOF_MODE!;
const events: string[] = [];
const observer = { read: () => 'original' };
const spy = jest.spyOn(observer, 'read').mockReturnValue('retained');
let release!: () => void, ownedRoot = '', removals = 0, cleanupBeforeSettlement = false;
let siblingStarted = false, siblingSettled = false, nextEntered = false;
let sibling: Promise<void> | undefined;
const held = new Promise<void>(resolve => { release = resolve; });
const mkdtemp = async (...args: Parameters<typeof actualFs.mkdtemp>) => {
  const root = await actualFs.mkdtemp(...args);
  if (typeof root === 'string' && path.basename(root).startsWith('memory-exclusive-create-')) ownedRoot = root;
  return root;
};
const writeFile = (...args: Parameters<typeof actualFs.writeFile>): Promise<void> => {
  const pending = actualFs.writeFile(...args);
  if (mode !== 'timeout' || path.basename(String(args[0])) !== 'Existing0.yaml') return pending;
  siblingStarted = true;
  sibling = pending.then(async () => {
    await held;
    expect(await actualFs.readFile(String(args[0]), 'utf8')).toContain('Existing');
    expect(observer.read()).toBe('retained');
    siblingSettled = true; events.push('sibling-settled-with-resources');
  });
  return sibling;
};
const rm = async (...args: Parameters<typeof actualFs.rm>): Promise<void> => {
  if (ownedRoot && String(args[0]) === ownedRoot) {
    removals++;
    if (siblingStarted && !siblingSettled) { cleanupBeforeSettlement = true; throw new Error('CREATE cleanup before sibling settlement'); }
    events.push('root-cleanup');
  }
  await actualFs.rm(...args);
};
jest.unstable_mockModule('node:fs/promises', () => ({ ...actualFs, mkdtemp, writeFile, rm }));
// Register before the imported suite: release after the failure/timeout is observed.
afterEach(() => { events.push('afterEach-enter'); if (mode !== 'blocked') release(); });
const { fixture, ownedAll, ownership } = await import('../FileMemoryOwnedCreate.test.js');
if (mode !== 'timeout') {
  it('controlled CREATE fail-fast sibling proof', ownership.own(async () => {
    const f = await fixture('Proof.yaml');
    const late = actualFs.writeFile(f.head, 'held').then(async () => {
      siblingStarted = true;
      await held;
      expect(await actualFs.readFile(f.head, 'utf8')).toBe('held');
      expect(observer.read()).toBe('retained');
      siblingSettled = true; events.push('sibling-settled-with-resources');
    });
    sibling = late;
    await ownedAll([Promise.reject(new Error('CREATE controlled first failure')), late]);
  }));
}
it('controlled CREATE next case', ownership.own(async () => {
  nextEntered = true; events.push('next-case');
  expect(siblingSettled).toBe(true);
  expect(removals).toBe(1);
  expect(cleanupBeforeSettlement).toBe(false);
  expect(observer.read()).toBe('original');
  await expect(actualFs.stat(ownedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
}));
afterAll(async () => {
  release();
  if (sibling) await Promise.allSettled([sibling]);
  await new Promise<void>(resolve => setImmediate(resolve));
  const rootRetained = await actualFs.stat(ownedRoot).then(() => true, () => false);
  await actualFs.writeFile(path.join(proofRoot, 'receipt.json'), JSON.stringify({
    mode, siblingStarted, siblingSettled, removals, cleanupBeforeSettlement,
    nextEntered, rootRetained, observer: observer.read(), events,
  }));
  spy.mockRestore();
});
