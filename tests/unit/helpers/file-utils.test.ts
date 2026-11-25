import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as native from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const remove = jest.fn<typeof native.rm>(native.rm);
const unlink = jest.fn<typeof native.unlink>(native.unlink);
const readdir = jest.fn<typeof native.readdir>(native.readdir);
const access = jest.fn<typeof native.access>(native.access);
jest.unstable_mockModule('node:fs/promises', () => ({ ...native, rm: remove, unlink, readdir, access }));
const { cleanDirectory, waitForFile } = await import('../../helpers/file-utils.js');
const { createRealSkillManager } = await import('../../helpers/di-mocks.js');
const { requireCompleteCollection } = await import('../../../src/elements/base/CollectionReport.js');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

let root: string;
beforeEach(async () => {
  remove.mockReset().mockImplementation(native.rm);
  unlink.mockReset().mockImplementation(native.unlink);
  readdir.mockReset().mockImplementation(native.readdir);
  access.mockReset().mockImplementation(native.access);
  root = await native.mkdtemp(path.join(tmpdir(), 'cleanup-helper-'));
});
afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  await native.rm(root, { recursive: true, force: true });
});

describe('waitForFile', () => {
  it('polls at 100ms intervals until the file appears', async () => {
    jest.useFakeTimers();
    access.mockRejectedValueOnce(new Error('missing')).mockResolvedValueOnce(undefined);
    const waiting = waitForFile(path.join(root, 'eventual.md'));
    await jest.advanceTimersByTimeAsync(99);
    expect(access).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await waiting;
    expect(access).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('checks the timeout before each probe and preserves the final polling interval', async () => {
    jest.useFakeTimers();
    access.mockRejectedValue(new Error('missing'));
    const file = path.join(root, 'missing.md');
    const outcome = waitForFile(file, 150).catch((error: Error) => error);
    await jest.advanceTimersByTimeAsync(200);
    expect(await outcome).toEqual(new Error(`File ${file} did not appear within 150ms`));
    expect(access).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not probe with a zero timeout', async () => {
    await expect(waitForFile(root, 0)).rejects.toThrow(`File ${root} did not appear within 0ms`);
    expect(access).not.toHaveBeenCalled();
  });
});

describe('cleanDirectory', () => {
  it('removes files and subdirectories while retaining the directory', async () => {
    await native.mkdir(path.join(root, '.tmp'));
    await native.writeFile(path.join(root, '.tmp', 'pending.tmp'), 'temporary');
    await native.writeFile(path.join(root, 'persona.md'), 'definition');
    await cleanDirectory(root);
    expect(remove).toHaveBeenCalledWith(path.join(root, '.tmp'), { recursive: true, force: true });
    expect(await native.readdir(root)).toEqual([]);
  });

  it('resolves for an absent directory and already-missing children', async () => {
    await expect(cleanDirectory(path.join(root, 'missing'))).resolves.toBeUndefined();
    await native.writeFile(path.join(root, 'vanished.md'), 'old');
    remove.mockImplementationOnce(async target => {
      await native.unlink(target);
      throw Object.assign(new Error('Already removed'), { code: 'ENOENT' });
    });
    await expect(cleanDirectory(root)).resolves.toBeUndefined();
    expect(await native.readdir(root)).toEqual([]);
  });

  it('propagates directory enumeration failures other than absence', async () => {
    const failure = Object.assign(new Error('Directory inaccessible'), { code: 'EACCES' });
    readdir.mockRejectedValueOnce(failure);
    await expect(cleanDirectory(root)).rejects.toBe(failure);
    expect(remove).not.toHaveBeenCalled();
  });

  it('joins every removal before reporting a sibling failure', async () => {
    const slow = path.join(root, 'slow.md');
    const blocked = path.join(root, 'blocked.md');
    await native.mkdir(path.join(root, '.tmp'));
    await native.writeFile(path.join(root, '.tmp', 'pending.tmp'), 'temporary');
    await native.writeFile(slow, 'old');
    await native.writeFile(blocked, 'blocked');
    const started = deferred();
    const release = deferred();
    const rejected = deferred();
    const failure = Object.assign(new Error('Removal denied'), { code: 'EACCES' });
    let slowFinished = false;
    let cleanupSettled = false;
    remove.mockImplementation(async (target, options) => {
      if (target === blocked) { rejected.resolve(); throw failure; }
      if (target === slow) { started.resolve(); await release.promise; }
      await native.rm(target, options);
      if (target === slow) slowFinished = true;
    });
    const outcome = cleanDirectory(root).then(
      () => { cleanupSettled = true; return undefined; },
      error => { cleanupSettled = true; return error as AggregateError; },
    );
    try {
      await Promise.all([started.promise, rejected.promise]);
      // An event-loop checkpoint lets the sibling rejection propagate; no timed settle delay.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(cleanupSettled).toBe(false);
      expect(slowFinished).toBe(false);
    } finally { release.resolve(); }
    const error = await outcome;
    expect(slowFinished).toBe(true);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error?.errors).toEqual([failure]);
    expect(await native.readdir(root)).toEqual(['blocked.md']);
  });

  it('keeps a newly created file when a cleaned directory path is reused', async () => {
    const file = path.join(root, 'technical-assistant.md');
    await native.mkdir(path.join(root, '.tmp'));
    await native.writeFile(file, 'old definition');
    const started = deferred();
    const directoryFinished = deferred();
    const release = deferred();
    const removalFinished = deferred();
    const delayFile = async (target: Parameters<typeof native.unlink>[0], operation: () => Promise<void>) => {
      if (target === file) { started.resolve(); await release.promise; }
      try { await operation(); }
      finally {
        if (target === file) removalFinished.resolve();
        else directoryFinished.resolve();
      }
    };
    remove.mockImplementation((target, options) => delayFile(target, () => native.rm(target, options)));
    unlink.mockImplementation(target => delayFile(target, () => native.unlink(target)));
    let cleaned = false;
    const reused = cleanDirectory(root).then(async () => {
      cleaned = true;
      await native.writeFile(file, 'new definition');
    });
    try {
      await Promise.all([started.promise, directoryFinished.promise]);
      await new Promise<void>(resolve => setImmediate(resolve));
      // Against the old helper, the .tmp unlink rejection permits premature path reuse.
      if (cleaned) await reused;
    } finally { release.resolve(); }
    await Promise.all([reused, removalFinished.promise]);
    expect(await native.readFile(file, 'utf8')).toBe('new definition');
  });
});

it('reports a real external deletion after collection discovery as incomplete', async () => {
  const manager = createRealSkillManager(root);
  const directory = path.join(root, 'skills');
  const file = path.join(directory, 'guard.md');
  await native.mkdir(directory);
  await native.writeFile(file, '---\nname: Guard\ndescription: Guard fixture\n---\nDetailed guard instructions.');
  const storage = manager['storageLayer'];
  const readCollection = storage.readCollection.bind(storage);
  jest.spyOn(storage, 'readCollection').mockImplementationOnce(async () => {
    const snapshot = await readCollection();
    expect(snapshot.entries.map(entry => entry.filePath)).toContain('guard.md');
    await native.unlink(file);
    return snapshot;
  });
  try {
    const report = await manager.listReport();
    expect(report.complete).toBe(false);
    expect(report.items).toEqual([]);
    expect(report.failures).toEqual([expect.objectContaining({
      reference: 'guard.md', error: expect.objectContaining({ kind: 'absent' }),
    })]);
    expect(() => requireCompleteCollection(report)).toThrow('Element collection could not be read completely');
  } finally { await manager.dispose(); }
});
