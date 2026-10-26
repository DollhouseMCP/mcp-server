import * as path from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { FileStorageLayerBase, type DirScanState } from '../../../src/storage/FileStorageLayerBase.js';
import { DirectoryStateCache } from '../../../src/storage/DirectoryStateCache.js';
import type { IStorageBackend } from '../../../src/storage/IStorageBackend.js';
import type { ElementIndexEntry } from '../../../src/storage/types.js';
import { logger } from '../../../src/utils/logger.js';

const TEST_DIR = path.resolve('storage-test');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class TestStorage extends FileStorageLayerBase {
  protected readonly scanLabel = 'TestStorage';
  protected get directory(): string { return TEST_DIR; }
  readonly events: string[] = [];
  readonly cooldowns: number[] = [];
  files = ['one.md'];
  enumerationError?: Error;

  constructor(backend: IStorageBackend, cooldown = 1000) {
    super(backend, new DirectoryStateCache(), cooldown);
  }

  get state(): DirScanState { return this.getState(); }
  protected extendState(_dir: string, base: DirScanState): DirScanState {
    return base;
  }
  protected async enumerate(): Promise<string[]> {
    this.events.push('enumerate');
    if (this.enumerationError) throw this.enumerationError;
    return this.files;
  }
  protected readIndexEntry(content: string, filePath: string): ElementIndexEntry {
    this.events.push('index');
    return { filePath, name: content, description: '', version: '1', author: '', tags: [], mtimeMs: 1, sizeBytes: 1 };
  }
  protected logCooldown(_dir: string, remainingMs: number): void { this.cooldowns.push(remainingMs); }
  protected logDiskScan(): void { /* Diagnostics are covered by the concrete layers. */ }
  async listSummaries(): Promise<ElementIndexEntry[]> { await this.scan(); return this.state.table.entries(); }
  async getIndexedPaths(): Promise<string[]> { await this.scan(); return this.state.table.entries().map(entry => entry.filePath); }
}

function setup(cooldown = 1000) {
  const backend: IStorageBackend = {
    directoryExists: jest.fn<IStorageBackend['directoryExists']>().mockResolvedValue(true),
    listDirectories: jest.fn<IStorageBackend['listDirectories']>().mockResolvedValue([]),
    listFiles: jest.fn<IStorageBackend['listFiles']>().mockResolvedValue([]),
    stat: jest.fn<IStorageBackend['stat']>(),
    statMany: jest.fn<IStorageBackend['statMany']>().mockResolvedValue({ stats: new Map([
      ['one.md', { relativePath: 'one.md', absolutePath: path.join(TEST_DIR, 'one.md'), mtimeMs: 1, sizeBytes: 1 }],
    ]), failures: new Map() }),
    readFile: jest.fn<IStorageBackend['readFile']>().mockResolvedValue('One'),
  };
  return { backend, layer: new TestStorage(backend, cooldown) };
}

afterEach(() => jest.restoreAllMocks());

