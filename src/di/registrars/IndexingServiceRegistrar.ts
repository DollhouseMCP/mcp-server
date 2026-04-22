/**
 * IndexingServiceRegistrar
 *
 * Owns the DI wiring for portfolio indexing, NLP scoring, relationship
 * management, and portfolio sync services. These services work together
 * to maintain the enhanced search index and keep local portfolios in sync
 * with remote repositories.
 *
 * Responsibilities:
 * - NLPScoringManager, VerbTriggerManager, RelationshipManager
 * - PortfolioIndexManager, EnhancedIndexHelpers, EnhancedIndexManager
 * - CollectionIndexCache, UnifiedIndexManager
 * - PortfolioSyncComparer, PortfolioDownloader
 * - PortfolioPullHandler, SubmitToPortfolioTool, PortfolioSyncManager
 *
 * @module di/registrars/IndexingServiceRegistrar
 */

import { APICache } from '../../cache/index.js';
import { CollectionIndexCache } from '../../cache/index.js';
import { NLPScoringManager } from '../../portfolio/NLPScoringManager.js';
import { VerbTriggerManager } from '../../portfolio/VerbTriggerManager.js';
import { RelationshipManager } from '../../portfolio/RelationshipManager.js';
import { PortfolioIndexManager } from '../../portfolio/PortfolioIndexManager.js';
import { EnhancedIndexManager } from '../../portfolio/EnhancedIndexManager.js';
import { DefaultEnhancedIndexHelpers } from '../../portfolio/enhanced-index/EnhancedIndexHelpers.js';
import { ElementDefinitionBuilder } from '../../portfolio/enhanced-index/ElementDefinitionBuilder.js';
import { ActionTriggerExtractor } from '../../portfolio/enhanced-index/ActionTriggerExtractor.js';
import { TriggerMetricsTracker } from '../../portfolio/enhanced-index/TriggerMetricsTracker.js';
import { SemanticRelationshipService } from '../../portfolio/enhanced-index/SemanticRelationshipService.js';
import { UnifiedIndexManager } from '../../portfolio/UnifiedIndexManager.js';
import { PortfolioSyncComparer } from '../../sync/PortfolioSyncComparer.js';
import { PortfolioDownloader } from '../../sync/PortfolioDownloader.js';
import { PortfolioPullHandler } from '../../handlers/PortfolioPullHandler.js';
import { SubmitToPortfolioTool } from '../../tools/portfolio/submitToPortfolioTool.js';
import { PortfolioSyncManager } from '../../portfolio/PortfolioSyncManager.js';
import { getTriggerMetricsLogListener } from '../../logging/LogHooks.js';
import type { IndexConfigManager } from '../../portfolio/config/IndexConfig.js';
import type { DiContainerFacade } from '../DiContainerFacade.js';

