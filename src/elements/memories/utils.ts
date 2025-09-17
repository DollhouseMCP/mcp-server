/**
 * Utility functions for Memory element operations
 *
 * PERFORMANCE CONSIDERATIONS:
 * - ID generation should be fast (<1ms)
 * - Hash functions optimized for memory verification
 * - Index operations designed for O(log n) complexity
 */

import * as crypto from 'crypto';

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
 * Uses SHA-256 for cryptographic strength
 *
 * @param content - The content to hash
 * @returns Hex-encoded hash string
 */
export function generateContentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Verify memory content integrity
 *
 * @param content - The content to verify
 * @param expectedHash - The expected hash value
 * @returns True if content matches hash
 */
export function verifyContentIntegrity(content: string, expectedHash: string): boolean {
  const actualHash = generateContentHash(content);
  return actualHash === expectedHash;
}

/**
 * Calculate shard key for memory distribution
 * Used for distributing memories across multiple files
 *
 * @param memoryId - The memory ID
 * @param shardCount - Number of shards (default 16)
 * @returns Shard index (0 to shardCount-1)
 */
export function calculateShardKey(memoryId: string, shardCount = 16): number {
  const hash = crypto.createHash('md5').update(memoryId).digest();
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
    const timestamp = parseInt(match[1], 10);
    return isNaN(timestamp) ? null : timestamp;
  }
  return null;
}

// TODO: Future index utilities
// - createMemoryIndex(): Create B-tree or similar structure for fast lookups
// - updateIndex(): Update index when memories are added/removed
// - searchIndex(): O(log n) search through indexed memories
// - mergeIndices(): Combine multiple index files for distributed search