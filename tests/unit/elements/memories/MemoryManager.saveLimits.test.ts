/**
 * Regression tests for Issue #2329 — memories whose serialized YAML exceeded
 * 64KB (MAX_YAML_LENGTH, a frontmatter limit) failed EVERY save with
 * "YAML content exceeds maximum allowed size", while the deferred save path
 * swallowed the error and addEntry kept reporting success. Entries lived only
 * in process RAM and were lost on restart.
 *
 * These tests pin the corrected behavior:
 * - serialized memories up to MAX_YAML_SIZE (256KB, the load-path limit) save fine
 * - memories past MAX_YAML_SIZE are rejected with an actionable error
 * - assertPersistable() reports the same verdict as save() without writing
 */

import { MemoryManager } from '../../../../src/elements/memories/MemoryManager.js';
import { Memory } from '../../../../src/elements/memories/Memory.js';
import { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { DollhouseContainer } from '../../../../src/di/Container.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { ElementEventDispatcher } from '../../../../src/events/ElementEventDispatcher.js';
import { createTestStorageFactory } from '../../../helpers/createTestStorageFactory.js';
import { MEMORY_CONSTANTS } from '../../../../src/elements/memories/constants.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';

const metadataService = createTestMetadataService();

/** Build a memory whose serialized YAML lands near the requested size. */
async function buildMemoryOfSize(name: string, targetBytes: number): Promise<Memory> {
  const memory = new Memory({
    name,
    description: `Sized test memory targeting ${targetBytes} bytes`,
  }, metadataService);

  // ~16KB of plain prose per entry — well under MAX_ENTRY_SIZE (100KB) and
  // survives sanitization unchanged.
  const chunk = 'research finding lorem ipsum dolor sit amet consectetur adipiscing elit '.padEnd(80, 'x');
  const entryContent = chunk.repeat(200);
  const entryCount = Math.ceil(targetBytes / entryContent.length);
  for (let i = 0; i < entryCount; i++) {
    await memory.addEntry(`entry-${i}: ${entryContent}`, ['sized']);
  }
  return memory;
}

describe('MemoryManager save size limits (#2329)', () => {
  let container: InstanceType<typeof DollhouseContainer>;
  let manager: InstanceType<typeof MemoryManager>;
  let testDir: string;
  let memoriesDir: string;

  beforeAll(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-save-limits-test-'));
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

    container = new DollhouseContainer();
    container.register('FileLockManager', () => new FileLockManager());
    container.register('FileOperationsService', () => new FileOperationsService(container.resolve('FileLockManager')));
    container.register('PortfolioManager', () => new PortfolioManager(container.resolve('FileOperationsService'), { baseDir: testDir }));
    container.register('SerializationService', () => new SerializationService());
    container.register('ValidationRegistry', () => new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    ));
    container.register('MemoryManager', () => new MemoryManager({
      portfolioManager: container.resolve('PortfolioManager'),
      fileLockManager: container.resolve('FileLockManager'),
      fileOperationsService: container.resolve('FileOperationsService'),
      validationRegistry: container.resolve('ValidationRegistry'),
      serializationService: container.resolve('SerializationService'),
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
      storageLayerFactory: createTestStorageFactory(),
    }));

    manager = container.resolve('MemoryManager');
    memoriesDir = path.join(testDir, 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });
  });

  afterAll(async () => {
    await container.dispose();
    await fs.rm(testDir, { recursive: true, force: true });
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
  });

  it('saves and reloads a memory whose serialized YAML exceeds 64KB (#2329 repro)', async () => {
    const memory = await buildMemoryOfSize('Large Memory 2329', 80 * 1024);

    await manager.save(memory, 'large-memory-2329.yaml');

    const filePath = path.join(memoriesDir, 'large-memory-2329.yaml');
    const stat = await fs.stat(filePath);
    // The whole point: past the old 64KB frontmatter cap, still persisted.
    expect(stat.size).toBeGreaterThan(64 * 1024);

    const raw = await fs.readFile(filePath, 'utf-8');
    expect(raw).toContain('entry-0:');

    const loaded = await manager.load('large-memory-2329.yaml');
    const entries = await loaded.search({});
    expect(entries.length).toBeGreaterThan(0);
  });

  it('rejects a save past MAX_YAML_SIZE with an actionable error and writes nothing', async () => {
    const memory = await buildMemoryOfSize('Oversized Memory 2329', MEMORY_CONSTANTS.MAX_YAML_SIZE + 32 * 1024);

    await expect(manager.save(memory, 'oversized-memory-2329.yaml'))
      .rejects.toThrow('maximum serialized size');

    await expect(fs.stat(path.join(memoriesDir, 'oversized-memory-2329.yaml')))
      .rejects.toThrow();
  });

  it('assertPersistable passes for a >64KB memory without writing anything', async () => {
    const memory = await buildMemoryOfSize('Persistable Check', 80 * 1024);

    await expect(manager.assertPersistable(memory)).resolves.toBeUndefined();

    // Pre-flight only — no file may appear.
    const files = await fs.readdir(memoriesDir, { recursive: true });
    expect(files.filter(f => String(f).includes('persistable-check'))).toHaveLength(0);
  });

  it('assertPersistable rejects a memory past MAX_YAML_SIZE with the same error as save', async () => {
    const memory = await buildMemoryOfSize('Unpersistable Check', MEMORY_CONSTANTS.MAX_YAML_SIZE + 32 * 1024);

    await expect(manager.assertPersistable(memory))
      .rejects.toThrow('maximum serialized size');
  });
});
