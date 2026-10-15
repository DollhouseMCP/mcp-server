import { afterAll, afterEach, expect, it, jest } from '@jest/globals';
import * as actualFs from 'node:fs/promises';
import * as path from 'node:path';

const proofRoot = process.env.EOF_SETUP_PROOF_ROOT!;
const mode = process.env.EOF_SETUP_PROOF_MODE!;
const writes: Promise<void>[] = [];
const events: string[] = [];
const observer = { read: () => 'original' };
const spy = jest.spyOn(observer, 'read').mockReturnValue('retained');
let release!: () => void, settled = 0, rejected = 0, removals = 0;
let ownedRoot = '', cleanupBeforeSettlement = false, nextEntered = false;
const held = new Promise<void>(resolve => { release = resolve; });
// This is a fixture scheduling gate after a real write, not a claim of a
// stalled kernel syscall. Its returned promise includes a real readback.
const writeFile = (...args: Parameters<typeof actualFs.writeFile>): Promise<void> => {
  const name = typeof args[0] === 'string' ? path.basename(args[0]) : '';
  if (!/^n\d+$/.test(name)) return actualFs.writeFile(...args);
  ownedRoot = path.dirname(String(args[0]));
  let write: Promise<void>;
  if (name === 'n0' && mode !== 'setup-timeout') {
    // Intentionally falsy: the regression must preserve Promise.all's original rejection.
    write = Promise.reject(undefined);
  } else if (name === 'n1') {
    write = actualFs.writeFile(...args).then(async () => {
      await held;
      expect(await actualFs.readFile(String(args[0]), 'utf8')).toBe('x');
      expect(observer.read()).toBe('retained');
      events.push('sibling-settled-with-resources');
    });
  } else {
    write = actualFs.writeFile(...args);
  }
  writes.push(write);
  void write.then(() => { settled++; }, () => { settled++; rejected++; });
  return write;
};
const rm = async (...args: Parameters<typeof actualFs.rm>): Promise<void> => {
  if (ownedRoot && path.basename(String(args[0])) === path.basename(ownedRoot)) {
    removals++;
    if (settled !== writes.length) { cleanupBeforeSettlement = true; throw new Error('cleanup admitted before sibling settlement'); }
    events.push('root-cleanup');
  }
  await actualFs.rm(...args);
};
jest.unstable_mockModule('node:fs/promises', () => ({ ...actualFs, writeFile, rm }));
afterEach(() => {
  events.push('afterEach-enter');
  if (mode !== 'blocked') release();
});
await import('../FileMemoryAdoptionRecoveryScanBudget.test.js');
it('controlled next case enters only after owned settlement and cleanup', async () => {
  nextEntered = true; events.push('next-case');
  expect(settled).toBe(4096); expect(removals).toBe(1);
  expect(cleanupBeforeSettlement).toBe(false); expect(observer.read()).toBe('original');
  await expect(actualFs.stat(ownedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});
afterAll(async () => {
  release(); await Promise.allSettled(writes);
  await new Promise<void>(resolve => setImmediate(resolve));
  const rootRetained = await actualFs.stat(ownedRoot).then(() => true, () => false);
  await actualFs.writeFile(path.join(proofRoot, 'receipt.json'), JSON.stringify({
    mode, writes: writes.length, settled, rejected, removals, cleanupBeforeSettlement,
    nextEntered, rootRetained, observer: observer.read(), events,
  }));
  spy.mockRestore(); // Harness cleanup after original callback/sibling settlement.
});
