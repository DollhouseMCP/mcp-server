import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Mock the logger using ESM-compatible approach
jest.unstable_mockModule('../../../src/utils/logger.js', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn()
  }
}));

// Import after mocking
const { logger } = await import('../../../src/utils/logger.js');
const {
  getAutonomyThresholdConservative,
  getAutonomyThresholdModerate,
  getAutonomyThresholdAggressive,
  getAutonomyMaxStepsDefault,
  getAutonomyRiskThresholds,
  AUTONOMY_DEFAULTS,
  AUTONOMY_HARD_LIMITS,
  AUTONOMY_MIN_LIMITS,
  AUTONOMY_ENV_VARS,
} = await import('../../../src/config/autonomy-config.js');

const mockWarn = logger.warn as jest.Mock;

describe('Autonomy Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear all autonomy env vars
    for (const envVar of Object.values(AUTONOMY_ENV_VARS)) {
      delete process.env[envVar];
    }
    mockWarn.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('AUTONOMY_ENV_VARS', () => {
    it('should follow DOLLHOUSE_AUTONOMY_* naming convention', () => {
      for (const envVar of Object.values(AUTONOMY_ENV_VARS)) {
        expect(envVar).toMatch(/^DOLLHOUSE_AUTONOMY_/);
      }
    });

    it('should have entries for all config keys', () => {
      expect(AUTONOMY_ENV_VARS.thresholdConservative).toBeDefined();
      expect(AUTONOMY_ENV_VARS.thresholdModerate).toBeDefined();
      expect(AUTONOMY_ENV_VARS.thresholdAggressive).toBeDefined();
      expect(AUTONOMY_ENV_VARS.maxStepsDefault).toBeDefined();
    });
  });

  describe('getAutonomyThresholdConservative', () => {
    it('should return default value (25) when no env var is set', () => {
      expect(getAutonomyThresholdConservative()).toBe(25);
    });

    it('should respect env var override with valid value', () => {
      process.env.DOLLHOUSE_AUTONOMY_THRESHOLD_CONSERVATIVE = '15';
      expect(getAutonomyThresholdConservative()).toBe(15);
    });

    it('should clamp to hard limit ceiling when value exceeds maximum', () => {
      process.env.DOLLHOUSE_AUTONOMY_THRESHOLD_CONSERVATIVE = '80';
      expect(getAutonomyThresholdConservative()).toBe(AUTONOMY_HARD_LIMITS.thresholdConservative);
    });

    it('should clamp to minimum limit floor when value is too low', () => {
      process.env.DOLLHOUSE_AUTONOMY_THRESHOLD_CONSERVATIVE = '1';
      expect(getAutonomyThresholdConservative()).toBe(AUTONOMY_MIN_LIMITS.thresholdConservative);
    });

    it('should fall back to default for non-numeric value', () => {
      process.env.DOLLHOUSE_AUTONOMY_THRESHOLD_CONSERVATIVE = 'abc';
      expect(getAutonomyThresholdConservative()).toBe(AUTONOMY_DEFAULTS.thresholdConservative);
    });
  });

  describe('getAutonomyThresholdModerate', () => {
    it('should return default value (50) when no env var is set', () => {
      expect(getAutonomyThresholdModerate()).toBe(50);
    });

    it('should respect env var override with valid value', () => {
      process.env.DOLLHOUSE_AUTONOMY_THRESHOLD_MODERATE = '40';
      expect(getAutonomyThresholdModerate()).toBe(40);
    });

    it('should clamp to hard limit ceiling when value exceeds maximum', () => {
      process.env.DOLLHOUSE_AUTONOMY_THRESHOLD_MODERATE = '99';
      expect(getAutonomyThresholdModerate()).toBe(AUTONOMY_HARD_LIMITS.thresholdModerate);
    });

    it('should clamp to minimum limit floor when value is too low', () => {
      process.env.DOLLHOUSE_AUTONOMY_THRESHOLD_MODERATE = '5';
      expect(getAutonomyThresholdModerate()).toBe(AUTONOMY_MIN_LIMITS.thresholdModerate);
    });
  });

  describe('getAutonomyThresholdAggressive', () => {
    it('should return default value (75) when no env var is set', () => {
      expect(getAutonomyThresholdAggressive()).toBe(75);
    });

    it('should respect env var override with valid value', () => {
      process.env.DOLLHOUSE_AUTONOMY_THRESHOLD_AGGRESSIVE = '85';
      expect(getAutonomyThresholdAggressive()).toBe(85);
    });

    it('should clamp to hard limit ceiling when value exceeds maximum', () => {
      process.env.DOLLHOUSE_AUTONOMY_THRESHOLD_AGGRESSIVE = '99';
      expect(getAutonomyThresholdAggressive()).toBe(AUTONOMY_HARD_LIMITS.thresholdAggressive);
    });

    it('should clamp to minimum limit floor when value is too low', () => {
      process.env.DOLLHOUSE_AUTONOMY_THRESHOLD_AGGRESSIVE = '10';
      expect(getAutonomyThresholdAggressive()).toBe(AUTONOMY_MIN_LIMITS.thresholdAggressive);
    });
  });

  describe('getAutonomyMaxStepsDefault', () => {
    it('should return default value (10) when no env var is set', () => {
      expect(getAutonomyMaxStepsDefault()).toBe(10);
    });

    it('should respect env var override with valid value', () => {
      process.env.DOLLHOUSE_AUTONOMY_MAX_STEPS_DEFAULT = '20';
      expect(getAutonomyMaxStepsDefault()).toBe(20);
    });

    it('should clamp to hard limit ceiling when value exceeds maximum', () => {
      process.env.DOLLHOUSE_AUTONOMY_MAX_STEPS_DEFAULT = '500';
      expect(getAutonomyMaxStepsDefault()).toBe(AUTONOMY_HARD_LIMITS.maxStepsDefault);
    });

    it('should clamp to minimum limit floor when value is too low', () => {
      process.env.DOLLHOUSE_AUTONOMY_MAX_STEPS_DEFAULT = '0';
      expect(getAutonomyMaxStepsDefault()).toBe(AUTONOMY_MIN_LIMITS.maxStepsDefault);
    });

    it('should fall back to default for non-numeric value', () => {
      process.env.DOLLHOUSE_AUTONOMY_MAX_STEPS_DEFAULT = 'unlimited';
      expect(getAutonomyMaxStepsDefault()).toBe(AUTONOMY_DEFAULTS.maxStepsDefault);
    });
  });

  describe('getAutonomyRiskThresholds', () => {
    it('should return all three thresholds with default values', () => {
      const thresholds = getAutonomyRiskThresholds();
      expect(thresholds).toEqual({
        conservative: 25,
        moderate: 50,
        aggressive: 75,
      });
    });

    it('should reflect env var overrides in composite result', () => {
      process.env.DOLLHOUSE_AUTONOMY_THRESHOLD_CONSERVATIVE = '10';
      process.env.DOLLHOUSE_AUTONOMY_THRESHOLD_MODERATE = '30';
      process.env.DOLLHOUSE_AUTONOMY_THRESHOLD_AGGRESSIVE = '60';

      const thresholds = getAutonomyRiskThresholds();
      expect(thresholds).toEqual({
        conservative: 10,
        moderate: 30,
        aggressive: 60,
      });
    });
  });

  describe('warning logging', () => {
    it('should warn when env var value is non-numeric', () => {
      process.env.DOLLHOUSE_AUTONOMY_THRESHOLD_MODERATE = 'banana';
      getAutonomyThresholdModerate();

      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('non-numeric value'),
        expect.objectContaining({
          envVar: 'DOLLHOUSE_AUTONOMY_THRESHOLD_MODERATE',
          providedValue: 'banana'
        })
      );
    });

    it('should warn when env var value exceeds security ceiling', () => {
      process.env.DOLLHOUSE_AUTONOMY_THRESHOLD_AGGRESSIVE = '99';
      getAutonomyThresholdAggressive();

      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('value exceeds security ceiling'),
        expect.objectContaining({
          envVar: 'DOLLHOUSE_AUTONOMY_THRESHOLD_AGGRESSIVE',
          providedValue: 99,
          maximumAllowed: AUTONOMY_HARD_LIMITS.thresholdAggressive
        })
      );
    });

    it('should not warn for valid env var values', () => {
      process.env.DOLLHOUSE_AUTONOMY_THRESHOLD_MODERATE = '40';
      getAutonomyThresholdModerate();

      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('should not warn when no env var is set', () => {
      getAutonomyThresholdModerate();

      expect(mockWarn).not.toHaveBeenCalled();
    });
  });

  describe('constants consistency', () => {
    it('should have defaults within min and hard limit bounds', () => {
      const keys = ['thresholdConservative', 'thresholdModerate', 'thresholdAggressive', 'maxStepsDefault'] as const;
      for (const key of keys) {
        expect(AUTONOMY_DEFAULTS[key]).toBeGreaterThanOrEqual(AUTONOMY_MIN_LIMITS[key]);
        expect(AUTONOMY_DEFAULTS[key]).toBeLessThanOrEqual(AUTONOMY_HARD_LIMITS[key]);
      }
    });

    it('should have min limits strictly less than hard limits', () => {
      const keys = ['thresholdConservative', 'thresholdModerate', 'thresholdAggressive', 'maxStepsDefault'] as const;
      for (const key of keys) {
        expect(AUTONOMY_MIN_LIMITS[key]).toBeLessThan(AUTONOMY_HARD_LIMITS[key]);
      }
    });

    it('should have positive min limits', () => {
      const keys = ['thresholdConservative', 'thresholdModerate', 'thresholdAggressive', 'maxStepsDefault'] as const;
      for (const key of keys) {
        expect(AUTONOMY_MIN_LIMITS[key]).toBeGreaterThan(0);
      }
    });

    it('should maintain threshold ordering: conservative < moderate < aggressive', () => {
      expect(AUTONOMY_DEFAULTS.thresholdConservative).toBeLessThan(AUTONOMY_DEFAULTS.thresholdModerate);
      expect(AUTONOMY_DEFAULTS.thresholdModerate).toBeLessThan(AUTONOMY_DEFAULTS.thresholdAggressive);
    });
  });
});
