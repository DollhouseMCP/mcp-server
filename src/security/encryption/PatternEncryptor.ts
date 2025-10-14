/**
 * Pattern Encryption Service for Memory Security
 *
 * Part of Issue #1321 Phase 2: Memory Security Architecture
 *
 * PURPOSE:
 * Encrypts dangerous patterns extracted from FLAGGED memories using AES-256-GCM.
 * Ensures patterns are never stored in plain text while remaining accessible
 * for authorized security research outside LLM contexts.
 *
 * ARCHITECTURE:
 * - Uses AES-256-GCM for authenticated encryption
 * - Derives keys from DOLLHOUSE_ENCRYPTION_SECRET via PBKDF2
 * - Generates unique IV for each encryption operation
 * - Provides GCM authentication tags for integrity verification
 *
 * SECURITY:
 * - Patterns encrypted at rest
 * - Decryption only outside LLM context
 * - All decryption attempts logged
 * - Key rotation supported
 *
 * @module PatternEncryptor
 */

import { randomBytes, createCipheriv, createDecipheriv, pbkdf2 } from 'node:crypto';
import { logger } from '../../utils/logger.js';

/**
 * Encrypted pattern structure
 * Contains ciphertext, algorithm metadata, and authentication data
 */
export interface EncryptedPattern {
  /** Base64-encoded encrypted data */
  encryptedData: string;

  /** Encryption algorithm (always 'aes-256-gcm') */
  algorithm: 'aes-256-gcm';

  /** Base64-encoded initialization vector */
  iv: string;

  /** Base64-encoded GCM authentication tag for integrity */
  authTag: string;
}

/**
 * Configuration for pattern encryption
 */
export interface EncryptionConfig {
  /** Enable encryption (default: true in production) */
  enabled: boolean;

  /** Encryption secret (from environment) */
  secret?: string;

  /** PBKDF2 iterations (default: 100000) */
  iterations: number;

  /** Salt for key derivation (default: 'dollhouse-pattern-encryption-v1') */
  salt: string;
}

/**
 * Default encryption configuration
 */
const DEFAULT_CONFIG: EncryptionConfig = {
  enabled: process.env.NODE_ENV === 'production',
  secret: process.env.DOLLHOUSE_ENCRYPTION_SECRET,
  iterations: 100000,
  // SECURITY FIX: Configurable salt to prevent rainbow table attacks
  // Falls back to default only if not configured
  salt: process.env.DOLLHOUSE_ENCRYPTION_SALT || 'dollhouse-pattern-encryption-v1',
};

/**
 * PatternEncryptor service
 *
 * Handles encryption and decryption of dangerous patterns using AES-256-GCM.
 * Provides authenticated encryption with integrity protection via GCM mode.
 */
export class PatternEncryptor {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly KEY_LENGTH = 32; // 256 bits
  private static readonly IV_LENGTH = 16; // 128 bits
  private static readonly AUTH_TAG_LENGTH = 16; // 128 bits

  private static config: EncryptionConfig = DEFAULT_CONFIG;
  private static encryptionKey?: Buffer;
  private static isInitialized: boolean = false;

  /**
   * Initialize encryption with configuration
   *
   * @param config - Optional configuration overrides
   * @throws Error if encryption secret is not provided when enabled
   */
  static async initialize(config?: Partial<EncryptionConfig>): Promise<void> {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (!this.config.enabled) {
      logger.info('Pattern encryption disabled');
      this.isInitialized = true;
      return;
    }

    if (!this.config.secret) {
      throw new Error(
        'DOLLHOUSE_ENCRYPTION_SECRET environment variable is required when encryption is enabled'
      );
    }

    logger.info('Initializing pattern encryption', {
      algorithm: this.ALGORITHM,
      iterations: this.config.iterations,
    });

    // Derive encryption key from secret
    this.encryptionKey = await this.deriveKey(
      this.config.secret,
      this.config.salt,
      this.config.iterations
    );

    this.isInitialized = true;
    logger.info('Pattern encryption initialized successfully');
  }

