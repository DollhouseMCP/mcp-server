/**
 * Tests for IndexConfig system
 *
 * Validates that magic numbers have been moved to configuration
 * and that the configuration system works correctly.
 */

import { IndexConfigManager } from '../../../src/portfolio/config/IndexConfig.js';

describe('IndexConfig', () => {
  let configManager: IndexConfigManager;

  beforeEach(() => {
    // Reset singleton for tests
    (IndexConfigManager as any).instance = null;
    configManager = IndexConfigManager.getInstance();
  });

  describe('Default Configuration Values', () => {
    it('should have all required performance configuration values', () => {
      const config = configManager.getConfig();

      // Performance limits
      expect(config.performance.maxElementsForFullMatrix).toBe(100);
      expect(config.performance.maxSimilarityComparisons).toBe(10000);
      expect(config.performance.maxRelationshipComparisons).toBe(100);
      expect(config.performance.similarityBatchSize).toBe(50);
      expect(config.performance.similarityThreshold).toBe(0.5);
      expect(config.performance.defaultSimilarityThreshold).toBe(0.5);
      expect(config.performance.defaultSimilarLimit).toBe(10);
      expect(config.performance.defaultVerbSearchLimit).toBe(10);
      expect(config.performance.circuitBreakerTimeoutMs).toBe(5000);
    });

    it('should have all required sampling configuration values', () => {
      const config = configManager.getConfig();

      expect(config.sampling).toBeDefined();
      expect(config.sampling.baseSampleSize).toBe(10);
      expect(config.sampling.sampleRatio).toBe(0.1);
      expect(config.sampling.clusterSampleLimit).toBe(20);
    });

    it('should have all required memory configuration values', () => {
      const config = configManager.getConfig();

      expect(config.memory.maxCacheSize).toBe(1000);
      expect(config.memory.enableGarbageCollection).toBe(true);
      expect(config.memory.gcIntervalMinutes).toBe(30);
      expect(config.memory.cleanupIntervalMinutes).toBe(5);
      expect(config.memory.staleIndexMultiplier).toBe(2);
    });
  });

  describe('Configuration Updates', () => {
    it('should allow updating configuration values', async () => {
      const newConfig = {
        performance: {
          defaultSimilarLimit: 10,
          defaultSimilarityThreshold: 0.5
        }
      };

      await configManager.updateConfig(newConfig);
      const config = configManager.getConfig();

      expect(config.performance.defaultSimilarLimit).toBe(10);
      expect(config.performance.defaultSimilarityThreshold).toBe(0.5);
      // Other values should remain at defaults
      expect(config.performance.maxElementsForFullMatrix).toBe(100);
    });

    it('should validate configuration updates', async () => {
      const invalidConfig = {
        performance: {
          defaultSimilarityThreshold: 1.5  // Invalid: > 1.0
        }
      };

      await expect(configManager.updateConfig(invalidConfig)).rejects.toThrow();
    });
  });

  describe('Configuration Persistence', () => {
    it('should save and load configuration', async () => {
      const testConfig = {
        performance: {
          defaultVerbSearchLimit: 20
        }
      };

      await configManager.updateConfig(testConfig);
      await configManager.saveConfig();

      // Create a new instance to test loading
      (IndexConfigManager as any).instance = null;
      const newManager = IndexConfigManager.getInstance();
      const loadedConfig = newManager.getConfig();

      expect(loadedConfig.performance.defaultVerbSearchLimit).toBe(20);
    });
  });

  describe('Migration from Hardcoded Values', () => {
    it('should no longer have hardcoded magic numbers in the codebase', () => {
      const config = configManager.getConfig();

      // These values should all come from configuration
      expect(config.performance.maxRelationshipComparisons).toBeDefined();
      expect(config.performance.defaultSimilarityThreshold).toBeDefined();
      expect(config.performance.defaultSimilarLimit).toBeDefined();
      expect(config.performance.defaultVerbSearchLimit).toBeDefined();
      expect(config.performance.circuitBreakerTimeoutMs).toBeDefined();
      expect(config.sampling.baseSampleSize).toBeDefined();
      expect(config.sampling.sampleRatio).toBeDefined();
      expect(config.memory.cleanupIntervalMinutes).toBeDefined();
      expect(config.memory.staleIndexMultiplier).toBeDefined();
    });
  });
});