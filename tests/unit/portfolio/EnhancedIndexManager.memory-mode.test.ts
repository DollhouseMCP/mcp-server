import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { EnhancedIndexManager, type MemoryDerivedIndexMode } from '../../../src/portfolio/EnhancedIndexManager.js';
import { IndexConfigManager } from '../../../src/portfolio/config/IndexConfig.js';
import type { ConfigManager } from '../../../src/config/ConfigManager.js';
import type { PathService } from '../../../src/paths/PathService.js';
import { PortfolioIndexManager, type IndexEntry, type PortfolioIndex } from '../../../src/portfolio/PortfolioIndexManager.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { NLPScoringManager } from '../../../src/portfolio/NLPScoringManager.js';
import { VerbTriggerManager } from '../../../src/portfolio/VerbTriggerManager.js';
import { RelationshipManager } from '../../../src/portfolio/RelationshipManager.js';
import { DefaultEnhancedIndexHelpers } from '../../../src/portfolio/enhanced-index/EnhancedIndexHelpers.js';
import { ElementDefinitionBuilder } from '../../../src/portfolio/enhanced-index/ElementDefinitionBuilder.js';
import { SemanticRelationshipService } from '../../../src/portfolio/enhanced-index/SemanticRelationshipService.js';
import { ActionTriggerExtractor } from '../../../src/portfolio/enhanced-index/ActionTriggerExtractor.js';
import { TriggerMetricsTracker } from '../../../src/portfolio/enhanced-index/TriggerMetricsTracker.js';
import { FileLock } from '../../../src/utils/FileLock.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';

const owned: Array<{ manager: EnhancedIndexManager; nlp: NLPScoringManager; directory: string }> = [];
afterEach(async () => {
  try {
    for (const f of owned.splice(0)) {
      try { await f.manager.cleanup(); await f.manager.dispose(); }
      finally { f.nlp.dispose(); await rm(f.directory, { recursive: true, force: true }); }
    }
  } finally { jest.restoreAllMocks(); }
});

async function fixture(storage: 'memory' | 'persistent' | 'ordinary' = 'memory') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'derived-index-mode-'));
  await writeFile(path.join(directory, 'bystander'), 'preserve this exact sibling');
  const config = new IndexConfigManager();
  const nlp = new NLPScoringManager({}, config);
  const verbs = new VerbTriggerManager();
  const relationships = new RelationshipManager({ nlpScoring: nlp, verbTriggerManager: verbs, indexConfigManager: config });
  const helpers = new DefaultEnhancedIndexHelpers(new ElementDefinitionBuilder(),
    new SemanticRelationshipService({ nlpScoring: nlp, relationshipManager: relationships }),
    context => new ActionTriggerExtractor(context), options => new TriggerMetricsTracker(options));
  const entries: IndexEntry[] = ['session-one', 'session-two'].map(name => ({
    filePath: `db-memory:${name}`, elementType: ElementType.MEMORY, filename: name,
    metadata: { name, description: `Remember ${name} notes`, keywords: ['notes'], tags: ['owned'], triggers: ['remember'] },
    lastModified: new Date('2026-10-01T00:00:00Z'),
  }));
  const data: PortfolioIndex = { byName: new Map(), byFilename: new Map(),
    byType: new Map([[ElementType.MEMORY, entries]]), byKeyword: new Map(), byTag: new Map(), byTrigger: new Map() };
  // The selected DB source has separate actual-PG controls. Here the real derived algorithms consume its existing entry shape.
  const getIndex = jest.fn<() => Promise<PortfolioIndex>>().mockResolvedValue(data);
  const portfolio = { getIndex } as unknown as PortfolioIndexManager;
  const fileOperations = new FileOperationsService(new FileLockManager());
  const effects = [jest.spyOn(fileOperations, 'stat'), jest.spyOn(fileOperations, 'readFile'),
    jest.spyOn(fileOperations, 'createDirectory'), jest.spyOn(fileOperations, 'writeFile'),
    jest.spyOn(FileLock.prototype, 'acquire'), jest.spyOn(FileLock.prototype, 'release')];
  // NLP owns its separate interval, created above. Observe only timers scheduled by the enhanced index and its metrics/extractor helpers.
  const interval = jest.spyOn(globalThis, 'setInterval');
  const timeout = jest.spyOn(globalThis, 'setTimeout');
  const failure = new Error('Original derived invocation closed');
  let active = true;
  const assertCurrent = () => { if (!active) throw failure; };
  const namespace = path.join(directory, 'capability-index.yaml');
  const mode: MemoryDerivedIndexMode = { storage: storage === 'memory' ? 'memory' : 'persistent', namespace, assertCurrent };
  const pathService = { getUserPortfolioDir: () => directory } as unknown as PathService;
  const manager = new EnhancedIndexManager(config,
    { getConfig: () => ({ elements: { enhanced_index: { telemetry: { enabled: storage === 'memory', sampleRate: 1, metricsInterval: 60000 } } } }) } as unknown as ConfigManager,
    portfolio, nlp, verbs, relationships, helpers, fileOperations, storage === 'ordinary' ? pathService : mode);
  owned.push({ manager, nlp, directory });
  return { manager, directory, entries, getIndex, relationships, effects, interval, timeout, failure, close: () => { active = false; } };
}

async function expectNoFilesystemEffects(f: Awaited<ReturnType<typeof fixture>>) {
  for (const effect of f.effects) expect(effect).not.toHaveBeenCalled();
  expect(await readdir(f.directory)).toEqual(['bystander']);
  expect(await readFile(path.join(f.directory, 'bystander'), 'utf8')).toBe('preserve this exact sibling');
}

