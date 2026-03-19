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
  getHandoffMaxRecentEntries,
  getHandoffMaxRecentDecisions,
  getHandoffWarnPayloadBytes,
  HANDOFF_DEFAULTS,
  HANDOFF_HARD_LIMITS,
  HANDOFF_MIN_LIMITS,
  HANDOFF_ENV_VARS,
} = await import('../../../src/config/handoff-limits.js');

const mockWarn = logger.warn as jest.Mock;

describe('Handoff Limits Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear all handoff limit env vars
    for (const envVar of Object.values(HANDOFF_ENV_VARS)) {
      delete process.env[envVar];
    }
    mockWarn.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('HANDOFF_ENV_VARS', () => {
    it('should follow DOLLHOUSE_HANDOFF_* naming convention', () => {
      for (const envVar of Object.values(HANDOFF_ENV_VARS)) {
        expect(envVar).toMatch(/^DOLLHOUSE_HANDOFF_/);
      }
    });

    it('should have entries for all config keys', () => {
      expect(HANDOFF_ENV_VARS.recentEntries).toBeDefined();
      expect(HANDOFF_ENV_VARS.recentDecisions).toBeDefined();
      expect(HANDOFF_ENV_VARS.warnPayloadBytes).toBeDefined();
    });
  });

  describe('getHandoffMaxRecentEntries', () => {
    it('should return default value (20) when no env var is set', () => {
      expect(getHandoffMaxRecentEntries()).toBe(20);
    });

    it('should respect env var override with valid value', () => {
      process.env.DOLLHOUSE_HANDOFF_MAX_RECENT_ENTRIES = '50';
      expect(getHandoffMaxRecentEntries()).toBe(50);
    });

    it('should clamp to hard limit ceiling when value exceeds maximum', () => {
      process.env.DOLLHOUSE_HANDOFF_MAX_RECENT_ENTRIES = '500';
      expect(getHandoffMaxRecentEntries()).toBe(HANDOFF_HARD_LIMITS.recentEntries); // 100
    });

    it('should clamp to minimum limit floor when value is too low', () => {
      process.env.DOLLHOUSE_HANDOFF_MAX_RECENT_ENTRIES = '1';
      expect(getHandoffMaxRecentEntries()).toBe(HANDOFF_MIN_LIMITS.recentEntries); // 5
    });

    it('should fall back to default for non-numeric value', () => {
      process.env.DOLLHOUSE_HANDOFF_MAX_RECENT_ENTRIES = 'abc';
      expect(getHandoffMaxRecentEntries()).toBe(HANDOFF_DEFAULTS.recentEntries);
    });

    it('should accept value exactly at hard limit', () => {
      process.env.DOLLHOUSE_HANDOFF_MAX_RECENT_ENTRIES = String(HANDOFF_HARD_LIMITS.recentEntries);
      expect(getHandoffMaxRecentEntries()).toBe(HANDOFF_HARD_LIMITS.recentEntries);
    });

    it('should accept value exactly at minimum limit', () => {
      process.env.DOLLHOUSE_HANDOFF_MAX_RECENT_ENTRIES = String(HANDOFF_MIN_LIMITS.recentEntries);
      expect(getHandoffMaxRecentEntries()).toBe(HANDOFF_MIN_LIMITS.recentEntries);
    });
  });

  describe('getHandoffMaxRecentDecisions', () => {
    it('should return default value (10) when no env var is set', () => {
      expect(getHandoffMaxRecentDecisions()).toBe(10);
    });

    it('should respect env var override with valid value', () => {
      process.env.DOLLHOUSE_HANDOFF_MAX_RECENT_DECISIONS = '25';
      expect(getHandoffMaxRecentDecisions()).toBe(25);
    });

    it('should clamp to hard limit ceiling when value exceeds maximum', () => {
      process.env.DOLLHOUSE_HANDOFF_MAX_RECENT_DECISIONS = '200';
      expect(getHandoffMaxRecentDecisions()).toBe(HANDOFF_HARD_LIMITS.recentDecisions); // 50
    });

    it('should clamp to minimum limit floor when value is too low', () => {
      process.env.DOLLHOUSE_HANDOFF_MAX_RECENT_DECISIONS = '1';
      expect(getHandoffMaxRecentDecisions()).toBe(HANDOFF_MIN_LIMITS.recentDecisions); // 3
    });
  });

  describe('getHandoffWarnPayloadBytes', () => {
    it('should return default value (100KB) when no env var is set', () => {
      expect(getHandoffWarnPayloadBytes()).toBe(102_400);
    });

    it('should respect env var override with valid value', () => {
      process.env.DOLLHOUSE_HANDOFF_WARN_PAYLOAD_BYTES = '512000';
      expect(getHandoffWarnPayloadBytes()).toBe(512_000);
    });

    it('should clamp to hard limit ceiling (1MB) when value exceeds maximum', () => {
      process.env.DOLLHOUSE_HANDOFF_WARN_PAYLOAD_BYTES = '10000000';
      expect(getHandoffWarnPayloadBytes()).toBe(HANDOFF_HARD_LIMITS.warnPayloadBytes); // 1MB
    });

    it('should clamp to minimum limit floor (1KB) when value is too low', () => {
      process.env.DOLLHOUSE_HANDOFF_WARN_PAYLOAD_BYTES = '100';
      expect(getHandoffWarnPayloadBytes()).toBe(HANDOFF_MIN_LIMITS.warnPayloadBytes); // 1KB
    });
  });

  describe('warning logging', () => {
    it('should warn when env var value is non-numeric', () => {
      process.env.DOLLHOUSE_HANDOFF_MAX_RECENT_ENTRIES = 'banana';
      getHandoffMaxRecentEntries();

      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('non-numeric value'),
        expect.objectContaining({
          envVar: 'DOLLHOUSE_HANDOFF_MAX_RECENT_ENTRIES',
          providedValue: 'banana'
        })
      );
    });

    it('should warn when env var value exceeds security ceiling', () => {
      process.env.DOLLHOUSE_HANDOFF_MAX_RECENT_ENTRIES = '999';
      getHandoffMaxRecentEntries();

      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('value exceeds security ceiling'),
        expect.objectContaining({
          envVar: 'DOLLHOUSE_HANDOFF_MAX_RECENT_ENTRIES',
          providedValue: 999,
          maximumAllowed: HANDOFF_HARD_LIMITS.recentEntries
        })
      );
    });

    it('should not warn for valid env var values', () => {
      process.env.DOLLHOUSE_HANDOFF_MAX_RECENT_ENTRIES = '50';
      getHandoffMaxRecentEntries();

      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('should not warn when no env var is set', () => {
      getHandoffMaxRecentEntries();

      expect(mockWarn).not.toHaveBeenCalled();
    });
  });

  describe('constants consistency', () => {
    it('should have defaults within min and hard limit bounds', () => {
      const keys = ['recentEntries', 'recentDecisions', 'warnPayloadBytes'] as const;
      for (const key of keys) {
        expect(HANDOFF_DEFAULTS[key]).toBeGreaterThanOrEqual(HANDOFF_MIN_LIMITS[key]);
        expect(HANDOFF_DEFAULTS[key]).toBeLessThanOrEqual(HANDOFF_HARD_LIMITS[key]);
      }
    });

    it('should have min limits strictly less than hard limits', () => {
      const keys = ['recentEntries', 'recentDecisions', 'warnPayloadBytes'] as const;
      for (const key of keys) {
        expect(HANDOFF_MIN_LIMITS[key]).toBeLessThan(HANDOFF_HARD_LIMITS[key]);
      }
    });

    it('should have positive min limits', () => {
      const keys = ['recentEntries', 'recentDecisions', 'warnPayloadBytes'] as const;
      for (const key of keys) {
        expect(HANDOFF_MIN_LIMITS[key]).toBeGreaterThan(0);
      }
    });
  });
});
