import { ElementResolver } from '../../../src/elements/base/ElementResolver.js';
import { ElementCache } from '../../../src/elements/base/ElementCache.js';
import { ElementType } from '../../../src/portfolio/types.js';
import type { IElement } from '../../../src/types/elements/IElement.js';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStorageLayer } from '../../../src/storage/MemoryStorageLayer.js';
import { ElementStorageLayer } from '../../../src/storage/ElementStorageLayer.js';
import { FileStorageBackend } from '../../../src/storage/FileStorageBackend.js';
import { createTestFileOperationsService, createRealSkillManager, createRealMemoryManager } from '../../helpers/di-mocks.js';
import { logger } from '../../../src/utils/logger.js';
import type { MemoryIndexData } from '../../../src/storage/MemoryIndexFile.js';

const failure = () => Object.assign(new Error('access denied'), { code: 'EACCES' });

describe('file scan failure recovery', () => {
  let dir: string;
  const fileOps = createTestFileOperationsService();
  const layers: MemoryStorageLayer[] = [];
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(tmpdir(), 'storage-failures-')); });
  afterEach(async () => {
    for (const layer of layers.splice(0)) await layer.dispose();
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });
  function memory() {
    const layer = new MemoryStorageLayer(fileOps, { memoriesDir: dir, scanCooldownMs: 0, indexDebounceMs: 60_000 });
    layers.push(layer);
    return layer;
  }
  async function persisted(): Promise<MemoryIndexData> {
    for (const layer of layers) {
      for (const state of layer['dirStates'].values()) await state.persistence.flush();
    }
    return JSON.parse(await fs.readFile(path.join(dir, '_index.json'), 'utf8'));
  }

  it.each(['syntax', 'security', 'read'])('excludes %s failures from disk, retries them after restart, and indexes repairs', async kind => {
    const relPath = 'broken.yaml';
    const absolutePath = path.join(dir, relPath);
    await fs.writeFile(absolutePath, kind === 'syntax' ? 'metadata: [broken' : kind === 'security' ? 'payload: !!js/function "function() {}"' : 'name: Healthy');
    const originalRead = fileOps.readFile.bind(fileOps);
    const reads = jest.spyOn(fileOps, 'readFile').mockImplementation(async (target, ...args) => {
      if (kind === 'read' && target === absolutePath) throw failure();
      return originalRead(target, ...args);
    });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const first = memory();
    await first.scan();
    expect(await first.readIndexedPath(['Healthy'])).toEqual({ path: undefined, indexComplete: true, authoritative: false, unindexed: [relPath] });
    expect((await persisted()).entries).toEqual({});
    const initialReads = reads.mock.calls.filter(([target]) => target === absolutePath).length;
    await first.scan();
    const warmReads = initialReads + 1;
    expect(reads.mock.calls.filter(([target]) => target === absolutePath)).toHaveLength(warmReads);
    expect(warn).toHaveBeenCalledWith(`MemoryStorageLayer: failed to index ${relPath}`, expect.any(Object));
    await first.dispose();
    const restarted = memory();
    await restarted.scan();
    expect(reads.mock.calls.filter(([target]) => target === absolutePath)).toHaveLength(warmReads + 1);
    expect((await restarted.readIndexedPath([])).unindexed).toEqual([relPath]);
    reads.mockImplementation(originalRead);
    await fs.writeFile(absolutePath, 'name: Repaired');
    await restarted.notifySaved(relPath, absolutePath);
    expect(await restarted.readIndexedPath(['Repaired'])).toEqual({ path: relPath, indexComplete: true, authoritative: true, unindexed: [] });
    await restarted.dispose();
    expect((await persisted()).entries[relPath].name).toBe('Repaired');
  });

  it('removes a stale warm entry from the persisted index after a parse failure', async () => {
    const absolutePath = path.join(dir, 'entry.yaml');
    await fs.writeFile(absolutePath, 'name: Original');
    const layer = memory();
    await layer.scan();
    await fs.writeFile(absolutePath, 'name: [broken');
    await fs.utimes(absolutePath, new Date(), new Date(Date.now() + 2000));
    await layer.scan();
    expect(await layer['getState']().persistence.flush()).toBe(true);
    expect((await persisted()).entries).toEqual({});
    expect((await layer.readIndexedPath(['Original'])).path).toBeUndefined();
    expect((await layer.readIndexedPath([])).unindexed).toEqual(['entry.yaml']);
  });

  it('rejects an unreadable date folder without changing the warm index or disk snapshot', async () => {
    const dateDir = path.join(dir, '2026-01-01');
    await fs.mkdir(dateDir);
    await fs.writeFile(path.join(dateDir, 'entry.yaml'), 'name: Original');
    const layer = memory();
    await layer.scan();
    expect(await layer['getState']().persistence.flush()).toBe(true);
    const disk = await fs.readFile(path.join(dir, '_index.json'), 'utf8');
    const originalList = fileOps.listDirectoryWithTypes.bind(fileOps);
    const denied = failure();
    jest.spyOn(fileOps, 'listDirectoryWithTypes').mockImplementation(async target => {
      if (target === dateDir) throw denied;
      return originalList(target);
    });
    await expect(layer.scan()).rejects.toMatchObject({ cause: denied });
    expect((await layer.readIndexedPath(['Original'])).path).toBe('2026-01-01/entry.yaml');
    expect(await fs.readFile(path.join(dir, '_index.json'), 'utf8')).toBe(disk);
  });

  it.each(['root', 'date', 'strict'])('keeps the explicit disappearance policy for %s enumeration', async kind => {
    const dateDir = path.join(dir, '2026-01-01');
    await fs.mkdir(dateDir);
    const originalList = fileOps.listDirectoryWithTypes.bind(fileOps);
    const gone = Object.assign(new Error('gone'), { code: 'ENOENT' });
    jest.spyOn(fileOps, 'listDirectoryWithTypes').mockImplementation(async target => {
      if ((target === dir && kind === 'root') || target === dateDir) throw gone;
      return originalList(target);
    });
    const layer = memory();
    if (kind === 'strict') await expect(layer.readFreshSummariesAtDirectory(dir)).rejects.toMatchObject({ cause: gone });
    else if (kind === 'root') await expect(layer.scan()).rejects.toMatchObject({ cause: gone });
    else await expect(layer.scan()).resolves.toBeDefined();
  });

  it('falls through to the resolver list when an unreadable file makes an indexed miss uncertain', async () => {
    const unreadable = path.join(dir, 'unreadable.md');
    await fs.writeFile(unreadable, '---\nname: Unreadable\n---\nContent');
    const backend = new FileStorageBackend(fileOps);
    jest.spyOn(backend, 'readFile').mockRejectedValue(failure());
    const layer = new ElementStorageLayer(fileOps, { elementDir: dir, fileExtension: '.md', storageBackend: backend, scanCooldownMs: 0 });
    const resolveAbsolutePath = (relativePath: string) => path.join(dir, relativePath);
    const cache = new ElementCache<IElement>(ElementType.SKILL, {
      elementDir: dir, resolveAbsolutePath, getCacheNamespace: () => 'test',
    }, { elementCacheTTL: 1000, pathCacheTTL: 1000 });
    const list = jest.fn<() => Promise<IElement[]>>().mockResolvedValue([]);
    const load = jest.fn<(filePath: string) => Promise<IElement>>()
      .mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const resolver = new ElementResolver({
      load, list, resolveAbsolutePath,
      normalizeFilename: (name: string) => name.toLowerCase(),
      getElementFilename: (name: string) => `${name}.md`,
      getFileExtension: () => '.md',
    }, cache, layer);
    try {
      await layer.scan();
      expect(await layer.readIndexedPath(['Missing'])).toMatchObject({ path: undefined, authoritative: false, unindexed: ['unreadable.md'] });
      await expect(resolver.findByName('Missing')).resolves.toBeUndefined();
      expect(load).toHaveBeenCalled();
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      cache.dispose();
      layer.clear();
    }
  });

  it('rebuilds a legacy persisted index instead of trusting rejected same-mtime metadata', async () => {
    const file = path.join(dir, 'a.yaml');
    await fs.writeFile(file, 'metadata: [broken');
    const stat = await fs.stat(file);
    await fs.writeFile(path.join(dir, '_index.json'), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), entryCount: 1,
      entries: { 'a.yaml': { filePath: 'a.yaml', name: 'unnamed', description: '', author: '', tags: [], version: '1.0.0', mtimeMs: stat.mtimeMs, sizeBytes: stat.size } } }));
    const layer = memory();
    const snapshot = await layer.scanMemorySnapshot();
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.unindexed.get('a.yaml')).toMatchObject({ name: 'MemoryMetadataExtractionError' });
    expect((await layer.readIndexedPath(['unnamed'])).authoritative).toBe(false);
    expect((await persisted()).version).toBe(2);
  });

  it.each([false, true])('preserves live cold metadata over same-mtime hydration (absent notification: %s)', async absent => {
    const file = path.join(dir, 'a.yaml');
    const untouched = path.join(dir, 'b.yaml');
    const timestamp = new Date('2026-01-01T00:00:00.000Z');
    await fs.writeFile(file, 'name: Old');
    await fs.writeFile(untouched, 'name: Untouched');
    await fs.utimes(file, timestamp, timestamp);
    const first = memory();
    await first.scan();
    await first.dispose();
    expect((await persisted()).version).toBe(2);
    await fs.writeFile(file, 'name: New');
    await fs.utimes(file, timestamp, timestamp);
    const cold = memory();
    await cold.notifySaved('a.yaml', file);
    if (absent) {
      jest.spyOn(cold['backend'], 'stat').mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
      await cold.notifySaved('a.yaml', file);
    }
    const reads = jest.spyOn(cold['backend'], 'readFile');
    const diff = await cold.scan();
    expect(reads.mock.calls.filter(([target]) => target === file)).toHaveLength(absent ? 1 : 0);
    expect(reads.mock.calls.filter(([target]) => target === untouched)).toHaveLength(0);
    expect(diff.modified).toEqual(absent ? ['a.yaml'] : []);
    expect(await cold.readIndexedPath(['New'])).toMatchObject({ path: 'a.yaml', authoritative: true });
    expect((await cold.readIndexedPath(['Old'])).path).toBeUndefined();
    expect((await cold.readIndexedPath(['Untouched'])).path).toBe('b.yaml');
    await cold.dispose();
    expect((await persisted()).entries['a.yaml'].name).toBe('New');
    expect((await persisted()).entries['b.yaml'].name).toBe('Untouched');
    const restarted = memory();
    await restarted.scan();
    expect(await restarted.readIndexedPath(['New'])).toMatchObject({ path: 'a.yaml', authoritative: true });
    expect((await restarted.readIndexedPath(['Old'])).path).toBeUndefined();
  });

  it('does not hydrate a same-mtime entry over a failed cold save notification', async () => {
    const file = path.join(dir, 'a.yaml');
    await fs.writeFile(file, 'name: Old');
    const first = memory();
    await first.scan();
    await first.dispose();
    const originalRead = fileOps.readFile.bind(fileOps);
    const read = jest.spyOn(fileOps, 'readFile').mockImplementation((target, options) => {
      if (target === file) return Promise.reject(failure());
      return originalRead(target, options);
    });
    const cold = memory();
    await cold.notifySaved('a.yaml', file);
    const snapshot = await cold.scanMemorySnapshot();
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.unindexed.get('a.yaml')).toMatchObject({ code: 'EACCES' });
    expect(read.mock.calls.filter(([target]) => target === file)).toHaveLength(2);
    expect((await cold.readIndexedPath(['Old'])).path).toBeUndefined();
    await cold.dispose();
    expect((await persisted()).entries['a.yaml']).toBeUndefined();
    const restarted = memory();
    await restarted.scan();
    expect(read.mock.calls.filter(([target]) => target === file)).toHaveLength(3);
    expect(await restarted.readIndexedPath(['Old'])).toMatchObject({ path: undefined, authoritative: false, unindexed: ['a.yaml'] });
  });

  it.each([false, true])('does not persist cold hydration without a successful override scan (scan failure: %s)', async failScan => {
    const file = path.join(dir, 'a.yaml');
    const timestamp = new Date('2026-01-01T00:00:00.000Z');
    await fs.writeFile(file, 'name: Old');
    await fs.utimes(file, timestamp, timestamp);
    const first = memory();
    await first.scan();
    await first.dispose();
    const before = await fs.readFile(path.join(dir, '_index.json'), 'utf8');
    const cold = memory();
    const writes = jest.spyOn(cold['getState']().persistence['file'], 'write');
    if (failScan) {
      await fs.writeFile(file, 'name: New');
      await fs.utimes(file, timestamp, timestamp);
      await cold.notifySaved('a.yaml', file);
      jest.spyOn(cold['backend'], 'directoryExists').mockRejectedValue(failure());
      await expect(cold.scan()).rejects.toMatchObject({ code: 'EACCES' });
    } else {
      await cold.scan();
    }
    expect(await cold['getState']().persistence.flush()).toBe(true);
    expect(writes).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(dir, '_index.json'), 'utf8')).toBe(before);
    if (failScan) {
      jest.mocked(cold['backend'].directoryExists).mockRestore();
      const reads = jest.spyOn(cold['backend'], 'readFile');
      expect((await cold.scan()).unchanged).toEqual(['a.yaml']);
      expect(reads).not.toHaveBeenCalled();
      await cold['getState']().persistence.flush();
      expect((await persisted()).entries['a.yaml'].name).toBe('New');
      const restarted = memory();
      await restarted.scan();
      expect(restarted.getPathByName('New')).toBe('a.yaml');
      expect(restarted.getPathByName('Old')).toBeUndefined();
    }
  });

  it('preserves notified state when the cold rebuild fails', async () => {
    const file = path.join(dir, 'a.yaml');
    await fs.writeFile(file, 'name: Old');
    const layer = memory();
    await layer.notifySaved('a.yaml', file);
    const state = layer['getState']();
    const before = { entries: state.table.entries(), unindexed: state.table.unindexed() };
    const attemptTime = Date.now(); jest.spyOn(Date, 'now').mockReturnValue(attemptTime);
    jest.spyOn(layer['backend'], 'directoryExists').mockRejectedValue(failure());
    await expect(layer.scan()).rejects.toMatchObject({ code: 'EACCES' });
    expect(state.table.entries()).toEqual(before.entries);
    expect(state.table.unindexed()).toEqual(before.unindexed);
    expect(state.lastScanAt).toBe(attemptTime);
    expect(await layer.readIndexedPath(['Old'])).toMatchObject({ path: 'a.yaml', authoritative: false });
    await expect(fs.stat(path.join(dir, '_index.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  function barrier() {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    return { release, entered, blocked, started };
  }

  it('preserves notifications during serialized persistence and restart', async () => {
    const file = path.join(dir, 'a.yaml');
    await fs.writeFile(file, 'name: Old');
    const layer = memory();
    const state = layer['getState']();
    const hold = barrier();
    const original = state.persistence['file'].write.bind(state.persistence['file']);
    jest.spyOn(state.persistence['file'], 'write').mockImplementationOnce(async (...args) => {
      hold.entered(); await hold.blocked; await original(...args);
    });
    await layer.scan();
    const rebuilding = state.persistence.flush();
    await hold.started;
    const read = fileOps.readFile.bind(fileOps);
    const reads = jest.spyOn(fileOps, 'readFile').mockImplementation((target, options) => target === file ? Promise.reject(failure()) : read(target, options));
    await layer.notifySaved('a.yaml', file);
    hold.release();
    await rebuilding;
    expect(await layer.readIndexedPath(['Old'])).toMatchObject({ path: undefined, authoritative: false, unindexed: ['a.yaml'] });
    await state.persistence.flush();
    expect((await persisted()).entries['a.yaml']).toBeUndefined();
    const restarted = memory();
    await restarted.scan();
    expect(await restarted.readIndexedPath(['Old'])).toMatchObject({ path: undefined, authoritative: false, unindexed: ['a.yaml'] });
    const attempts = reads.mock.calls.filter(([target]) => target === file).length;
    await layer.scan();
    expect(reads.mock.calls.filter(([target]) => target === file)).toHaveLength(attempts + 1);
    await state.persistence.flush();
    expect((await persisted()).entries['a.yaml']).toBeUndefined();
  });

  it.each(['save', 'delete', 'absent'])('preserves a %s notification during an ordinary scan', async action => {
    const file = path.join(dir, 'a.yaml');
    await fs.writeFile(file, 'name: Old');
    const layer = memory();
    await layer.notifySaved('a.yaml', file);
    const hold = barrier();
    const scan = layer['backend'].statMany.bind(layer['backend']);
    jest.spyOn(layer['backend'], 'statMany').mockImplementationOnce(async (...args) => {
      const diff = await scan(...args);
      hold.entered();
      await hold.blocked;
      return diff;
    });
    const rebuilding = layer.scan();
    await hold.started;
    if (action === 'save') {
      await fs.writeFile(file, 'name: New');
      await layer.notifySaved('a.yaml', file);
    } else if (action === 'absent') {
      jest.spyOn(layer['backend'], 'stat').mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
      await layer.notifySaved('a.yaml', file);
    } else {
      await fs.unlink(file);
      layer.notifyDeleted('a.yaml');
    }
    hold.release();
    await rebuilding;
    expect((await layer.readIndexedPath(['Old'])).path).toBeUndefined();
    if (action === 'absent') expect(layer['getState']().table.pendingInvalidation).toBe(true);
    const expected = action === 'save' ? 'New' : undefined;
    expect(layer['getState']().table.getPathByName('New') === 'a.yaml' ? 'New' : undefined).toBe(expected);
    if (action === 'save') await layer.scan();
    expect((await persisted()).entries['a.yaml']?.name).toBe(expected);
    if (action === 'absent') {
      expect((await layer.scan()).modified).toEqual(['a.yaml']);
      expect(await layer.readIndexedPath(['Old'])).toMatchObject({ path: 'a.yaml', authoritative: true });
    }
  });

  it.each(['element', 'memory'])('rechecks an absent %s notification at the same mtime', async kind => {
    const relativePath = kind === 'memory' ? 'a.yaml' : 'a.md';
    const file = path.join(dir, relativePath);
    await fs.writeFile(file, kind === 'memory' ? 'name: Old' : '---\nname: Old\n---\nContent');
    const layer = kind === 'memory' ? memory()
      : new ElementStorageLayer(fileOps, { elementDir: dir, fileExtension: '.md', scanCooldownMs: 60_000 });
    await layer.scan();
    const mtime = (await fs.stat(file)).mtimeMs;
    jest.spyOn(layer['backend'], 'stat').mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    await layer.notifySaved(relativePath, file);
    const reads = jest.spyOn(layer['backend'], 'readFile');
    expect((await layer.scan()).modified).toEqual([relativePath]);
    expect(reads).toHaveBeenCalledWith(file);
    expect((await fs.stat(file)).mtimeMs).toBe(mtime);
    expect(await layer.readIndexedPath(['Old'])).toMatchObject({ path: relativePath, authoritative: true, unindexed: [] });
  });

  it.each(['element', 'memory'])('retains removal evidence after an absent %s save notification', async kind => {
    const relativePath = kind === 'memory' ? 'a.yaml' : 'a.md';
    const file = path.join(dir, relativePath);
    await fs.writeFile(file, kind === 'memory' ? 'name: Old' : '---\nname: Old\n---\nContent');
    const layer = kind === 'memory' ? memory()
      : new ElementStorageLayer(fileOps, { elementDir: dir, fileExtension: '.md', scanCooldownMs: 60_000 });
    await layer.scan();
    await fs.unlink(file);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    await layer.notifySaved(relativePath, file);
    expect((await layer.scan()).removed).toEqual([relativePath]);
    await layer.notifySaved('never-seen', path.join(dir, 'never-seen'));
    expect(await layer.scan()).toMatchObject({ added: [], modified: [], removed: [] });
    expect(layer['getState']().table.unindexed().size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  describe.each(['skill', 'memory'])('real %s manager eviction', kind => {
  it.each(['removed', 'recheck', 'vanished', 'during scan'])('evicts a cached element after %s', async condition => {
    const skillsDir = path.join(dir, kind === 'skill' ? 'skills' : 'memories');
    const relativePath = kind === 'skill' ? 'a.md' : 'a.yaml';
    await fs.mkdir(skillsDir);
    const file = path.join(skillsDir, relativePath);
    await fs.writeFile(file, kind === 'memory' ? 'metadata:\n  name: A\n  description: Useful memory content\nentries: []' : '---\nname: A\ndescription: A useful capability\n---\nDetailed skill instructions.');
    const createManager = kind === 'skill' ? createRealSkillManager : createRealMemoryManager;
    const manager = createManager(dir, { fileOperationsService: fileOps });
    try {
      await manager['storageLayer'].scan();
      const element = await manager.load(relativePath);
      expect(manager['_cache'].getCachedByAbsolutePath(file)).toBe(element);
      const layer = manager['storageLayer'];
      if (condition === 'removed') await fs.unlink(file);
      if (condition === 'vanished') await fs.rm(skillsDir, { recursive: true });
      if (condition === 'recheck' || condition === 'during scan') {
        const paused = barrier();
        const storage = layer as ElementStorageLayer | MemoryStorageLayer;
        const original = storage['backend'].statMany.bind(storage['backend']);
        const scan = condition === 'during scan' ? jest.spyOn(storage['backend'], 'statMany').mockImplementation(async (...args) => {
          const result = await original(...args); paused.entered(); await paused.blocked; return result;
        }) : undefined;
        layer.invalidate();
        const scanning = scan ? layer.scan() : undefined;
        if (scanning) await paused.started;
        const absent = jest.spyOn(storage['backend'], 'stat').mockRejectedValueOnce(Object.assign(new Error('transient absence'), { code: 'ENOENT' }));
        await layer.notifySaved(relativePath, file);
        absent.mockRestore(); paused.release();
        if (scanning) await scanning;
        scan?.mockRestore();
      } else await layer.notifySaved(relativePath, file);
      await manager['scanAndEvict']();
      expect(manager['_cache'].getCachedByAbsolutePath(file)).toBeUndefined();
    } finally { await manager.dispose(); }
  });

  });

  it('evicts a stale manager cache entry even after a summary reader consumed the first failure diff', async () => {
    const skillsDir = path.join(dir, 'skills');
    await fs.mkdir(skillsDir);
    const file = path.join(skillsDir, 'a.md');
    await fs.writeFile(file, '---\nname: A\ndescription: A useful capability\n---\nDetailed skill instructions.');
    const manager = createRealSkillManager(dir, { fileOperationsService: fileOps });
    try {
      const layer = manager['storageLayer'];
      await layer.scan();
      const element = await manager.load('a.md');
      expect(manager['_cache'].getCachedByAbsolutePath(file)).toBe(element);
      await fs.utimes(file, new Date(), new Date(Date.now() + 1000));
      const read = fileOps.readFile.bind(fileOps);
      jest.spyOn(fileOps, 'readFile').mockImplementation((target, options) => target === file ? Promise.reject(failure()) : read(target, options));
      layer.invalidate();
      await layer.listSummaries();
      expect(manager['_cache'].getCachedByAbsolutePath(file)).toBe(element);
      layer.invalidate();
      await manager['scanAndEvict']();
      expect(manager['_cache'].getCachedByAbsolutePath(file)).toBeUndefined();
    } finally { await manager.dispose(); }
  });

  it.each(['element', 'memory'])('treats an absent saved %s as absent and retains a denied save for the next scan', async kind => {
    const relativePath = kind === 'memory' ? 'a.yaml' : 'a.md';
    const file = path.join(dir, relativePath);
    await fs.writeFile(file, kind === 'memory' ? 'name: Old' : '---\nname: Old\n---\nContent');
    const layer = kind === 'memory' ? memory()
      : new ElementStorageLayer(fileOps, { elementDir: dir, fileExtension: '.md', scanCooldownMs: 0 });
    await layer.scan();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const stat = jest.spyOn(layer['backend'], 'stat').mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    await layer.notifySaved(relativePath, file);
    expect(await layer.readIndexedPath(['Old'])).toMatchObject({ path: undefined, authoritative: false, unindexed: [] });
    expect(warn).not.toHaveBeenCalled();
    stat.mockRejectedValueOnce(failure());
    await layer.notifySaved(relativePath, file);
    expect(await layer.readIndexedPath(['Old'])).toMatchObject({ path: undefined, authoritative: false, unindexed: [relativePath] });
    jest.spyOn(layer['backend'], 'readFile').mockRejectedValue(failure());
    expect((await layer.scan()).modified).toContain(relativePath);
    expect((await layer.scan()).modified).toContain(relativePath);
  });

  it.each(['element', 'memory'])('removes a stale saved %s entry and repairs it through notifySaved', async kind => {
    const backend = new FileStorageBackend(fileOps);
    const relativePath = kind === 'memory' ? 'entry.yaml' : 'entry.md';
    const absolutePath = path.join(dir, relativePath);
    const valid = kind === 'memory' ? 'name: Original' : '---\nname: Original\n---\nContent';
    await fs.writeFile(absolutePath, valid);
    const layer = kind === 'memory'
      ? new MemoryStorageLayer(fileOps, { memoriesDir: dir, storageBackend: backend, scanCooldownMs: 0, indexDebounceMs: 0 })
      : new ElementStorageLayer(fileOps, { elementDir: dir, fileExtension: '.md', storageBackend: backend, scanCooldownMs: 0 });
    if (layer instanceof MemoryStorageLayer) layers.push(layer);
    await layer.scan();
    await fs.writeFile(absolutePath, kind === 'memory' ? 'metadata: [broken' : '---\nname: [broken\n---\nContent');
    await layer.notifySaved(relativePath, absolutePath);
    expect(await layer.readIndexedPath(['Original'])).toMatchObject({ path: undefined, authoritative: false, unindexed: [relativePath] });
    if (layer instanceof MemoryStorageLayer) {
      expect(await layer['getState']().persistence.flush()).toBe(true);
      expect((await persisted()).entries[relativePath]).toBeUndefined();
    }
    await fs.writeFile(absolutePath, valid.replace('Original', 'Repaired'));
    await layer.notifySaved(relativePath, absolutePath);
    expect((await layer.readIndexedPath(['Repaired'])).path).toBe(relativePath);
    expect(layer['getState']().table.unindexed().size).toBe(0);
  });

  it('preserves hydration on cold enumeration failure and retries incrementally', async () => {
    const subdir = path.join(dir, '2026-01-01');
    await fs.mkdir(subdir);
    await fs.writeFile(path.join(subdir, 'entry.yaml'), 'name: Original');
    const first = memory();
    await first.scan();
    await first.dispose();
    const disk = await fs.readFile(path.join(dir, '_index.json'), 'utf8');
    const originalList = fileOps.listDirectoryWithTypes.bind(fileOps);
    const list = jest.spyOn(fileOps, 'listDirectoryWithTypes').mockImplementation(async target => {
      if (target === subdir) throw failure();
      return originalList(target);
    });
    const restarted = memory();
    await expect(restarted.scan()).rejects.toMatchObject({ code: 'EACCES' });
    expect((await restarted.readIndexedPath(['Original'])).path).toBe('2026-01-01/entry.yaml');
    expect(await fs.readFile(path.join(dir, '_index.json'), 'utf8')).toBe(disk);
    list.mockRestore();
    const read = jest.spyOn(fileOps, 'readFile');
    const diff = await restarted.scan();
    expect(diff.unchanged).toEqual(['2026-01-01/entry.yaml']);
    expect(diff.added).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['element', 'memory'])('clears markers on notifyDeleted and clear for %s storage', async kind => {
    const backend = new FileStorageBackend(fileOps);
    const relPath = kind === 'memory' ? 'entry.yaml' : 'entry.md';
    await fs.writeFile(path.join(dir, relPath), 'name: Original');
    jest.spyOn(backend, 'readFile').mockRejectedValue(failure());
    const layer = kind === 'memory'
      ? new MemoryStorageLayer(fileOps, { memoriesDir: dir, storageBackend: backend, scanCooldownMs: 0 })
      : new ElementStorageLayer(fileOps, { elementDir: dir, fileExtension: '.md', storageBackend: backend, scanCooldownMs: 0 });
    if (layer instanceof MemoryStorageLayer) layers.push(layer);
    await layer.scan();
    expect((await layer.readIndexedPath([])).unindexed).toEqual([relPath]);
    layer.notifyDeleted(relPath);
    expect((await layer.readIndexedPath([])).unindexed).toEqual([]);
    await layer.scan();
    expect((await layer.readIndexedPath([])).unindexed).toEqual([relPath]);
    layer.clear();
    expect((await layer.readIndexedPath([])).unindexed).toEqual([]);
  });
  it.each(['element', 'memory'])('returns disk entries to %s list callers joined across clear', async kind => {
    const relative = kind === 'memory' ? 'a.yaml' : 'a.md';
    const file = path.join(dir, relative);
    await fs.writeFile(file, kind === 'memory' ? 'name: Present' : '---\nname: Present\n---\nContent');
    const layer = kind === 'memory' ? memory() : new ElementStorageLayer(fileOps, { elementDir: dir, fileExtension: '.md' });
    const held = barrier();
    const read = layer['backend'].readFile.bind(layer['backend']);
    jest.spyOn(layer['backend'], 'readFile').mockImplementationOnce(async target => {
      const content = await read(target); held.entered(); await held.blocked; return content;
    });
    const original = layer.listSummaries(); await held.started;
    layer.clear(); const joined = layer.listSummaries(); held.release();
    expect((await original).map(entry => entry.name)).toEqual(['Present']);
    expect((await joined).map(entry => entry.name)).toEqual(['Present']);
    expect(await layer.readIndexedPath(['Present'])).toMatchObject({ authoritative: true, path: relative });
  });

});
