/**
 * Tests for Issue #2861 — rollover_memory seals older entries into read-only
 * archive volumes and resets the live memory under the same name.
 *
 * MemoryManager.rolloverMemory() writes and verifies every volume but does not
 * modify the live memory; the caller applies the result and saves through the
 * ordinary save path. These tests pin:
 * - volumes are standard memory YAML under memories/volumes/<memory>/, never listed
 * - dry runs write nothing
 * - oversized legacy memories (#2864) split into volumes within MAX_YAML_SIZE
 * - nothing is written when the live memory would still be too large
 * - a failure part-way removes the volumes written by that call
 * - the volume index survives save and reload, and numbering continues
 * - database storage mode is refused with a clear error
 */

import { jest } from '@jest/globals';
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
import type { MemoryRolloverOptions } from '../../../../src/elements/memories/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';

const metadataService = createTestMetadataService();

const options = (overrides: Partial<MemoryRolloverOptions> = {}): MemoryRolloverOptions => ({
  keepTags: [...MEMORY_CONSTANTS.ROLLOVER_DEFAULT_KEEP_TAGS],
  keepLatest: 0,
  dryRun: false,
  ...overrides,
});

/** A memory with `count` entries of roughly `entryChars` characters each. */
async function buildMemory(name: string, count: number, entryChars = 200): Promise<Memory> {
  const memory = new Memory({ name, description: `Rollover test memory ${name}` }, metadataService);
  const body = 'rollover test entry lorem ipsum dolor sit amet '.repeat(Math.ceil(entryChars / 47)).slice(0, entryChars);
  for (let i = 0; i < count; i++) {
    await memory.addEntry(`entry-${i}: ${body}`, ['sized']);
  }
  return memory;
}

