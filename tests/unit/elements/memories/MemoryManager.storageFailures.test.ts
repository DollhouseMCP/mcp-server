import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryManager } from '../../../../src/elements/memories/MemoryManager.js';
import { Memory } from '../../../../src/elements/memories/Memory.js';
import { MemoryUpgradeLifecycle } from '../../../../src/lifecycle/MemoryUpgradeLifecycle.js';
import { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ElementEventDispatcher } from '../../../../src/events/ElementEventDispatcher.js';
import { MemoryStorageLayer } from '../../../../src/storage/MemoryStorageLayer.js';
import { ElementReadError } from '../../../../src/elements/base/ElementReadError.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import { createTestStorageFactory } from '../../../helpers/createTestStorageFactory.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'memory-failure-'));
  const dir = path.join(root, 'memories');
  await mkdir(dir);
  const locks = new FileLockManager();
  const files = new FileOperationsService(locks);
  const metadata = createTestMetadataService();
  const manager = new MemoryManager({ portfolioManager: new PortfolioManager(files, { baseDir: root }),
    fileLockManager: locks, fileOperationsService: files, metadataService: metadata,
    serializationService: new SerializationService(),
    validationRegistry: new ValidationRegistry(new ValidationService(), new TriggerValidationService(), metadata),
    eventDispatcher: new ElementEventDispatcher(), storageLayerFactory: createTestStorageFactory(files),
    memoryUpgradeLifecycle: new MemoryUpgradeLifecycle() });
  const layer = manager['storageLayer'] as MemoryStorageLayer;
  return { manager, layer, files, dir, metadata, cleanup: async () => {
    await manager.dispose();
    await layer.dispose();
    await rm(root, { recursive: true, force: true });
  } };
}

afterEach(() => jest.restoreAllMocks());

