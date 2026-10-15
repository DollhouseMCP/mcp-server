import { expect, it } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { OwnedStorageCase } from './fixtures/ownedStorageCase.js';

it('preserves the second private root and ledger when admitted cleanup settles late', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-cleanup-'));
  const ledger = [path.join(root, 'first'), path.join(root, 'second')];
  await Promise.all(ledger.map(directory => fs.mkdir(directory)));
  const owner = new OwnedStorageCase(); owner.begin();
  let release!: () => void, entered!: () => void, finished!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const settled = new Promise<void>(resolve => { finished = resolve; });
  let lateGlobalMutation = false;
  const cleanup = owner.teardown(async (checkpoint?: () => void) => {
    // Optional only so this SAME real-root control executes against old helper.
    try {
      checkpoint?.(); await fs.rm(ledger[0], { recursive: true });
      entered(); await hold; // Hold the continuation after real first-root I/O.
      checkpoint?.(); ledger.shift();
      checkpoint?.(); lateGlobalMutation = true;
      checkpoint?.(); await fs.rm(ledger[0], { recursive: true });
      checkpoint?.(); ledger.shift();
    } finally { finished(); }
  }, 200);
  void cleanup.catch(() => undefined); // Observe immediately; assertions retain the original rejection.
  try {
    await started;
    await expect(cleanup).rejects.toThrow('safe cleanup not established');
    expect(() => owner.begin()).toThrow('Previous storage case');
    release(); await settled;
    expect((await fs.stat(path.join(root, 'second'))).isDirectory()).toBe(true);
    expect(ledger).toEqual([path.join(root, 'first'), path.join(root, 'second')]);
    expect(lateGlobalMutation).toBe(false);
    expect(() => owner.begin()).toThrow('Previous storage case');
    expect(() => owner.own(() => Promise.resolve())()).toThrow('admission is closed');
  } finally { release(); await settled; await cleanup.catch(() => undefined); await fs.rm(root, { recursive: true, force: true }); }
});

it('checks the absolute cutoff when the deadline timer cannot run', async () => {
  const owner = new OwnedStorageCase(); owner.begin();
  let lateMutation = false;
  await expect(owner.teardown((checkpoint?: () => void) => {
    // Keep the event loop occupied beyond the 50ms cutoff; no fake clock/timer.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
    checkpoint?.(); lateMutation = true;
    return Promise.resolve();
  }, 150)).rejects.toThrow('safe cleanup not established');
  expect(lateMutation).toBe(false);
  expect(() => owner.begin()).toThrow('Previous storage case');
});

it('shares the original cutoff across drain and cleanup', async () => {
  const owner = new OwnedStorageCase(); owner.begin();
  let release!: () => void;
  const pending = owner.own(() => new Promise<void>(resolve => { release = resolve; }))();
  await Promise.resolve();
  const cleanup = owner.teardown(checkpoint => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
    checkpoint();
    return Promise.resolve();
  }, 200);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
  release(); await pending;
  await expect(cleanup).rejects.toThrow('safe cleanup not established');
  expect(() => owner.begin()).toThrow('Previous storage case');
});

it('reopens only after normal cleanup, preserving falsy cleanup and body failures', async () => {
  const owner = new OwnedStorageCase(); owner.begin();
  await expect(owner.own(() => Promise.reject(undefined))()).rejects.toBeUndefined();
  let cleaned = false;
  await owner.teardown(async checkpoint => { checkpoint(); await Promise.resolve(); checkpoint(); cleaned = true; });
  expect(cleaned).toBe(true); expect(() => owner.begin()).not.toThrow();
  await expect(owner.teardown(() => Promise.reject(false))).rejects.toBe(false);
  expect(() => owner.begin()).toThrow('Previous storage case');
});