export class IndexingServiceRegistrar {
  public register(container: DiContainerFacade): void {
    // NLP & INDEXING
    container.register('NLPScoringManager', () => {
      const indexConfigManager = container.resolve<IndexConfigManager>('IndexConfigManager');
      const config = indexConfigManager.getConfig();
      return new NLPScoringManager({
        cacheExpiry: config.nlp.cacheExpiryMinutes * 60 * 1000,
        minTokenLength: config.nlp.minTokenLength,
        entropyBands: config.nlp.entropyBands,
        jaccardThresholds: config.nlp.jaccardThresholds
      }, indexConfigManager);
    });

    container.register('VerbTriggerManager', () => {
      const indexConfigManager = container.resolve<IndexConfigManager>('IndexConfigManager');
      const config = indexConfigManager.getConfig();
      return new VerbTriggerManager({
        confidenceThreshold: config.verbs.confidenceThreshold,
        maxElementsPerVerb: config.verbs.maxElementsPerVerb,
        includeSynonyms: config.verbs.includeSynonyms
      });
    });

    container.register('RelationshipManager', () => {
      const indexConfigManager = container.resolve<IndexConfigManager>('IndexConfigManager');
      const config = indexConfigManager.getConfig();
      return new RelationshipManager({
        config: {
          minConfidence: config.performance.similarityThreshold,
          enableAutoDiscovery: true
        },
        indexConfigManager,
        verbTriggerManager: container.resolve('VerbTriggerManager'),
        nlpScoring: container.resolve('NLPScoringManager'),
      });
    });

    container.register('PortfolioIndexManager', () => new PortfolioIndexManager(
      container.resolve('IndexConfigManager'),
      container.resolve('PortfolioManager'),
      container.resolve('FileOperationsService')
    ));

    container.register('EnhancedIndexHelpers', () => new DefaultEnhancedIndexHelpers(
      new ElementDefinitionBuilder(),
      new SemanticRelationshipService({
        nlpScoring: container.resolve('NLPScoringManager'),
        relationshipManager: container.resolve('RelationshipManager')
      }),
      (context) => new ActionTriggerExtractor(context),
      (options) => {
        const tracker = new TriggerMetricsTracker(options);
        try {
          tracker.addLogListener(getTriggerMetricsLogListener(
            container.resolve('LogManager'),
            container.resolve('ContextTracker')
          ));
        } catch { /* LogManager not yet registered */ }
        return tracker;
      }
    ));

    container.register('EnhancedIndexManager', () => new EnhancedIndexManager(
      container.resolve('IndexConfigManager'),
      container.resolve('ConfigManager'),
      container.resolve('PortfolioIndexManager'),
      container.resolve('NLPScoringManager'),
      container.resolve('VerbTriggerManager'),
      container.resolve('RelationshipManager'),
      container.resolve('EnhancedIndexHelpers'),
      container.resolve('FileOperationsService')
    ));

    container.register('CollectionIndexCache', () => new CollectionIndexCache(
      container.resolve('GitHubClient'),
      process.cwd(),
      container.resolve('PerformanceMonitor'),
      container.resolve('FileOperationsService')
    ));

    container.register('UnifiedIndexManager', () => new UnifiedIndexManager({
      portfolioIndexManager: container.resolve('PortfolioIndexManager'),
      githubIndexer: container.resolve('GitHubPortfolioIndexer'),
      collectionIndexCache: container.resolve('CollectionIndexCache'),
      githubClient: container.resolve('GitHubClient'),
      apiCache: container.resolve<APICache>('APICache'),
      rateLimitTracker: container.resolve('RateLimitTracker'),
      performanceMonitor: container.resolve('PerformanceMonitor'),
      fileOperations: container.resolve('FileOperationsService')
    }));

    container.register('PortfolioSyncComparer', () => new PortfolioSyncComparer());
    container.register('PortfolioDownloader', () => new PortfolioDownloader());

    // SYNC & TOOLS
    container.register('PortfolioPullHandler', () => new PortfolioPullHandler({
      portfolioManager: container.resolve('PortfolioManager'),
      indexManager: container.resolve('PortfolioIndexManager'),
      githubIndexer: container.resolve('GitHubPortfolioIndexer'),
      portfolioRepoManager: container.resolve('PortfolioRepoManager'),
      syncComparer: container.resolve('PortfolioSyncComparer'),
      downloader: container.resolve('PortfolioDownloader'),
      fileOperations: container.resolve('FileOperationsService'),
      tokenManager: container.resolve('TokenManager'),
    }));

    container.register('SubmitToPortfolioTool', () => new SubmitToPortfolioTool(container.resolve<APICache>('APICache'), {
      authManager: container.resolve('GitHubAuthManager'),
      portfolioManager: container.resolve('PortfolioManager'),
      portfolioIndexManager: container.resolve('PortfolioIndexManager'),
      portfolioRepoManager: container.resolve('PortfolioRepoManager'),
      rateLimiter: container.resolve('GitHubRateLimiter'),
      fileOperations: container.resolve('FileOperationsService'),
      tokenManager: container.resolve('TokenManager')
    }));

    container.register('PortfolioSyncManager', () => new PortfolioSyncManager({
      configManager: container.resolve('ConfigManager'),
      portfolioManager: container.resolve('PortfolioManager'),
      portfolioRepoManager: container.resolve('PortfolioRepoManager'),
      indexer: container.resolve('GitHubPortfolioIndexer'),
      fileOperations: container.resolve('FileOperationsService'),
      tokenManager: container.resolve('TokenManager')
    }));
  }
}
