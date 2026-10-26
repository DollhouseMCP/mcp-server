import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ElementStorageLayer } from '../../../src/storage/ElementStorageLayer.js';
import { MemoryStorageLayer } from '../../../src/storage/MemoryStorageLayer.js';
import { FileStateTable } from '../../../src/storage/FileStateTable.js';
import { FileStorageBackend } from '../../../src/storage/FileStorageBackend.js';
import { SecurityError } from '../../../src/errors/SecurityError.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { logger } from '../../../src/utils/logger.js';
import { createTestFileOperationsService, createRealMemoryManager, createRealSkillManager } from '../../helpers/di-mocks.js';

describe('FailedScanRetries', () => {
  const roots: string[] = [];
  const layers: Array<ElementStorageLayer | MemoryStorageLayer> = [];
  afterEach(async () => {
    for (const layer of layers.splice(0)) await layer.dispose();
    jest.restoreAllMocks();
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  });
  async function fixture(kind: 'element' | 'memory', cooldown = 0) {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'failure-reuse-')); roots.push(root);
    const ops = createTestFileOperationsService(); const backend = new FileStorageBackend(ops);
    const relative = kind === 'memory' ? 'entry.yaml' : 'entry.md';
    const file = path.join(root, relative);
    const wrap = (value: string) => kind === 'memory' ? value : `---\n${value}\n---\nContent`;
    await fs.writeFile(file, wrap('name: [broken'));
    const layer = kind === 'memory'
      ? new MemoryStorageLayer(ops, { memoriesDir: root, storageBackend: backend, scanCooldownMs: cooldown })
      : new ElementStorageLayer(ops, { elementDir: root, fileExtension: '.md', storageBackend: backend, scanCooldownMs: cooldown });
    layers.push(layer);
    return { root, ops, backend, relative, file, layer, wrap };
  }

  it.each(['element', 'memory'] as const)('re-reads unchanged %s parse failures and observes touches, repairs, deletion and rechecks', async kind => {
    const f = await fixture(kind);
    const reads = jest.spyOn(f.backend, 'readFile');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => {});
    await f.layer.scan();
    const initial = f.layer['getState']().table.unindexed().get(f.relative);
    warn.mockClear(); debug.mockClear();
    for (let i = 0; i < 3; i++) expect((await f.layer.scan()).modified).toEqual([f.relative]);
    expect(reads).toHaveBeenCalledTimes(4);
    expect(f.layer['getState']().table.unindexed().get(f.relative)).toEqual(initial);
    expect((await f.layer.readIndexedPath(['missing'])).authoritative).toBe(false);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('failed to index'))).toHaveLength(0);
    expect(debug.mock.calls.filter(([message]) => String(message).includes('failed to index'))).toHaveLength(3);
    const timestamp = new Date(Date.now() + 10000);
    await fs.utimes(f.file, timestamp, timestamp); await f.layer.scan(); expect(reads).toHaveBeenCalledTimes(5);
    f.layer['getState']().table.applyAbsent(f.relative); await f.layer.scan(); expect(reads).toHaveBeenCalledTimes(6);
    await f.layer.notifySaved(f.relative, f.file); expect(reads).toHaveBeenCalledTimes(7);
    f.layer.clear(); await f.layer.scan(); expect(reads).toHaveBeenCalledTimes(8);
    await fs.writeFile(f.file, f.wrap('name: Repaired'));
    await fs.utimes(f.file, new Date(timestamp.getTime() + 1000), new Date(timestamp.getTime() + 1000));
    await f.layer.scan(); expect(reads).toHaveBeenCalledTimes(9);
    expect((await f.layer.readIndexedPath(['Repaired'])).path).toBe(f.relative);
    await fs.unlink(f.file); expect((await f.layer.scan()).removed).toEqual([f.relative]);
    expect(f.layer['getState']().table.get(f.relative)).toBeUndefined();
    await fs.writeFile(f.file, f.wrap('name: [broken')); await f.layer.scan();
    await fs.unlink(f.file); await f.layer.scan();
    expect(f.layer['getState']().table.unindexed().size).toBe(0);
  });

  it.each(['element', 'memory'] as const)('retries %s I/O and unknown content errors on every eligible scan', async kind => {
    const f = await fixture(kind);
    const read = jest.spyOn(f.backend, 'readFile');
    for (const failure of [Object.assign(new Error('denied'), { code: 'EACCES' }), new SecurityError('read failure', 'high')]) {
      f.layer.clear(); read.mockClear().mockRejectedValue(failure);
      for (let i = 0; i < 3; i++) await f.layer.scan();
      expect(read).toHaveBeenCalledTimes(3);
    }
    read.mockRestore();
    const originalStat = f.ops.stat.bind(f.ops);
    const stat = jest.spyOn(f.ops, 'stat').mockImplementation(async target => {
      if (target === f.file) throw Object.assign(new Error('stat denied'), { code: 'EACCES' });
      return originalStat(target);
    });
    f.layer.clear();
    for (let i = 0; i < 3; i++) await f.layer.scan();
    expect(stat.mock.calls.filter(([target]) => target === f.file)).toHaveLength(3);
    stat.mockRestore();
    const parse = jest.spyOn(f.layer, 'readIndexEntry' as never);
    for (const failure of [new Error('unknown'), new SecurityError('I/O code', 'EIO'), new SecurityError('not content', 'TOKEN_VALIDATION_FAILED')]) {
      f.layer.clear(); parse.mockClear().mockImplementation(() => { throw failure; });
      for (let i = 0; i < 3; i++) await f.layer.scan();
      expect(parse).toHaveBeenCalledTimes(3);
    }
  });

  it.each(['element', 'memory'] as const)('consumes served %s invalidation on failure while preserving later invalidations and expiry', async kind => {
    const f = await fixture(kind, 100);
    const denied = Object.assign(new Error('directory denied'), { code: 'EACCES' });
    const enumerate = jest.spyOn(f.ops, 'listDirectoryWithTypes').mockRejectedValue(denied);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    f.layer.invalidate();
    await expect(f.layer.scan()).rejects.toMatchObject({ cause: denied });
    await expect(f.layer.scan()).rejects.toMatchObject({ cause: denied });
    expect(enumerate).toHaveBeenCalledTimes(1);
    expect(f.layer['getState']().table.isAuthoritative()).toBe(false);
    clock.mockReturnValue(1100); await expect(f.layer.scan()).rejects.toMatchObject({ cause: denied });
    expect(enumerate).toHaveBeenCalledTimes(2);
    f.layer.invalidate();
    enumerate.mockImplementationOnce(async () => { f.layer.invalidate(); throw denied; });
    await expect(f.layer.scan()).rejects.toMatchObject({ cause: denied });
    await expect(f.layer.scan()).rejects.toMatchObject({ cause: denied });
    expect(enumerate).toHaveBeenCalledTimes(4);
    await expect(f.layer.scan()).rejects.toMatchObject({ cause: denied });
    expect(enumerate).toHaveBeenCalledTimes(4);
  });

  it.each(['record', 'mtime'])('rejects a missing ownership %s with an explicit invariant error', missing => {
    const table = new FileStateTable();
    table['byName'].set('name', new Set(['first.md', 'missing.md']));
    if (missing === 'mtime') table['records'].set('first.md', { status: 'recheck', nameKey: 'name' });
    expect(() => table.getPathByName('name')).toThrow('File name ownership requires an observed modification time');
  });

  it.each(['list', 'date folders'])('treats ENOTDIR as absence in memory %s', async operation => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'memory-absence-')); roots.push(root);
    const ops = createTestFileOperationsService();
    const manager = createRealMemoryManager(root, { fileOperationsService: ops });
    const cause = Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    try {
      if (operation === 'list') {
        jest.spyOn(manager['storageLayer'] as MemoryStorageLayer, 'scanMemorySnapshot').mockRejectedValue(cause);
        await expect(manager.list()).resolves.toEqual([]);
      } else {
        jest.spyOn(ops, 'listDirectory').mockRejectedValue(cause);
        await expect(manager['getDateFolders']()).resolves.toEqual([]);
      }
    } finally { await manager.dispose(); }
  });

  it('evicts stale manager content when another reader already observed a parse failure', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'failed-cache-')); roots.push(root);
    const dir = path.join(root, 'skills'); await fs.mkdir(dir);
    const file = path.join(dir, 'entry.md');
    await fs.writeFile(file, '---\nname: Example\ndescription: A useful capability\n---\nDetailed skill instructions.');
    const manager = createRealSkillManager(root, { fileOperationsService: createTestFileOperationsService() });
    try {
      const layer = manager['storageLayer'];
      const element = await manager.load('entry.md');
      await fs.writeFile(file, '---\nname: [broken\n---\nContent');
      await fs.utimes(file, new Date(), new Date(Date.now() + 10000));
      layer.invalidate(); await layer.listSummaries();
      expect(manager['_cache'].getCachedByAbsolutePath(file)).toBe(element);
      await manager['scanAndEvict']();
      expect(manager['_cache'].getCachedByAbsolutePath(file)).toBeUndefined();
    } finally { await manager.dispose(); }
  });

  for (const kind of ['element', 'memory'] as const) {
    it(`re-reads ${kind} indexed content when size changes at the same mtime`, async () => {
      const f = await fixture(kind);
      await fs.writeFile(f.file, f.wrap('name: Before'));
      const timestamp = new Date('2025-01-01T00:00:00Z');
      await fs.utimes(f.file, timestamp, timestamp);
      const before = await fs.stat(f.file);
      const reads = jest.spyOn(f.backend, 'readFile');
      await f.layer.scan();
      expect(f.layer['getState']().table.get(f.relative)?.status).toBe('indexed');
      await fs.writeFile(f.file, f.wrap('name: Completed replacement'));
      await fs.utimes(f.file, timestamp, timestamp);
      const after = await fs.stat(f.file);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.size).not.toBe(before.size);
      await f.layer.scan();
      expect(reads).toHaveBeenCalledTimes(2);
      expect((await f.layer.readIndexedPath(['Completed replacement'])).path).toBe(f.relative);
      await f.layer.scan();
      expect(reads).toHaveBeenCalledTimes(2);
    });
  }

  it('retries a transient YAML warning listener failure on the next element scan', async () => {
    const f = await fixture('element');
    await fs.writeFile(f.file, f.wrap('name: Valid Warning\nextra:\n  array: [\na, b]'));
    const monitor = new SecurityMonitor();
    SecurityMonitor.setInstance(monitor);
    const failure = Object.assign(new Error('temporary audit sink outage'), { code: 'EIO' });
    const remove = monitor.instanceAddLogListener(event => {
      if (event.type === 'YAML_PARSING_WARNING') throw failure;
    });
    const reads = jest.spyOn(f.backend, 'readFile');
    try {
      await f.layer.scan();
      expect(f.layer['getState']().table.unindexed().get(f.relative)).toMatchObject({
        name: 'Error', code: 'EIO', reason: expect.not.stringContaining(f.root),
      });
      remove();
      await f.layer.scan();
      expect(reads).toHaveBeenCalledTimes(2);
      expect((await f.layer.readIndexedPath(['Valid Warning'])).path).toBe(f.relative);
      expect(f.layer['getState']().table.unindexed().size).toBe(0);
    } finally { remove(); SecurityMonitor.clearInstance(monitor); }
  });

  it.each(['element', 'memory'] as const)('re-reads hydrated %s entries without size evidence once', async kind => {
    const f = await fixture(kind);
    await fs.writeFile(f.file, f.wrap('name: Hydrated'));
    await f.layer.scan();
    const table = f.layer['getState']().table;
    const entries = table.entries();
    Reflect.deleteProperty(entries[0], 'sizeBytes');
    table.clear(); table.hydrate(entries);
    const reads = jest.spyOn(f.backend, 'readFile');
    await f.layer.scan();
    expect(reads).toHaveBeenCalledTimes(1);
    await f.layer.scan();
    expect(reads).toHaveBeenCalledTimes(1);
  });
});
