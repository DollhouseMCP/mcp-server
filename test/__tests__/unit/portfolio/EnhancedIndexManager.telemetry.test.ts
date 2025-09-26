/**
 * Tests for EnhancedIndexManager telemetry functionality
 *
 * Validates telemetry tracking, metrics aggregation, and reporting
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Mock modules before importing
jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

jest.unstable_mockModule('../../../../src/config/ConfigManager.js', () => ({
  ConfigManager: {
    getInstance: jest.fn(() => ({
      getConfig: jest.fn(() => ({
        elements: {
          enhanced_index: {
            enabled: true,
            limits: {
              maxTriggersPerElement: 50,
              maxTriggerLength: 50,
              maxKeywordsToCheck: 100
            },
            telemetry: {
              enabled: true,
              sampleRate: 1.0, // 100% sampling for tests
              metricsInterval: 100 // Fast interval for tests
            }
          }
        }
      }))
    }))
  }
}));

const { logger } = await import('../../../../src/utils/logger.js');
const { EnhancedIndexManager } = await import('../../../../src/portfolio/EnhancedIndexManager.js');
type ElementDefinition = import('../../../../src/portfolio/EnhancedIndexManager.js').ElementDefinition;

describe('EnhancedIndexManager Telemetry', () => {
  let manager: any;
  let originalEnv: string | undefined;

  beforeEach(() => {
    // Save original env
    originalEnv = process.env.DOLLHOUSE_TELEMETRY_ENABLED;

    // Enable telemetry for tests
    process.env.DOLLHOUSE_TELEMETRY_ENABLED = 'true';

    // Get manager instance
    manager = EnhancedIndexManager.getInstance();

    // Clear mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.DOLLHOUSE_TELEMETRY_ENABLED = originalEnv;
    } else {
      delete process.env.DOLLHOUSE_TELEMETRY_ENABLED;
    }

    // Clear telemetry timer
    if (manager.telemetryTimer) {
      clearTimeout(manager.telemetryTimer);
      manager.telemetryTimer = null;
    }
  });

  describe('telemetry tracking', () => {
    it('should track metrics when telemetry is enabled', () => {
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
      manager.extractActionTriggers(elementDef, 'test-element', triggers);

      // Should log telemetry data
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Telemetry:'),
        expect.objectContaining({
          duration: expect.any(Number),
          elementName: 'test-element',
          elementType: 'persona',
          triggersExtracted: 3,
          uniqueTriggers: 3
        })
      );
    });

    it('should not track metrics when telemetry is disabled', () => {
      // Disable telemetry
      process.env.DOLLHOUSE_TELEMETRY_ENABLED = 'false';

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

      manager.extractActionTriggers(elementDef, 'test-element', triggers);

      // Should not log telemetry
      expect(logger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('Telemetry:'),
        expect.anything()
      );
    });

    it('should respect sampling rate', () => {
      // Mock Math.random to control sampling
      const originalRandom = Math.random;
      let callCount = 0;

      // Make first call pass sampling (< 0.1), rest fail
      Math.random = jest.fn(() => {
        callCount++;
        return callCount === 1 ? 0.05 : 0.5;
      });

      // Create a new manager with low sample rate
      jest.replaceProperty(manager, 'isTelemetryEnabled', () => true);

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

      // First call should be tracked (random = 0.05 < 0.1)
      manager.extractActionTriggers(elementDef, 'test-element', triggers);

      // Second call should not be tracked (random = 0.5 > 0.1)
      manager.extractActionTriggers(elementDef, 'test-element2', triggers);

      // Restore original random
      Math.random = originalRandom;

      // Only first call should be tracked
      expect(logger.debug).toHaveBeenCalledTimes(1);
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
        manager.extractActionTriggers(elementDef, `element-${i}`, triggers);
      }

      // Check internal metrics
      const metrics = manager.telemetryMetrics.get('extractActionTriggers');
      expect(metrics).toBeDefined();
      expect(metrics.count).toBe(3);
      expect(metrics.avgDuration).toBeGreaterThan(0);
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
      manager.extractActionTriggers(elementDef, 'test-element', triggers);

      const metrics = manager.telemetryMetrics.get('extractActionTriggers');
      expect(metrics).toBeDefined();
      expect(metrics.totalDuration).toBeGreaterThan(0);
      expect(metrics.maxDuration).toBeGreaterThan(0);
      expect(metrics.minDuration).toBeGreaterThan(0);
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
      manager.extractActionTriggers(elementDef, 'test-element', triggers);

      // Check that timer was set
      expect(manager.telemetryTimer).toBeDefined();

      // Wait for report
      setTimeout(() => {
        expect(logger.info).toHaveBeenCalledWith(
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
        expect(manager.telemetryMetrics.size).toBe(0);
        done();
      }, 150); // Wait longer than metricsInterval (100ms)
    });

    it('should not report when no metrics collected', (done) => {
      // Clear any existing metrics
      manager.telemetryMetrics.clear();

      // Manually trigger report
      manager.reportTelemetry();

      // Should not log report
      expect(logger.info).not.toHaveBeenCalledWith(
        'Telemetry Report',
        expect.anything()
      );

      done();
    });
  });

  describe('telemetry configuration', () => {
    it('should load telemetry config from ConfigManager', () => {
      // Config should be loaded in constructor
      expect(manager.constructor.VERB_EXTRACTION_CONFIG.telemetry).toEqual({
        enabled: true,
        sampleRate: 1.0,
        metricsInterval: 100
      });
    });

    it('should handle missing telemetry config gracefully', () => {
      // Mock ConfigManager to return no enhanced_index config
      const { ConfigManager } = require('../../../../src/config/ConfigManager.js');
      ConfigManager.getInstance.mockReturnValue({
        getConfig: jest.fn(() => ({
          elements: {}
        }))
      });

      // Should not throw
      expect(() => {
        manager.loadEnhancedIndexConfig();
      }).not.toThrow();

      // Should log warning
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load enhanced index configuration'),
        expect.anything()
      );
    });
  });

  describe('edge cases', () => {
    it('should handle null/undefined elementDef without telemetry errors', () => {
      const triggers: Record<string, string[]> = {};

      // Should not throw
      expect(() => {
        manager.extractActionTriggers(null, 'test', triggers);
        manager.extractActionTriggers(undefined, 'test', triggers);
      }).not.toThrow();

      // Should not track telemetry for null/undefined
      expect(logger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('Telemetry:'),
        expect.anything()
      );
    });

    it('should handle concurrent telemetry operations', () => {
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
          manager.extractActionTriggers(elementDef, `concurrent-${i}`, triggers)
        );
      });

      return Promise.all(promises).then(() => {
        // All operations should be tracked
        const metrics = manager.telemetryMetrics.get('extractActionTriggers');
        expect(metrics).toBeDefined();
        expect(metrics.count).toBe(5);
      });
    });
  });
});