  /**
   * Encrypt a pattern using AES-256-GCM
   *
   * @param pattern - Plain text pattern to encrypt
   * @returns Encrypted pattern with metadata
   * @throws Error if encryption not initialized or pattern is empty
   */
  static encrypt(pattern: string): EncryptedPattern {
    if (!this.isInitialized) {
      throw new Error('PatternEncryptor not initialized. Call initialize() first.');
    }

    if (!this.config.enabled) {
      // Encryption disabled - return mock encrypted structure
      // This allows testing without encryption enabled
      logger.debug('Encryption disabled, returning mock structure');
      return {
        encryptedData: Buffer.from(pattern).toString('base64'),
        algorithm: this.ALGORITHM,
        iv: randomBytes(this.IV_LENGTH).toString('base64'),
        authTag: randomBytes(this.AUTH_TAG_LENGTH).toString('base64'),
      };
    }

    if (!pattern || pattern.length === 0) {
      throw new Error('Cannot encrypt empty pattern');
    }

    if (!this.encryptionKey) {
      throw new Error('Encryption key not available');
    }

    logger.debug('Encrypting pattern', {
      patternLength: pattern.length,
    });

    try {
      // Generate random IV for this encryption
      const iv = randomBytes(this.IV_LENGTH);

      // Create cipher with AES-256-GCM
      const cipher = createCipheriv(this.ALGORITHM, this.encryptionKey, iv);

      // Encrypt the pattern
      let encrypted = cipher.update(pattern, 'utf8', 'base64');
      encrypted += cipher.final('base64');

      // Get authentication tag from GCM mode
      const authTag = cipher.getAuthTag();

      logger.debug('Pattern encrypted successfully', {
        ivLength: iv.length,
        authTagLength: authTag.length,
        encryptedLength: encrypted.length,
      });

      return {
        encryptedData: encrypted,
        algorithm: this.ALGORITHM,
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
      };
    } catch (error) {
      logger.error('Failed to encrypt pattern', { error });
      throw new Error(`Pattern encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Decrypt an encrypted pattern
   *
   * @param encrypted - Encrypted pattern structure
   * @returns Decrypted plain text pattern
   * @throws Error if decryption fails or authentication fails
   */
  static decrypt(encrypted: EncryptedPattern): string {
    if (!this.isInitialized) {
      throw new Error('PatternEncryptor not initialized. Call initialize() first.');
    }

    if (!this.config.enabled) {
      // Encryption disabled - decode the base64 mock data
      logger.debug('Encryption disabled, decoding mock structure');
      return Buffer.from(encrypted.encryptedData, 'base64').toString('utf8');
    }

    if (!this.encryptionKey) {
      throw new Error('Encryption key not available');
    }

    if (!encrypted.encryptedData || !encrypted.iv || !encrypted.authTag) {
      throw new Error('Invalid encrypted pattern: missing required fields');
    }

    logger.debug('Decrypting pattern', {
      algorithm: encrypted.algorithm,
    });

    try {
      // Decode base64 components
      const iv = Buffer.from(encrypted.iv, 'base64');
      const authTag = Buffer.from(encrypted.authTag, 'base64');

      // Create decipher with AES-256-GCM
      const decipher = createDecipheriv(this.ALGORITHM, this.encryptionKey, iv);

      // Set authentication tag for verification
      decipher.setAuthTag(authTag);

      // Decrypt the pattern
      let decrypted = decipher.update(encrypted.encryptedData, 'base64', 'utf8');
      decrypted += decipher.final('utf8');

      logger.debug('Pattern decrypted successfully', {
        decryptedLength: decrypted.length,
      });

      return decrypted;
    } catch (error) {
      logger.error('Failed to decrypt pattern', { error });

      // Authentication failure means data was tampered with
      // Check for various GCM authentication error messages
      if (error instanceof Error) {
        const errorMsg = error.message.toLowerCase();
        if (
          errorMsg.includes('auth') ||
          errorMsg.includes('decrypt') ||
          errorMsg.includes('unsupported state') ||
          errorMsg.includes('unable to authenticate')
        ) {
          throw new Error('Pattern decryption failed: Authentication tag mismatch (data may be corrupted or tampered)');
        }
      }

      throw new Error(`Pattern decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Derive encryption key from secret using PBKDF2
   *
   * @param secret - Master secret from environment
   * @param salt - Salt for key derivation
   * @param iterations - Number of PBKDF2 iterations
   * @returns Derived encryption key
   */
  private static async deriveKey(
    secret: string,
    salt: string,
    iterations: number
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      pbkdf2(
        secret,
        salt,
        iterations,
        this.KEY_LENGTH,
        'sha256',
        (err, derivedKey) => {
          if (err) {
            logger.error('Key derivation failed', { error: err });
            reject(new Error(`Failed to derive encryption key: ${err.message}`));
          } else {
            logger.debug('Encryption key derived successfully', {
              keyLength: derivedKey.length,
              iterations,
            });
            resolve(derivedKey);
          }
        }
      );
    });
  }

  /**
   * Check if encryption is enabled
   *
   * @returns true if encryption is enabled and initialized
   */
  static isEnabled(): boolean {
    return this.config.enabled && this.isInitialized;
  }

  /**
   * Get encryption configuration status
   *
   * @returns Configuration status (without exposing secrets)
   */
  static getStatus() {
    return {
      enabled: this.config.enabled,
      initialized: this.isInitialized,
      algorithm: this.ALGORITHM,
      keyLength: this.KEY_LENGTH,
      iterations: this.config.iterations,
      hasSecret: !!this.config.secret,
    };
  }

  /**
   * Securely clear encryption key from memory
   * SECURITY FIX: Overwrites key buffer with zeros before releasing
   *
   * This prevents key recovery from memory dumps or process inspection.
   * Should be called when encryption is no longer needed.
   */
  private static secureKeyClear(): void {
    if (this.encryptionKey) {
      // Overwrite key material with zeros
      this.encryptionKey.fill(0);
      this.encryptionKey = undefined;
      logger.debug('Encryption key securely cleared from memory');
    }
  }

  /**
   * Reset the encryptor (useful for testing)
   * SECURITY FIX: Now performs secure key clearing
   * WARNING: This will securely clear the encryption key from memory
   */
  static reset(): void {
    this.secureKeyClear();
    this.isInitialized = false;
    this.config = DEFAULT_CONFIG;
    logger.debug('PatternEncryptor reset');
  }

  /**
   * Securely reset the encryptor and clear all sensitive data
   * SECURITY: Explicitly clears encryption keys from memory
   *
   * Use this when:
   * - Shutting down the application
   * - Rotating encryption keys
   * - Responding to security incidents
   */
  static secureReset(): void {
    this.secureKeyClear();
    this.isInitialized = false;
    this.config = DEFAULT_CONFIG;
    logger.info('PatternEncryptor securely reset - all sensitive data cleared');
  }
}
