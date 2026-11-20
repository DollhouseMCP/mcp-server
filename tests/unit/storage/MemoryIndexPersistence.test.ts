import * as path from 'node:path';
import { jest } from '@jest/globals';
import { MemoryIndexPersistence } from '../../../src/storage/MemoryIndexPersistence.js';
import { MemoryStorageLayer } from '../../../src/storage/MemoryStorageLayer.js';
import { logger } from '../../../src/utils/logger.js';
import { MemoryIndexFile } from '../../../src/storage/MemoryIndexFile.js';
import { FileStateTable } from '../../../src/storage/FileStateTable.js';
import { createTestFileOperationsService } from '../../helpers/di-mocks.js';
import type { ElementIndexEntry } from '../../../src/storage/types.js';

const entry = (name: string): ElementIndexEntry => ({ filePath: 'a.yaml', name, mtimeMs: 1, sizeBytes: 1, description: '', author: '', tags: [], version: '1' });
function setup() {
  const table = new FileStateTable();
  table.publishScan(table.beginScan(), new Map([['a.yaml', { status: 'indexed', mtimeMs: 1, entry: entry('A') }]]));
  const file = new MemoryIndexFile(path.resolve('index.json'), createTestFileOperationsService());
  const write = jest.spyOn(file, 'write').mockResolvedValue();
  const persistence = new MemoryIndexPersistence(file, { debounceMs: 500 });
  const request = () => persistence.request(() => table.persistableSnapshot(), generation => table.markPersisted(generation));
  return { table, file, write, persistence, request };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

describe('MemoryIndexPersistence', () => {
  it('coalesces requests, resets debounce, and snapshots at write time', async () => {
    jest.useFakeTimers(); const { table, write, persistence, request } = setup();
    request(); jest.advanceTimersByTime(400); request(); jest.advanceTimersByTime(400);
    expect(write).not.toHaveBeenCalled();
    table.applySaved('a.yaml', 2, entry('B'));
    jest.advanceTimersByTime(100); await persistence.flush();
    expect(write).toHaveBeenCalledTimes(1); expect(write.mock.calls[0][0][0].name).toBe('B');
    expect(table.hasUnsavedChanges()).toBe(false); persistence.dispose();
  });
  it('flushes pending requests immediately and is a no-op when idle', async () => {
    const { persistence, request, write } = setup();
    expect(await persistence.flush()).toBe(true); expect(write).not.toHaveBeenCalled();
    request(); expect(await persistence.flush()).toBe(true); expect(write).toHaveBeenCalledTimes(1);
    expect(await persistence.flush()).toBe(true); expect(write).toHaveBeenCalledTimes(1);
  });
  it('cancels scheduled writes on dispose', async () => {
    jest.useFakeTimers(); const { persistence, request, write } = setup();
    request(); persistence.dispose(); jest.advanceTimersByTime(1000);
    expect(write).not.toHaveBeenCalled(); expect(await persistence.flush()).toBe(true);
  });
  it.each(['ENOSPC', 'EACCES'])('keeps dirty state after %s and retries on the next request', async code => {
    const { table, persistence, request, write } = setup();
    write.mockRejectedValueOnce(Object.assign(new Error('write failed'), { code }));
    request(); expect(await persistence.flush()).toBe(false); expect(table.hasUnsavedChanges()).toBe(true);
    request(); expect(await persistence.flush()).toBe(true); expect(table.hasUnsavedChanges()).toBe(false);
  });
  it('serializes active and trailing writes and waits for both on flush', async () => {
    const { table, persistence, request, write } = setup(); const first = deferred(); const second = deferred();
    write.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    request(); let finished = false; const flush = persistence.flush().then(value => { finished = true; return value; });
    table.applySaved('a.yaml', 2, entry('B')); request(); table.applySaved('a.yaml', 3, entry('C')); request();
    expect(write).toHaveBeenCalledTimes(1); expect(table.hasUnsavedChanges()).toBe(true);
    first.resolve(); await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(2); expect(write.mock.calls[1][0][0].name).toBe('C');
    expect(finished).toBe(false); expect(persistence.hasPendingWrite()).toBe(true);
    second.resolve(); expect(await flush).toBe(true); expect(table.hasUnsavedChanges()).toBe(false);
  });
  it.each(['clear', 'missing', 'cold'])('does not write an ineligible %s snapshot', async state => {
    const { table, persistence, request, write } = setup();
    request();
    if (state === 'missing') table.publishMissingDirectory(table.beginScan());
    else table.clear();
    if (state === 'cold') table.applySaved('a.yaml', 1, entry('New'));
    expect(await persistence.flush()).toBe(true); expect(write).not.toHaveBeenCalled();
  });
  it('does not persist hydrated metadata before a successful scan', async () => {
    const { table, persistence, request, write } = setup(); table.clear();
    const token = table.beginScan(); table.hydrate([entry('A')]); table.failScan(token);
    request(); expect(await persistence.flush()).toBe(true); expect(write).not.toHaveBeenCalled();
  });
});

describe('automatic persistence recovery', () => {
  it('retries without a new mutation, doubles backoff and clears the failure latch', async () => {
    jest.useFakeTimers();
    const { persistence, request, write, table } = setup();
    write.mockRejectedValueOnce(new Error('full')).mockRejectedValueOnce(new Error('full'));
    request(); expect(await persistence.flush()).toBe(false);
    expect(persistence.hasPendingWrite()).toBe(true);
    await jest.advanceTimersByTimeAsync(499); expect(write).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1); expect(write).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(999); expect(write).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1); expect(write).toHaveBeenCalledTimes(3);
    expect(table.hasUnsavedChanges()).toBe(false);
    expect(await persistence.flush()).toBe(true);
    expect(persistence.hasPendingWrite()).toBe(false);
  });
  it('reports a failed active write even when the awaited trailing write succeeds', async () => {
    const { persistence, request, write } = setup();
    let reject!: (error: Error) => void;
    write.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    request(); const flushing = persistence.flush(); request(); reject(new Error('interrupted'));
    expect(await flushing).toBe(false);
    expect(await persistence.flush()).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
  });
  it('clears cancelled failure history and restarts retry backoff for a new obligation', async () => {
    jest.useFakeTimers(); const { persistence, request, write } = setup();
    write.mockRejectedValue(new Error('full'));
    request(); expect(await persistence.flush()).toBe(false);
    await jest.advanceTimersByTimeAsync(500);
    expect(write).toHaveBeenCalledTimes(2);
    persistence.cancelPending();
    expect(await persistence.flush()).toBe(true);
    expect(persistence.hasPendingWrite()).toBe(false);
    request(); expect(await persistence.flush()).toBe(false);
    await jest.advanceTimersByTimeAsync(499); expect(write).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1); expect(write).toHaveBeenCalledTimes(4);
    persistence.dispose();
  });
  it('does not log a shutdown flush failure after the failed obligation was cancelled', async () => {
    const layer = new MemoryStorageLayer(createTestFileOperationsService(), { memoriesDir: path.resolve('memories') });
    const persistence = layer['getState']().persistence;
    const log = jest.spyOn(logger, 'error').mockImplementation(() => {});
    jest.spyOn(persistence['file'], 'write').mockRejectedValue(new Error('full'));
    persistence.request(() => ({ entries: [entry('A')], blocked: {}, generation: 1 }), () => {});
    expect(await persistence.flush()).toBe(false);
    persistence.cancelPending(); log.mockClear();
    await layer.dispose();
    expect(log).not.toHaveBeenCalled();
    expect(persistence.hasPendingWrite()).toBe(false);
  });
  it('cancels queued retries for a missing directory, including an active failure', async () => {
    jest.useFakeTimers(); const { persistence, request, write } = setup();
    let reject!: (error: Error) => void;
    write.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    request(); const flushing = persistence.flush(); persistence.cancelPending(); reject(new Error('gone'));
    expect(await flushing).toBe(false);
    await jest.advanceTimersByTimeAsync(60000);
    expect(write).toHaveBeenCalledTimes(1); expect(persistence.hasPendingWrite()).toBe(false);
  });
});
