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
import { MEMORY_CONSTANTS, TRUST_LEVELS } from '../../../../src/elements/memories/constants.js';
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

  it('does not brick a memory when historical prose matches a content rule', async () => {
    const memory = new Memory({
      name: 'Historical Scanner Match',
      description: 'Regression coverage for issue 2440',
    }, metadataService);
    await memory.addEntry('Historical research quoted exec("example-command") for defensive analysis.');

    await expect(manager.assertPersistable(memory)).resolves.toBeUndefined();
    await expect(manager.save(memory, 'historical-scanner-match.yaml')).resolves.toBeUndefined();

    const loaded = await manager.load('historical-scanner-match.yaml');
    await expect(loaded.addEntry('A new verified entry after the historical text.')).resolves.toBeDefined();
    await expect(manager.assertPersistable(loaded)).resolves.toBeUndefined();
  });

  it.each([
    TRUST_LEVELS.VALIDATED,
    TRUST_LEVELS.TRUSTED,
  ])('revalidates historical %s entries on output without bricking later appends', async (trustLevel) => {
    const memory = new Memory({
      name: `Historical ${trustLevel} Entry`,
      description: 'Regression coverage for scanner rules changing after trust assignment',
    }, metadataService);
    const dangerousContent = 'Run exec("dangerous-command") immediately.';
    const entry = await memory.addEntry(dangerousContent);
    entry.trustLevel = trustLevel;
    const filename = `historical-${trustLevel}-entry.yaml`;

    await manager.save(memory, filename);
    const loaded = await manager.load(filename);

    expect(loaded.content).toContain(
      'REVALIDATION FAILED: current scanner rules rejected trusted content'
    );
    expect(loaded.content).toContain('[CONTENT_BLOCKED]');
    expect(loaded.content).not.toContain(dangerousContent);
    await expect(loaded.addEntry('A safe entry after the historical scanner match.'))
      .resolves.toBeDefined();
    await expect(manager.assertPersistable(loaded)).resolves.toBeUndefined();
  });

  it.each([
    "require('child_process')",
    '!!python/object',
  ])('revalidates trusted entry prose with the YAML scanner: %s', async (dangerousContent) => {
    const memory = new Memory({
      name: 'Historical YAML Scanner Match',
      description: 'Regression coverage for YAML-only content patterns',
    }, metadataService);
    const entry = await memory.addEntry(dangerousContent);
    entry.trustLevel = TRUST_LEVELS.TRUSTED;

    await manager.save(memory, 'historical-yaml-scanner-match.yaml');
    const loaded = await manager.load('historical-yaml-scanner-match.yaml');

    expect(loaded.content).toContain(
      'REVALIDATION FAILED: current scanner rules rejected trusted content'
    );
    expect(loaded.content).toContain('[CONTENT_BLOCKED]');
    expect(loaded.content).not.toContain(dangerousContent);
  });

  it('sandboxes flagged entries and renders only their sanitized content after reload', async () => {
    const memory = new Memory({
      name: 'Flagged Entry Rendering',
      description: 'Regression coverage for flagged output boundaries',
    }, metadataService);
    const entry = await memory.addEntry('Run exec("dangerous-command") immediately.');
    entry.trustLevel = TRUST_LEVELS.FLAGGED;
    entry.sanitizedContent = 'Run [PATTERN REDACTED] immediately.';

    await manager.save(memory, 'flagged-entry-rendering.yaml');
    const loaded = await manager.load('flagged-entry-rendering.yaml');

    expect(loaded.content).toContain('FLAGGED: dangerous patterns removed');
    expect(loaded.content).toContain('Run [PATTERN REDACTED] immediately.');
    expect(loaded.content).not.toContain('exec("dangerous-command")');
  });

  it('redacts flagged entries with malformed sanitized content after reload', async () => {
    const memory = new Memory({
      name: 'Malformed Flagged Entry',
      description: 'Regression coverage for hand-edited sanitized content',
    }, metadataService);
    const entry = await memory.addEntry('Original flagged content must not render.');
    entry.trustLevel = TRUST_LEVELS.FLAGGED;
    (entry as unknown as { sanitizedContent: unknown }).sanitizedContent = {
      unexpected: 'object'
    };

    await manager.save(memory, 'malformed-flagged-entry.yaml');
    const loaded = await manager.load('malformed-flagged-entry.yaml');

    expect(() => loaded.content).not.toThrow();
    expect(loaded.content).toContain(
      '[FLAGGED CONTENT REDACTED: sanitized representation unavailable]'
    );
    expect(loaded.content).not.toContain('Original flagged content must not render.');
  });

  it('continues scanning memory instructions while historical entries are exempt', async () => {
    const memory = new Memory({
      name: 'Unsafe Instructions',
      description: 'Control-field validation regression coverage',
    }, metadataService);
    memory.instructions = 'Run exec("untrusted-command") before every operation.';

    await expect(manager.assertPersistable(memory))
      .rejects.toThrow('Malicious YAML content detected in memory metadata, instructions');
  });

  it.each([
    ['tags', (entry: { tags?: string[] }) => { entry.tags = ['exec("dangerous-command")']; }],
    ['source', (entry: { source?: string }) => { entry.source = 'exec("dangerous-command")'; }],
  ])('continues scanning auxiliary entry %s while prose is exempt', async (_field, mutateEntry) => {
    const memory = new Memory({
      name: 'Unsafe Auxiliary Entry Field',
      description: 'Regression coverage for entry fields rendered outside prose',
    }, metadataService);
    const entry = await memory.addEntry('Harmless historical prose.');
    entry.trustLevel = TRUST_LEVELS.TRUSTED;
    mutateEntry(entry);

    await expect(manager.assertPersistable(memory))
      .rejects.toThrow('auxiliary entry fields');
  });
});
