import { expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { OwnedStorageCase } from './fixtures/ownedStorageCase.js';
import { cleanupDirectoryReadObservers, observeDirectoryReads } from './fixtures/aggregateDirectoryReadObserver.js';

it('stops the real observer backstop before a second restoration when the timer is delayed', async () => {
  const first = { read: () => Promise.resolve(null) }, second = { read: () => Promise.resolve(null) };
  const originalFirst = first.read, originalSecond = second.read;
  let armed = false;
  const slow = new Proxy(second, { defineProperty(target, key, descriptor) {
    const result = Reflect.defineProperty(target, key, descriptor);
    if (armed && descriptor.value === originalSecond) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
    return result;
  } });
  const a = observeDirectoryReads(first), b = observeDirectoryReads(slow), installedFirst = first.read;
  const owner = new OwnedStorageCase(); owner.begin();
  const cleanup = jest.fn(() => Promise.resolve());
  try {
    armed = true;
    await expect(owner.teardown(checkpoint => cleanupDirectoryReadObservers(cleanup, checkpoint), 150))
      .rejects.toThrow('safe cleanup not established');
    expect(second.read).toBe(originalSecond); expect(first.read).toBe(installedFirst);
    expect(cleanup).not.toHaveBeenCalled(); expect(() => owner.begin()).toThrow('Previous storage case');
  } finally { armed = false; b.restore(); a.restore(); }
  expect(first.read).toBe(originalFirst);
});

it('retains later observers, mocks and the second root after an admitted cleanup continuation expires', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-compat-'));
  const ledger = [path.join(root, 'first'), path.join(root, 'second')];
  await Promise.all(ledger.map(directory => fs.mkdir(directory)));
  const method = { read: () => Promise.resolve(null), marker: () => 'original' };
  const old = observeDirectoryReads(method);
  const owner = new OwnedStorageCase(); owner.begin();
  let release!: () => void, entered!: () => void, finished!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const settled = new Promise<void>(resolve => { finished = resolve; });
  const cleanup = owner.teardown(checkpoint => cleanupDirectoryReadObservers(async () => {
    try {
      checkpoint(); await fs.rm(ledger[0], { recursive: true });
      entered(); await hold;
      checkpoint(); ledger.shift();
      checkpoint(); jest.restoreAllMocks();
      checkpoint(); await fs.rm(ledger[0], { recursive: true });
      checkpoint(); ledger.shift();
    } finally { finished(); }
  }, checkpoint), 200);
  void cleanup.catch(() => undefined);
  let later: ReturnType<typeof observeDirectoryReads> | undefined;
  let spy: ReturnType<typeof jest.spyOn> | undefined;
  try {
    await started; await expect(cleanup).rejects.toThrow('safe cleanup not established');
    later = observeDirectoryReads(method); const installed = method.read;
    const markerSpy = jest.spyOn(method, 'marker').mockReturnValue('later'); spy = markerSpy;
    release(); await settled;
    expect(method.read).toBe(installed); expect(method.marker()).toBe('later');
    expect((await fs.stat(path.join(root, 'second'))).isDirectory()).toBe(true);
    expect(ledger).toEqual([path.join(root, 'first'), path.join(root, 'second')]);
    expect(() => owner.begin()).toThrow('Previous storage case');
  } finally {
    release(); await settled; await cleanup.catch(() => undefined);
    spy?.mockRestore(); later?.restore(); old.restore(); await fs.rm(root, { recursive: true, force: true });
  }
});

it('preserves an earlier restoration failure when admission closes before cleanup', async () => {
  const method = { read: () => Promise.resolve(null) }, original = method.read;
  const observer = observeDirectoryReads(method), installed = Object.getOwnPropertyDescriptor(method, 'read')!;
  Object.defineProperty(method, 'read', { ...installed, value: () => Promise.resolve(null) });
  const deadline = new Error('admission closed'); let checks = 0;
  const cleanup = jest.fn(() => Promise.resolve());
  try {
    const error = await cleanupDirectoryReadObservers(cleanup, () => { if (++checks > 1) throw deadline; })
      .then(() => undefined, cause => cause as AggregateError);
    expect(error?.errors).toHaveLength(2); expect(error?.errors[0].message).toContain('no longer owns');
    expect(error?.errors[1]).toBe(deadline); expect(cleanup).not.toHaveBeenCalled();
  } finally { Object.defineProperty(method, 'read', installed); observer.restore(); }
  expect(method.read).toBe(original);
});
