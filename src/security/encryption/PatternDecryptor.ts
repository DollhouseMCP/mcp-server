/**
 * Pattern Decryption Service with LLM Context Protection
 *
 * Part of Issue #1321 Phase 2: Memory Security Architecture
 *
 * PURPOSE:
 * Provides secure access to decrypt patterns while preventing
 * decryption in LLM request contexts. All decryption attempts
 * are audited for security monitoring.
 *
 * SECURITY:
 * - Prevents decryption in LLM contexts (blocks pattern leaks to LLM)
 * - Requires explicit authorization
 * - Audits all decryption attempts
 * - Uses ContextTracker to detect execution context
 *
 * @module PatternDecryptor
 */

import { logger } from '../../utils/logger.js';
import { PatternEncryptor } from './PatternEncryptor.js';
import { ContextTracker } from './ContextTracker.js';
import type { SanitizedPattern } from '../validation/BackgroundValidator.js';
import type { EncryptedPattern } from './PatternEncryptor.js';

/**
 * Decryption attempt metadata for audit logging
 */
export interface DecryptionAttempt {
  /** Pattern reference ID */
  patternRef: string;

  /** Whether decryption was successful */
  success: boolean;

  /** Timestamp of the attempt */
  timestamp: number;

  /** Execution context type */
  contextType: string;

  /** Request ID for correlation */
  requestId?: string;

  /** Reason for denial (if unsuccessful) */
  denialReason?: string;

  /** Error message (if failed) */
  error?: string;
}

/**
 * Decryption audit log
 * Maintains a record of all decryption attempts for security monitoring
 */
class DecryptionAuditLog {
  private static attempts: DecryptionAttempt[] = [];
  private static readonly MAX_LOG_SIZE = 1000;

  /**
   * Log a decryption attempt
   *
   * @param attempt - Decryption attempt metadata
   */
  static log(attempt: DecryptionAttempt): void {
    this.attempts.push(attempt);

    // Trim log if it exceeds max size
    if (this.attempts.length > this.MAX_LOG_SIZE) {
      this.attempts = this.attempts.slice(-this.MAX_LOG_SIZE);
    }

    // Always log to system logger for persistence
    if (attempt.success) {
      logger.info('Pattern decrypted', {
        patternRef: attempt.patternRef,
        contextType: attempt.contextType,
        requestId: attempt.requestId,
      });
    } else {
      logger.warn('Pattern decryption denied', {
        patternRef: attempt.patternRef,
        contextType: attempt.contextType,
        reason: attempt.denialReason,
        error: attempt.error,
        requestId: attempt.requestId,
      });
    }
  }

  /**
   * Get all decryption attempts
   *
   * @returns Array of decryption attempts
   */
  static getAttempts(): DecryptionAttempt[] {
    return [...this.attempts];
  }

  /**
   * Get recent decryption attempts
   *
   * @param limit - Maximum number of attempts to return
   * @returns Array of recent attempts
   */
  static getRecentAttempts(limit: number = 100): DecryptionAttempt[] {
    return this.attempts.slice(-limit);
  }

  /**
   * Clear the audit log (useful for testing)
   */
  static clear(): void {
    this.attempts = [];
    logger.debug('Decryption audit log cleared');
  }
}

/**
 * PatternDecryptor service
 *
 * Provides controlled access to decrypt encrypted patterns with
 * LLM context protection and audit logging.
 */
export class PatternDecryptor {
  /**
   * Decrypt a sanitized pattern with security checks
   *
   * This method:
   * 1. Checks if in LLM context (denies if true)
   * 2. Validates pattern structure
   * 3. Audits the decryption attempt
   * 4. Decrypts the pattern using PatternEncryptor
   *
   * @param pattern - Sanitized pattern to decrypt
   * @returns Decrypted pattern text
   * @throws Error if decryption is not allowed or fails
   */
  static decryptPattern(pattern: SanitizedPattern): string {
    const context = ContextTracker.getContext();
    const patternRef = pattern.ref;

    // Security check: Prevent decryption in LLM context
    if (ContextTracker.isLLMContext()) {
      const attempt: DecryptionAttempt = {
        patternRef,
        success: false,
        timestamp: Date.now(),
        contextType: context?.type || 'unknown',
        requestId: context?.requestId,
        denialReason: 'Decryption not allowed in LLM request context',
      };

      DecryptionAuditLog.log(attempt);

      throw new Error(
        'Pattern decryption blocked: Cannot decrypt patterns in LLM request context'
      );
    }

    // Validate pattern structure
    if (!pattern.encryptedPattern || !pattern.iv || !pattern.authTag) {
      const attempt: DecryptionAttempt = {
        patternRef,
        success: false,
        timestamp: Date.now(),
        contextType: context?.type || 'unknown',
        requestId: context?.requestId,
        denialReason: 'Pattern not encrypted or missing required fields',
      };

      DecryptionAuditLog.log(attempt);

      throw new Error(
        'Pattern decryption failed: Pattern is not encrypted or missing required fields'
      );
    }

    try {
      // Build encrypted pattern structure
      const encryptedPattern: EncryptedPattern = {
        encryptedData: pattern.encryptedPattern,
        algorithm: (pattern.algorithm as 'aes-256-gcm') || 'aes-256-gcm',
        iv: pattern.iv,
        authTag: pattern.authTag,
      };

      // Decrypt using PatternEncryptor
      const decrypted = PatternEncryptor.decrypt(encryptedPattern);

      // Log successful decryption
      const attempt: DecryptionAttempt = {
        patternRef,
        success: true,
        timestamp: Date.now(),
        contextType: context?.type || 'unknown',
        requestId: context?.requestId,
      };

      DecryptionAuditLog.log(attempt);

      return decrypted;
    } catch (error) {
      // Log failed decryption
      const attempt: DecryptionAttempt = {
        patternRef,
        success: false,
        timestamp: Date.now(),
        contextType: context?.type || 'unknown',
        requestId: context?.requestId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };

      DecryptionAuditLog.log(attempt);

      throw error;
    }
  }

  /**
   * Get decryption audit log
   *
   * @param limit - Maximum number of attempts to return
   * @returns Array of recent decryption attempts
   */
  static getAuditLog(limit?: number): DecryptionAttempt[] {
    if (limit !== undefined) {
      return DecryptionAuditLog.getRecentAttempts(limit);
    }
    return DecryptionAuditLog.getAttempts();
  }

  /**
   * Clear the audit log (useful for testing)
   */
  static clearAuditLog(): void {
    DecryptionAuditLog.clear();
  }
}