describe('MemoryManager.rolloverMemory (#2861)', () => {
  let container: InstanceType<typeof DollhouseContainer>;
  let manager: InstanceType<typeof MemoryManager>;
  let testDir: string;
  let memoriesDir: string;

  beforeAll(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-rollover-test-'));
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

    container = new DollhouseContainer();
    container.replace('FileLockManager', () => new FileLockManager());
    container.replace('FileOperationsService', () => new FileOperationsService(container.resolve('FileLockManager')));
    container.replace('PortfolioManager', () => new PortfolioManager(container.resolve('FileOperationsService'), { baseDir: testDir }));
    container.replace('SerializationService', () => new SerializationService());
    container.replace('ValidationRegistry', () => new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    ));
    container.replace('MemoryManager', () => new MemoryManager({
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

  async function volumeFiles(slug: string): Promise<string[]> {
    try {
      return (await fs.readdir(path.join(memoriesDir, 'volumes', slug))).sort();
    } catch {
      return [];
    }
  }

  it('writes a verified volume under memories/volumes/<memory>/ that is never listed', async () => {
    const memory = await buildMemory('Volume Basics', 6);
    await manager.save(memory, 'volume-basics.yaml');

    const result = await manager.rolloverMemory(memory, options({ keepLatest: 2 }));

    expect(result.sealedCount).toBe(4);
    expect(result.keptCount).toBe(2);
    expect(result.sealedIds).toHaveLength(4);
    expect(result.volumes).toHaveLength(1);
    const [record] = result.volumes;
    expect(record.file).toBe('volumes/volume-basics/v0001.yaml');

    const written = await fs.readFile(path.join(memoriesDir, record.file), 'utf-8');
    expect(crypto.createHash('sha256').update(written, 'utf8').digest('hex')).toBe(record.sha256);
    expect(written).toContain('entry-0:');
    expect(written).not.toContain('entry-5:');

    // The live memory is untouched until the caller applies the result.
    expect((await memory.search({})).length).toBe(6);

    const listed = (await manager.list()).map(m => m.metadata.name);
    expect(listed).toContain('Volume Basics');
    expect(listed.some(name => name.includes('volume'))).toBe(false);
  });

  it('writes nothing on a dry run', async () => {
    const memory = await buildMemory('Dry Run Memory', 5);

    const result = await manager.rolloverMemory(memory, options({ dryRun: true }));

    expect(result.dryRun).toBe(true);
    expect(result.sealedCount).toBe(5);
    expect(result.volumes).toHaveLength(1);
    expect(result.sealedIds).toEqual([]);
    expect(await volumeFiles('dry-run-memory')).toEqual([]);
  });

  it('seals nothing and writes nothing when every entry is kept', async () => {
    const memory = await buildMemory('All Kept', 3);

    const result = await manager.rolloverMemory(memory, options({ keepTags: ['sized'] }));

    expect(result.sealedCount).toBe(0);
    expect(await volumeFiles('all-kept')).toEqual([]);
  });

  it('splits an oversized legacy memory into volumes within MAX_YAML_SIZE (#2864)', async () => {
    // ~600KB: over the save limit, as a pre-#2329 file could be.
    const memory = await buildMemory('Oversized Legacy', 40, 16 * 1024);

    const result = await manager.rolloverMemory(memory, options({ keepLatest: 2 }));

    expect(result.sealedCount).toBe(38);
    expect(result.volumes.length).toBeGreaterThan(1);
    expect(result.volumes.reduce((sum, v) => sum + v.entryCount, 0)).toBe(38);
    for (const record of result.volumes) {
      const written = await fs.readFile(path.join(memoriesDir, record.file), 'utf-8');
      expect(written.length).toBeLessThanOrEqual(MEMORY_CONSTANTS.MAX_YAML_SIZE);
    }

    memory.applyRollover(result.sealedIds, result.volumes);
    await expect(manager.assertPersistable(memory)).resolves.toBeUndefined();
  });

  it('refuses before writing anything when the live memory would still be too large', async () => {
    const memory = await buildMemory('Still Too Big', 40, 16 * 1024);

    await expect(manager.rolloverMemory(memory, options({ keepLatest: 30 })))
      .rejects.toThrow('still over the');
    expect(await volumeFiles('still-too-big')).toEqual([]);
  });

  it('removes the volumes it wrote when a later volume fails, and changes nothing', async () => {
    const memory = await buildMemory('Fails Midway', 40, 16 * 1024);
    const fileOps = (manager as unknown as { fileOperations: FileOperationsService }).fileOperations;
    const original = fileOps.createFileExclusive.bind(fileOps);
    let calls = 0;
    const spy = jest.spyOn(fileOps, 'createFileExclusive').mockImplementation(async (...args) => {
      calls++;
      if (calls === 2) throw new Error('simulated disk failure');
      return original(...args);
    });

    try {
      await expect(manager.rolloverMemory(memory, options({ keepLatest: 2 })))
        .rejects.toThrow('nothing was changed');
    } finally {
      spy.mockRestore();
    }
    expect(await volumeFiles('fails-midway')).toEqual([]);
    expect((await memory.search({})).length).toBe(40);
  });

  it('keeps the volume index across save and reload, and continues numbering', async () => {
    const memory = await buildMemory('Numbered Log', 4);
    const first = await manager.rolloverMemory(memory, options());
    memory.applyRollover(first.sealedIds, first.volumes);
    await manager.save(memory, 'numbered-log.yaml');

    const reloaded = await manager.load('numbered-log.yaml');
    expect(reloaded.getVolumeRecords()).toEqual(first.volumes);

    await reloaded.addEntry('entry after first rollover', ['sized']);
    const second = await manager.rolloverMemory(reloaded, options());
    expect(second.volumes.map(v => v.volume)).toEqual([2]);
    expect(await volumeFiles('numbered-log')).toEqual(['v0001.yaml', 'v0002.yaml']);
  });

  it('refuses in database storage mode with a clear error', async () => {
    const memory = await buildMemory('Database Mode', 2);
    const original = (manager as unknown as { storageLayer: unknown }).storageLayer;
    Object.defineProperty(manager, 'storageLayer', { value: { writeContent: async () => 'id' }, configurable: true });
    try {
      await expect(manager.rolloverMemory(memory, options()))
        .rejects.toThrow('not yet available in database storage mode');
    } finally {
      Object.defineProperty(manager, 'storageLayer', { value: original, configurable: true, writable: false });
    }
  });
});
