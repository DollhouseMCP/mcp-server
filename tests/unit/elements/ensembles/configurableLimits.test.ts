/**
 * Unit tests for configurable ensemble limits (Issue #368)
 *
 * Tests environment variable support, global configuration, and per-ensemble overrides
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  ENSEMBLE_LIMITS,
  ENSEMBLE_HARD_LIMITS,
  ENSEMBLE_MIN_LIMITS,
  getEffectiveLimits,
  setGlobalEnsembleLimits,
  getGlobalEnsembleLimits,
  resetGlobalEnsembleLimits,
  EnsembleLimitsConfig
} from '../../../../src/elements/ensembles/constants.js';
import { Ensemble } from '../../../../src/elements/ensembles/Ensemble.js';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import type { MetadataService } from '../../../../src/services/MetadataService.js';

// Mock dependencies
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('../../../../src/utils/logger.js');

const metadataService: MetadataService = createTestMetadataService();

describe('Configurable Ensemble Limits', () => {
  // Store original env values
  const originalEnv: Record<string, string | undefined> = {};
  const envVars = [
    'ENSEMBLE_MAX_ELEMENTS',
    'ENSEMBLE_MAX_NESTING_DEPTH',
    'ENSEMBLE_MAX_ACTIVATION_TIME',
    'ENSEMBLE_MAX_CONTEXT_SIZE',
    'ENSEMBLE_MAX_CONTEXT_VALUE_SIZE',
    'ENSEMBLE_MAX_DEPENDENCIES',
    'ENSEMBLE_MAX_CONDITION_LENGTH'
  ];

  beforeEach(() => {
    // Save and clear env vars
    for (const key of envVars) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Reset global config
    resetGlobalEnsembleLimits();
  });

  afterEach(() => {
    // Restore env vars
    for (const key of envVars) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    // Reset global config
    resetGlobalEnsembleLimits();
  });

  describe('Default Limits', () => {
    it('should return default values when no configuration is set', () => {
      const limits = getEffectiveLimits();

      expect(limits.MAX_ELEMENTS).toBe(50);
      expect(limits.MAX_NESTING_DEPTH).toBe(5);
      expect(limits.MAX_ACTIVATION_TIME).toBe(30000);
      expect(limits.MAX_CONTEXT_SIZE).toBe(1000);
      expect(limits.MAX_CONTEXT_VALUE_SIZE).toBe(10000);
      expect(limits.MAX_DEPENDENCIES).toBe(10);
      expect(limits.MAX_CONDITION_LENGTH).toBe(200);
    });

    it('should match ENSEMBLE_LIMITS constant values', () => {
      const limits = getEffectiveLimits();

      expect(limits.MAX_ELEMENTS).toBe(ENSEMBLE_LIMITS.MAX_ELEMENTS);
      expect(limits.MAX_NESTING_DEPTH).toBe(ENSEMBLE_LIMITS.MAX_NESTING_DEPTH);
      expect(limits.MAX_ACTIVATION_TIME).toBe(ENSEMBLE_LIMITS.MAX_ACTIVATION_TIME);
      expect(limits.MAX_CONTEXT_SIZE).toBe(ENSEMBLE_LIMITS.MAX_CONTEXT_SIZE);
      expect(limits.MAX_CONTEXT_VALUE_SIZE).toBe(ENSEMBLE_LIMITS.MAX_CONTEXT_VALUE_SIZE);
      expect(limits.MAX_DEPENDENCIES).toBe(ENSEMBLE_LIMITS.MAX_DEPENDENCIES);
      expect(limits.MAX_CONDITION_LENGTH).toBe(ENSEMBLE_LIMITS.MAX_CONDITION_LENGTH);
    });
  });

  describe('Environment Variable Support', () => {
    it('should read MAX_ELEMENTS from environment variable', () => {
      process.env.ENSEMBLE_MAX_ELEMENTS = '100';

      const limits = getEffectiveLimits();
      expect(limits.MAX_ELEMENTS).toBe(100);
    });

    it('should read MAX_NESTING_DEPTH from environment variable', () => {
      process.env.ENSEMBLE_MAX_NESTING_DEPTH = '3';

      const limits = getEffectiveLimits();
      expect(limits.MAX_NESTING_DEPTH).toBe(3);
    });

    it('should read MAX_ACTIVATION_TIME from environment variable', () => {
      process.env.ENSEMBLE_MAX_ACTIVATION_TIME = '60000';

      const limits = getEffectiveLimits();
      expect(limits.MAX_ACTIVATION_TIME).toBe(60000);
    });

    it('should read MAX_CONTEXT_SIZE from environment variable', () => {
      process.env.ENSEMBLE_MAX_CONTEXT_SIZE = '5000';

      const limits = getEffectiveLimits();
      expect(limits.MAX_CONTEXT_SIZE).toBe(5000);
    });

    it('should read MAX_CONTEXT_VALUE_SIZE from environment variable', () => {
      process.env.ENSEMBLE_MAX_CONTEXT_VALUE_SIZE = '50000';

      const limits = getEffectiveLimits();
      expect(limits.MAX_CONTEXT_VALUE_SIZE).toBe(50000);
    });

    it('should read MAX_DEPENDENCIES from environment variable', () => {
      process.env.ENSEMBLE_MAX_DEPENDENCIES = '25';

      const limits = getEffectiveLimits();
      expect(limits.MAX_DEPENDENCIES).toBe(25);
    });

    it('should read MAX_CONDITION_LENGTH from environment variable', () => {
      process.env.ENSEMBLE_MAX_CONDITION_LENGTH = '500';

      const limits = getEffectiveLimits();
      expect(limits.MAX_CONDITION_LENGTH).toBe(500);
    });

    it('should clamp values below minimum to minimum', () => {
      process.env.ENSEMBLE_MAX_ELEMENTS = '0';

      const limits = getEffectiveLimits();
      expect(limits.MAX_ELEMENTS).toBe(ENSEMBLE_MIN_LIMITS.MAX_ELEMENTS);
    });

    it('should clamp values above maximum to security ceiling', () => {
      process.env.ENSEMBLE_MAX_ELEMENTS = '9999';

      const limits = getEffectiveLimits();
      expect(limits.MAX_ELEMENTS).toBe(ENSEMBLE_HARD_LIMITS.MAX_ELEMENTS);
    });

    it('should use default for invalid (non-numeric) environment variable', () => {
      process.env.ENSEMBLE_MAX_ELEMENTS = 'invalid';

      // Suppress console.warn
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const limits = getEffectiveLimits();
      expect(limits.MAX_ELEMENTS).toBe(50); // Default

      warnSpy.mockRestore();
    });
  });

  describe('Global Configuration', () => {
    it('should apply global configuration', () => {
      setGlobalEnsembleLimits({
        maxElements: 75,
        maxNestingDepth: 7
      });

      const limits = getEffectiveLimits();
      expect(limits.MAX_ELEMENTS).toBe(75);
      expect(limits.MAX_NESTING_DEPTH).toBe(7);
    });

    it('should override environment variables with global config', () => {
      process.env.ENSEMBLE_MAX_ELEMENTS = '100';

      setGlobalEnsembleLimits({
        maxElements: 60
      });

      const limits = getEffectiveLimits();
      expect(limits.MAX_ELEMENTS).toBe(60); // Global config takes precedence
    });

    it('should return current global config', () => {
      setGlobalEnsembleLimits({
        maxElements: 150,
        maxActivationTime: 45000
      });

      const config = getGlobalEnsembleLimits();
      expect(config.maxElements).toBe(150);
      expect(config.maxActivationTime).toBe(45000);
    });

    it('should reset global config to defaults', () => {
      setGlobalEnsembleLimits({
        maxElements: 200
      });

      resetGlobalEnsembleLimits();

      const config = getGlobalEnsembleLimits();
      expect(config.maxElements).toBeUndefined();
    });

    it('should clamp global config values to hard limits', () => {
      setGlobalEnsembleLimits({
        maxElements: 9999
      });

      const limits = getEffectiveLimits();
      expect(limits.MAX_ELEMENTS).toBe(ENSEMBLE_HARD_LIMITS.MAX_ELEMENTS);
    });

    it('should clamp global config values to minimum limits', () => {
      setGlobalEnsembleLimits({
        maxNestingDepth: -5
      });

      const limits = getEffectiveLimits();
      expect(limits.MAX_NESTING_DEPTH).toBe(ENSEMBLE_MIN_LIMITS.MAX_NESTING_DEPTH);
    });
  });

  describe('Per-Ensemble Overrides', () => {
    it('should apply per-ensemble overrides via getEffectiveLimits', () => {
      const overrides: Partial<EnsembleLimitsConfig> = {
        maxElements: 30,
        maxDependencies: 5
      };

      const limits = getEffectiveLimits(overrides);
      expect(limits.MAX_ELEMENTS).toBe(30);
      expect(limits.MAX_DEPENDENCIES).toBe(5);
    });

    it('should override global config with per-ensemble values', () => {
      setGlobalEnsembleLimits({
        maxElements: 100
      });

      const overrides: Partial<EnsembleLimitsConfig> = {
        maxElements: 25
      };

      const limits = getEffectiveLimits(overrides);
      expect(limits.MAX_ELEMENTS).toBe(25); // Per-ensemble takes precedence
    });

    it('should override environment variables with per-ensemble values', () => {
      process.env.ENSEMBLE_MAX_ELEMENTS = '100';

      const overrides: Partial<EnsembleLimitsConfig> = {
        maxElements: 20
      };

      const limits = getEffectiveLimits(overrides);
      expect(limits.MAX_ELEMENTS).toBe(20); // Per-ensemble takes precedence
    });

    it('should clamp per-ensemble overrides to hard limits', () => {
      const overrides: Partial<EnsembleLimitsConfig> = {
        maxElements: 9999
      };

      const limits = getEffectiveLimits(overrides);
      expect(limits.MAX_ELEMENTS).toBe(ENSEMBLE_HARD_LIMITS.MAX_ELEMENTS);
    });

    it('should clamp per-ensemble overrides to minimum limits', () => {
      const overrides: Partial<EnsembleLimitsConfig> = {
        maxActivationTime: 100 // Below minimum of 1000ms
      };

      const limits = getEffectiveLimits(overrides);
      expect(limits.MAX_ACTIVATION_TIME).toBe(ENSEMBLE_MIN_LIMITS.MAX_ACTIVATION_TIME);
    });
  });

  describe('Priority Order', () => {
    it('should follow priority: per-ensemble > global > env > default', () => {
      // Set environment variable
      process.env.ENSEMBLE_MAX_ELEMENTS = '100';

      // Set global config
      setGlobalEnsembleLimits({
        maxElements: 75
      });

      // Per-ensemble override
      const overrides: Partial<EnsembleLimitsConfig> = {
        maxElements: 50
      };

      const limits = getEffectiveLimits(overrides);
      expect(limits.MAX_ELEMENTS).toBe(50); // Per-ensemble wins

      // Without per-ensemble, global wins
      const limitsNoOverride = getEffectiveLimits();
      expect(limitsNoOverride.MAX_ELEMENTS).toBe(75);

      // Without global, env wins
      resetGlobalEnsembleLimits();
      const limitsNoGlobal = getEffectiveLimits();
      expect(limitsNoGlobal.MAX_ELEMENTS).toBe(100);

      // Without env, default wins
      delete process.env.ENSEMBLE_MAX_ELEMENTS;
      const limitsDefault = getEffectiveLimits();
      expect(limitsDefault.MAX_ELEMENTS).toBe(50); // Default
    });
  });

  describe('Hard Limits (Security)', () => {
    it('should define sensible hard limits', () => {
      expect(ENSEMBLE_HARD_LIMITS.MAX_ELEMENTS).toBe(500);
      expect(ENSEMBLE_HARD_LIMITS.MAX_NESTING_DEPTH).toBe(10);
      expect(ENSEMBLE_HARD_LIMITS.MAX_ACTIVATION_TIME).toBe(300000);
      expect(ENSEMBLE_HARD_LIMITS.MAX_CONTEXT_SIZE).toBe(10000);
      expect(ENSEMBLE_HARD_LIMITS.MAX_CONTEXT_VALUE_SIZE).toBe(1048576); // 1MB
      expect(ENSEMBLE_HARD_LIMITS.MAX_DEPENDENCIES).toBe(50);
      expect(ENSEMBLE_HARD_LIMITS.MAX_CONDITION_LENGTH).toBe(1000);
    });

    it('should define sensible minimum limits', () => {
      expect(ENSEMBLE_MIN_LIMITS.MAX_ELEMENTS).toBe(1);
      expect(ENSEMBLE_MIN_LIMITS.MAX_NESTING_DEPTH).toBe(0);
      expect(ENSEMBLE_MIN_LIMITS.MAX_ACTIVATION_TIME).toBe(1000);
      expect(ENSEMBLE_MIN_LIMITS.MAX_CONTEXT_SIZE).toBe(10);
      expect(ENSEMBLE_MIN_LIMITS.MAX_CONTEXT_VALUE_SIZE).toBe(100);
      expect(ENSEMBLE_MIN_LIMITS.MAX_DEPENDENCIES).toBe(1);
      expect(ENSEMBLE_MIN_LIMITS.MAX_CONDITION_LENGTH).toBe(10);
    });
  });

  describe('Ensemble Integration', () => {
    it('should use effective limits in Ensemble.getEffectiveLimits()', () => {
      setGlobalEnsembleLimits({
        maxElements: 100
      });

      const ensemble = new Ensemble(
        { name: 'test-ensemble' },
        [],
        metadataService
      );

      const limits = ensemble.getEffectiveLimits();
      expect(limits.MAX_ELEMENTS).toBe(100);
    });

    it('should apply per-ensemble resourceLimits overrides', () => {
      const ensemble = new Ensemble(
        {
          name: 'test-ensemble',
          resourceLimits: {
            maxActiveElements: 25,
            maxExecutionTimeMs: 10000
          }
        },
        [],
        metadataService
      );

      const limits = ensemble.getEffectiveLimits();
      expect(limits.MAX_ELEMENTS).toBe(25);
      expect(limits.MAX_ACTIVATION_TIME).toBe(10000);
    });

    it('should enforce element limit during addElement', () => {
      const ensemble = new Ensemble(
        {
          name: 'limited-ensemble',
          resourceLimits: {
            maxActiveElements: 2
          }
        },
        [],
        metadataService
      );

      // Add first element
      ensemble.addElement({
        element_name: 'element-1',
        element_type: 'skill',
        role: 'support',
        priority: 50,
        activation: 'always'
      });

      // Add second element
      ensemble.addElement({
        element_name: 'element-2',
        element_type: 'skill',
        role: 'support',
        priority: 50,
        activation: 'always'
      });

      // Third element should fail
      expect(() => {
        ensemble.addElement({
          element_name: 'element-3',
          element_type: 'skill',
          role: 'support',
          priority: 50,
          activation: 'always'
        });
      }).toThrow(/cannot contain more than 2 elements/i);
    });

    it('should enforce context value size limit', () => {
      const ensemble = new Ensemble(
        {
          name: 'context-limited',
          resourceLimits: {
            maxContextValueSize: 100 // Very small limit
          }
        },
        [
          {
            element_name: 'test-element',
            element_type: 'skill',
            role: 'support',
            priority: 50,
            activation: 'always'
          }
        ],
        metadataService
      );

      const largeValue = 'x'.repeat(200); // Exceeds 100 byte limit

      expect(() => {
        ensemble.setContextValue('key', largeValue, 'test-element');
      }).toThrow(/exceeds maximum allowed size/i);
    });

    it('should cache effective limits', () => {
      const ensemble = new Ensemble(
        { name: 'cache-test' },
        [],
        metadataService
      );

      const limits1 = ensemble.getEffectiveLimits();
      const limits2 = ensemble.getEffectiveLimits();

      // Should return same object (cached)
      expect(limits1).toBe(limits2);
    });

    it('should invalidate cache when requested', () => {
      const ensemble = new Ensemble(
        { name: 'cache-invalidate-test' },
        [],
        metadataService
      );

      const limits1 = ensemble.getEffectiveLimits();
      ensemble.invalidateLimitsCache();
      const limits2 = ensemble.getEffectiveLimits();

      // Should be different objects after invalidation
      expect(limits1).not.toBe(limits2);
      // But same values
      expect(limits1.MAX_ELEMENTS).toBe(limits2.MAX_ELEMENTS);
    });
  });
});
