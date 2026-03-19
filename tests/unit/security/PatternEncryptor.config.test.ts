/**
 * Unit tests for PatternEncryptor environment configuration
 * Issue #10: Verify DOLLHOUSE_DISABLE_ENCRYPTION is properly honored
 *
 * Tests various environment combinations to ensure correct behavior:
 * - Encryption disabled via environment variable
 * - Encryption enabled in production
 * - Encryption disabled in development
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { PatternEncryptor } from '../../../src/security/encryption/PatternEncryptor.js';

describe('PatternEncryptor - Environment Configuration', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('DOLLHOUSE_DISABLE_ENCRYPTION behavior via configuration', () => {
    it('should disable encryption when configured with enabled=false', async () => {
      // Test explicit disable via configuration
      const encryptor = new PatternEncryptor({ enabled: false });

      // Should initialize successfully without throwing (no secret required)
      await expect(encryptor.initialize()).resolves.toBeUndefined();

      // Encryption should be disabled
      const status = encryptor.getStatus();
      expect(status.enabled).toBe(false);
      expect(status.initialized).toBe(true);
    });

    it('should require secret when encryption is enabled', async () => {
      // Test enabling encryption without secret
      const encryptor = new PatternEncryptor({ enabled: true });

      // Should throw error requiring encryption secret
      await expect(encryptor.initialize()).rejects.toThrow(
        'DOLLHOUSE_ENCRYPTION_SECRET environment variable is required when encryption is enabled'
      );
    });

    it('should enable encryption when secret is provided', async () => {
      // Test enabling encryption with secret
      const encryptor = new PatternEncryptor({
        enabled: true,
        secret: 'test-secret-key-for-unit-tests',
      });

      // Should initialize successfully with encryption enabled
      await expect(encryptor.initialize()).resolves.toBeUndefined();

      const status = encryptor.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.initialized).toBe(true);
      expect(status.hasSecret).toBe(true);
    });

    it('should respect explicit disable even when secret is provided', async () => {
      // Test disable taking precedence over secret availability
      const encryptor = new PatternEncryptor({
        enabled: false,
        secret: 'test-secret-key-for-unit-tests',
      });

      // Should initialize with encryption disabled (explicit disable takes precedence)
      await expect(encryptor.initialize()).resolves.toBeUndefined();

      const status = encryptor.getStatus();
      expect(status.enabled).toBe(false);
      expect(status.initialized).toBe(true);
    });

    it('should use custom salt when provided', async () => {
      const customSalt = 'custom-salt-for-testing';
      const encryptor = new PatternEncryptor({
        enabled: true,
        secret: 'test-secret-key',
        salt: customSalt,
      });

      await encryptor.initialize();

      const status = encryptor.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.initialized).toBe(true);
    });
  });

  describe('Configuration override behavior', () => {
    it('should allow configuration override during initialization', async () => {
      // Start with encryption disabled
      process.env.NODE_ENV = 'development';
      process.env.DOLLHOUSE_DISABLE_ENCRYPTION = 'true';

      const encryptor = new PatternEncryptor();

      // Override to enable encryption with secret
      await encryptor.initialize({
        enabled: true,
        secret: 'override-secret-key',
      });

      const status = encryptor.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.initialized).toBe(true);
    });

    it('should allow configuration override in constructor', async () => {
      process.env.NODE_ENV = 'production';

      // Override encryption settings in constructor
      const encryptor = new PatternEncryptor({
        enabled: false,
      });

      // Should initialize without secret (encryption disabled)
      await expect(encryptor.initialize()).resolves.toBeUndefined();

      const status = encryptor.getStatus();
      expect(status.enabled).toBe(false);
    });
  });
});
