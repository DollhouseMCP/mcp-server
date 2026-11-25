/**
 * A stored reference is read exactly, for every type: a legacy root memory is never read as the
 * system/ or date-folder file that shares its basename. Memory sub-folders are searched only by the
 * resolver's filename fallback, for a bare name the index does not hold, and the resolver never
 * returns a definition whose name it was not asked for.
 */
import { describe, expect, it, afterEach, beforeEach, jest } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { ElementMissingError, ElementReadError, isRejectedDefinition } from '../../../src/elements/base/ElementReadError.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { MetadataService } from '../../../src/services/MetadataService.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { Memory } from '../../../src/elements/memories/Memory.js';
import { MemoryUpgradeLifecycle } from '../../../src/lifecycle/MemoryUpgradeLifecycle.js';
import { logger } from '../../../src/utils/logger.js';
import { createTestStorageFactory } from '../../helpers/createTestStorageFactory.js';

const BOUND = 15_000;
const memory = (name: string) => `name: ${name}\ndescription: ${name} fixture\nentries: []\n`;
const skill = (name: string) => `---\nname: ${JSON.stringify(name)}\ndescription: Exact read fixture\n---\nFollow these detailed instructions.`;

describe('exact stored-reference reads', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  let dir: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'memory-exact-reads-'));
    suite = createRealManagerSuite(root);
    dir = (suite.memoryManager as any)['memoriesDir'];
    for (const folder of ['2026-01-01', 'system']) await mkdir(path.join(dir, folder), { recursive: true });
    await writeFile(path.join(dir, 'notes.yaml'), memory('root-notes'));
    await writeFile(path.join(dir, 'system', 'notes.yaml'), memory('system-notes'));
    await writeFile(path.join(dir, '2026-01-01', 'notes.yaml'), memory('dated-notes'));
    await writeFile(path.join(dir, 'other.yaml'), memory('root-other'));
    await writeFile(path.join(dir, '2026-01-01', 'other.yaml'), memory('dated-other'));
  });
  afterEach(async () => {
    await Promise.all([suite.memoryManager.dispose(), suite.skillManager.dispose()]);
    await rm(root, { recursive: true, force: true });
  });

  it('keeps wrong-extension and missing upgrade definitions typed as absent', async () => {
    const manager = suite.memoryManager;
    await expect(manager.loadStoredReference('notes.md')).rejects.toBeInstanceOf(ElementMissingError);
    await expect(manager['readUpgradeContent']('missing.yaml')).rejects.toBeInstanceOf(ElementMissingError);
    const cause = Object.assign(new Error('Storage unavailable'), { code: 'EIO' });
    jest.spyOn(manager['storageLayer'], 'readContent').mockRejectedValueOnce(cause);
    await expect(manager['readUpgradeContent']('notes.yaml')).rejects.toMatchObject({ kind: 'unreadable', cause });
  });

  const exists = (relative: string) => access(path.join(dir, relative)).then(() => true, () => false);

  it('lists, finds and identifies each same-basename memory as itself', async () => {
    const memories = suite.memoryManager;
    const listed = (await memories.list()).map(item => [item.metadata.name, item.getFilePath()]).sort();
    const summaries = (await memories.listSummaries()).map(entry => [entry.name, entry.filePath]).sort();
    expect(listed).toEqual(summaries);
    expect(listed.map(([name]) => name)).toEqual(['dated-notes', 'dated-other', 'root-notes', 'root-other', 'system-notes']);
    for (const [name, reference] of listed) {
      expect((await memories.findByName(name))?.getFilePath()).toBe(reference);
      memories.clearCache();
      expect((await memories.findByStorageIdentity(reference))?.metadata.name).toBe(name);
    }
  }, BOUND);

  it('deletes exactly the selected memory: root-notes leaves system/notes.yaml intact', async () => {
    await suite.memoryManager.delete('root-notes');
    expect(await exists('notes.yaml')).toBe(false);
    expect(await exists(path.join('system', 'notes.yaml'))).toBe(true);
    expect(await exists(path.join('2026-01-01', 'notes.yaml'))).toBe(true);
  }, BOUND);

  it('reads held references on the list path without searching the memory folders', async () => {
    const memories = suite.memoryManager;
    await memories.listSummaries();
    memories.clearCache();
    await memories.listSummaries();
    const probes = jest.spyOn((suite as any).fileOperationsService, 'exists');
    await memories.list();
    expect(probes).not.toHaveBeenCalled();
  }, BOUND);

  it('still finds a bare name the index has not seen yet in a sub-folder, through the fallback', async () => {
    const memories = suite.memoryManager;
    await memories.listSummaries();
    await writeFile(path.join(dir, 'system', 'sys-only.yaml'), memory('sys-only'));
    expect((await memories.findByName('sys-only'))?.getFilePath()).toBe('system/sys-only.yaml');
  }, BOUND);

  it('never reads a path-syntax raw candidate in the filename fallback', async () => {
    const skills = suite.skillManager;
    const skillDir = (skills as any)['elementDir'];
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'plain.md'), skill('Plain'));
    await skills.listReport();
    const reads = jest.spyOn(skills as any, 'loadStoredReference');
    await expect(skills.findByName('C:alpha')).resolves.toBeUndefined();
    expect(reads.mock.calls.map(([reference]) => reference)).not.toContain('C:alpha.md');
  }, BOUND);

  it('never returns a definition whose name the index did not select it for: the stale selection is rescanned', async () => {
    const skills = suite.skillManager;
    const skillDir = (skills as any)['elementDir'];
    await mkdir(skillDir, { recursive: true });
    const file = path.join(skillDir, 'alpha.md');
    await writeFile(file, skill('Alpha'));
    await skills.listReport();
    skills.clearCache();
    await skills.listReport();
    // Inside the scan window the file is renamed in place: the index still selects alpha.md for
    // 'Alpha', its read carries another name, and the rescan gives the fresh answer.
    await writeFile(file, skill('Renamed Elsewhere'));
    await expect(skills.findByName('Alpha')).resolves.toBeUndefined();
    expect((await skills.findByName('Renamed Elsewhere'))?.metadata.name).toBe('Renamed Elsewhere');
  }, BOUND);

  it('classifies a held path-syntax reference by one exit, cold or warm, path policy included', async () => {
    const memories = suite.memoryManager;
    await writeFile(path.join(dir, '2026-01-01', 'save%41.yaml'), memory('percent-dated'));
    const policy = jest.spyOn(memories as any, 'applyPathPolicy');
    expect(await (memories as any).classifyCallerText('2026-01-01/save%41.yaml')).toBe('reference');
    const cold = policy.mock.calls.length;
    policy.mockClear();
    expect(await (memories as any).classifyCallerText('2026-01-01/save%41.yaml')).toBe('reference');
    expect(cold).toBe(1);
    expect(policy).toHaveBeenCalledTimes(1);
  }, BOUND);

  it('addresses the root file for every caller-text form of a held bare filename, cold or warm', async () => {
    const memories = suite.memoryManager;
    // Cold: nothing has read the collection; load fills the index once, then reads the held reference.
    expect((await memories.load('notes.yaml')).metadata.name).toBe('root-notes');
    memories.clearCache();
    expect((await memories.findByStorageIdentity('notes.yaml'))?.metadata.name).toBe('root-notes');
    await expect(memories.exists('notes.yaml')).resolves.toBe(true);
    await memories.delete('notes.yaml');
    expect(await exists('notes.yaml')).toBe(false);
    expect(await exists(path.join('system', 'notes.yaml'))).toBe(true);
  }, BOUND);

  it('still loads an unindexed bare filename from system/ by caller text', async () => {
    const memories = suite.memoryManager;
    await memories.listSummaries();
    await writeFile(path.join(dir, 'system', 'sys-loaded.yaml'), memory('sys-loaded'));
    const loaded = await memories.load('sys-loaded.yaml');
    expect([loaded.metadata.name, loaded.getFilePath()]).toEqual(['sys-loaded', 'system/sys-loaded.yaml']);
  }, BOUND);

  const withEntry = (name: string) => `name: ${name}\ndescription: ${name} fixture\nentries:\n  - id: e1\n    content: user content\n    timestamp: 2026-01-01T00:00:00.000Z\n`;

  it.each([
    ['system copy with content beside an empty root copy: kept, nothing removed', withEntry('seed-system'), memory('seed-root'), true, []],
    ['empty system copy beside a root copy with content: the system copy is reinstalled, the root kept', memory('seed-system'), withEntry('seed-root'), false, ['system/seedlike.yaml']],
    ['a root copy with content and no system copy: kept', undefined, withEntry('seed-root'), true, []],
    ['an empty root copy and no system copy: the root copy is reinstalled', undefined, memory('seed-root'), false, ['seedlike.yaml']],
  ] as const)('the seed check examines the system copy first, then a legacy copy (%s)', async (_label, systemBody, rootBody, skips, removed) => {
    const memories = suite.memoryManager as any;
    if (systemBody) await writeFile(path.join(dir, 'system', 'seedlike.yaml'), systemBody);
    if (rootBody) await writeFile(path.join(dir, 'seedlike.yaml'), rootBody);
    const existing = await memories.findExistingSeedMemory('seedlike.yaml');
    expect(existing.getFilePath()).toBe(systemBody ? 'system/seedlike.yaml' : 'seedlike.yaml');
    await expect(memories.prepareExistingSeedForInstall(existing, 'seedlike.yaml')).resolves.toBe(skips);
    for (const reference of ['seedlike.yaml', 'system/seedlike.yaml']) {
      const present = reference === 'seedlike.yaml' ? rootBody !== undefined : systemBody !== undefined;
      expect([reference, await exists(reference)]).toEqual([reference, present && !(removed as readonly string[]).includes(reference)]);
    }
  }, BOUND);

  it.each(['cold', 'warm'])('surfaces an unreadable root copy as its own failure, never the system/ copy (%s)', async temperature => {
    const memories = suite.memoryManager;
    await writeFile(path.join(dir, 'notes.yaml'), 'name: [unclosed\n  : : :\n');
    if (temperature === 'warm') await memories.listReport();
    await expect(memories.load('notes.yaml')).rejects.toMatchObject({ name: 'ElementUnreadableError' });
    memories.clearCache();
    await expect(memories.findByStorageIdentity('notes.yaml')).rejects.toMatchObject({ name: 'ElementUnreadableError' });
  }, BOUND);

  it('loads an unindexed bare filename from a warm index without reading the collection again', async () => {
    const memories = suite.memoryManager;
    await memories.listSummaries();
    await writeFile(path.join(dir, 'system', 'warm-only.yaml'), memory('warm-only'));
    const reads = jest.spyOn((memories as any)['storageLayer'], 'readCollection');
    expect((await memories.load('warm-only.yaml')).getFilePath()).toBe('system/warm-only.yaml');
    expect(reads).not.toHaveBeenCalled();
  }, BOUND);

  it.each([
    [['unnamed.yaml', 'system/unnamed.yaml']],
    [['system/unnamed.yaml', '2026-01-01/unnamed.yaml']],
    [['2026-01-02/unnamed.yaml', '2026-01-01/unnamed.yaml']],
  ])('refuses as ambiguous, and deletes nothing, when separator-only memories in %j both derive the unnamed file', async files => {
    const memories = suite.memoryManager;
    await mkdir(path.join(dir, '2026-01-02'), { recursive: true });
    for (const [index, relative] of files.entries()) {
      await writeFile(path.join(dir, ...relative.split('/')), `name: ${JSON.stringify(index === 0 ? '---' : '___')}\ndescription: separator-only\nentries: []\n`);
    }
    for (const temperature of ['cold', 'warm']) {
      if (temperature === 'warm') await memories.listReport();
      else memories.clearCache();
      await expect(memories.findByName('unnamed')).rejects.toMatchObject({ name: 'ElementIndeterminateError' });
    }
    await expect(memories.delete('unnamed')).rejects.toMatchObject({ name: 'ElementIndeterminateError' });
    for (const relative of files) expect(await exists(relative)).toBe(true);
  }, BOUND);

  it('finds a separator-only memory in a date folder as unnamed, and nothing for other text deriving its file', async () => {
    const memories = suite.memoryManager;
    await memories.listSummaries();
    await writeFile(path.join(dir, '2026-01-01', 'unnamed.yaml'), 'name: "---"\ndescription: separator-only\nentries: []\n');
    expect((await memories.findByName('unnamed'))?.getFilePath()).toBe('2026-01-01/unnamed.yaml');
    await expect(memories.findByName('中文')).resolves.toBeUndefined();
  }, BOUND);

  it('offers no fallback file the stored read would refuse: an unheld ??? is absent, as on beta', async () => {
    const memories = suite.memoryManager;
    await memories.listSummaries();
    await expect(memories.findByName('???')).resolves.toBeUndefined();
  }, BOUND);

  const SEED = 'dollhousemcp-baseline-knowledge.yaml';
  const backupsOf = async () => {
    const found: string[] = [];
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(full);
        else found.push(full);
      }
    };
    await walk(path.join(dir, 'backups'));
    return found;
  };

  // #1016: an unreadable installed seed is backed up (its bytes kept) and reinstalled, as on beta.
  it.each([
    ['broken yaml', 'name: [unclosed\nentries:\n  - content: USER PRIVATE NOTES\n'],
    // M1 (#606): a refusal by the memory validators is a rejection of the seed's own bytes too.
    ['a validator-rejected description', 'name: dollhousemcp-baseline-knowledge\ndescription: 42\nentries:\n'
      + "  - id: e1\n    timestamp: '2026-01-01T00:00:00.000Z'\n    content: USER PRIVATE NOTES\n"],
  ])('backs up an unreadable system/ seed with its bytes and reinstalls it (%s)', async (_label, body) => {
    const file = path.join(dir, 'system', SEED);
    await writeFile(file, body);
    await suite.memoryManager.installSeedMemories();
    const backups = await backupsOf();
    expect(backups).toHaveLength(1);
    expect(path.relative(path.join(dir, 'backups', 'user'), backups[0]).split(path.sep)).toHaveLength(2);
    expect(path.basename(backups[0])).toMatch(/^dollhousemcp-baseline-knowledge\.backup-.*\.yaml$/);
    expect(await readFile(backups[0], 'utf8')).toBe(body);
    const installed = await readFile(file, 'utf8');
    expect(installed).not.toBe(body);
    expect((await suite.memoryManager.findByStorageIdentity(`system/${SEED}`))?.metadata.name).toBe('dollhousemcp-baseline-knowledge');
  }, BOUND);

  // H1 (#603): a failure that is not a rejection of the seed's own bytes establishes nothing about the
  // seed. A healthy seed beside an unreadable folder stays byte-identical across restarts, and nothing
  // is backed up.
  const healthySeed = 'name: dollhousemcp-baseline-knowledge\ndescription: d\nmemoryType: system\nautoLoad: true\n'
    + "entries:\n  - id: e1\n    timestamp: '2026-01-01T00:00:00.000Z'\n    content: USER ADDED NOTES that matter\n";
  const lockFolder = (target: { fileOperationsService: FileOperationsService }, folder: string) => {
    const operations = target.fileOperationsService;
    const list = operations.listDirectoryWithTypes.bind(operations);
    jest.spyOn(operations, 'listDirectoryWithTypes').mockImplementation(async directory => {
      if (path.basename(directory) === folder) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return list(directory);
    });
  };

  it('leaves a healthy seed untouched across restarts while another folder is unreadable (H1)', async () => {
    const file = path.join(dir, 'system', SEED);
    await writeFile(file, healthySeed);
    for (let start = 0; start < 5; start++) {
      if (start > 0) {
        await Promise.all([suite.memoryManager.dispose(), suite.skillManager.dispose()]);
        suite = createRealManagerSuite(root);
      }
      lockFolder(suite, '2026-01-01');
      await suite.memoryManager.installSeedMemories();
      expect([start, await readFile(file, 'utf8')]).toEqual([start, healthySeed]);
      expect([start, await backupsOf()]).toEqual([start, []]);
    }
  }, BOUND * 2);

  // #618 (owner decision B, #1023 L1 accepted): a seed that cannot be examined is never written, even
  // when it is missing. The install is skipped with a typed warning, and the seed is installed on the
  // first start where the folder is readable.
  it('skips the install of a missing seed while another folder is unreadable, and installs it once readable', async () => {
    const warn = jest.spyOn(logger, 'warn');
    lockFolder(suite, '2026-01-01');
    await suite.memoryManager.installSeedMemories();
    expect(await exists(path.join('system', SEED))).toBe(false);
    expect(await backupsOf()).toEqual([]);
    expect(warn.mock.calls.some(([message]) => String(message).includes('could not be examined; left untouched, install skipped'))).toBe(true);
    jest.restoreAllMocks();
    suite.memoryManager.clearCache();
    await suite.memoryManager.installSeedMemories();
    expect((await suite.memoryManager.findByStorageIdentity(`system/${SEED}`))?.metadata.name).toBe('dollhousemcp-baseline-knowledge');
  }, BOUND);

  it('never replaces an existing empty seed it could not examine', async () => {
    const file = path.join(dir, 'system', SEED);
    const empty = 'name: dollhousemcp-baseline-knowledge\ndescription: d\nentries: []\n';
    await writeFile(file, empty);
    lockFolder(suite, '2026-01-01');
    await suite.memoryManager.installSeedMemories();
    expect(await readFile(file, 'utf8')).toBe(empty);
    expect(await backupsOf()).toEqual([]);
  }, BOUND);

  // #618 H1: every production MemoryManager carries the MemoryUpgradeLifecycle (ElementManagerServiceRegistrar).
  // A seed check beside an unreadable folder must write nothing, so it never records a failed write
  // that refuses later memory saves and the shutdown drain.
  it.each([
    ['an existing seed', healthySeed],
    ['an existing empty seed', 'name: dollhousemcp-baseline-knowledge\ndescription: d\nentries: []\n'],
  ])('keeps later saves and the drain working after %s could not be examined, under the upgrade lifecycle', async (_label, body) => {
    const fileLockManager = new FileLockManager();
    const fileOperationsService = new FileOperationsService(fileLockManager);
    const metadataService = new MetadataService();
    const lifecycle = new MemoryUpgradeLifecycle();
    const managed = new MemoryManager({
      portfolioManager: new PortfolioManager(fileOperationsService, { baseDir: root }), fileLockManager, fileOperationsService,
      validationRegistry: new ValidationRegistry(new ValidationService(), new TriggerValidationService(), metadataService),
      serializationService: new SerializationService(), metadataService, eventDispatcher: new ElementEventDispatcher(),
      storageLayerFactory: createTestStorageFactory(fileOperationsService), memoryUpgradeLifecycle: lifecycle,
    });
    const file = path.join(dir, 'system', SEED);
    await writeFile(file, body);
    try {
      lockFolder({ fileOperationsService }, '2026-01-01');
      await managed.installSeedMemories();
      jest.restoreAllMocks();
      expect(await readFile(file, 'utf8')).toBe(body);
      expect(lifecycle.getSummary().failedWrites).toBe(0);
      await managed.save(new Memory({ name: 'later-note', description: 'd' }, metadataService));
      await expect(lifecycle.quiesceAndDrain(2_000)).resolves.toBeUndefined();
    } finally {
      // Cleanup only: on a refused drain, dispose refuses too, and the assertions above name the cause.
      await managed.dispose().catch(() => undefined);
    }
  }, BOUND);

  it('reports an unreadable folder as a storage failure, never as a rejected definition (H1, I2)', async () => {
    await writeFile(path.join(dir, 'system', SEED), healthySeed);
    lockFolder(suite, '2026-01-01');
    const failure = await suite.memoryManager.findByStorageIdentity(`system/${SEED}`).then(() => undefined, error => error);
    expect(failure).toBeInstanceOf(ElementReadError);
    expect(isRejectedDefinition(failure)).toBe(false);
    expect((failure as ElementReadError).failures.some(entry => entry.contentRejected)).toBe(false);
  }, BOUND);

  it('installs the system/ seed beside an unreadable legacy root copy, leaving that copy alone', async () => {
    const legacy = path.join(dir, SEED);
    const body = 'name: [unclosed\n  : : bad yaml {{{\n';
    await writeFile(legacy, body);
    await suite.memoryManager.installSeedMemories();
    expect(await readFile(legacy, 'utf8')).toBe(body);
    expect(await backupsOf()).toEqual([]);
    expect((await suite.memoryManager.findByStorageIdentity(`system/${SEED}`))?.metadata.name).toBe('dollhousemcp-baseline-knowledge');
  }, BOUND);
});
