/**
 * Utility functions for Memory element operations
 *
 * PERFORMANCE CONSIDERATIONS:
 * - ID generation should be fast (<1ms)
 * - Hash functions optimized for memory verification
 * - Index operations designed for O(log n) complexity
 *
 * SECURITY CONSIDERATIONS:
 * - Hash functions normalize Unicode to prevent bypass attempts
 * - Content verification detects external modifications
 * - Protects against manual editing and tampering
 */

import * as crypto from 'crypto';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { MEMORY_SECURITY_EVENTS } from './constants.js';

/**
 * Generate a unique ID for memory entries
 * Format: mem_{timestamp}_{random}
 *
 * @returns Unique memory entry ID
 * @example
 * generateMemoryId() // "mem_1699234567890_x7k2n9p4m"
 */
export function generateMemoryId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substr(2, 9);
  return `mem_${timestamp}_${random}`;
}

/**
 * Generate a content hash for memory integrity verification
 * Uses SHA-256 for cryptographic strength with Unicode normalization
 *
 * SECURITY: Normalizes content to prevent Unicode-based bypass attempts
 * where attackers use homographs or invisible characters to create
 * content that appears identical but has a different hash
 *
 * @param content - The content to hash (will be normalized)
 * @returns Hex-encoded hash string
 */
export function generateContentHash(content: string): string {
  // SECURITY FIX: Normalize Unicode to prevent homograph attacks
  // This ensures consistent hashing regardless of Unicode representation
  const normalized = UnicodeValidator.normalize(content);

  if (!normalized.isValid && normalized.detectedIssues) {
    // Log potential security issue but still generate hash
    // We want to detect the tampering, not reject it silently
    SecurityMonitor.logSecurityEvent({
      type: MEMORY_SECURITY_EVENTS.MEMORY_UNICODE_VALIDATION_FAILED,
      severity: 'MEDIUM',
      source: 'generateContentHash',
      details: `Unicode security issues detected: ${normalized.detectedIssues.join(', ')}`
    });
  }

  return crypto.createHash('sha256')
    .update(normalized.normalizedContent)
    .digest('hex');
}

/**
 * Verify memory content integrity
 *
 * SECURITY: This function detects:
 * - External tool modifications (didn't use our hash function)
 * - Manual human editing of YAML files
 * - Filesystem corruption
 * - Tampering attempts (including Unicode tricks)
 *
 * @param content - The content to verify (will be normalized)
 * @param expectedHash - The expected hash value
 * @returns True if content matches hash after normalization
 */
export function verifyContentIntegrity(content: string, expectedHash: string): boolean {
  const actualHash = generateContentHash(content);
  const isValid = actualHash === expectedHash;

  if (!isValid) {
    // SECURITY: Log integrity violation for audit trail
    // This could indicate external modification or tampering
    SecurityMonitor.logSecurityEvent({
      type: MEMORY_SECURITY_EVENTS.MEMORY_INTEGRITY_VIOLATION,
      severity: 'HIGH',
      source: 'verifyContentIntegrity',
      details: `Hash mismatch detected. Expected: ${expectedHash.substring(0, 8)}..., Got: ${actualHash.substring(0, 8)}...`
    });
  }

  return isValid;
}

/**
 * Calculate shard key for memory distribution
 * Used for distributing memories across multiple files
 *
 * SECURITY: Normalizes input to ensure consistent sharding
 * regardless of Unicode representation
 *
 * @param memoryId - The memory ID (will be normalized)
 * @param shardCount - Number of shards (default 16)
 * @returns Shard index (0 to shardCount-1)
 */
export function calculateShardKey(memoryId: string, shardCount = 16): number {
  // SECURITY FIX: Normalize memoryId to prevent Unicode-based attacks
  // that could cause memories to be placed in unexpected shards
  const normalized = UnicodeValidator.normalize(memoryId);

  if (!normalized.isValid && normalized.detectedIssues) {
    // Log but continue - we still need to calculate a shard
    SecurityMonitor.logSecurityEvent({
      type: MEMORY_SECURITY_EVENTS.MEMORY_UNICODE_VALIDATION_FAILED,
      severity: 'LOW',
      source: 'calculateShardKey',
      details: `Unicode issues in memory ID: ${normalized.detectedIssues.join(', ')}`
    });
  }

  const hash = crypto.createHash('md5')
    .update(normalized.normalizedContent)
    .digest();
  const hashInt = hash.readUInt32BE(0);
  return hashInt % shardCount;
}

/**
 * Parse memory ID to extract timestamp
 *
 * @param memoryId - The memory ID to parse
 * @returns Timestamp or null if invalid format
 */
export function parseMemoryTimestamp(memoryId: string): number | null {
  const match = memoryId.match(/^mem_(\d+)_/);
  if (match && match[1]) {
    const timestamp = Number.parseInt(match[1], 10);
    return Number.isNaN(timestamp) ? null : timestamp;
  }
  return null;
}

// TODO: Future index utilities
// - createMemoryIndex(): Create B-tree or similar structure for fast lookups
// - updateIndex(): Update index when memories are added/removed
// - searchIndex(): O(log n) search through indexed memories
// - mergeIndices(): Combine multiple index files for distributed search