describe('memory storage failure consumers', () => {
  it.each([['system', 'system'], ['adapters', 'adapter']])('infers the memory type from the selected %s path', async (folder, memoryType) => {
    const f = await fixture();
    try {
      await mkdir(path.join(f.dir, folder));
      await writeFile(path.join(f.dir, folder, 'legacy.yaml'), 'name: Legacy memory\n');
      expect((await f.manager.load(`${folder}/legacy.yaml`)).metadata).toMatchObject({ memoryType });
    } finally { await f.cleanup(); }
  });

  it.each(['root', 'date'])('reports a denied %s directory in load diagnostics', async directory => {
    const f = await fixture();
    try {
      jest.spyOn(f.manager as any, 'getDateFolders').mockResolvedValue(directory === 'date' ? ['2026-10-28'] : []);
      jest.spyOn(f.files, 'listDirectory').mockImplementation(async target => {
        if (target === path.join(f.dir, directory === 'date' ? '2026-10-28' : '')) {
          throw Object.assign(new Error('Private directory failure'), { code: 'EACCES' });
        }
        return [];
      });
      const result = await f.manager.getLoadStatus();
      expect(result.failed).toBe(1);
      expect(result.failures).toEqual([{ file: directory === 'date' ? '2026-10-28' : '.', error: expect.stringContaining('EACCES') }]);
      expect(result.loaded).toBe(0);
      expect(JSON.stringify(result)).not.toContain('Private directory failure');
    } finally { await f.cleanup(); }
  });

  it('reports a date folder that is a file instead of counting it as empty', async () => {
    const f = await fixture();
    try {
      // A genuine ENOTDIR: the date-shaped entry exists but is a file, so its listing cannot be empty.
      await writeFile(path.join(f.dir, '2026-10-28'), 'not a directory');
      const result = await f.manager.getLoadStatus();
      expect(result.failed).toBe(1);
      expect(result.failures).toEqual([{ file: '2026-10-28', error: expect.stringContaining('ENOTDIR') }]);
      expect(JSON.stringify(result)).not.toContain(f.dir);
    } finally { await f.cleanup(); }
  });

  it.each(['list', 'getAutoLoadMemories'] as const)('%s uses one pinned snapshot and audits a rejected definition once', async method => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.dir, 'broken.yaml'), 'metadata: [broken');
      SecurityMonitor.clearAllEventsForTesting();
      const snapshot = jest.spyOn(f.layer, 'readCollection');
      const paths = jest.spyOn(f.layer, 'getIndexedPaths');
      const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
      if (method === 'list') {
        await expect(f.manager.list()).rejects.toBeInstanceOf(ElementReadError);
        await expect(f.manager.list()).rejects.toBeInstanceOf(ElementReadError);
      } else {
        await expect(f.manager.getAutoLoadMemories()).rejects.toBeInstanceOf(ElementReadError);
        await expect(f.manager.getAutoLoadMemories()).rejects.toBeInstanceOf(ElementReadError);
      }
      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(paths).not.toHaveBeenCalled();
      expect(audit.mock.calls.filter(([event]) => event.type === 'MEMORY_LIST_ITEM_FAILED')).toHaveLength(1);
    } finally { await f.cleanup(); }
  });

  it.each([false, true])('returns discovery errors with auto-load survivors (healthy memory: %s)', async healthy => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.dir, 'broken.yaml'), 'metadata: [broken');
      if (healthy) await writeFile(path.join(f.dir, 'healthy.yaml'), 'name: Healthy\ndescription: Useful memory information\nautoLoad: true\nentries: []\n');
      jest.spyOn(f.manager, 'installSeedMemories').mockResolvedValue(undefined);
      const result = await f.manager.loadAndActivateAutoLoadMemories();
      expect(result.loaded).toBe(healthy ? 1 : 0);
      expect(result.errors).toEqual([expect.stringContaining('broken.yaml')]);
    } finally { await f.cleanup(); }
  });

  it('preserves a read failure code at the loader seam', async () => {
    const f = await fixture();
    try {
      const file = path.join(f.dir, 'denied.yaml');
      await writeFile(file, 'name: Denied');
      const read = f.files.readFile.bind(f.files);
      jest.spyOn(f.files, 'readFile').mockImplementation((target, options) => {
        if (target === file) return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
        return read(target, options);
      });
      const report = await f.manager.listReport();
      expect(report.complete).toBe(false);
      expect(report.failures).toEqual([expect.objectContaining({ reference: 'denied.yaml', error: expect.any(ElementReadError) })]);
      expect(report.failures[0].error.message).toContain('EACCES');
    } finally { await f.cleanup(); }
  });

  it('runs a fresh mutation beside a sibling that cannot be parsed, and refuses one a broken copy could hold', async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.dir, 'healthy.yaml'), 'name: Healthy');
      await writeFile(path.join(f.dir, 'broken.yaml'), 'metadata: [broken');
      const mutate = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      // The broken file can hold only its filename key ('broken'), so it does not block 'Healthy'.
      await expect(f.manager.runFreshMemoryMutation('Healthy', mutate)).resolves.toBeUndefined();
      expect(mutate).toHaveBeenCalledTimes(1);
      // A never-parsed copy whose filename could hold the requested name still refuses it.
      await mkdir(path.join(f.dir, '2026-10-27'), { recursive: true });
      await writeFile(path.join(f.dir, '2026-10-27', 'healthy.yaml'), 'metadata: [broken');
      mutate.mockClear();
      await expect(f.manager.runFreshMemoryMutation('Healthy', mutate)).rejects.toMatchObject({ name: 'ElementIndeterminateError',
        failures: [expect.objectContaining({ reference: '2026-10-27/healthy.yaml' })] });
      expect(mutate).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it('certifies a literal reference for fresh mutation beside a failed same-name copy', async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.dir, 'healthy.yaml'), 'name: Healthy');
      await mkdir(path.join(f.dir, '2026-10-27'));
      await writeFile(path.join(f.dir, '2026-10-27', 'healthy.yaml'), 'metadata: [broken');
      const mutate = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      await expect(f.manager.runFreshMemoryMutation('healthy.yaml', mutate)).resolves.toBeUndefined();
      expect(mutate).toHaveBeenCalledTimes(1);
      await expect(f.manager.runFreshMemoryMutation('Healthy', mutate)).rejects.toMatchObject({ kind: 'indeterminate' });
      await expect(f.manager.runFreshMemoryMutation('2026-10-27/healthy.yaml', mutate)).rejects.toBeInstanceOf(ElementReadError);
    } finally { await f.cleanup(); }
  });

  it('keeps the fresh-mutation ambiguous-target refusal', async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.dir, 'first.yaml'), 'name: Shared');
      await writeFile(path.join(f.dir, 'second.yaml'), 'name: Shared');
      const mutate = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      await expect(f.manager.runFreshMemoryMutation('Shared', mutate)).rejects.toMatchObject({ name: 'MemoryDrainRefusedError' });
      expect(mutate).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it('refuses a denied backup-before-overwrite probe without moving the existing file', async () => {
    const f = await fixture();
    try {
      const memory = new Memory({ name: 'Existing' }, f.metadata);
      const file = await f.manager['generateMemoryPath'](memory, undefined, 'existing.yaml');
      await writeFile(file, 'original');
      const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
      jest.spyOn(f.files, 'exists').mockRejectedValue(denied);
      const rename = jest.spyOn(f.files, 'renameFile');
      await expect(f.manager['generateMemoryPath'](memory, undefined, 'existing.yaml')).rejects.toBe(denied);
      expect(rename).not.toHaveBeenCalled();
      expect(await readFile(file, 'utf8')).toBe('original');
    } finally { await f.cleanup(); }
  });
});
