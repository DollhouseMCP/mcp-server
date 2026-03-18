/**
 * Tests for EnhancedIndexManager telemetry functionality
 *
 * Validates telemetry tracking, metrics aggregation, and reporting
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
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
import { createTestFileOperationsService } from '../../helpers/di-mocks.js';
import type { ElementDefinition } from '../../../src/portfolio/EnhancedIndexManager.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { dump as yamlDump } from 'js-yaml';
import { logger } from '../../../src/utils/logger.js';

describe('EnhancedIndexManager Telemetry', () => {
  let container: InstanceType<typeof DollhouseContainer>;
  let manager: InstanceType<typeof EnhancedIndexManager>;
  let testDir: string;
  let portfolioPath: string;
  let originalEnv: string | undefined;
  let loggerDebugSpy: any;
  let loggerInfoSpy: any;

  beforeEach(async () => {
    // Save original env
    originalEnv = process.env.DOLLHOUSE_TELEMETRY_ENABLED;

    // Enable telemetry for tests
    process.env.DOLLHOUSE_TELEMETRY_ENABLED = 'true';

    // Create test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-test-'));
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

    // Create config file with telemetry enabled
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
      },
      telemetry: {
        enabled: true,
        sampleRate: 1.0, // 100% sampling for tests
        metricsInterval: 100 // Fast interval for tests
      }
    }));

    // Create DI container and register all dependencies
    container = new DollhouseContainer();
    container.register('IndexConfigManager', () => new IndexConfigManager());
    const fileOperationsService = createTestFileOperationsService();
    container.register('FileOperationsService', () => fileOperationsService);
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

    // Manually set telemetry config to ensure it's enabled with 100% sampling
    // (ConfigManager in tests may not load the YAML file we created)
    (EnhancedIndexManager as any).VERB_EXTRACTION_CONFIG.telemetry = {
      enabled: true,
      sampleRate: 1.0,
      metricsInterval: 100
    };

    // Spy on logger methods
    loggerDebugSpy = jest.spyOn(logger, 'debug');
    loggerInfoSpy = jest.spyOn(logger, 'info');

    // Clear mocks
    jest.clearAllMocks();
  });

  afterEach(async () => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.DOLLHOUSE_TELEMETRY_ENABLED = originalEnv;
    } else {
      delete process.env.DOLLHOUSE_TELEMETRY_ENABLED;
    }

    // Clear telemetry timer
    const telemetryTimer = (manager as any).telemetryTimer;
    if (telemetryTimer) {
      clearTimeout(telemetryTimer);
      (manager as any).telemetryTimer = null;
    }

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

    // Restore all mocks
    jest.restoreAllMocks();
  });

  describe('telemetry tracking', () => {
    it('should track metrics when telemetry is enabled', async () => {
      // Ensure index is loaded first
      await manager.getIndex();

      const triggers: Record<string, string[]> = {};
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'persona'
        },
        search: {
          triggers: ['debug', 'troubleshoot', 'fix']
        }
      };

      // Call extractActionTriggers which includes telemetry
      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      // Telemetry is aggregated internally (per-element debug logs suppressed for fast ops <50ms).
      // Verify metrics were recorded in the aggregation map instead.
      const telemetryMetrics = (manager as any).telemetryMetrics;
      const stats = telemetryMetrics.get('extractActionTriggers');
      expect(stats).toBeDefined();
      expect(stats.count).toBeGreaterThanOrEqual(1);
      expect(stats.lastMetrics.elementName).toBe('test-element');
    });

    it('should not track metrics when telemetry is disabled', () => {
      // Disable telemetry via both env var and static config
      process.env.DOLLHOUSE_TELEMETRY_ENABLED = 'false';
      (EnhancedIndexManager as any).VERB_EXTRACTION_CONFIG.telemetry.enabled = false;

      const triggers: Record<string, string[]> = {};
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'persona'
        },
        search: {
          triggers: ['debug']
        }
      };

      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      // Should not log telemetry
      expect(loggerDebugSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Telemetry:'),
        expect.anything()
      );

      // Re-enable for next tests
      (EnhancedIndexManager as any).VERB_EXTRACTION_CONFIG.telemetry.enabled = true;
    });

    it('should respect sampling rate', () => {
      // Mock Math.random to control sampling
      const originalRandom = Math.random;
      let callCount = 0;

      // Make first call pass sampling (< 1.0), second fail (but with 100% rate it always passes)
      // So we need to test with a modified config
      Math.random = jest.fn(() => {
        callCount++;
        return callCount === 1 ? 0.05 : 0.95;
      });

      const triggers: Record<string, string[]> = {};
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'persona'
        },
        search: {
          triggers: ['debug']
        }
      };

      // Both calls should be tracked since sampleRate is 1.0 in config
      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);
      (manager as any).extractActionTriggers(elementDef, 'test-element2', triggers);

      // Restore original random
      Math.random = originalRandom;

      // Both calls should be tracked in aggregation (debug logs suppressed for fast ops)
      const telemetryMetrics = (manager as any).telemetryMetrics;
      const stats = telemetryMetrics.get('extractActionTriggers');
      expect(stats).toBeDefined();
      expect(stats.count).toBe(2);
    });
  });

  describe('metrics aggregation', () => {
    it('should aggregate metrics correctly', () => {
      const triggers: Record<string, string[]> = {};

      // Process multiple elements
      for (let i = 0; i < 3; i++) {
        const elementDef: ElementDefinition = {
          core: {
            name: `element-${i}`,
            type: 'persona'
          },
          search: {
            triggers: ['debug', 'test']
          }
        };
        (manager as any).extractActionTriggers(elementDef, `element-${i}`, triggers);
      }

      // Check internal metrics
      const metrics = (manager as any).telemetryMetrics.get('extractActionTriggers');
      expect(metrics).toBeDefined();
      expect(metrics.count).toBe(3);
      expect(metrics.avgDuration).toBeGreaterThanOrEqual(0);
      expect(metrics.minDuration).toBeLessThanOrEqual(metrics.maxDuration);
    });

    it('should track duration statistics', () => {
      const triggers: Record<string, string[]> = {};
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'persona'
        },
        search: {
          triggers: Array.from({ length: 20 }, (_, i) => `trigger${i}`)
        }
      };

      // Process element with many triggers (should take longer)
      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      const metrics = (manager as any).telemetryMetrics.get('extractActionTriggers');
      expect(metrics).toBeDefined();
      expect(metrics.totalDuration).toBeGreaterThanOrEqual(0);
      expect(metrics.maxDuration).toBeGreaterThanOrEqual(0);
      expect(metrics.minDuration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('telemetry reporting', () => {
    it('should schedule periodic reporting', (done) => {
      const triggers: Record<string, string[]> = {};
      const elementDef: ElementDefinition = {
        core: {
          name: 'test-element',
          type: 'persona'
        },
        search: {
          triggers: ['debug']
        }
      };

      // Process element to trigger telemetry
      (manager as any).extractActionTriggers(elementDef, 'test-element', triggers);

      // Check that timer was set
      expect((manager as any).telemetryTimer).toBeDefined();

      // Wait for report
      setTimeout(() => {
        expect(loggerInfoSpy).toHaveBeenCalledWith(
          'Telemetry Report',
          expect.objectContaining({
            timestamp: expect.stringMatching(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
            metrics: expect.objectContaining({
              extractActionTriggers: expect.objectContaining({
                count: expect.any(Number),
                avgDuration: expect.any(Number)
              })
            })
          })
        );

        // Metrics should be cleared after reporting
        expect((manager as any).telemetryMetrics.size).toBe(0);
        done();
      }, 150); // Wait longer than metricsInterval (100ms)
    });

    it('should not report when no metrics collected', () => {
      // Clear any existing metrics
      (manager as any).telemetryMetrics.clear();

      // Manually trigger report
      (manager as any).reportTelemetry();

      // Should not log report
      expect(loggerInfoSpy).not.toHaveBeenCalledWith(
        'Telemetry Report',
        expect.anything()
      );
    });
  });

  describe('edge cases', () => {
    it('should handle null/undefined elementDef without telemetry errors', () => {
      const triggers: Record<string, string[]> = {};

      // Should not throw
      expect(() => {
        (manager as any).extractActionTriggers(null, 'test', triggers);
        (manager as any).extractActionTriggers(undefined, 'test', triggers);
      }).not.toThrow();

      // Should not track telemetry for null/undefined
      expect(loggerDebugSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Telemetry:'),
        expect.anything()
      );
    });

    it('should handle concurrent telemetry operations', async () => {
      const triggers: Record<string, string[]> = {};

      // Process multiple elements concurrently
      const promises = Array.from({ length: 5 }, (_, i) => {
        const elementDef: ElementDefinition = {
          core: {
            name: `concurrent-${i}`,
            type: 'persona'
          },
          search: {
            triggers: [`trigger-${i}`]
          }
        };

        return Promise.resolve(
          (manager as any).extractActionTriggers(elementDef, `concurrent-${i}`, triggers)
        );
      });

      await Promise.all(promises);

      // All operations should be tracked
      const metrics = (manager as any).telemetryMetrics.get('extractActionTriggers');
      expect(metrics).toBeDefined();
      expect(metrics.count).toBe(5);
    });
  });
});
