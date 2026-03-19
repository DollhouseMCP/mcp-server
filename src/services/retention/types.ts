/**
 * Retention Policy Types (Issue #51)
 *
 * Generic interfaces for retention management across all element types.
 * Designed to support 50+ element types with type-specific retention strategies.
 *
 * @module RetentionTypes
 */

import { ElementType } from '../../portfolio/types.js';

/**
 * Interface for any item that can be subject to retention policies.
 * Element types implement this to enable retention management.
 */
export interface IRetainableItem {
  /** Unique identifier for the item */
  id: string;
  /** When this item was created */
  createdAt?: Date;
  /** When this item expires (if set) */
  expiresAt?: Date;
  /** Last time this item was accessed (for LRU-style retention) */
  lastAccessedAt?: Date;
  /** Content preview for display in dry-run results */
  contentPreview?: string;
  /** Additional metadata that might affect retention */
  metadata?: Record<string, unknown>;
}

/**
 * Result of checking a single item for retention
 */
export interface RetentionCheckResult {
  /** The item that was checked */
  item: IRetainableItem;
  /** Whether this item should be retained (true) or removed (false) */
  shouldRetain: boolean;
  /** Reason for the retention decision */
  reason: RetentionReason;
  /** Days until expiry (negative if already expired) */
  daysUntilExpiry?: number;
}

/**
 * Reasons why an item might be retained or removed
 */
export type RetentionReason =
  | 'not_expired'           // Item hasn't reached expiry date
  | 'expired'               // Item has passed expiry date
  | 'capacity_exceeded'     // Removing due to capacity limits
  | 'manual_request'        // User explicitly requested removal
  | 'no_expiry_set'         // Item has no expiry date (permanent)
  | 'pinned'                // Item is marked as pinned/permanent
  | 'within_warning'        // Item is approaching expiry but not yet
  | 'lru_eviction'          // Removed due to LRU eviction policy
  | 'policy_disabled';      // Retention is disabled for this type

/**
 * Configuration for retention policy per element type
 */
export interface ElementRetentionConfig {
  /** Whether retention is enabled for this element type */
  enabled: boolean;
  /** Default TTL in days for new items (-1 for permanent) */
  defaultTtlDays: number;
  /** Maximum number of items before capacity enforcement (-1 for unlimited) */
  maxItems: number;
  /** Enforcement mode for this element type */
  enforcementMode: RetentionEnforcementMode;
  /** Whether items can be pinned to prevent deletion */
  allowPinning: boolean;
  /** Custom settings specific to the element type */
  custom?: Record<string, unknown>;
}

/**
 * When retention enforcement happens
 */
export type RetentionEnforcementMode =
  | 'disabled'    // Never enforce automatically
  | 'manual'      // Only via explicit command
  | 'on_load'     // When element is loaded
  | 'on_save'     // When element is saved
  | 'scheduled';  // On a schedule (future)

/**
 * Result of a retention enforcement operation
 */
export interface RetentionEnforcementResult {
  /** Element type this result applies to */
  elementType: ElementType | string;
  /** Whether the operation was successful */
  success: boolean;
  /** Number of items checked */
  itemsChecked: number;
  /** Number of items that would be/were removed */
  itemsRemoved: number;
  /** Details of items affected */
  affectedItems: RetentionCheckResult[];
  /** Whether this was a dry run (preview only) */
  dryRun: boolean;
  /** Warning messages */
  warnings: string[];
  /** Error message if operation failed */
  error?: string;
  /** Timestamp of the operation */
  timestamp: Date;
}

/**
 * Summary of expiring items across element types
 */
export interface RetentionSummary {
  /** Items expiring within warning threshold */
  expiringSoon: Array<{
    elementType: ElementType | string;
    itemId: string;
    contentPreview: string;
    expiresAt: Date;
    daysUntilExpiry: number;
  }>;
  /** Items that have already expired */
  alreadyExpired: Array<{
    elementType: ElementType | string;
    itemId: string;
    contentPreview: string;
    expiresAt: Date;
    daysOverdue: number;
  }>;
  /** Per-type counts */
  countsByType: Record<string, {
    total: number;
    expiringSoon: number;
    expired: number;
  }>;
}

/**
 * Strategy interface for element-type specific retention logic.
 * Each element type that supports retention implements this interface.
 */
export interface IRetentionStrategy<T extends IRetainableItem = IRetainableItem> {
  /** The element type this strategy handles */
  readonly elementType: ElementType | string;

  /**
   * Get all retainable items from an element
   * @param element - The parent element containing items
   * @returns Map of item ID to retainable item
   */
  getRetainableItems(element: unknown): Map<string, T>;

  /**
   * Check a single item against retention policy
   * @param item - The item to check
   * @param config - Retention configuration
   * @returns Check result with retention decision
   */
  checkItem(item: T, config: ElementRetentionConfig): RetentionCheckResult;

  /**
   * Remove an item from its parent element
   * @param element - The parent element
   * @param itemId - ID of item to remove
   */
  removeItem(element: unknown, itemId: string): void;

  /**
   * Calculate expiry date for a new item
   * @param config - Retention configuration
   * @returns Expiry date, or undefined if permanent
   */
  calculateExpiryDate(config: ElementRetentionConfig): Date | undefined;

  /**
   * Check if an item is pinned (exempt from retention)
   * @param item - The item to check
   * @returns True if item should never be deleted
   */
  isPinned(item: T): boolean;

  /**
   * Get a content preview for display
   * @param item - The item
   * @param maxLength - Maximum preview length
   * @returns Truncated content for display
   */
  getContentPreview(item: T, maxLength?: number): string;
}

/**
 * Options for retention enforcement
 */
export interface EnforcementOptions {
  /** Force enforcement even if dry_run_first is enabled */
  force?: boolean;
  /** Name/identifier of the element being processed */
  elementName?: string;
  /** Skip confirmation even if required */
  skipConfirmation?: boolean;
  /** Callback for progress updates */
  onProgress?: (processed: number, total: number) => void;
  /** Stop on first error instead of continuing (prevents partial failures) */
  failFast?: boolean;
}

/**
 * Global retention policy defaults
 */
export const RETENTION_DEFAULTS = {
  /** Default TTL in days */
  DEFAULT_TTL_DAYS: 30,
  /** Minimum TTL in days */
  MIN_TTL_DAYS: 1,
  /** Maximum TTL in days */
  MAX_TTL_DAYS: 3650, // 10 years
  /** Default warning threshold in days */
  WARNING_THRESHOLD_DAYS: 7,
  /** Default max items per element */
  DEFAULT_MAX_ITEMS: 1000,
  /** Default backup retention days */
  BACKUP_RETENTION_DAYS: 30,
  /** Maximum content preview length */
  MAX_PREVIEW_LENGTH: 100,
} as const;
