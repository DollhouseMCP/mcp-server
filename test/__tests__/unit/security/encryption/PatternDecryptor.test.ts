/**
 * Unit tests for PatternDecryptor
 *
 * Tests LLM context protection, audit logging, and decryption access control
 *
 * Part of Issue #1321 Phase 2
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { PatternDecryptor } from '../../../../../src/security/encryption/PatternDecryptor.js';
import { PatternEncryptor } from '../../../../../src/security/encryption/PatternEncryptor.js';
import { ContextTracker } from '../../../../../src/security/encryption/ContextTracker.js';
import type { SanitizedPattern } from '../../../../../src/security/validation/BackgroundValidator.js';

/**
 * Helper to create a mock sanitized pattern with encryption
 * FIX: Moved to module scope to comply with SonarCloud best practices
 */
function createEncryptedPattern(pattern: string): SanitizedPattern {
  const encrypted = PatternEncryptor.encrypt(pattern);

  return {
    ref: 'PATTERN_001',
    description: 'Test pattern',
    severity: 'high',
    location: 'offset 0, length 10',
    safetyInstruction: 'DO NOT EXECUTE',
    encryptedPattern: encrypted.encryptedData,
    algorithm: encrypted.algorithm,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
  };
}

describe('PatternDecryptor', () => {
  const TEST_SECRET = 'test-secret-for-pattern-decryption-testing';
  const TEST_PATTERN = 'eval(malicious.code())';

  beforeEach(async () => {
    // Initialize encryptor
    PatternEncryptor.reset();
    await PatternEncryptor.initialize({
      enabled: true,
      secret: TEST_SECRET,
    });

    // Clear audit log
    PatternDecryptor.clearAuditLog();

    // Clear context
    ContextTracker.clearContext();
  });

  afterEach(() => {
    PatternEncryptor.reset();
    PatternDecryptor.clearAuditLog();
  });

  // FIX: Move helper function to outer scope to reduce nesting
  // This was previously nested inside describe block

  describe('decryptPattern - LLM context protection', () => {
    it('should decrypt pattern when not in LLM context', () => {
      const encrypted = createEncryptedPattern(TEST_PATTERN);

      const decrypted = PatternDecryptor.decryptPattern(encrypted);

      expect(decrypted).toBe(TEST_PATTERN);
    });

    it('should block decryption in LLM context', () => {
      const encrypted = createEncryptedPattern(TEST_PATTERN);
      const llmContext = ContextTracker.createContext('llm-request');

      // FIX: Extract nested function to reduce nesting depth
      const attemptDecrypt = () => {
        ContextTracker.run(llmContext, () => {
          PatternDecryptor.decryptPattern(encrypted);
        });
      };

      expect(attemptDecrypt).toThrow(
        'Pattern decryption blocked: Cannot decrypt patterns in LLM request context'
      );
    });

    it('should allow decryption in background-task context', () => {
      const encrypted = createEncryptedPattern(TEST_PATTERN);
      const bgContext = ContextTracker.createContext('background-task');

      const decrypted = ContextTracker.run(bgContext, () => {
        return PatternDecryptor.decryptPattern(encrypted);
      });

      expect(decrypted).toBe(TEST_PATTERN);
    });

    it('should allow decryption in test context', () => {
      const encrypted = createEncryptedPattern(TEST_PATTERN);
      const testContext = ContextTracker.createContext('test');

      const decrypted = ContextTracker.run(testContext, () => {
        return PatternDecryptor.decryptPattern(encrypted);
      });

      expect(decrypted).toBe(TEST_PATTERN);
    });
  });

  describe('decryptPattern - validation', () => {
    it('should throw error for pattern without encrypted data', () => {
      const invalidPattern: SanitizedPattern = {
        ref: 'PATTERN_001',
        description: 'Test',
        severity: 'high',
        location: 'offset 0',
        safetyInstruction: 'DO NOT EXECUTE',
        // Missing encryption fields
      };

      expect(() => PatternDecryptor.decryptPattern(invalidPattern)).toThrow(
        'Pattern is not encrypted or missing required fields'
      );
    });

    it('should throw error for pattern with incomplete encryption data', () => {
      const invalidPattern: SanitizedPattern = {
        ref: 'PATTERN_001',
        description: 'Test',
        severity: 'high',
        location: 'offset 0',
        safetyInstruction: 'DO NOT EXECUTE',
        encryptedPattern: 'data',
        algorithm: 'aes-256-gcm',
        // Missing iv and authTag
      };

      expect(() => PatternDecryptor.decryptPattern(invalidPattern)).toThrow(
        'Pattern is not encrypted or missing required fields'
      );
    });
  });

  describe('audit logging', () => {
    it('should log successful decryption', () => {
      const encrypted = createEncryptedPattern(TEST_PATTERN);

      PatternDecryptor.decryptPattern(encrypted);

      const auditLog = PatternDecryptor.getAuditLog();
      expect(auditLog).toHaveLength(1);
      expect(auditLog[0]).toMatchObject({
        patternRef: 'PATTERN_001',
        success: true,
        contextType: 'unknown',
      });
    });

    it('should log blocked decryption in LLM context', () => {
      const encrypted = createEncryptedPattern(TEST_PATTERN);
      const llmContext = ContextTracker.createContext('llm-request');

      // FIX: Extract nested function to reduce nesting depth
      const attemptDecrypt = () => {
        ContextTracker.run(llmContext, () => {
          PatternDecryptor.decryptPattern(encrypted);
        });
      };

      expect(attemptDecrypt).toThrow();

      const auditLog = PatternDecryptor.getAuditLog();
      expect(auditLog).toHaveLength(1);
      expect(auditLog[0]).toMatchObject({
        patternRef: 'PATTERN_001',
        success: false,
        contextType: 'llm-request',
        denialReason: 'Decryption not allowed in LLM request context',
      });
    });

    it('should log failed decryption with error', () => {
      const invalidPattern: SanitizedPattern = {
        ref: 'PATTERN_002',
        description: 'Test',
        severity: 'high',
        location: 'offset 0',
        safetyInstruction: 'DO NOT EXECUTE',
        encryptedPattern: 'invalid-data',
        algorithm: 'aes-256-gcm',
        iv: 'invalid-iv',
        authTag: 'invalid-tag',
      };

      expect(() => PatternDecryptor.decryptPattern(invalidPattern)).toThrow();

      const auditLog = PatternDecryptor.getAuditLog();
      expect(auditLog).toHaveLength(1);
      expect(auditLog[0]).toMatchObject({
        patternRef: 'PATTERN_002',
        success: false,
        contextType: 'unknown',
      });
      expect(auditLog[0].error).toBeDefined();
    });

    it('should include request ID in audit log', () => {
      const encrypted = createEncryptedPattern(TEST_PATTERN);
      const context = ContextTracker.createContext('background-task');

      ContextTracker.run(context, () => {
        PatternDecryptor.decryptPattern(encrypted);
      });

      const auditLog = PatternDecryptor.getAuditLog();
      expect(auditLog[0].requestId).toBe(context.requestId);
    });

    it('should maintain audit log across multiple operations', () => {
      const pattern1 = createEncryptedPattern('pattern1');
      const pattern2 = createEncryptedPattern('pattern2');
      const pattern3 = createEncryptedPattern('pattern3');

      PatternDecryptor.decryptPattern(pattern1);
      PatternDecryptor.decryptPattern(pattern2);
      PatternDecryptor.decryptPattern(pattern3);

      const auditLog = PatternDecryptor.getAuditLog();
      expect(auditLog).toHaveLength(3);
      expect(auditLog.every((entry) => entry.success)).toBe(true);
    });

    it('should limit audit log with parameter', () => {
      // Create multiple decryption attempts
      for (let i = 0; i < 10; i++) {
        const pattern = createEncryptedPattern(`pattern${i}`);
        PatternDecryptor.decryptPattern(pattern);
      }

      const recentLog = PatternDecryptor.getAuditLog(5);
      expect(recentLog).toHaveLength(5);
    });

    it('should clear audit log', () => {
      const pattern = createEncryptedPattern(TEST_PATTERN);
      PatternDecryptor.decryptPattern(pattern);

      expect(PatternDecryptor.getAuditLog()).toHaveLength(1);

      PatternDecryptor.clearAuditLog();

      expect(PatternDecryptor.getAuditLog()).toHaveLength(0);
    });
  });

  describe('decryption with different contexts', () => {
    it('should track context type in audit log', () => {
      const encrypted = createEncryptedPattern(TEST_PATTERN);
      const contexts = [
        ContextTracker.createContext('background-task'),
        ContextTracker.createContext('test'),
        ContextTracker.createContext('unknown'),
      ];

      for (const context of contexts) {
        ContextTracker.run(context, () => {
          PatternDecryptor.decryptPattern(encrypted);
        });
      }

      const auditLog = PatternDecryptor.getAuditLog();
      expect(auditLog).toHaveLength(3);
      expect(auditLog[0].contextType).toBe('background-task');
      expect(auditLog[1].contextType).toBe('test');
      expect(auditLog[2].contextType).toBe('unknown');
    });
  });

  describe('decrypt roundtrip with PatternEncryptor', () => {
    it('should decrypt patterns encrypted by PatternEncryptor', () => {
      const patterns = [
        'eval()',
        'DROP TABLE users;',
        '../../../etc/passwd',
        'SELECT * FROM users WHERE id=1 OR 1=1',
      ];

      for (const pattern of patterns) {
        const encrypted = createEncryptedPattern(pattern);
        const decrypted = PatternDecryptor.decryptPattern(encrypted);
        expect(decrypted).toBe(pattern);
      }
    });

    it('should handle special characters', () => {
      const pattern = 'Pattern with\nnewlines and "quotes" and 你好';
      const encrypted = createEncryptedPattern(pattern);
      const decrypted = PatternDecryptor.decryptPattern(encrypted);

      expect(decrypted).toBe(pattern);
    });
  });

  describe('edge cases', () => {
    it('should handle concurrent decryption requests', async () => {
      const patterns = Array.from({ length: 5 }, (_, i) => createEncryptedPattern(`pattern${i}`));

      // FIX: Extract promise creation to helper function to reduce nesting depth
      const decryptInContext = (pattern: SanitizedPattern) => {
        return new Promise((resolve) => {
          const context = ContextTracker.createContext('background-task');
          resolve(ContextTracker.run(context, () => PatternDecryptor.decryptPattern(pattern)));
        });
      };

      const decryptions = patterns.map(decryptInContext);
      const results = await Promise.all(decryptions);

      expect(results).toHaveLength(5);
      expect(PatternDecryptor.getAuditLog()).toHaveLength(5);
    });
  });
});
