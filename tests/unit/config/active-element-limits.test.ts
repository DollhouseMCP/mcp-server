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
  getMaxActiveLimit,
  getActiveElementLimitConfig,
  ACTIVE_ELEMENT_DEFAULTS,
  ACTIVE_ELEMENT_HARD_LIMITS,
  ACTIVE_ELEMENT_MIN_LIMITS,
  ACTIVE_LIMIT_ENV_VARS,
} = await import('../../../src/config/active-element-limits.js');
import type { ActiveLimitElementType } from '../../../src/config/active-element-limits.js';

const mockWarn = logger.warn as jest.Mock;

describe('Active Element Limits Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear all active limit env vars
    for (const envVar of Object.values(ACTIVE_LIMIT_ENV_VARS)) {
      delete process.env[envVar];
    }
    mockWarn.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('ACTIVE_LIMIT_ENV_VARS', () => {
    it('should follow DOLLHOUSE_MAX_ACTIVE_* naming convention', () => {
      for (const [type, envVar] of Object.entries(ACTIVE_LIMIT_ENV_VARS)) {
        expect(envVar).toMatch(/^DOLLHOUSE_MAX_ACTIVE_/);
        expect(envVar).toBe(`DOLLHOUSE_MAX_ACTIVE_${type.toUpperCase()}`);
      }
    });

    it('should have entries for all element types', () => {
      const types: ActiveLimitElementType[] = ['skills', 'agents', 'memories', 'ensembles', 'personas'];
      for (const type of types) {
        expect(ACTIVE_LIMIT_ENV_VARS[type]).toBeDefined();
      }
    });
  });

  describe('getMaxActiveLimit', () => {
    const types: ActiveLimitElementType[] = ['skills', 'agents', 'memories', 'ensembles', 'personas'];

    it('should return default values when no env vars are set', () => {
      for (const type of types) {
        expect(getMaxActiveLimit(type)).toBe(ACTIVE_ELEMENT_DEFAULTS[type]);
      }
    });

    it('should return correct default for skills (200)', () => {
      expect(getMaxActiveLimit('skills')).toBe(200);
    });

    it('should return correct default for agents (100)', () => {
      expect(getMaxActiveLimit('agents')).toBe(100);
    });

    it('should return correct default for memories (100)', () => {
      expect(getMaxActiveLimit('memories')).toBe(100);
    });

    it('should return correct default for ensembles (50)', () => {
      expect(getMaxActiveLimit('ensembles')).toBe(50);
    });

    it('should return correct default for personas (20)', () => {
      expect(getMaxActiveLimit('personas')).toBe(20);
    });

    it('should respect env var override with valid value', () => {
      process.env.DOLLHOUSE_MAX_ACTIVE_SKILLS = '300';
      expect(getMaxActiveLimit('skills')).toBe(300);
    });

    it('should respect env var override for each element type', () => {
      process.env.DOLLHOUSE_MAX_ACTIVE_AGENTS = '75';
      expect(getMaxActiveLimit('agents')).toBe(75);

      process.env.DOLLHOUSE_MAX_ACTIVE_MEMORIES = '150';
      expect(getMaxActiveLimit('memories')).toBe(150);

      process.env.DOLLHOUSE_MAX_ACTIVE_ENSEMBLES = '100';
      expect(getMaxActiveLimit('ensembles')).toBe(100);

      process.env.DOLLHOUSE_MAX_ACTIVE_PERSONAS = '50';
      expect(getMaxActiveLimit('personas')).toBe(50);
    });

    it('should clamp to hard limit ceiling when value exceeds maximum', () => {
      process.env.DOLLHOUSE_MAX_ACTIVE_SKILLS = '5000';
      expect(getMaxActiveLimit('skills')).toBe(ACTIVE_ELEMENT_HARD_LIMITS.skills); // 1000

      process.env.DOLLHOUSE_MAX_ACTIVE_AGENTS = '9999';
      expect(getMaxActiveLimit('agents')).toBe(ACTIVE_ELEMENT_HARD_LIMITS.agents); // 500

      process.env.DOLLHOUSE_MAX_ACTIVE_PERSONAS = '999';
      expect(getMaxActiveLimit('personas')).toBe(ACTIVE_ELEMENT_HARD_LIMITS.personas); // 100
    });

    it('should clamp to minimum limit floor when value is too low', () => {
      process.env.DOLLHOUSE_MAX_ACTIVE_SKILLS = '1';
      expect(getMaxActiveLimit('skills')).toBe(ACTIVE_ELEMENT_MIN_LIMITS.skills); // 5

      process.env.DOLLHOUSE_MAX_ACTIVE_AGENTS = '0';
      expect(getMaxActiveLimit('agents')).toBe(ACTIVE_ELEMENT_MIN_LIMITS.agents); // 5

      process.env.DOLLHOUSE_MAX_ACTIVE_ENSEMBLES = '1';
      expect(getMaxActiveLimit('ensembles')).toBe(ACTIVE_ELEMENT_MIN_LIMITS.ensembles); // 2

      process.env.DOLLHOUSE_MAX_ACTIVE_PERSONAS = '-5';
      expect(getMaxActiveLimit('personas')).toBe(ACTIVE_ELEMENT_MIN_LIMITS.personas); // 2
    });

    it('should fall back to default for non-numeric env var value', () => {
      process.env.DOLLHOUSE_MAX_ACTIVE_SKILLS = 'not-a-number';
      expect(getMaxActiveLimit('skills')).toBe(ACTIVE_ELEMENT_DEFAULTS.skills);
    });

    it('should fall back to default for empty env var value', () => {
      process.env.DOLLHOUSE_MAX_ACTIVE_SKILLS = '';
      expect(getMaxActiveLimit('skills')).toBe(ACTIVE_ELEMENT_DEFAULTS.skills);
    });

    it('should handle env var with spaces (parseInt ignores trailing)', () => {
      process.env.DOLLHOUSE_MAX_ACTIVE_SKILLS = '  250  ';
      // parseInt('  250  ', 10) returns 250 - leading spaces are trimmed by parseInt
      expect(getMaxActiveLimit('skills')).toBe(250);
    });

    it('should handle env var with float value (parseInt truncates)', () => {
      process.env.DOLLHOUSE_MAX_ACTIVE_SKILLS = '150.7';
      // parseInt('150.7', 10) returns 150
      expect(getMaxActiveLimit('skills')).toBe(150);
    });

    it('should accept value exactly at hard limit', () => {
      process.env.DOLLHOUSE_MAX_ACTIVE_SKILLS = String(ACTIVE_ELEMENT_HARD_LIMITS.skills);
      expect(getMaxActiveLimit('skills')).toBe(ACTIVE_ELEMENT_HARD_LIMITS.skills);
    });

    it('should accept value exactly at minimum limit', () => {
      process.env.DOLLHOUSE_MAX_ACTIVE_SKILLS = String(ACTIVE_ELEMENT_MIN_LIMITS.skills);
      expect(getMaxActiveLimit('skills')).toBe(ACTIVE_ELEMENT_MIN_LIMITS.skills);
    });
  });

  describe('getActiveElementLimitConfig', () => {
    it('should return max and cleanupThreshold for each type', () => {
      const types: ActiveLimitElementType[] = ['skills', 'agents', 'memories', 'ensembles', 'personas'];

      for (const type of types) {
        const config = getActiveElementLimitConfig(type);
        expect(config).toHaveProperty('max');
        expect(config).toHaveProperty('cleanupThreshold');
        expect(typeof config.max).toBe('number');
        expect(typeof config.cleanupThreshold).toBe('number');
      }
    });

    it('should calculate cleanup threshold as floor(max * 0.9)', () => {
      // Default skills: 200 -> threshold = floor(200 * 0.9) = 180
      const skillsConfig = getActiveElementLimitConfig('skills');
      expect(skillsConfig.cleanupThreshold).toBe(Math.floor(skillsConfig.max * 0.9));
      expect(skillsConfig.cleanupThreshold).toBe(180);

      // Default agents: 100 -> threshold = floor(100 * 0.9) = 90
      const agentsConfig = getActiveElementLimitConfig('agents');
      expect(agentsConfig.cleanupThreshold).toBe(90);

      // Default personas: 20 -> threshold = floor(20 * 0.9) = 18
      const personasConfig = getActiveElementLimitConfig('personas');
      expect(personasConfig.cleanupThreshold).toBe(18);
    });

    it('should respect env var override in cleanup threshold calculation', () => {
      process.env.DOLLHOUSE_MAX_ACTIVE_SKILLS = '500';
      const config = getActiveElementLimitConfig('skills');
      expect(config.max).toBe(500);
      expect(config.cleanupThreshold).toBe(Math.floor(500 * 0.9)); // 450
    });

    it('should ensure cleanup threshold is always less than max', () => {
      const types: ActiveLimitElementType[] = ['skills', 'agents', 'memories', 'ensembles', 'personas'];

      for (const type of types) {
        const config = getActiveElementLimitConfig(type);
        expect(config.cleanupThreshold).toBeLessThan(config.max);
      }
    });
  });

  describe('warning logging', () => {
    it('should warn when env var value is non-numeric', () => {
      process.env.DOLLHOUSE_MAX_ACTIVE_SKILLS = 'banana';
      getMaxActiveLimit('skills');

      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('non-numeric value'),
        expect.objectContaining({
          envVar: 'DOLLHOUSE_MAX_ACTIVE_SKILLS',
          providedValue: 'banana'
        })
      );
    });

    it('should warn when env var value is below minimum', () => {
      process.env.DOLLHOUSE_MAX_ACTIVE_SKILLS = '1';
      getMaxActiveLimit('skills');

      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('value below minimum'),
        expect.objectContaining({
          envVar: 'DOLLHOUSE_MAX_ACTIVE_SKILLS',
          providedValue: 1,
          minimumAllowed: ACTIVE_ELEMENT_MIN_LIMITS.skills
        })
      );
    });

    it('should warn when env var value exceeds security ceiling', () => {
      process.env.DOLLHOUSE_MAX_ACTIVE_SKILLS = '9999';
      getMaxActiveLimit('skills');

      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('value exceeds security ceiling'),
        expect.objectContaining({
          envVar: 'DOLLHOUSE_MAX_ACTIVE_SKILLS',
          providedValue: 9999,
          maximumAllowed: ACTIVE_ELEMENT_HARD_LIMITS.skills
        })
      );
    });

    it('should not warn for valid env var values', () => {
      process.env.DOLLHOUSE_MAX_ACTIVE_SKILLS = '300';
      getMaxActiveLimit('skills');

      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('should not warn when no env var is set', () => {
      getMaxActiveLimit('skills');

      expect(mockWarn).not.toHaveBeenCalled();
    });
  });

  describe('constants consistency', () => {
    it('should have defaults within min and hard limit bounds', () => {
      const types: ActiveLimitElementType[] = ['skills', 'agents', 'memories', 'ensembles', 'personas'];

      for (const type of types) {
        expect(ACTIVE_ELEMENT_DEFAULTS[type]).toBeGreaterThanOrEqual(ACTIVE_ELEMENT_MIN_LIMITS[type]);
        expect(ACTIVE_ELEMENT_DEFAULTS[type]).toBeLessThanOrEqual(ACTIVE_ELEMENT_HARD_LIMITS[type]);
      }
    });

    it('should have min limits strictly less than hard limits', () => {
      const types: ActiveLimitElementType[] = ['skills', 'agents', 'memories', 'ensembles', 'personas'];

      for (const type of types) {
        expect(ACTIVE_ELEMENT_MIN_LIMITS[type]).toBeLessThan(ACTIVE_ELEMENT_HARD_LIMITS[type]);
      }
    });

    it('should have positive min limits', () => {
      const types: ActiveLimitElementType[] = ['skills', 'agents', 'memories', 'ensembles', 'personas'];

      for (const type of types) {
        expect(ACTIVE_ELEMENT_MIN_LIMITS[type]).toBeGreaterThan(0);
      }
    });
  });
});
