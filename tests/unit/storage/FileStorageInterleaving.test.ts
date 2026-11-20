import * as path from 'node:path';
import { jest } from '@jest/globals';
import { FileStorageLayerBase, type DirScanState } from '../../../src/storage/FileStorageLayerBase.js';
import { DirectoryStateCache } from '../../../src/storage/DirectoryStateCache.js';
import { FileStateTable, type HydratedIndex } from '../../../src/storage/FileStateTable.js';
import type { IndexPersistence } from '../../../src/storage/MemoryIndexPersistence.js';
import type { IStorageBackend } from '../../../src/storage/IStorageBackend.js';
import type { ElementIndexEntry, StorageItemMetadata } from '../../../src/storage/types.js';

const ROOT = path.resolve('interleaving-storage');
const phases = ['before begin', 'hydration', 'directory', 'enumeration', 'stat', 'read', 'after publish'] as const;
type Phase = typeof phases[number];
const actions = ['save', 'known absent', 'unknown absent', 'failure', 'delete', 'second notification', 'invalidate', 'clear'] as const;
type Action = typeof actions[number];
const metadata = (filePath: string, name: string, mtimeMs: number): ElementIndexEntry => ({
  filePath, name, mtimeMs, sizeBytes: 1, description: '', version: '1', author: '', tags: [],
});
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

class InterleavingStorage extends FileStorageLayerBase {
  protected readonly scanLabel = 'InterleavingStorage';
  protected get directory(): string { return ROOT; }
  constructor(backend: IStorageBackend, private readonly persistence: IndexPersistence) {
    super(backend, new DirectoryStateCache(), 1000);
  }
  get state(): DirScanState { return this.getState(); }
  protected extendState(_dir: string, state: DirScanState): DirScanState { return { ...state, persistence: this.persistence }; }
  protected enumerate(dir: string): Promise<string[]> { return this.backend.listFiles(dir, '.md'); }
  protected readIndexEntry(content: string, file: string, stats: Map<string, { mtimeMs: number }>): ElementIndexEntry {
    return metadata(file, content, stats.get(file)!.mtimeMs);
  }
  protected logCooldown(): void { /* No logging in the fixture. */ }
  protected logDiskScan(): void { /* No logging in the fixture. */ }
  async listSummaries(): Promise<ElementIndexEntry[]> { await this.scan(); return this.state.table.entries(); }
  async getIndexedPaths(): Promise<string[]> { return (await this.listSummaries()).map(entry => entry.filePath); }
}

