import { promises as fs } from 'fs';
import * as path from 'path';

import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { Memory } from '../../../src/elements/memories/Memory.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { FileWatchService } from '../../../src/services/FileWatchService.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { createPortfolioTestEnvironment, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import { createTestMetadataService } from '../../helpers/di-mocks.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import type { MetadataService } from '../../../src/services/MetadataService.js';
import { createTestStorageFactory } from '../../helpers/createTestStorageFactory.js';

// Create a shared MetadataService instance for all tests
const metadataService: MetadataService = createTestMetadataService();

describe('MemoryManager integration', () => {
  let manager: MemoryManager;
  let env: PortfolioTestEnvironment;
  let memoriesDir: string;
  let fileLockManager: FileLockManager;
  let fileOperationsService: FileOperationsService;
  let serializationService: SerializationService;
  let fileWatchService: FileWatchService;
  let validationRegistry: ValidationRegistry;

  const createManager = () => {
    return new MemoryManager({
      portfolioManager: env.portfolioManager,
      fileLockManager,
      fileOperationsService,
      validationRegistry,
      serializationService,
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
      fileWatchService,
      storageLayerFactory: createTestStorageFactory(fileOperationsService),
    });
  };

  beforeAll(async () => {
    env = await createPortfolioTestEnvironment('memory-manager-int');

    fileLockManager = new FileLockManager();
    fileOperationsService = new FileOperationsService(fileLockManager);
    serializationService = new SerializationService();
    fileWatchService = new FileWatchService();
    validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    );

    manager = createManager();

    memoriesDir = path.join(env.testDir, ElementType.MEMORY);
    await fs.mkdir(memoriesDir, { recursive: true });
  });

  afterAll(async () => {
    // Dispose manager to clean up file watchers
    if (manager) {
      manager.dispose();
    }

    await env.cleanup();
  });

  afterEach(async () => {
    // Dispose current manager before creating a new one
    if (manager) {
      manager.dispose();
    }

    await fs.rm(memoriesDir, { recursive: true, force: true });
    await fs.mkdir(memoriesDir, { recursive: true });

    // Create fresh manager for next test
    manager = createManager();
  });

  it('saves memories into date folders and loads them', async () => {
    const memory = new Memory({ name: 'Integration Memory', description: 'Integration scenario' }, metadataService);
    await memory.addEntry('First entry', ['integration']);

    await manager.save(memory);

    const dateFolders = await fs.readdir(memoriesDir, { withFileTypes: true });
    expect(dateFolders.some(dir => dir.isDirectory())).toBe(true);

    const firstFolder = dateFolders.find(dir => dir.isDirectory());
    if (!firstFolder) {
      throw new Error('Expected at least one date folder to be created.');
    }

    const files = await fs.readdir(path.join(memoriesDir, firstFolder.name));
    expect(files.some(file => file.endsWith('.yaml'))).toBe(true);

    const fileName = files.find(file => file.endsWith('.yaml'))!;
    const loaded = await manager.load(path.join(firstFolder.name, fileName));
    expect(loaded.metadata.name).toBe('Integration Memory');
    expect(loaded.getStats().totalEntries).toBe(1);
  });

  it('lists saved memories across folders', async () => {
    const memoryA = new Memory({ name: 'Memory A' }, metadataService);
    await memoryA.addEntry('Entry A');
    await manager.save(memoryA);

    const memoryB = new Memory({ name: 'Memory B' }, metadataService);
    await memoryB.addEntry('Entry B');
    await manager.save(memoryB);

    const memories = await manager.list();
    const names = memories.map(m => m.metadata.name);
    expect(names).toEqual(expect.arrayContaining(['Memory A', 'Memory B']));
  });

  it('deletes memories and cleans cache', async () => {
    const memory = new Memory({ name: 'Deletable Memory' }, metadataService);
    await memory.addEntry('To be removed');
    await manager.save(memory, 'deletable.yaml');

    await manager.delete('deletable.yaml');
    await expect(fs.access(path.join(memoriesDir, 'deletable.yaml'))).rejects.toThrow();
  });
});
