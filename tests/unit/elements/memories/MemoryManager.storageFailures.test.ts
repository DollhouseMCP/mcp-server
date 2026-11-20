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
import { MemoryMetadataExtractionError } from '../../../../src/storage/MemoryMetadataExtractor.js';
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
  it.each(['list', 'getAutoLoadMemories'] as const)('%s uses one pinned snapshot and audits a rejected definition once', async method => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.dir, 'broken.yaml'), 'metadata: [broken');
      const snapshot = jest.spyOn(f.layer, 'scanMemorySnapshot');
      const paths = jest.spyOn(f.layer, 'getIndexedPaths');
      const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
      const record = jest.spyOn(f.manager as unknown as { recordUnreadableElement(file: string, error: Error): void }, 'recordUnreadableElement');
      await expect(f.manager[method]()).resolves.toEqual([]);
      await expect(f.manager[method]()).resolves.toEqual([]);
      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(paths).not.toHaveBeenCalled();
      expect(record.mock.calls[0]).toEqual(['broken.yaml', expect.objectContaining({ name: 'MemoryMetadataExtractionError' })]);
      expect(audit.mock.calls.filter(([event]) => event.type === 'MEMORY_LIST_ITEM_FAILED')).toHaveLength(1);
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
      const record = jest.spyOn(f.manager as unknown as { recordUnreadableElement(file: string, error: Error): void }, 'recordUnreadableElement');
      await f.manager.list();
      expect(record.mock.calls[0]).toEqual(['denied.yaml', expect.objectContaining({ name: 'Error', code: 'EACCES' })]);
    } finally { await f.cleanup(); }
  });

  it('refuses a fresh mutation when a sibling cannot be parsed', async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.dir, 'healthy.yaml'), 'name: Healthy');
      await writeFile(path.join(f.dir, 'broken.yaml'), 'metadata: [broken');
      const mutate = jest.fn<() => Promise<void>>();
      const failure = await f.manager.runFreshMemoryMutation('Healthy', mutate).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MemoryMetadataExtractionError);
      expect(failure).toMatchObject({ message: expect.stringMatching(/broken\.yaml:.*(?:unexpected end|flow collection)/s) });
      expect(failure).toMatchObject({ message: expect.not.stringContaining(f.dir) });
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
