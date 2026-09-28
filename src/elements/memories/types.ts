/**
 * Shared types for Memory and MemorySearchIndex
 *
 * This file contains types used by both Memory and MemorySearchIndex
 * to prevent circular dependencies.
 *
 * FIX: DMCP-SEC-006 - No security logging required
 * RATIONALE: This file contains ONLY TypeScript type definitions (interfaces and type aliases).
 * There are no exported functions, classes, or executable code.
 * Type definitions are compile-time only and produce no runtime operations.
 * Security logging occurs in the classes that USE these types (Memory.ts, MemoryManager.ts).
 *
 * VERIFICATION: Run `grep "^export (function|const|class)" types.ts` - returns no matches
 * @security-audit-suppress DMCP-SEC-006
 */

import { PrivacyLevel, TrustLevel } from './constants.js';

/**
 * Memory type classification for folder organization
 * - system: System-provided memories (seeds, baseline knowledge)
 * - adapter: Adapter-specific memories
 * - user: User-created memories (stored in date folders)
 */
export enum MemoryType {
  SYSTEM = 'system',
  ADAPTER = 'adapter',
  USER = 'user'
}

/**
 * Memory entry structure
 */
export interface MemoryEntry {
  id: string;
  timestamp: Date;
  content: string;
  tags?: string[];
  metadata?: Record<string, any>;
  expiresAt?: Date;
  privacyLevel?: PrivacyLevel;
  trustLevel?: TrustLevel;  // Memory Security Architecture (Issue #1314)
  sanitizedPatterns?: any[];  // Patterns extracted from FLAGGED entries
  sanitizedContent?: string;  // Sanitized version of content for FLAGGED entries
}

/**
 * Memory search options
 */
export interface MemorySearchOptions {
  query?: string;
  tags?: string[];
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  privacyLevel?: PrivacyLevel;
}

/**
 * Memory metadata interface
 * Note: The actual MemoryMetadata in Memory.ts extends IElementMetadata
 * This is a simplified version for MemorySearchIndex to use
 */
export interface MemoryMetadataBase {
  name: string;
  description?: string;
  author?: string;
  version?: string;
  storage_backend?: 'memory' | 'file' | 'database';
  retention_policy?: {
    ttl_days?: number;
    max_entries?: number;
  };
  default_privacy_level?: PrivacyLevel;
  search_enabled?: boolean;

  // IElementMetadata compatibility fields
  category?: string;
  tags?: string[];
  created_date?: string;

  // Trigger words for Enhanced Index (Issue #1124)
  triggers?: string[];
}

/**
 * Index record for one sealed archive volume of a memory (Issue #2861).
 * Stored in the live memory's metadata.volumes. Holds only structured,
 * system-generated values; free-text reasons go in the rollover marker entry.
 */
export interface MemoryVolumeRecord {
  /** 1-based volume number, unique per memory */
  volume: number;
  /** Volume file path relative to the memories directory */
  file: string;
  /** ISO timestamp when the volume was sealed */
  sealedAt: string;
  entryCount: number;
  /** ISO timestamps of the oldest and newest sealed entries */
  firstEntryAt?: string;
  lastEntryAt?: string;
  /** SHA-256 of the volume file content as written */
  sha256: string;
}

/**
 * Options for rolling a memory over into sealed archive volumes (Issue #2861).
 */
export interface MemoryRolloverOptions {
  /** Entries carrying any of these tags stay in the live memory */
  keepTags: string[];
  /** Number of newest entries that stay in the live memory */
  keepLatest: number;
  /** Plan only; write nothing */
  dryRun: boolean;
  /** Free-text reason, recorded in the marker entry only */
  reason?: string;
}

/**
 * Outcome of a rollover (Issue #2861).
 */
export interface MemoryRolloverResult {
  memory: string;
  dryRun: boolean;
  sealedCount: number;
  keptCount: number;
  /** Records for volumes written (or that would be written, on a dry run) */
  volumes: MemoryVolumeRecord[];
  /** Entry ids moved out of the live memory; empty on a dry run */
  sealedIds: string[];
  /** Internal preflight decision; an informational marker must never evict kept entries. */
  includeMarker?: boolean;
  /** Exact prepared marker projected into the head; omitted when it would exceed a limit. */
  markerEntry?: MemoryEntry;
}
