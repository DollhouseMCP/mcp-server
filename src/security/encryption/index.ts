/**
 * Pattern Encryption Module
 *
 * Part of Issue #1321 Phase 2: Memory Security Architecture
 *
 * Exports encryption services for pattern security:
 * - PatternEncryptor: AES-256-GCM encryption/decryption
 * - PatternDecryptor: Secure decryption with LLM context protection
 * - ContextTracker: Execution context tracking for security
 *
 * @module security/encryption
 */

export { PatternEncryptor } from './PatternEncryptor.js';
export { PatternDecryptor } from './PatternDecryptor.js';
export { ContextTracker } from './ContextTracker.js';

export type { EncryptedPattern, EncryptionConfig } from './PatternEncryptor.js';
export type { DecryptionAttempt } from './PatternDecryptor.js';
export type { ExecutionContext } from './ContextTracker.js';
