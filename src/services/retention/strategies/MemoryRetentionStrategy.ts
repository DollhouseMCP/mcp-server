/**
 * MemoryRetentionStrategy - Retention strategy for Memory element entries
 *
 * Implements IRetentionStrategy for Memory entries, which have:
 * - Individual entries with expiresAt dates
 * - TTL-based expiration
 * - Capacity limits (max entries)
 *
 * @module MemoryRetentionStrategy
 */

import { ElementType } from '../../../portfolio/types.js';
import type { MemoryEntry } from '../../../elements/memories/types.js';
import type { Memory } from '../../../elements/memories/Memory.js';
import { UnicodeValidator } from '../../../security/validators/unicodeValidator.js';
import {
  IRetentionStrategy,
  IRetainableItem,
  ElementRetentionConfig,
  RetentionCheckResult,
  RETENTION_DEFAULTS,
} from '../types.js';

/**
 * Adapter to make MemoryEntry conform to IRetainableItem
 */
interface RetainableMemoryEntry extends IRetainableItem {
  originalEntry: MemoryEntry;
}

/**
 * Retention strategy for Memory element entries
 */
export class MemoryRetentionStrategy implements IRetentionStrategy<RetainableMemoryEntry> {
  readonly elementType = ElementType.MEMORY;

  /**
   * Extract retainable items from a Memory element
   * Converts Memory entries to IRetainableItem interface for retention processing
   *
   * @param element - The Memory instance to extract entries from
   * @returns Map of entry IDs to retainable item wrappers
   * @throws {TypeError} If element is not a valid Memory instance
   */
  getRetainableItems(element: unknown): Map<string, RetainableMemoryEntry> {
    const memory = element as Memory;
    const items = new Map<string, RetainableMemoryEntry>();

    // Memory exposes entries through its public interface
    // We need to access the entries - check if memory has a method or property
    const entries = this.getMemoryEntries(memory);

    for (const [id, entry] of entries) {
      items.set(id, this.toRetainableItem(entry));
    }

    return items;
  }

  /**
   * Check if a memory entry should be retained based on retention policy
   * Evaluates expiration, pinning status, and policy configuration
   *
   * @param item - The retainable memory entry to check
   * @param config - Retention configuration for this element type
   * @returns Result indicating whether to retain and the reason
   *
   * Retention reasons:
   * - 'pinned': Entry is marked as permanent/pinned
   * - 'policy_disabled': Retention is disabled in config
   * - 'no_expiry': Entry has no expiration date
   * - 'valid': Entry has not expired yet
   * - 'within_warning': Entry expires within warning threshold
   * - 'expired': Entry has passed its expiration date
   */
  checkItem(item: RetainableMemoryEntry, config: ElementRetentionConfig): RetentionCheckResult {
    const now = new Date();

    // Check if item is pinned
    if (this.isPinned(item)) {
      return {
        item,
        shouldRetain: true,
        reason: 'pinned',
      };
    }

    // Check if retention is disabled
    if (!config.enabled) {
      return {
        item,
        shouldRetain: true,
        reason: 'policy_disabled',
      };
    }

    // Check if item has no expiry (permanent)
    if (!item.expiresAt) {
      return {
        item,
        shouldRetain: true,
        reason: 'no_expiry_set',
      };
    }

    const expiresAt = new Date(item.expiresAt);
    const msUntilExpiry = expiresAt.getTime() - now.getTime();
    const daysUntilExpiry = Math.ceil(msUntilExpiry / (1000 * 60 * 60 * 24));

    if (daysUntilExpiry < 0) {
      // Item has expired
      return {
        item,
        shouldRetain: false,
        reason: 'expired',
        daysUntilExpiry,
      };
    }

    // Item is still valid
    return {
      item,
      shouldRetain: true,
      reason: daysUntilExpiry <= RETENTION_DEFAULTS.WARNING_THRESHOLD_DAYS
        ? 'within_warning'
        : 'not_expired',
      daysUntilExpiry,
    };
  }

  /**
   * Remove a memory entry by ID
   * Uses Memory.removeEntry() public API (no reflection)
   *
   * @param element - The Memory instance
   * @param itemId - The entry ID to remove
   * @throws {Error} If element is not a valid Memory instance
   *
   * SECURITY: Normalizes itemId to prevent Unicode bypass attacks
   */
  removeItem(element: unknown, itemId: string): void {
    // SECURITY: Normalize itemId user input
    const sanitizedItemId = UnicodeValidator.normalize(itemId).normalizedContent;

    const memory = element as Memory;
    // Use public API - removeEntry() added in Issue #51
    memory.removeEntry(sanitizedItemId);
  }

  /**
   * Calculate expiry date for a new memory entry based on TTL config
   *
   * @param config - Retention configuration with defaultTtlDays
   * @returns Date when entry expires, or undefined if permanent (negative TTL)
   */
  calculateExpiryDate(config: ElementRetentionConfig): Date | undefined {
    if (config.defaultTtlDays < 0) {
      return undefined; // Permanent
    }

    const expiry = new Date();
    expiry.setDate(expiry.getDate() + config.defaultTtlDays);
    return expiry;
  }

  /**
   * Check if a memory entry is pinned (protected from deletion)
   * Pinned entries are never deleted by retention policy
   *
   * @param item - The retainable memory entry to check
   * @returns true if entry has pinned or permanent flag in metadata
   */
  isPinned(item: RetainableMemoryEntry): boolean {
    // Check metadata for pinned flag
    const metadata = item.originalEntry.metadata;
    if (metadata && typeof metadata === 'object') {
      return metadata.pinned === true || metadata.permanent === true;
    }
    return false;
  }

  /**
   * Get truncated content preview for display in retention reports
   *
   * @param item - The retainable memory entry
   * @param maxLength - Maximum preview length (default: RETENTION_DEFAULTS.MAX_PREVIEW_LENGTH)
   * @returns Truncated content with ellipsis if needed
   */
  getContentPreview(item: RetainableMemoryEntry, maxLength: number = RETENTION_DEFAULTS.MAX_PREVIEW_LENGTH): string {
    const content = item.originalEntry.content || '';
    if (content.length <= maxLength) {
      return content;
    }
    return content.substring(0, maxLength) + '...';
  }

  /**
   * Convert MemoryEntry to IRetainableItem
   */
  private toRetainableItem(entry: MemoryEntry): RetainableMemoryEntry {
    return {
      id: entry.id,
      createdAt: entry.timestamp,
      expiresAt: entry.expiresAt,
      contentPreview: this.truncateContent(entry.content),
      metadata: entry.metadata,
      originalEntry: entry,
    };
  }

  /**
   * Get entries from a Memory element
   * Uses the public getEntries() API (Issue #51)
   */
  private getMemoryEntries(memory: Memory): Map<string, MemoryEntry> {
    // Memory class now exposes a public getEntries() method
    return memory.getEntries();
  }

  /**
   * Truncate content for preview
   */
  private truncateContent(content: string, maxLength: number = RETENTION_DEFAULTS.MAX_PREVIEW_LENGTH): string {
    if (!content) return '';
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + '...';
  }
}
