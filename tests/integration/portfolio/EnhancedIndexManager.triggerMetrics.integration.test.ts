/**
 * Integration tests for trigger usage metrics functionality in EnhancedIndexManager
 *
 * Tests trigger tracking, persistence, and metrics across real filesystem operations
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EnhancedIndexManager } from '../../../src/portfolio/EnhancedIndexManager.js';
import { IndexConfigManager } from '../../../src/portfolio/config/IndexConfig.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { PortfolioIndexManager } from '../../../src/portfolio/PortfolioIndexManager.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { NLPScoringManager } from '../../../src/portfolio/NLPScoringManager.js';
import { VerbTriggerManager } from '../../../src/portfolio/VerbTriggerManager.js';
import { RelationshipManager } from '../../../src/portfolio/RelationshipManager.js';
import { DefaultEnhancedIndexHelpers } from '../../../src/portfolio/enhanced-index/EnhancedIndexHelpers.js';
import { ElementDefinitionBuilder } from '../../../src/portfolio/enhanced-index/ElementDefinitionBuilder.js';
import { SemanticRelationshipService } from '../../../src/portfolio/enhanced-index/SemanticRelationshipService.js';
import { ActionTriggerExtractor } from '../../../src/portfolio/enhanced-index/ActionTriggerExtractor.js';
import { TriggerMetricsTracker } from '../../../src/portfolio/enhanced-index/TriggerMetricsTracker.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { dump as yamlDump } from 'js-yaml';

describe('EnhancedIndexManager - Trigger Metrics Integration', () => {
  let container: InstanceType<typeof DollhouseContainer>;
  let manager: InstanceType<typeof EnhancedIndexManager>;
  let testDir: string;
  let portfolioPath: string;

  beforeEach(async () => {
    // Create test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trigger-metrics-test-'));
    process.env.HOME = testDir;

    // Set up portfolio directory structure
    portfolioPath = path.join(testDir, '.dollhouse', 'portfolio');
    const testIndexPath = path.join(portfolioPath, 'capability-index.yaml');

    // Create subdirectories for element types
    await fs.mkdir(path.join(portfolioPath, 'personas'), { recursive: true });
    await fs.mkdir(path.join(portfolioPath, 'skills'), { recursive: true });
    await fs.mkdir(path.join(portfolioPath, 'templates'), { recursive: true });
    await fs.mkdir(path.join(portfolioPath, 'agents'), { recursive: true });
    await fs.mkdir(path.join(portfolioPath, 'memories'), { recursive: true });
    await fs.mkdir(path.join(portfolioPath, 'ensembles'), { recursive: true });

    // Create a minimal portfolio index
    const portfolioIndexPath = path.join(portfolioPath, 'index.json');
    await fs.writeFile(portfolioIndexPath, JSON.stringify({
      version: '1.0.0',
      entries: [],
      metadata: {
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
      }
    }));

    // Create a pre-built capability index
    const minimalIndex = {
      version: '2.0.0',
      metadata: {
        version: '2.0.0',
        created: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        total_elements: 0
      },
      action_triggers: {},
      elements: {},
      context: {
        recent_elements: [],
        session_patterns: {}
      },
      scoring: {
        corpus_stats: {
          total_documents: 0,
          average_length: 0
        }
      }
    };

    await fs.writeFile(testIndexPath, yamlDump(minimalIndex));

    // Create test element files with triggers that tests will use
    const testElements = [
      { type: 'personas', name: 'debug-helper', triggers: ['debug', 'troubleshoot'] },
      { type: 'skills', name: 'test-runner', triggers: ['test', 'validate'] },
      { type: 'skills', name: 'analyzer', triggers: ['analyze'] },
      { type: 'templates', name: 'creator', triggers: ['create', 'generate'] },
      { type: 'agents', name: 'optimizer', triggers: ['optimize'] },
      { type: 'personas', name: 'common-helper', triggers: ['common'] },
      { type: 'skills', name: 'medium-task', triggers: ['medium'] },
      { type: 'templates', name: 'rare-use', triggers: ['rare'] }
    ];

    for (const elem of testElements) {
      const elemContent = `---
name: ${elem.name}
type: ${elem.type.slice(0, -1)}
version: 1.0.0
description: Test element for trigger metrics
search:
  triggers:
${elem.triggers.map(t => `    - ${t}`).join('\n')}
---

# ${elem.name}

Test element content.
`;
      await fs.writeFile(
        path.join(portfolioPath, elem.type, `${elem.name}.md`),
        elemContent,
        'utf8'
      );
    }

    // Create config file
    const configPath = path.join(portfolioPath, 'config', 'enhanced-index.yaml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, yamlDump({
      index: {
        ttlMinutes: 5,
        version: '2.0.0'
      },
      performance: {
        similarityThreshold: 0.3,
        maxElementsForFullMatrix: 100
      }
    }));

    // Create DI container and register all dependencies
    container = new DollhouseContainer();
    container.register('IndexConfigManager', () => new IndexConfigManager());
    container.register('FileOperationsService', () => new FileOperationsService(container.resolve('FileLockManager')));
    container.register('ConfigManager', () => new ConfigManager(
      container.resolve('FileOperationsService'),
      os
    ));
    container.register('PortfolioManager', () => new PortfolioManager(container.resolve('FileOperationsService'), { baseDir: portfolioPath }));
    container.register('PortfolioIndexManager', () => new PortfolioIndexManager(
      container.resolve('IndexConfigManager'),
      container.resolve('PortfolioManager'),
      container.resolve('FileOperationsService')
    ));
    container.register('NLPScoringManager', () => new NLPScoringManager(
      container.resolve('IndexConfigManager')
    ));
    container.register('VerbTriggerManager', () => new VerbTriggerManager(
      container.resolve('IndexConfigManager')
    ));
    container.register('RelationshipManager', () => new RelationshipManager(
      container.resolve('IndexConfigManager')
    ));
    container.register('EnhancedIndexHelpers', () => new DefaultEnhancedIndexHelpers(
      new ElementDefinitionBuilder(),
      new SemanticRelationshipService({
        nlpScoring: container.resolve('NLPScoringManager'),
        relationshipManager: container.resolve('RelationshipManager')
      }),
      (context) => new ActionTriggerExtractor(context),
      (options) => new TriggerMetricsTracker(options)
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

    // Resolve manager from container
    manager = container.resolve('EnhancedIndexManager');
  });

  afterEach(async () => {
    // Cleanup manager
    if (manager) {
      try {
        await manager.cleanup();
      } catch (_e) {
        // Ignore cleanup errors
      }
    }

    // Dispose container
    await container.dispose();

    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('trackTriggerUsage', () => {
    it('should track trigger usage when getElementsByAction is called', async () => {
      // Call getElementsByAction multiple times (index will be built automatically)
      await manager.getElementsByAction('debug');
      await manager.getElementsByAction('debug');
      await manager.getElementsByAction('test');

      // Flush metrics batch (metrics are batched for performance)
      await (manager as any).flushMetricsBatch();

      // Get metrics
      const metrics = await manager.getTriggerMetrics();

      // Find the debug metric
      const debugMetric = metrics.find(m => m.trigger === 'debug');
      const testMetric = metrics.find(m => m.trigger === 'test');

      expect(debugMetric).toBeDefined();
      expect(debugMetric?.usage_count).toBe(2);
      expect(testMetric).toBeDefined();
      expect(testMetric?.usage_count).toBe(1);
    });

    it('should persist trigger metrics across instance reloads', async () => {
      // Track usage (index will be built automatically)
      await manager.getElementsByAction('analyze');
      await manager.getElementsByAction('analyze');
      await manager.getElementsByAction('analyze');

      // Flush metrics batch (metrics are batched for performance)
      await (manager as any).flushMetricsBatch();

      // Cleanup current manager
      await manager.cleanup();
      await container.dispose();

      // Create new container and manager to simulate reload
      const newContainer = new DollhouseContainer();
      newContainer.register('IndexConfigManager', () => new IndexConfigManager());
      newContainer.register('FileOperationsService', () => new FileOperationsService(newContainer.resolve('FileLockManager')));
      newContainer.register('ConfigManager', () => new ConfigManager(newContainer.resolve('FileOperationsService'), os));
      newContainer.register('PortfolioManager', () => new PortfolioManager(newContainer.resolve('FileOperationsService'), { baseDir: portfolioPath }));
      newContainer.register('PortfolioIndexManager', () => new PortfolioIndexManager(
        newContainer.resolve('IndexConfigManager'),
        newContainer.resolve('PortfolioManager'),
        newContainer.resolve('FileOperationsService')
      ));
      newContainer.register('NLPScoringManager', () => new NLPScoringManager(
        newContainer.resolve('IndexConfigManager')
      ));
      newContainer.register('VerbTriggerManager', () => new VerbTriggerManager(
        newContainer.resolve('IndexConfigManager')
      ));
      newContainer.register('RelationshipManager', () => new RelationshipManager(
        newContainer.resolve('IndexConfigManager')
      ));
      newContainer.register('EnhancedIndexHelpers', () => new DefaultEnhancedIndexHelpers(
        new ElementDefinitionBuilder(),
        new SemanticRelationshipService({
          nlpScoring: newContainer.resolve('NLPScoringManager'),
          relationshipManager: newContainer.resolve('RelationshipManager')
        }),
        (context) => new ActionTriggerExtractor(context),
        (options) => new TriggerMetricsTracker(options)
      ));
      newContainer.register('EnhancedIndexManager', () => new EnhancedIndexManager(
        newContainer.resolve('IndexConfigManager'),
        newContainer.resolve('ConfigManager'),
        newContainer.resolve('PortfolioIndexManager'),
        newContainer.resolve('NLPScoringManager'),
        newContainer.resolve('VerbTriggerManager'),
        newContainer.resolve('RelationshipManager'),
        newContainer.resolve('EnhancedIndexHelpers'),
        newContainer.resolve('FileOperationsService')
      ));

      const newManager = newContainer.resolve('EnhancedIndexManager');

      // Get metrics from new instance
      const metrics = await newManager.getTriggerMetrics();
      const analyzeMetric = metrics.find(m => m.trigger === 'analyze');

      expect(analyzeMetric).toBeDefined();
      expect(analyzeMetric?.usage_count).toBe(3);

      // Cleanup
      await newManager.cleanup();
      await newContainer.dispose();

      // Restore original container reference
      container = newContainer;
      manager = newManager;
    });

    it('should track daily usage patterns', async () => {
      // Track usage (index will be built automatically)
      await manager.getElementsByAction('create');

      // Flush metrics batch (metrics are batched for performance)
      await (manager as any).flushMetricsBatch();

      // Get metrics
      const metrics = await manager.getTriggerMetrics();
      const createMetric = metrics.find(m => m.trigger === 'create');

      expect(createMetric).toBeDefined();
      expect(createMetric?.daily_average).toBeGreaterThan(0);
      expect(createMetric?.first_used).toBeDefined();
      expect(createMetric?.last_used).toBeDefined();
    });

    it('should calculate usage trends', async () => {
      // Track usage multiple times (index will be built automatically)
      for (let i = 0; i < 5; i++) {
        await manager.getElementsByAction('optimize');
      }

      // Flush metrics batch (metrics are batched for performance)
      await (manager as any).flushMetricsBatch();

      // Get metrics
      const metrics = await manager.getTriggerMetrics();
      const optimizeMetric = metrics.find(m => m.trigger === 'optimize');

      expect(optimizeMetric).toBeDefined();
      expect(optimizeMetric?.trend).toBeDefined();
      expect(['increasing', 'stable', 'decreasing']).toContain(optimizeMetric?.trend);
    });

    it('should sort triggers by usage frequency', async () => {
      // Create usage pattern (index will be built automatically)
      await manager.getElementsByAction('common');
      await manager.getElementsByAction('common');
      await manager.getElementsByAction('common');
      await manager.getElementsByAction('medium');
      await manager.getElementsByAction('medium');
      await manager.getElementsByAction('rare');

      // Flush metrics batch (metrics are batched for performance)
      await (manager as any).flushMetricsBatch();

      // Get metrics
      const metrics = await manager.getTriggerMetrics();

      // Verify sorting
      const indices = {
        common: metrics.findIndex(m => m.trigger === 'common'),
        medium: metrics.findIndex(m => m.trigger === 'medium'),
        rare: metrics.findIndex(m => m.trigger === 'rare')
      };

      // Common should come before medium, medium before rare
      if (indices.common !== -1 && indices.medium !== -1) {
        expect(indices.common).toBeLessThan(indices.medium);
      }
      if (indices.medium !== -1 && indices.rare !== -1) {
        expect(indices.medium).toBeLessThan(indices.rare);
      }
    });

    it('should handle metrics when no usage data exists', async () => {
      // Get metrics without any usage (index will be built automatically)
      const metrics = await manager.getTriggerMetrics();

      // Should return empty array or array with 0 counts
      expect(metrics).toBeDefined();
      expect(Array.isArray(metrics)).toBe(true);
    });

    it('should clean up old daily usage data (>30 days)', async () => {
      // Get index (will be built automatically) and inject old usage data
      const index = await manager.getIndex();

      if (!index.metadata.trigger_metrics) {
        index.metadata.trigger_metrics = {
          usage_count: {},
          last_used: {},
          first_used: {},
          daily_usage: {}
        };
      }

      // Add old date entry (35 days ago)
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 35);
      const oldDateStr = oldDate.toISOString().split('T')[0];
      index.metadata.trigger_metrics.daily_usage[oldDateStr] = { test: 5 };

      // Add recent date entry (today)
      const recentDate = new Date();
      const recentDateStr = recentDate.toISOString().split('T')[0];
      index.metadata.trigger_metrics.daily_usage[recentDateStr] = { test: 3 };

      // Save index
      await (manager as any).writeToFile(index);

      // Trigger cleanup by tracking new usage
      await manager.getElementsByAction('test');

      // Flush metrics batch to trigger cleanup (metrics are batched for performance)
      await (manager as any).flushMetricsBatch();

      // Reload and check
      const updatedIndex = await manager.getIndex();
      const dailyUsage = updatedIndex.metadata.trigger_metrics.daily_usage;

      // Old date should be removed
      expect(dailyUsage[oldDateStr]).toBeUndefined();
      // Recent date should remain
      expect(dailyUsage[recentDateStr]).toBeDefined();
    });
  });

  describe('getTriggerMetrics', () => {
    it('should return empty array when no metrics exist', async () => {
      // Get metrics without usage (index will be built automatically)
      const metrics = await manager.getTriggerMetrics();
      expect(metrics).toEqual([]);
    });

    it('should include all required fields in metrics', async () => {
      // Track usage (index will be built automatically)
      await manager.getElementsByAction('validate');

      // Flush metrics batch (metrics are batched for performance)
      await (manager as any).flushMetricsBatch();

      const metrics = await manager.getTriggerMetrics();
      const validateMetric = metrics.find(m => m.trigger === 'validate');

      expect(validateMetric).toBeDefined();
      expect(validateMetric).toHaveProperty('trigger');
      expect(validateMetric).toHaveProperty('usage_count');
      expect(validateMetric).toHaveProperty('last_used');
      expect(validateMetric).toHaveProperty('first_used');
      expect(validateMetric).toHaveProperty('daily_average');
      expect(validateMetric).toHaveProperty('trend');
    });
  });
});
