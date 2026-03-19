/**
 * Unit tests for PatternDecryptor
 *
 * Tests LLM context protection, audit logging, and decryption access control
 *
 * Part of Issue #1321 Phase 2
 * DI REFACTOR: Adapted for instance-based architecture
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { PatternDecryptor } from '../../../../src/security/encryption/PatternDecryptor.js';
import { PatternEncryptor } from '../../../../src/security/encryption/PatternEncryptor.js';
import { ContextTracker } from '../../../../src/security/encryption/ContextTracker.js';
import type { SanitizedPattern } from '../../../../src/security/validation/BackgroundValidator.js';

describe('PatternDecryptor', () => {
  const TEST_SECRET = 'test-secret-for-pattern-decryption-testing';
  const TEST_PATTERN = 'eval(malicious.code())';

  // DI REFACTOR: Create instances for each test
  let decryptor: PatternDecryptor;
  let encryptor: PatternEncryptor;
  let tracker: ContextTracker;

  /**
   * Helper to create a mock sanitized pattern with encryption
   * DI REFACTOR: Uses instance-based encryptor
   */
  function createEncryptedPattern(pattern: string): SanitizedPattern {
    const encrypted = encryptor.encrypt(pattern);

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

  /**
   * Helper to attempt decryption in an LLM context (should throw)
   * DI REFACTOR: Uses instance-based tracker and decryptor
   */
  function attemptDecryptInLLMContext(
    encrypted: SanitizedPattern,
    llmContext: ReturnType<typeof tracker.createContext>
  ): void {
    tracker.run(llmContext, () => {
      decryptor.decryptPattern(encrypted);
    });
  }

  /**
   * Helper for concurrent decryption in context
   * DI REFACTOR: Uses instance-based tracker and decryptor
   */
  function decryptInContext(pattern: SanitizedPattern): Promise<string> {
    const context = tracker.createContext('background-task');
    return Promise.resolve(tracker.run(context, () => decryptor.decryptPattern(pattern)));
  }

  beforeEach(async () => {
    // Create fresh instances before each test
    encryptor = new PatternEncryptor();
    decryptor = new PatternDecryptor(encryptor, tracker = new ContextTracker());

    // Initialize encryptor
    await encryptor.initialize({
      enabled: true,
      secret: TEST_SECRET,
    });

    // Clear audit log
    decryptor.clearAuditLog();

    // Clear context
    tracker.clearContext();
  });

  afterEach(() => {
    encryptor.reset();
    decryptor.clearAuditLog();
  });

  describe('decryptPattern - LLM context protection', () => {
    it('should decrypt pattern when not in LLM context', () => {
      const encrypted = createEncryptedPattern(TEST_PATTERN);

      const decrypted = decryptor.decryptPattern(encrypted);

      expect(decrypted).toBe(TEST_PATTERN);
    });

    it('should block decryption in LLM context', () => {
      const encrypted = createEncryptedPattern(TEST_PATTERN);
      const llmContext = tracker.createContext('llm-request');

      // FIX: Use module-scope helper to reduce nesting depth
      expect(() => attemptDecryptInLLMContext(encrypted, llmContext)).toThrow(
        'Pattern decryption blocked: Cannot decrypt patterns in LLM request context'
      );
    });

    it('should allow decryption in background-task context', () => {
      const encrypted = createEncryptedPattern(TEST_PATTERN);
      const bgContext = tracker.createContext('background-task');

      const decrypted = tracker.run(bgContext, () => {
        return decryptor.decryptPattern(encrypted);
      });

      expect(decrypted).toBe(TEST_PATTERN);
    });

    it('should allow decryption in test context', () => {
      const encrypted = createEncryptedPattern(TEST_PATTERN);
      const testContext = tracker.createContext('test');

      const decrypted = tracker.run(testContext, () => {
        return decryptor.decryptPattern(encrypted);
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

      expect(() => decryptor.decryptPattern(invalidPattern)).toThrow(
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

      expect(() => decryptor.decryptPattern(invalidPattern)).toThrow(
        'Pattern is not encrypted or missing required fields'
      );
    });
  });

  describe('audit logging', () => {
    it('should log successful decryption', () => {
      const encrypted = createEncryptedPattern(TEST_PATTERN);

      decryptor.decryptPattern(encrypted);

      const auditLog = decryptor.getAuditLog();
      expect(auditLog).toHaveLength(1);
      expect(auditLog[0]).toMatchObject({
        patternRef: 'PATTERN_001',
        success: true,
        contextType: 'unknown',
      });
    });

    it('should log blocked decryption in LLM context', () => {
      const encrypted = createEncryptedPattern(TEST_PATTERN);
      const llmContext = tracker.createContext('llm-request');

      // FIX: Use module-scope helper to reduce nesting and eliminate duplication
      expect(() => attemptDecryptInLLMContext(encrypted, llmContext)).toThrow();

      const auditLog = decryptor.getAuditLog();
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

      expect(() => decryptor.decryptPattern(invalidPattern)).toThrow();

      const auditLog = decryptor.getAuditLog();
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
      const context = tracker.createContext('background-task');

      tracker.run(context, () => {
        decryptor.decryptPattern(encrypted);
      });

      const auditLog = decryptor.getAuditLog();
      expect(auditLog[0].requestId).toBe(context.requestId);
    });

    it('should maintain audit log across multiple operations', () => {
      const pattern1 = createEncryptedPattern('pattern1');
      const pattern2 = createEncryptedPattern('pattern2');
      const pattern3 = createEncryptedPattern('pattern3');

      decryptor.decryptPattern(pattern1);
      decryptor.decryptPattern(pattern2);
      decryptor.decryptPattern(pattern3);

      const auditLog = decryptor.getAuditLog();
      expect(auditLog).toHaveLength(3);
      expect(auditLog.every((entry) => entry.success)).toBe(true);
    });

    it('should limit audit log with parameter', () => {
      // Create multiple decryption attempts
      for (let i = 0; i < 10; i++) {
        const pattern = createEncryptedPattern(`pattern${i}`);
        decryptor.decryptPattern(pattern);
      }

      const recentLog = decryptor.getAuditLog(5);
      expect(recentLog).toHaveLength(5);
    });

    it('should clear audit log', () => {
      const pattern = createEncryptedPattern(TEST_PATTERN);
      decryptor.decryptPattern(pattern);

      expect(decryptor.getAuditLog()).toHaveLength(1);

      decryptor.clearAuditLog();

      expect(decryptor.getAuditLog()).toHaveLength(0);
    });
  });

  describe('decryption with different contexts', () => {
    it('should track context type in audit log', () => {
      const encrypted = createEncryptedPattern(TEST_PATTERN);
      const contexts = [
        tracker.createContext('background-task'),
        tracker.createContext('test'),
        tracker.createContext('unknown'),
      ];

      for (const context of contexts) {
        tracker.run(context, () => {
          decryptor.decryptPattern(encrypted);
        });
      }

      const auditLog = decryptor.getAuditLog();
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
        const decrypted = decryptor.decryptPattern(encrypted);
        expect(decrypted).toBe(pattern);
      }
    });

    it('should handle special characters', () => {
      const pattern = 'Pattern with\nnewlines and "quotes" and 你好';
      const encrypted = createEncryptedPattern(pattern);
      const decrypted = decryptor.decryptPattern(encrypted);

      expect(decrypted).toBe(pattern);
    });
  });

  describe('edge cases', () => {
    it('should handle concurrent decryption requests', async () => {
      const patterns = Array.from({ length: 5 }, (_, i) => createEncryptedPattern(`pattern${i}`));

      // FIX: Use module-scope helper to reduce nesting depth
      const decryptions = patterns.map(decryptInContext);
      const results = await Promise.all(decryptions);

      expect(results).toHaveLength(5);
      expect(decryptor.getAuditLog()).toHaveLength(5);
    });
  });
});