function fixture(phase: Phase) {
  const reached = signal(); const resume = signal();
  let armed = true; let directoryExists = true; let directoryFailure = false;
  const files = new Map([['a.md', { content: 'Disk', mtimeMs: 2, failed: false }]]);
  const wait = async (at: Phase): Promise<void> => {
    if (armed && phase === at) { armed = false; reached.resolve(); await resume.promise; }
  };
  const stat = async (absolute: string): Promise<StorageItemMetadata> => {
    const relative = path.relative(ROOT, absolute); const file = files.get(relative);
    if (!file || !directoryExists) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    if (file.failed) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return { relativePath: relative, absolutePath: absolute, mtimeMs: file.mtimeMs, sizeBytes: 1 };
  };
  const backend: IStorageBackend = {
    directoryExists: jest.fn(async () => { await wait('directory'); if (directoryFailure) throw new Error('directory unavailable'); return directoryExists; }),
    listDirectories: async () => [],
    listFiles: async () => { const result = [...files.keys()]; await wait('enumeration'); return result; },
    stat,
    statMany: async (_dir, paths) => {
      const stats = new Map<string, StorageItemMetadata>(); const failures = new Map<string, Error>();
      for (const relative of paths) {
        try { stats.set(relative, await stat(path.join(ROOT, relative))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.set(relative, error as Error); }
      }
      await wait('stat'); return { stats, failures };
    },
    readFile: async absolute => {
      await stat(absolute); const content = files.get(path.relative(ROOT, absolute))!.content;
      await wait('read'); return content;
    },
  };
  const persisted: HydratedIndex = { entries: [metadata('a.md', 'Cached', 1)], blocked: {} };
  const persistence: IndexPersistence = {
    read: async () => { await wait('hydration'); return persisted; },
    cancelPending: () => {}, request: () => {}, flush: async () => true, dispose: () => {}, hasPendingWrite: () => false,
  };
  const layer = new InterleavingStorage(backend, persistence);
  layer.state.table.applySaved('a.md', 1, metadata('a.md', 'Cached', 1));
  return { layer, files, backend, reached, resume,
    disappear: () => { directoryExists = false; files.clear(); },
    rejectDirectory: (value: boolean) => { directoryFailure = value; },
  };
}

async function inject(f: ReturnType<typeof fixture>, action: Action): Promise<void> {
  if (action === 'save' || action === 'second notification') {
    f.files.set('a.md', { content: 'Saved', mtimeMs: 3, failed: false });
    await f.layer.notifySaved('a.md', path.join(ROOT, 'a.md'));
  }
  if (action === 'second notification') {
    f.layer.notifyDeleted('a.md');
    f.files.set('a.md', { content: 'Latest', mtimeMs: 4, failed: false });
    await f.layer.notifySaved('a.md', path.join(ROOT, 'a.md'));
  }
  if (action === 'known absent' || action === 'unknown absent') {
    const relative = action === 'known absent' ? 'a.md' : 'unknown.md';
    f.files.delete(relative); await f.layer.notifySaved(relative, path.join(ROOT, relative));
  }
  if (action === 'failure') {
    f.files.get('a.md')!.failed = true;
    await f.layer.notifySaved('a.md', path.join(ROOT, 'a.md'));
  }
  if (action === 'delete') { f.files.delete('a.md'); f.layer.notifyDeleted('a.md'); }
  if (action === 'invalidate') f.layer.invalidate();
  if (action === 'clear') f.layer.clear();
}

function assertViews(table: FileStateTable): void {
  for (const entry of table.entries()) expect(table.get(entry.filePath)?.status).toBe('indexed');
  for (const relative of table.unindexed().keys()) expect(table.get(relative)?.status).toBe('failed');
  for (const entry of table.ownerEntries()) expect(table.getPathByName(entry.name)).toBe(entry.filePath);
  if (table.pendingInvalidation || table.lastScan !== 'succeeded' || table.unindexed().size) expect(table.isAuthoritative()).toBe(false);
  const snapshot = table.persistableSnapshot();
  if (!snapshot) return;
  const restarted = new FileStateTable(); restarted.beginScan(); restarted.hydrate(snapshot.entries, snapshot.blocked);
  for (const entry of snapshot.entries) expect(restarted.getPathByName(entry.name)).toBe(table.getPathByName(entry.name));
  for (const identity of Object.values(snapshot.blocked)) expect(restarted.getPathByName(identity.nameKey)).toBeUndefined();
}

describe.each(phases)('notifications at %s', phase => {
  it.each(actions)('preserves live %s, then classifies the follow-up and cooldown', async action => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(5000);
    const f = fixture(phase);
    try {
      if (phase === 'before begin') await inject(f, action);
      const scanning = f.layer.scan();
      if (phase !== 'before begin' && phase !== 'after publish') {
        await f.reached.promise; await inject(f, action); f.resume.resolve();
      }
      await scanning;
      if (phase === 'after publish') await inject(f, action);
      const table = f.layer.state.table;
      assertViews(table);
      const cleared = action === 'clear' && phase === 'after publish';
      if (cleared) { expect(table.entries()).toEqual([]); expect(table.everSucceeded).toBe(false); }
      if (action === 'save' || action === 'second notification') expect(table.entries()[0].name).toBe(action === 'save' ? 'Saved' : 'Latest');
      if (action === 'delete') expect(table.get('a.md')).toBeUndefined();
      if (action === 'failure') expect(table.get('a.md')?.status).toBe('failed');
      if (action === 'known absent') expect(table.get('a.md')?.status).toBe(phase === 'before begin' ? undefined : 'recheck');
      if (action === 'unknown absent') expect(table.get('unknown.md')).toBeUndefined();
      const needsScan = table.needsScan();
      const calls = jest.mocked(f.backend.directoryExists).mock.calls.length;
      const followUp = await f.layer.scan();
      expect(jest.mocked(f.backend.directoryExists).mock.calls).toHaveLength(calls + Number(needsScan));
      if (needsScan && action === 'known absent') expect(followUp.removed).toEqual(['a.md']);
      if (needsScan && action === 'failure') expect(followUp.modified).toEqual(['a.md']);
      if (cleared) expect(followUp.added).toEqual(['a.md']);
      assertViews(table);
      const settled = jest.mocked(f.backend.directoryExists).mock.calls.length;
      expect(await f.layer.scan()).toEqual({ added: [], modified: [], removed: [], unchanged: [] });
      expect(jest.mocked(f.backend.directoryExists).mock.calls).toHaveLength(settled);
    } finally { f.resume.resolve(); clock.mockRestore(); }
  });
});

it.each(['hydration', 'directory', 'enumeration', 'stat', 'read'] as const)('merges fresh-after-in-flight at %s', async phase => {
  const f = fixture(phase); const first = f.layer.scan();
  await f.reached.promise;
  await inject(f, 'save');
  const trailing = f.layer.scan({ freshAfterInFlight: true });
  f.resume.resolve(); await first;
  expect((await trailing).modified).toContain('a.md');
  expect(f.layer.getPathByName('Saved')).toBe('a.md');
  expect(f.layer.state.table.pendingInvalidation).toBe(false);
  assertViews(f.layer.state.table);
});

it('removes indexed paths when the directory vanishes after enumeration', async () => {
  const f = fixture('enumeration'); const scan = f.layer.scan();
  await f.reached.promise; f.disappear(); f.resume.resolve();
  expect((await scan).removed).toEqual(['a.md']);
  f.layer.invalidate(); await f.layer.scan();
  expect(f.layer.state.table.persistableSnapshot()).toBeNull();
});

it('keeps hydrated records after rejection and allows an invalidated retry', async () => {
  const f = fixture('directory'); f.rejectDirectory(true); const scan = f.layer.scan();
  await f.reached.promise; f.resume.resolve();
  await expect(scan).rejects.toThrow('directory unavailable');
  expect(f.layer.state.table.entries()[0].name).toBe('Cached');
  expect(f.layer.state.table.isAuthoritative()).toBe(false);
  expect(f.layer.state.table.persistableSnapshot()).toBeNull();
  f.rejectDirectory(false); f.layer.invalidate();
  expect((await f.layer.scan()).modified).toEqual(['a.md']);
  expect(f.layer.state.table.isAuthoritative()).toBe(true);
});
