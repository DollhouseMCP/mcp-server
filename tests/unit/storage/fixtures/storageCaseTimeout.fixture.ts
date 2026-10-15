import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { OwnedStorageCase } from './ownedStorageCase.js';
import { observeDirectoryReads, cleanupDirectoryReadObservers } from './aggregateDirectoryReadObserver.js';

const root = process.env.STORAGE_CASE_PROOF_ROOT!;
const events: string[] = [];
const method = { read: () => Promise.resolve(null), observed: () => 'original' };
const originalRead = method.read;

describe('settling original callback', () => {
  const owner = new OwnedStorageCase();
  let release!: () => void;
  let first = true;
  beforeEach(() => owner.begin());
  afterEach(async () => {
    // Jest invokes this only after recording the original 10s body failure.
    // Release the actual admitted operation deterministically at that boundary.
    events.push('teardown-enter'); release?.();
    await owner.teardown(checkpoint => cleanupDirectoryReadObservers(async () => {
      checkpoint();
      events.push('cleanup'); checkpoint(); jest.restoreAllMocks();
      checkpoint(); await fs.rm(path.join(root, 'settling'), { recursive: true, force: true });
      checkpoint();
    }, checkpoint));
  });
  it('preserves the original ten second timeout', owner.own(async () => {
    await fs.mkdir(path.join(root, 'settling'));
    await fs.writeFile(path.join(root, 'settling', 'evidence'), 'retained');
    observeDirectoryReads(method);
    jest.spyOn(method, 'observed').mockReturnValue('installed');
    const admittedOperation = new Promise<void>(resolve => { release = resolve; });
    try {
      await admittedOperation;
      expect(await fs.readFile(path.join(root, 'settling', 'evidence'), 'utf8')).toBe('retained');
      expect(method.observed()).toBe('installed');
      expect(method.read).not.toBe(originalRead);
      events.push('operation-settled-with-resources');
      owner.checkpoint();
      events.push('forbidden-next-batch');
    } finally { events.push('body-settled'); }
  }), 10000);
  it('admits the next case only after settlement and cleanup', owner.own(async () => {
    first = false;
    events.push('next-body');
    expect(events).toEqual(['teardown-enter', 'operation-settled-with-resources', 'body-settled', 'cleanup', 'next-body']);
    expect(method.observed()).toBe('original'); expect(method.read).toBe(originalRead);
    await expect(fs.stat(path.join(root, 'settling'))).rejects.toMatchObject({ code: 'ENOENT' });
  }));
  afterAll(() => { expect(first).toBe(false); });
});

describe('unsettled original callback', () => {
  const owner = new OwnedStorageCase();
  let releaseBlocked!: () => void;
  let bodySettled!: () => void;
  const settled = new Promise<void>(resolve => { bodySettled = resolve; });
  beforeEach(() => owner.begin());
  afterEach(() => owner.teardown(async checkpoint => {
    checkpoint(); events.push('forbidden-cleanup'); checkpoint(); jest.restoreAllMocks();
    checkpoint(); await fs.rm(path.join(root, 'blocked'), { recursive: true, force: true });
    checkpoint();
  }, 200));
  it('retains resources if the actual callback exceeds the cleanup budget', owner.own(async () => {
    await fs.mkdir(path.join(root, 'blocked'));
    jest.spyOn(method, 'observed').mockReturnValue('retained');
    await new Promise<void>(resolve => { releaseBlocked = resolve; });
    events.push('late-settlement'); bodySettled();
  }), 100);
  it('refuses the following body', owner.own(() => { events.push('forbidden-body'); return Promise.resolve(); }));
  afterAll(async () => {
    releaseBlocked(); await settled;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(method.observed()).toBe('retained');
    expect((await fs.stat(path.join(root, 'blocked'))).isDirectory()).toBe(true);
    expect(events).not.toContain('forbidden-cleanup'); expect(events).not.toContain('forbidden-body');
    await fs.writeFile(path.join(root, 'events.json'), JSON.stringify(events));
  });
});
