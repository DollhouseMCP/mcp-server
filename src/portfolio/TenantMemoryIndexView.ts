/** Dormant caller compatibility. No production registration or qualification authority. */
import path from 'node:path';
import { TenantMemoryOperationProvider, type BoundMemoryOperation } from '../storage/TenantMemoryOperationProvider.js';
import type { PathService } from '../paths/PathService.js';
import type { ConfigManager } from '../config/ConfigManager.js';
import type { FileOperationsService } from '../services/FileOperationsService.js';
import type { Memory, MemoryMetadata } from '../elements/memories/Memory.js';
import { PortfolioManager, ElementType } from './PortfolioManager.js';
import { PortfolioIndexManager, type IndexEntry } from './PortfolioIndexManager.js';
import { EnhancedIndexManager } from './EnhancedIndexManager.js';
import { UnifiedIndexManager, type UnifiedIndexManagerDependencies } from './UnifiedIndexManager.js';
import { IndexConfigManager } from './config/IndexConfig.js';
import { NLPScoringManager } from './NLPScoringManager.js';
import { VerbTriggerManager } from './VerbTriggerManager.js';
import { RelationshipManager } from './RelationshipManager.js';
import { DefaultEnhancedIndexHelpers } from './enhanced-index/EnhancedIndexHelpers.js';
import { ElementDefinitionBuilder } from './enhanced-index/ElementDefinitionBuilder.js';
import { SemanticRelationshipService } from './enhanced-index/SemanticRelationshipService.js';
import { ActionTriggerExtractor } from './enhanced-index/ActionTriggerExtractor.js';
import { TriggerMetricsTracker } from './enhanced-index/TriggerMetricsTracker.js';

export interface TenantMemoryIndexDependencies {
  readonly portfolioManager: PortfolioManager;
  readonly pathService: PathService;
  readonly indexConfig: IndexConfigManager;
  readonly config: ConfigManager;
  readonly fileOperations: FileOperationsService;
  /** Actual session-owned remote collaborators; no caller-selected tenant or cache. */
  readonly remote?: Omit<UnifiedIndexManagerDependencies, 'portfolioIndexManager' | 'resultCache' | 'indexCache'>;
}

/** One genuine selected manager and immutable original invocation, never a shared current field. */
export function bindTenantMemoryIndexView(provider: TenantMemoryOperationProvider,
  operation: BoundMemoryOperation, deps: TenantMemoryIndexDependencies) {
  if (!(provider instanceof TenantMemoryOperationProvider)) throw new TypeError('Actual memory provider required');
  const tenant = provider.getOperationTenant(operation);
  const namespace = deps.pathService.getUserElementDir(ElementType.PERSONA, tenant);
  const memoryNamespace = deps.pathService.getUserElementDir(ElementType.MEMORY, tenant);
  const indexPath = path.join(deps.pathService.getUserPortfolioDir(tenant), 'capability-index.yaml');
  const assertCurrent = () => {
    provider.assertOperation(operation);
    if (deps.portfolioManager.getElementDir(ElementType.PERSONA) !== namespace ||
      deps.portfolioManager.getElementDir(ElementType.MEMORY) !== memoryNamespace) {
      throw new Error('Memory index namespace binding changed');
    }
  };
  assertCurrent();
  const portfolioIndex = new PortfolioIndexManager(deps.indexConfig, deps.portfolioManager, deps.fileOperations, {
    namespace, assertCurrent,
    listEntries: async () => {
      assertCurrent();
      const memories = await operation.manager.list({ strictDatabase: true });
      assertCurrent();
      return memories.map(memory => memoryIndexEntry(memory, operation, assertCurrent));
    },
  });
  // Derived algorithm state belongs to this view, not another tenant's shared corpus/graph.
  const settings = deps.indexConfig.getConfig();
  const nlp = new NLPScoringManager({ cacheExpiry: settings.nlp.cacheExpiryMinutes * 60 * 1000,
    minTokenLength: settings.nlp.minTokenLength, entropyBands: settings.nlp.entropyBands,
    jaccardThresholds: settings.nlp.jaccardThresholds }, deps.indexConfig);
  let metrics: TriggerMetricsTracker | undefined;
  let enhancedIndex: EnhancedIndexManager | undefined;
  let unifiedIndex: UnifiedIndexManager | undefined;
  try {
    const verbs = new VerbTriggerManager({ confidenceThreshold: settings.verbs.confidenceThreshold,
      maxElementsPerVerb: settings.verbs.maxElementsPerVerb, includeSynonyms: settings.verbs.includeSynonyms });
    const relationships = new RelationshipManager({
      config: { minConfidence: deps.indexConfig.getConfig().performance.similarityThreshold, enableAutoDiscovery: true },
      indexConfigManager: deps.indexConfig, verbTriggerManager: verbs, nlpScoring: nlp,
    });
    const helpers = new DefaultEnhancedIndexHelpers(new ElementDefinitionBuilder(),
      new SemanticRelationshipService({ nlpScoring: nlp, relationshipManager: relationships }),
      context => new ActionTriggerExtractor(context), options => (metrics = new TriggerMetricsTracker(options)));
    enhancedIndex = new EnhancedIndexManager(deps.indexConfig, deps.config, portfolioIndex,
      nlp, verbs, relationships, helpers, deps.fileOperations, {
        storage: operation.manager.isGuardedHeadUpdateEnabled() ? 'memory' : 'persistent',
        namespace: indexPath, assertCurrent,
      });
    unifiedIndex = deps.remote ? new UnifiedIndexManager({ ...deps.remote, portfolioIndexManager: portfolioIndex,
      resultCache: undefined, indexCache: undefined, assertCurrent }) : undefined;
    const completedEnhanced = enhancedIndex;
    const completedUnified = unifiedIndex;
    return Object.freeze({ portfolioIndex, enhancedIndex: completedEnhanced, unifiedIndex: completedUnified, assertCurrent,
      dispose: async () => {
        try { await completedEnhanced.dispose(); }
        finally { completedUnified?.dispose(); nlp.dispose(); }
      },
    });
  } catch (cause) {
    enhancedIndex?.stopMemoryCleanup();
    metrics?.dispose();
    unifiedIndex?.dispose();
    nlp.dispose();
    throw cause;
  }
}

function memoryIndexEntry(memory: Memory, operation: BoundMemoryOperation, assertCurrent: () => void): IndexEntry {
  assertCurrent();
  const locator = operation.manager.getMemoryProbeToken(memory);
  if (!locator || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(locator)) {
    throw new Error('Persisted database memory locator required for index');
  }
  const metadata = memory.metadata as MemoryMetadata & { keywords?: unknown; category?: unknown };
  return { filePath: locator, filename: metadata.name, elementType: ElementType.MEMORY,
    lastModified: new Date(metadata.modified ?? metadata.created ?? 0),
    metadata: { name: metadata.name, description: metadata.description, version: metadata.version,
      author: metadata.author, tags: metadata.tags?.slice(), keywords: stringArray(metadata.keywords),
      triggers: metadata.triggers?.slice(), category: typeof metadata.category === 'string' ? metadata.category : undefined,
      created: metadata.created, updated: metadata.modified },
  };
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value.slice() : undefined;
}
