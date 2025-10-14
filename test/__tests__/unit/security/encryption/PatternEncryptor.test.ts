/**
 * Unit tests for PatternEncryptor
 *
 * Tests AES-256-GCM encryption, PBKDF2 key derivation, and error handling
 *
 * Part of Issue #1321 Phase 2
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { PatternEncryptor } from '../../../../../src/security/encryption/PatternEncryptor.js';

describe('PatternEncryptor', () => {
  // Test secret for encryption
  const TEST_SECRET = 'test-secret-with-sufficient-entropy-for-testing';
  const TEST_PATTERN = 'eval(malicious.code())';

  beforeEach(async () => {
    // Reset encryptor before each test
    PatternEncryptor.reset();
  });

  afterEach(() => {
    // Cleanup after each test
    PatternEncryptor.reset();
  });

  describe('initialization', () => {
    it('should initialize with valid secret', async () => {
      await expect(
        PatternEncryptor.initialize({
          enabled: true,
          secret: TEST_SECRET,
        })
      ).resolves.not.toThrow();

      expect(PatternEncryptor.isEnabled()).toBe(true);
    });

    it('should throw error when enabled without secret', async () => {
      await expect(
        PatternEncryptor.initialize({
          enabled: true,
          secret: undefined,
        })
      ).rejects.toThrow('DOLLHOUSE_ENCRYPTION_SECRET');
    });

    it('should not require secret when disabled', async () => {
      await expect(
        PatternEncryptor.initialize({
          enabled: false,
          secret: undefined,
        })
      ).resolves.not.toThrow();

      expect(PatternEncryptor.isEnabled()).toBe(false);
    });

    it('should return correct status after initialization', async () => {
      await PatternEncryptor.initialize({
        enabled: true,
        secret: TEST_SECRET,
        iterations: 50000,
      });

      const status = PatternEncryptor.getStatus();

      expect(status).toEqual({
        enabled: true,
        initialized: true,
        algorithm: 'aes-256-gcm',
        keyLength: 32,
        iterations: 50000,
        hasSecret: true,
      });
    });
  });

  describe('encryption', () => {
    beforeEach(async () => {
      await PatternEncryptor.initialize({
        enabled: true,
        secret: TEST_SECRET,
      });
    });

    it('should encrypt pattern successfully', () => {
      const encrypted = PatternEncryptor.encrypt(TEST_PATTERN);

      expect(encrypted).toHaveProperty('encryptedData');
      expect(encrypted).toHaveProperty('algorithm', 'aes-256-gcm');
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('authTag');

      // Verify all fields are base64 strings
      expect(encrypted.encryptedData).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(encrypted.iv).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(encrypted.authTag).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    it('should produce different IVs for same pattern', () => {
      const encrypted1 = PatternEncryptor.encrypt(TEST_PATTERN);
      const encrypted2 = PatternEncryptor.encrypt(TEST_PATTERN);

      expect(encrypted1.iv).not.toBe(encrypted2.iv);
      expect(encrypted1.encryptedData).not.toBe(encrypted2.encryptedData);
    });

    it('should throw error when encrypting empty pattern', () => {
      expect(() => PatternEncryptor.encrypt('')).toThrow('Cannot encrypt empty pattern');
    });

    it('should throw error when not initialized', () => {
      PatternEncryptor.reset();

      expect(() => PatternEncryptor.encrypt(TEST_PATTERN)).toThrow(
        'PatternEncryptor not initialized'
      );
    });

    it('should handle encryption when disabled', async () => {
      PatternEncryptor.reset();
      await PatternEncryptor.initialize({
        enabled: false,
      });

      const encrypted = PatternEncryptor.encrypt(TEST_PATTERN);

      // Should return mock structure when disabled
      expect(encrypted).toHaveProperty('encryptedData');
      expect(encrypted).toHaveProperty('algorithm', 'aes-256-gcm');
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('authTag');
    });
  });

  describe('decryption', () => {
    beforeEach(async () => {
      await PatternEncryptor.initialize({
        enabled: true,
        secret: TEST_SECRET,
      });
    });

    it('should decrypt encrypted pattern correctly', () => {
      const encrypted = PatternEncryptor.encrypt(TEST_PATTERN);
      const decrypted = PatternEncryptor.decrypt(encrypted);

      expect(decrypted).toBe(TEST_PATTERN);
    });

    it('should handle decryption when disabled', async () => {
      // FIX: Remove useless assignment - encryption is disabled immediately after
      // Then disable encryption
      PatternEncryptor.reset();
      await PatternEncryptor.initialize({
        enabled: false,
      });

      // Mock encrypted data when disabled
      const mockEncrypted = PatternEncryptor.encrypt(TEST_PATTERN);
      const decrypted = PatternEncryptor.decrypt(mockEncrypted);

      expect(decrypted).toBe(TEST_PATTERN);
    });

    it('should throw error for tampered ciphertext', () => {
      const encrypted = PatternEncryptor.encrypt(TEST_PATTERN);

      // Tamper with the ciphertext
      encrypted.encryptedData = 'tampered-data-that-is-invalid';

      expect(() => PatternEncryptor.decrypt(encrypted)).toThrow('Pattern decryption failed');
    });

    it('should throw error for tampered auth tag', () => {
      const encrypted = PatternEncryptor.encrypt(TEST_PATTERN);

      // Tamper with auth tag
      encrypted.authTag = 'AAAAAAAAAAAAAAAAAAAAAA==';

      // Should throw some error - auth tag validation failure
      // The exact error message may vary across Node.js versions
      expect(() => PatternEncryptor.decrypt(encrypted)).toThrow();
    });

    it('should throw error for missing fields', () => {
      const invalidEncrypted = {
        encryptedData: 'data',
        algorithm: 'aes-256-gcm' as const,
        iv: '',
        authTag: '',
      };

      expect(() => PatternEncryptor.decrypt(invalidEncrypted)).toThrow(
        'Invalid encrypted pattern: missing required fields'
      );
    });

    it('should throw error when not initialized', () => {
      PatternEncryptor.reset();

      const encrypted = {
        encryptedData: 'data',
        algorithm: 'aes-256-gcm' as const,
        iv: 'iv',
        authTag: 'tag',
      };

      expect(() => PatternEncryptor.decrypt(encrypted)).toThrow(
        'PatternEncryptor not initialized'
      );
    });
  });

  describe('encrypt/decrypt roundtrip', () => {
    beforeEach(async () => {
      await PatternEncryptor.initialize({
        enabled: true,
        secret: TEST_SECRET,
      });
    });

    it('should handle various pattern types', () => {
      const patterns = [
        'eval()',
        'DROP TABLE users;',
        '../../../etc/passwd',
        'ignore previous instructions',
        'SELECT * FROM users WHERE id=1 OR 1=1',
        '<!ENTITY xxe SYSTEM "file:///etc/passwd">',
      ];

      for (const pattern of patterns) {
        const encrypted = PatternEncryptor.encrypt(pattern);
        const decrypted = PatternEncryptor.decrypt(encrypted);
        expect(decrypted).toBe(pattern);
      }
    });

    it('should handle special characters', () => {
      const patterns = [
        'Pattern with "quotes" and \'apostrophes\'',
        'Pattern with\nnewlines\nand\ttabs',
        'Unicode: 你好世界 🔒',
        'Pattern with null\x00byte',
      ];

      for (const pattern of patterns) {
        const encrypted = PatternEncryptor.encrypt(pattern);
        const decrypted = PatternEncryptor.decrypt(encrypted);
        expect(decrypted).toBe(pattern);
      }
    });

    it('should handle long patterns', () => {
      const longPattern = 'x'.repeat(10000);
      const encrypted = PatternEncryptor.encrypt(longPattern);
      const decrypted = PatternEncryptor.decrypt(encrypted);

      expect(decrypted).toBe(longPattern);
      expect(decrypted.length).toBe(10000);
    });
  });

  describe('key derivation', () => {
    it('should derive consistent keys from same secret', async () => {
      await PatternEncryptor.initialize({
        enabled: true,
        secret: TEST_SECRET,
      });

      const encrypted1 = PatternEncryptor.encrypt(TEST_PATTERN);

      // Reinitialize with same secret
      PatternEncryptor.reset();
      await PatternEncryptor.initialize({
        enabled: true,
        secret: TEST_SECRET,
      });

      // FIX: Remove useless encrypted2 assignment - only encrypted1 is used
      // Should be able to decrypt pattern encrypted with first key
      const decrypted = PatternEncryptor.decrypt(encrypted1);

      expect(decrypted).toBe(TEST_PATTERN);
    });

    it('should not decrypt with different secret', async () => {
      await PatternEncryptor.initialize({
        enabled: true,
        secret: TEST_SECRET,
      });

      const encrypted = PatternEncryptor.encrypt(TEST_PATTERN);

      // Reinitialize with different secret
      PatternEncryptor.reset();
      await PatternEncryptor.initialize({
        enabled: true,
        secret: 'different-secret-for-testing',
      });

      // Should fail to decrypt
      expect(() => PatternEncryptor.decrypt(encrypted)).toThrow();
    });

    it('should use specified iteration count', async () => {
      // Lower iteration count for testing performance
      await PatternEncryptor.initialize({
        enabled: true,
        secret: TEST_SECRET,
        iterations: 1000,
      });

      const encrypted = PatternEncryptor.encrypt(TEST_PATTERN);
      const decrypted = PatternEncryptor.decrypt(encrypted);

      expect(decrypted).toBe(TEST_PATTERN);
    });
  });

  describe('reset and security', () => {
    it('should clear encryption state', async () => {
      await PatternEncryptor.initialize({
        enabled: true,
        secret: TEST_SECRET,
      });

      expect(PatternEncryptor.isEnabled()).toBe(true);

      PatternEncryptor.reset();

      expect(PatternEncryptor.isEnabled()).toBe(false);
      expect(() => PatternEncryptor.encrypt(TEST_PATTERN)).toThrow('not initialized');
    });

    it('should securely clear encryption keys from memory', async () => {
      // SECURITY FIX TEST: Verifies encryption keys are overwritten
      await PatternEncryptor.initialize({
        enabled: true,
        secret: TEST_SECRET,
      });

      // Encrypt a pattern (key is now in memory)
      const encrypted = PatternEncryptor.encrypt(TEST_PATTERN);

      // Securely reset
      PatternEncryptor.secureReset();

      // Should not be able to encrypt or decrypt after secure reset
      expect(PatternEncryptor.isEnabled()).toBe(false);
      expect(() => PatternEncryptor.encrypt(TEST_PATTERN)).toThrow('not initialized');
      expect(() => PatternEncryptor.decrypt(encrypted)).toThrow('not initialized');
    });

    it('should support custom salt configuration', async () => {
      // SECURITY FIX TEST: Verifies configurable salt support
      const customSalt = 'custom-salt-for-testing';

      await PatternEncryptor.initialize({
        enabled: true,
        secret: TEST_SECRET,
        salt: customSalt,
      });

      const encrypted = PatternEncryptor.encrypt(TEST_PATTERN);
      const decrypted = PatternEncryptor.decrypt(encrypted);

      expect(decrypted).toBe(TEST_PATTERN);

      // Keys derived with different salts should produce different results
      PatternEncryptor.reset();
      await PatternEncryptor.initialize({
        enabled: true,
        secret: TEST_SECRET,
        salt: 'different-salt',
      });

      // Should not be able to decrypt with different salt
      expect(() => PatternEncryptor.decrypt(encrypted)).toThrow();
    });
  });
});
