import * as path from 'node:path';
import { afterEach, expect, it, jest } from '@jest/globals';
import { ElementStorageLayer } from '../../../src/storage/ElementStorageLayer.js';
import { MemoryStorageLayer } from '../../../src/storage/MemoryStorageLayer.js';
import { MemoryIndexFile } from '../../../src/storage/MemoryIndexFile.js';
import { MemoryIndexPersistence } from '../../../src/storage/MemoryIndexPersistence.js';
import { FileStorageBackend } from '../../../src/storage/FileStorageBackend.js';
import { logger } from '../../../src/utils/logger.js';
import { createTestFileOperationsService } from '../../helpers/di-mocks.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const snapshot = () => ({ entries: [], blocked: {}, generation: 1 });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

it.each([false, true])('stops a cleared scan after disposal with writer failure=%s', async fails => {
  jest.useFakeTimers();
  const ops = createTestFileOperationsService(); const backend = new FileStorageBackend(ops);
  const held = deferred<string[]>(); const entered = deferred<void>();
  jest.spyOn(backend, 'directoryExists').mockResolvedValue(true);
  jest.spyOn(backend, 'listDirectories').mockImplementation(() => { entered.resolve(); return held.promise; });
  jest.spyOn(backend, 'listFiles').mockResolvedValue([]);
  const layer = new MemoryStorageLayer(ops, { memoriesDir: path.resolve('memories'), storageBackend: backend });
  const state = layer['getState']();
  jest.spyOn(state.persistence, 'read').mockResolvedValue(null);
  const write = jest.spyOn(state.persistence['file'], 'write');
  if (fails) write.mockRejectedValue(new Error('full')); else write.mockResolvedValue();
  const scanning = layer.scan();
  const rejected = expect(scanning).rejects.toThrow('Storage layer disposed');
  await entered.promise;
  layer.clear(); await layer.dispose(); held.resolve([]); await rejected;
  await layer.notifySaved('late.yaml', path.resolve('memories', 'late.yaml'));
  layer.notifyDeleted('late.yaml');
  await jest.advanceTimersByTimeAsync(60000);
  expect(write).not.toHaveBeenCalled();
  expect(state.persistence.hasPendingWrite()).toBe(false);
  expect(state.scanInProgress).toBeNull();
  expect(jest.getTimerCount()).toBe(0);
});

it('rejects an element scan held across disposal without publishing', async () => {
  const ops = createTestFileOperationsService(); const backend = new FileStorageBackend(ops);
  const held = deferred<string[]>(); const entered = deferred<void>();
  jest.spyOn(backend, 'directoryExists').mockResolvedValue(true);
  jest.spyOn(backend, 'listFiles').mockImplementation(() => { entered.resolve(); return held.promise; });
  const layer = new ElementStorageLayer(ops, { elementDir: path.resolve('elements'), fileExtension: '.md', storageBackend: backend });
  const state = layer['getState'](); const scanning = layer.scan();
  const rejected = expect(scanning).rejects.toThrow('Storage layer disposed');
  await entered.promise; layer.clear(); await layer.dispose(); held.resolve([]); await rejected;
  expect(state.table.everSucceeded).toBe(false);
});

it.each([false, true])('never reschedules a late write after disposal with failure=%s', async fails => {
  jest.useFakeTimers(); const held = deferred<void>();
  const file = new MemoryIndexFile(path.resolve('index.json'), createTestFileOperationsService());
  const write = jest.spyOn(file, 'write').mockReturnValue(held.promise);
  jest.spyOn(logger, 'error').mockImplementation(() => {});
  const persistence = new MemoryIndexPersistence(file);
  const acknowledged = jest.fn();
  persistence.request(snapshot, acknowledged); const flushing = persistence.flush();
  persistence.request(snapshot, acknowledged); persistence.dispose();
  persistence.request(snapshot, acknowledged);
  if (fails) held.reject(new Error('full')); else held.resolve();
  expect(await flushing).toBe(!fails);
  await jest.advanceTimersByTimeAsync(60000);
  expect(write).toHaveBeenCalledTimes(1); expect(acknowledged).not.toHaveBeenCalled();
  expect(persistence.hasPendingWrite()).toBe(false); expect(jest.getTimerCount()).toBe(0);
});

it('flushes two stalled directories under one shutdown deadline', async () => {
  jest.useFakeTimers();
  let dir = path.resolve('first');
  const layer = new MemoryStorageLayer(createTestFileOperationsService(), {
    memoriesDir: dir, memoriesDirResolver: () => dir, shutdownFlushTimeoutMs: 50,
  });
  const first = layer['getState']().persistence;
  dir = path.resolve('second'); const second = layer['getState']().persistence;
  const disposed = [first, second].map(persistence => {
    jest.spyOn(persistence['file'], 'write').mockReturnValue(new Promise(() => {}));
    persistence.request(snapshot, () => {});
    return jest.spyOn(persistence, 'dispose');
  });
  const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
  let settled = false; const disposal = layer.dispose().then(() => { settled = true; });
  await jest.advanceTimersByTimeAsync(49); expect(settled).toBe(false);
  await jest.advanceTimersByTimeAsync(1); expect(settled).toBe(true); await disposal;
  for (const spy of disposed) expect(spy).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});

it.each(['linux', 'win32'] as const)('validates colon and backslash index identities for %s', async platform => {
  const ops = createTestFileOperationsService();
  const file = new MemoryIndexFile(path.resolve('index.json'), ops, platform);
  let serialized = '';
  jest.spyOn(ops, 'writeFile').mockImplementation(async (_file, content) => { serialized = content; });
  jest.spyOn(ops, 'readFile').mockImplementation(async () => serialized);
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
  const entries = ['notes-10:30.yaml', 'notes\\part.yaml'].map(filePath => ({
    filePath, name: filePath, mtimeMs: 1, sizeBytes: 1, description: '', author: '', tags: [], version: '1',
  }));
  const blocked = Object.fromEntries(entries.map(entry => [entry.filePath, { nameKey: entry.name, mtimeMs: 1 }]));
  await file.write(entries, blocked);
  const result = await file.read();
  expect(Object.values(result!.entries)).toEqual(platform === 'linux' ? entries : []);
  expect(result!.blocked).toEqual(platform === 'linux' ? blocked : {});
});
