import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { FileStorageLayerBase, type DirScanState } from '../../../src/storage/FileStorageLayerBase.js';
import { DirectoryStateCache } from '../../../src/storage/DirectoryStateCache.js';
import type { IStorageBackend } from '../../../src/storage/IStorageBackend.js';
import type { ElementIndexEntry, ManifestDiffResult } from '../../../src/storage/types.js';
import { logger } from '../../../src/utils/logger.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class TestStorage extends FileStorageLayerBase {
  protected readonly scanLabel = 'TestStorage';
  protected get directory(): string { return '/test'; }
  readonly events: string[] = [];
  readonly cooldowns: number[] = [];
  readonly publications: boolean[] = [];
  files = ['one.md'];
  enumerationError?: Error;
  bootstrap = false;
  private bootstrapped = false;

  constructor(backend: IStorageBackend, cooldown = 1000) {
    super(backend, cooldown, new DirectoryStateCache());
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
  protected override afterScan(_state: DirScanState, updated: boolean): void {
    this.events.push('afterScan');
    this.publications.push(updated);
  }
  protected logCooldown(_dir: string, remainingMs: number): void { this.cooldowns.push(remainingMs); }
  protected logDiskScan(): void { /* Diagnostics are covered by the concrete layers. */ }
  protected override beforeScan(dir: string, state: DirScanState): (() => Promise<ManifestDiffResult>) | undefined {
    if (this.bootstrap && !this.bootstrapped) {
      this.bootstrapped = true;
      return () => this.performScanForDir(dir, state);
    }
    return undefined;
  }
  async listSummaries(): Promise<ElementIndexEntry[]> { await this.scan(); return this.state.index.getAll(); }
  async getIndexedPaths(): Promise<string[]> { await this.scan(); return this.state.index.getPaths(); }
  async notifySaved(): Promise<void> { /* This fake only exercises scans. */ }
  notifyDeleted(): void { /* This fake only exercises scans. */ }
}

function setup(cooldown = 1000) {
  const backend: IStorageBackend = {
    directoryExists: jest.fn<IStorageBackend['directoryExists']>().mockResolvedValue(true),
    listFiles: jest.fn<IStorageBackend['listFiles']>().mockResolvedValue([]),
    stat: jest.fn<IStorageBackend['stat']>(),
    statMany: jest.fn<IStorageBackend['statMany']>().mockResolvedValue(new Map([
      ['one.md', { relativePath: 'one.md', absolutePath: '/test/one.md', mtimeMs: 1, sizeBytes: 1 }],
    ])),
    readFile: jest.fn<IStorageBackend['readFile']>().mockResolvedValue('One'),
  };
  return { backend, layer: new TestStorage(backend, cooldown) };
}

afterEach(() => jest.restoreAllMocks());

describe('FileStorageLayerBase', () => {
  it('orders enumeration, stat, diff, indexing, manifest update and publication', async () => {
    const { backend, layer } = setup();
    const stats = await backend.statMany('/test', layer.files);
    jest.spyOn(backend, 'statMany').mockImplementation(async () => { layer.events.push('stat'); return stats; });
    const manifest = layer.state.manifest;
    const diff = manifest.diff.bind(manifest);
    const update = manifest.update.bind(manifest);
    jest.spyOn(manifest, 'diff').mockImplementation(stats => { layer.events.push('diff'); return diff(stats); });
    jest.spyOn(manifest, 'update').mockImplementation(stats => { layer.events.push('update'); update(stats); });
    expect((await layer.scan()).added).toEqual(['one.md']);
    expect(layer.events).toEqual(['enumerate', 'stat', 'diff', 'index', 'update', 'afterScan']);
    expect(layer.publications).toEqual([true]);
    expect(layer.state.hasScanned).toBe(true);
  });

  it('skips I/O within cooldown', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(5000);
    const { backend, layer } = setup();
    await layer.scan();
    expect(await layer.scan()).toEqual({ added: [], modified: [], removed: [], unchanged: [] });
    expect(backend.statMany).toHaveBeenCalledTimes(1);
    expect(layer.cooldowns).toEqual([1000]);
  });

  it.each([false, true])('coalesces same-turn scans through the synchronous hook (bootstrap: %s)', async bootstrap => {
    const { backend, layer } = setup(0);
    layer.bootstrap = bootstrap;
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

  it('runs cold bootstrap before cooldown at a near-zero clock', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1);
    const { backend, layer } = setup();
    layer.bootstrap = true;
    await layer.scan();
    expect(backend.statMany).toHaveBeenCalledTimes(1);
    expect(layer.cooldowns).toEqual([]);
    const ordinary = setup();
    await ordinary.layer.scan();
    expect(ordinary.backend.statMany).not.toHaveBeenCalled();
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

  it('clears index and manifest and reports removals for a missing directory', async () => {
    const { backend, layer } = setup(0);
    jest.spyOn(Date, 'now').mockReturnValue(6000);
    await layer.scan();
    jest.spyOn(backend, 'directoryExists').mockResolvedValue(false);
    expect((await layer.scan()).removed).toEqual(['one.md']);
    expect(layer.state.index.getPaths()).toEqual([]);
    expect(layer.state.manifest.diff(new Map()).removed).toEqual([]);
    expect(layer.state.lastScanTimestamp).toBe(6000);
    expect(layer.publications).toEqual([true]);
  });

  it('catches enumeration failure, stamps the attempt and returns an empty diff', async () => {
    const { layer } = setup();
    const error = new Error('enumeration unavailable');
    layer.enumerationError = error;
    const log = jest.spyOn(logger, 'error').mockImplementation(() => {});
    jest.spyOn(Date, 'now').mockReturnValue(6000);
    expect(await layer.scan()).toEqual({ added: [], modified: [], removed: [], unchanged: [] });
    expect(layer.state.lastScanTimestamp).toBe(6000);
    expect(log).toHaveBeenCalledWith('TestStorage.performScan failed', error);
  });

  it('skips and logs a failed file read while advancing the manifest', async () => {
    const { backend, layer } = setup();
    jest.spyOn(backend, 'readFile').mockRejectedValue(new Error('read unavailable'));
    const log = jest.spyOn(logger, 'debug').mockImplementation(() => {});
    expect((await layer.scan()).added).toEqual(['one.md']);
    expect(layer.state.index.getPaths()).toEqual([]);
    expect(layer.state.manifest.diff(new Map()).removed).toEqual(['one.md']);
    expect(layer.publications).toEqual([false]);
    expect(log).toHaveBeenCalledWith('TestStorage: failed to index one.md', { error: 'read unavailable' });
  });
});