describe('FileStorageLayerBase', () => {
  it('retains a stat failure while indexing healthy siblings and retries after invalidation', async () => {
    const { backend, layer } = setup(0);
    const failure = Object.assign(new Error('symbolic link loop'), { code: 'ELOOP' });
    const result = await backend.statMany(TEST_DIR, layer.files);
    result.failures.set('loop.md', failure);
    layer.files.push('loop.md');
    const first = await layer.scan();
    expect(first.added).toEqual(['one.md', 'loop.md']);
    expect(layer.state.table.entries().map(entry => entry.filePath)).toEqual(['one.md']);
    expect(await layer.readIndexedPath(['One'])).toMatchObject({ authoritative: false, unindexed: ['loop.md'] });
    expect(layer.state.table.unindexed().get('loop.md')).toEqual({ name: 'Error', code: 'ELOOP', reason: 'Cannot inspect storage path \"loop.md\" (ELOOP)' });
    layer.invalidate();
    expect(layer.state.table.unindexed().has('loop.md')).toBe(true);
    expect((await layer.scan()).modified).toEqual(['loop.md']);
    expect(backend.statMany).toHaveBeenCalledTimes(3);
    result.failures.clear();
    expect((await layer.scan()).removed).toEqual([]);
    expect(layer.state.table.unindexed().size).toBe(0);
  });

  it('reports persistent failures in each diff but logs only changed failures', async () => {
    const { backend, layer } = setup(0);
    const log = jest.spyOn(layer as unknown as { logDiskScan(): void }, 'logDiskScan');
    const read = jest.spyOn(backend, 'readFile').mockRejectedValue(new Error('first failure'));
    expect((await layer.scan()).added).toEqual(['one.md']);
    expect((await layer.scan()).modified).toEqual(['one.md']);
    expect(log).toHaveBeenCalledTimes(1);
    read.mockRejectedValue(Object.assign(new Error('changed failure'), { code: 'EIO' }));
    expect((await layer.scan()).modified).toEqual(['one.md']);
    expect(log).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('does all I/O before one synchronous publication', async () => {
    const { backend, layer } = setup();
    const stats = await backend.statMany(TEST_DIR, layer.files);
    jest.spyOn(backend, 'statMany').mockImplementation(async () => { layer.events.push('stat'); return stats; });
    const publish = layer.state.table.publishScan.bind(layer.state.table);
    jest.spyOn(layer.state.table, 'publishScan').mockImplementation((token, outcomes) => {
      layer.events.push('publish'); return publish(token, outcomes);
    });
    expect((await layer.scan()).added).toEqual(['one.md']);
    expect(layer.events).toEqual(['enumerate', 'stat', 'index', 'publish']);
    expect(layer.state.table.everSucceeded).toBe(true);
  });

  it('skips I/O within cooldown', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(5000);
    const { backend, layer } = setup();
    await layer.scan();
    expect(await layer.scan()).toEqual({ added: [], modified: [], removed: [], unchanged: [] });
    expect(backend.statMany).toHaveBeenCalledTimes(1);
    expect(layer.cooldowns).toEqual([1000]);
  });

  it('coalesces same-turn scans before any asynchronous I/O finishes', async () => {
    const { backend, layer } = setup(0);
    const pending = deferred<boolean>();
    jest.spyOn(backend, 'directoryExists').mockReturnValue(pending.promise);
    const first = layer.scan();
    const second = layer.scan();
    expect(backend.directoryExists).toHaveBeenCalledTimes(1);
    pending.resolve(true);
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(backend.statMany).toHaveBeenCalledTimes(1);
  });

  it('runs a first scan before cooldown at a near-zero clock', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1);
    const { backend, layer } = setup();
    await layer.scan();
    expect(backend.statMany).toHaveBeenCalledTimes(1);
    expect(layer.cooldowns).toEqual([]);
    const ordinary = setup();
    await ordinary.layer.scan();
    expect(ordinary.backend.statMany).toHaveBeenCalledTimes(1);
  });

  it('merges an in-flight diff with one serialized trailing scan', async () => {
    const { backend, layer } = setup();
    const pending = deferred<string>();
    jest.spyOn(backend, 'readFile').mockReturnValue(pending.promise);
    const first = layer.scan();
    const trailing = layer.scan({ freshAfterInFlight: true });
    const anotherTrailing = layer.scan({ freshAfterInFlight: true });
    pending.resolve('One');
    const [initial, merged, other] = await Promise.all([first, trailing, anotherTrailing]);
    expect(initial.added).toEqual(['one.md']);
    expect(merged.added).toEqual(['one.md']);
    expect(other).toEqual(merged);
    expect(backend.statMany).toHaveBeenCalledTimes(2);
  });

  it('clears records and reports removals for a missing directory', async () => {
    const { backend, layer } = setup(0);
    jest.spyOn(Date, 'now').mockReturnValue(6000);
    await layer.scan();
    jest.spyOn(backend, 'directoryExists').mockResolvedValue(false);
    expect((await layer.scan()).removed).toEqual(['one.md']);
    expect(layer.state.table.entries().map(entry => entry.filePath)).toEqual([]);
    expect(layer.state.table.entries()).toEqual([]);
    expect(layer.state.lastScanAt).toBe(6000);
  });

  it.each(['enumerate', 'stat', 'directory'] as const)('rejects %s failure without publishing or replacing the previous scan', async failure => {
    const { backend, layer } = setup(0);
    jest.spyOn(Date, 'now').mockReturnValue(5000);
    await layer.scan();
    const entries = layer.state.table.entries();
    const error = Object.assign(new Error('unavailable'), { code: 'EACCES' });
    if (failure === 'enumerate') layer.enumerationError = error;
    else jest.spyOn(backend, failure === 'stat' ? 'statMany' : 'directoryExists').mockRejectedValue(error);
    jest.spyOn(Date, 'now').mockReturnValue(6000);
    await expect(layer.scan()).rejects.toMatchObject({ cause: error });
    expect(layer.state.lastScanAt).toBe(6000);
    expect(layer.state.table.entries()).toEqual(entries);
    expect(layer.state.table.get('one.md')?.status).toBe('indexed');
    expect(layer.state.scanInProgress).toBeNull();
  });

  it('marks unreadable files unindexed, retries unchanged mtimes, and clears the marker on repair', async () => {
    const { backend, layer } = setup(0);
    const read = jest.spyOn(backend, 'readFile').mockRejectedValue(new Error('read unavailable'));
    const log = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    await layer.scan();
    expect(await layer.readIndexedPath(['One'])).toEqual({ path: undefined, indexComplete: true, authoritative: false, unindexed: ['one.md'] });
    expect(layer.state.table.entries()).toEqual([]);
    const failures = new Map(layer.state.table.unindexed());
    expect([...failures]).toEqual([['one.md', { reason: 'read unavailable', name: 'Error' }]]);
    await layer.scan();
    expect(read).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('TestStorage: failed to index one.md', { error: 'Error' });
    read.mockResolvedValue('One');
    expect((await layer.scan()).modified).toEqual(['one.md']);
    expect(await layer.readIndexedPath(['One'])).toEqual({ path: 'one.md', indexComplete: true, authoritative: true, unindexed: [] });
    expect([...layer.state.table.unindexed()]).toEqual([]);
    expect([...failures]).toEqual([['one.md', { reason: 'read unavailable', name: 'Error' }]]);
  });

  it('reports repair of a previously unindexed path as modified', async () => {
    const { backend, layer } = setup(0);
    const read = jest.spyOn(backend, 'readFile').mockRejectedValueOnce(new Error('unreadable'));
    expect((await layer.scan()).added).toEqual(['one.md']);
    read.mockResolvedValue('Repaired');
    const repaired = await layer.scan();
    expect(repaired.modified).toEqual(['one.md']);
    expect(repaired.added).toEqual([]);
    expect(layer.state.table.unindexed().size).toBe(0);
  });

  it('reports a warm stat failure as modified rather than removed', async () => {
    const { backend, layer } = setup(0);
    await layer.scan();
    const result = await backend.statMany(TEST_DIR, layer.files);
    result.stats.clear();
    result.failures.set('one.md', Object.assign(new Error('denied'), { code: 'EACCES' }));
    const diff = await layer.scan();
    expect(diff.modified).toEqual(['one.md']);
    expect(diff.removed).toEqual([]);
    expect(layer.state.table.entries().map(entry => entry.filePath)).toEqual([]);
    expect(layer.state.table.unindexed().has('one.md')).toBe(true);
  });

  it('removes a previously indexed entry when its changed file becomes unreadable', async () => {
    const { backend, layer } = setup(0);
    await layer.scan();
    const stats = await backend.statMany(TEST_DIR, layer.files);
    stats.stats.get('one.md')!.mtimeMs = 2;
    jest.spyOn(backend, 'readFile').mockRejectedValue(new Error('unreadable'));
    expect((await layer.scan()).modified).toEqual(['one.md']);
    expect(layer.state.table.entries().map(entry => entry.filePath)).toEqual([]);
    expect(layer.state.table.unindexed().has('one.md')).toBe(true);
  });

  it.each(['file', 'directory'])('clears a vanished unindexed %s without reporting an indexed removal', async kind => {
    const { backend, layer } = setup(0);
    jest.spyOn(backend, 'readFile').mockRejectedValue(new Error('unreadable'));
    await layer.scan();
    if (kind === 'file') jest.spyOn(backend, 'statMany').mockResolvedValue({ stats: new Map(), failures: new Map() });
    else jest.spyOn(backend, 'directoryExists').mockResolvedValue(false);
    expect((await layer.scan()).removed).toEqual([]);
    expect((await layer.readIndexedPath([])).unindexed).toEqual([]);
  });

  it.each([false, true])('retries a disappeared read at the same mtime without retaining metadata (warm: %s)', async warm => {
    const { backend, layer } = setup(0);
    const read = jest.spyOn(backend, 'readFile');
    if (warm) await layer.scan();
    const stats = await backend.statMany(TEST_DIR, layer.files);
    stats.stats.get('one.md')!.mtimeMs = 2;
    read.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const diff = await layer.scan();
    expect(diff).toEqual({ added: [], modified: [], removed: warm ? ['one.md'] : [], unchanged: [] });
    expect(await layer.readIndexedPath(['One'])).toEqual({ path: undefined, indexComplete: true, authoritative: true, unindexed: [] });
    expect(layer.state.table.get('one.md')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    read.mockResolvedValue('Recreated');
    expect((await layer.scan()).added).toEqual(['one.md']);
    expect((await layer.readIndexedPath(['Recreated'])).path).toBe('one.md');
    expect(read).toHaveBeenCalledTimes(warm ? 3 : 2);
    jest.spyOn(backend, 'statMany').mockResolvedValue({ stats: new Map(), failures: new Map() });
    expect((await layer.scan()).removed).toEqual(['one.md']);
  });

  it('includes the error code but never its message in index diagnostics', async () => {
    const { backend, layer } = setup(0);
    jest.spyOn(backend, 'readFile').mockRejectedValue(Object.assign(new Error('private parser details'), { code: 'EACCES' }));
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    await layer.scan();
    expect(warn).toHaveBeenCalledWith('TestStorage: failed to index one.md', { error: 'Error', code: 'EACCES' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private parser details');
  });

  it('warns again only when an unindexed failure reason changes', async () => {
    const { backend, layer } = setup(0);
    const read = jest.spyOn(backend, 'readFile').mockRejectedValue(new Error('first reason'));
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => {});
    await layer.scan();
    await layer.scan();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith('TestStorage: failed to index one.md', { error: 'Error' });
    read.mockRejectedValue(Object.assign(new Error('changed reason'), { code: 'EIO' }));
    await layer.scan();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(layer.state.table.unindexed().get('one.md')).toEqual({ reason: 'Cannot inspect storage path \"one.md\" (EIO)', name: 'Error', code: 'EIO' });
  });

  it('runs a trailing fresh scan after an in-flight rejection', async () => {
    const { backend, layer } = setup();
    const pending = deferred<boolean>();
    const error = new Error('first attempt failed');
    jest.spyOn(backend, 'directoryExists').mockImplementationOnce(async () => { await pending.promise; throw error; });
    const first = expect(layer.scan()).rejects.toBe(error);
    const trailing = layer.scan({ freshAfterInFlight: true });
    pending.resolve(true);
    await first;
    expect((await trailing).added).toEqual(['one.md']);
    expect(layer.state.scanInProgress).toBeNull();
    expect(backend.directoryExists).toHaveBeenCalledTimes(2);
  });

  it('owns successful indexing and removal marker transitions in shared helpers', async () => {
    const { layer } = setup();
    await layer.scan();
    const entry = layer.state.table.entries()[0];
    layer.state.table.applyFailure(entry.filePath, { reason: 'failed', name: 'Error' });
    layer.state.table.applySaved(entry.filePath, entry.mtimeMs, entry);
    expect(layer.state.table.unindexed().size).toBe(0);
    layer.state.table.applyFailure(entry.filePath, { reason: 'failed', name: 'Error' });
    layer.state.table.applyDeleted(entry.filePath);
    expect(layer.state.table.unindexed().size).toBe(0);
    expect(layer.state.table.entries().map(entry => entry.filePath)).toEqual([]);
  });

  it('clears unreadable markers with directory state', async () => {
    const { backend, layer } = setup();
    jest.spyOn(backend, 'readFile').mockRejectedValue(new Error('unreadable'));
    await layer.scan();
    layer.clear();
    expect(layer.state.table.unindexed().size).toBe(0);
    expect(layer.state.table.everSucceeded).toBe(false);
  });

  it('returns independent empty cooldown diffs', async () => {
    const { layer } = setup();
    await layer.scan();
    (await layer.scan()).added.push('not-a-file.md');
    expect((await layer.scan()).added).toEqual([]);
  });
});

it.each([100, 1000])('does linear table work for %s repeated failing paths', async count => {
  const { layer, backend } = setup(0);
  layer.files = Array.from({ length: count }, (_, index) => `${index}.md`);
  const failures = new Map(layer.files.map(file => [file, Object.assign(new Error('denied'), { code: 'EACCES' })]));
  jest.mocked(backend.statMany).mockResolvedValue({ stats: new Map(), failures });
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
  jest.spyOn(logger, 'debug').mockImplementation(() => {});
  await layer.scan();
  const unindexed = jest.spyOn(layer.state.table, 'unindexed');
  const update = jest.spyOn(layer.state.table as any, 'updateDerivedState');
  const values = jest.spyOn(layer.state.table['records'], 'values');
  expect((await layer.scan()).modified).toHaveLength(count);
  expect(unindexed).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledTimes(count);
  expect(layer.state.table.isAuthoritative()).toBe(false);
  expect(layer.state.table.unindexed().size).toBe(count);
  expect(values).not.toHaveBeenCalled();
});

it('rejects repeated clears instead of returning an empty joined scan indefinitely', async () => {
  const { layer, backend } = setup();
  jest.mocked(backend.directoryExists).mockImplementation(async () => { layer.clear(); return true; });
  await expect(layer.listSummaries()).rejects.toThrow('repeatedly invalidated');
  expect(backend.directoryExists).toHaveBeenCalledTimes(3);
});