describe('EnhancedIndexManager bound RAM derived mode', () => {
  it('keeps all public derived read/edit paths in RAM and refuses explicit persistence', async () => {
    const f = await fixture();
    const index = await f.manager.getIndex();
    expect(Object.keys(index.elements.memories)).toEqual(['session-one', 'session-two']);
    expect(await f.manager.getIndex()).toBe(index);
    expect((await f.manager.searchEnhanced({ type: 'memories', keywords: ['notes'] })).map(e => e.core.name)).toEqual(['session-one', 'session-two']);
    expect(await f.manager.getElementsByAction('remember')).toEqual(['session-one', 'session-two']);
    expect(await f.manager.getTriggerMetrics()).toEqual(expect.arrayContaining([expect.objectContaining({ trigger: 'remember', usage_count: 1 })]));
    for (const format of ['json', 'csv', 'prometheus'] as const) expect(await f.manager.exportMetrics(format)).toContain('remember');
    await f.manager.addExtension('owned', { exact: 'RAM only' });
    await f.manager.addRelationship('session-one', 'memories:session-two', { type: 'uses', strength: 1, element: 'memories:session-two' });
    expect((await f.manager.getElementRelationships('memories:session-one')).uses).toEqual(expect.arrayContaining([expect.objectContaining({ element: 'memories:session-two' })]));
    expect(await f.manager.findElementPath('memories:session-one', 'memories:session-two')).not.toBeNull();
    expect((await f.manager.getConnectedElements('memories:session-one')).has('memories:session-two')).toBe(true);
    expect((await f.manager.getRelationshipStats()).totalRelationships).toBeGreaterThan(0);
    await f.manager.updateElements(['session-one'], { forceRebuild: true });
    expect((await f.manager.getIndex()).extensions?.owned).toEqual({ exact: 'RAM only' });
    await expect(f.manager.persist()).rejects.toThrow('cannot be persisted');
    f.manager.startMemoryCleanup(1); f.manager.stopMemoryCleanup(); f.manager.clearMemoryCache();
    await f.manager.cleanup(); await f.manager.dispose();
    expect(f.interval).not.toHaveBeenCalled(); expect(f.timeout).not.toHaveBeenCalled();
    await expectNoFilesystemEffects(f);
  });

  it('refuses a closed original binding even when the derived index is cached', async () => {
    const f = await fixture(); await f.manager.getIndex(); f.close();
    for (const operation of [() => f.manager.getIndex(), () => f.manager.searchEnhanced({}),
      () => f.manager.getElementsByAction('remember'), () => f.manager.getTriggerMetrics(),
      () => f.manager.exportMetrics(), () => f.manager.addExtension('closed', {}),
      () => f.manager.addRelationship('session-one', 'memories:session-two', { type: 'uses', element: 'memories:session-two' }),
      () => f.manager.persist()]) await expect(operation()).rejects.toBe(f.failure);
    await expectNoFilesystemEffects(f);
  });

  it('rejects binding drift during the awaited source before publishing a built index', async () => {
    const f = await fixture();
    f.getIndex.mockImplementationOnce(async () => { f.close(); return { byName: new Map(), byFilename: new Map(),
      byType: new Map(), byKeyword: new Map(), byTag: new Map(), byTrigger: new Map() }; });
    await expect(f.manager.getIndex()).rejects.toBe(f.failure);
    await expectNoFilesystemEffects(f);
  });

  it('rejects original binding closure during the cached rebuild check yield', async () => {
    const f = await fixture(); await f.manager.getIndex();
    const result = f.manager.getIndex();
    // Even a false async rebuild check yields before the direct public result is returned.
    f.close();
    await expect(result).rejects.toBe(f.failure);
    await expectNoFilesystemEffects(f);
  });

  it.each(['path', 'connected'] as const)('checks the original binding before returning a relationship %s result', async kind => {
    const f = await fixture(); await f.manager.getIndex();
    if (kind === 'path') {
      jest.spyOn(f.relationships, 'findPath').mockImplementationOnce(() => { f.close(); return null; });
      await expect(f.manager.findElementPath('memories:session-one', 'memories:session-two')).rejects.toBe(f.failure);
    } else {
      jest.spyOn(f.relationships, 'getConnectedElements').mockImplementationOnce(() => { f.close(); return new Map(); });
      await expect(f.manager.getConnectedElements('memories:session-one')).rejects.toBe(f.failure);
    }
    await expectNoFilesystemEffects(f);
  });

  it.each(['ordinary', 'persistent'] as const)('preserves real disk persistence in %s mode', async storage => {
    const f = await fixture(storage); const _index = await f.manager.getIndex();
    f.manager.startMemoryCleanup(1);
    if (storage === 'persistent') expect(f.interval).not.toHaveBeenCalled();
    else expect(f.interval).toHaveBeenCalled();
    await f.manager.addExtension('owned', { exact: 'persisted' }); await f.manager.persist();
    const onDisk = yamlLoad(await readFile(path.join(f.directory, 'capability-index.yaml'), 'utf8')) as typeof _index;
    expect(onDisk.extensions?.owned).toEqual({ exact: 'persisted' });
    expect(Object.keys(onDisk.elements.memories)).toEqual(['session-one', 'session-two']);
    expect(f.effects[3]).toHaveBeenCalled(); expect(f.effects[4]).toHaveBeenCalled();
    expect(await readFile(path.join(f.directory, 'bystander'), 'utf8')).toBe('preserve this exact sibling');
  });
});
