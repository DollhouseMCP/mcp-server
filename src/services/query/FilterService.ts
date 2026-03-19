/**
 * FilterService - Element filtering implementation
 *
 * Provides stateless filtering capabilities for element arrays based on
 * metadata and other criteria. All filters combine with AND logic except
 * tagsAny which uses OR logic.
 *
 * SECURITY:
 * - All string inputs are sanitized using normalizeSearchTerm
 * - Date inputs are validated as ISO 8601 format
 * - Tag arrays are validated and limited
 * - Missing metadata fields are handled gracefully
 * - Validation failures are logged to SecurityMonitor
 *
 * @see src/services/query/types.ts for interface definitions
 */

import { IElement, ElementStatus } from '../../types/elements/IElement.js';
import { normalizeSearchTerm, validateSearchQuery } from '../../utils/searchUtils.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { FilterCriteria, AppliedFilters, IFilterService } from './types.js';

/**
 * Maximum number of tags allowed in a single filter
 * Prevents array manipulation attacks and excessive processing
 */
const MAX_TAGS_PER_FILTER = 50;

/**
 * Maximum length for author field
 * Prevents DoS through excessively long strings
 */
const MAX_AUTHOR_LENGTH = 100;

/**
 * Maximum length for description filter
 */
const MAX_DESCRIPTION_FILTER_LENGTH = 500;

/**
 * Maximum length for category filter
 */
const MAX_CATEGORY_LENGTH = 100;

/**
 * Set of known filter keys for validation
 */
const KNOWN_FILTER_KEYS = new Set([
  'nameContains',
  'tags',
  'tagsAny',
  'author',
  'createdAfter',
  'createdBefore',
  'status',
  'descriptionContains',
  'category',
]);

/**
 * FilterService implementation
 *
 * Stateless service for filtering element arrays. Safe for injection
 * via DI and concurrent use across multiple operations.
 *
 * @template T - Element type being filtered (must extend IElement)
 */
export class FilterService<T extends IElement = IElement> implements IFilterService<T> {
  /**
   * Filter an array of elements based on criteria
   *
   * All criteria are optional and combined with AND logic when multiple
   * filters are specified. The exception is tagsAny which uses OR logic
   * (element must have ANY of the specified tags).
   *
   * Elements with missing metadata fields pass the filter if that field
   * is not required by the criteria (graceful degradation).
   *
   * @param items - Array of elements to filter
   * @param criteria - Filter criteria to apply
   * @returns Filtered array (may be empty if no matches)
   * @throws {Error} If filter criteria contain invalid values
   *
   * @example
   * ```typescript
   * const filtered = filterService.filter(elements, {
   *   nameContains: 'code review',
   *   tags: ['typescript', 'linting'],
   *   status: 'active'
   * });
   * ```
   */
  filter(items: T[], criteria?: FilterCriteria): T[] {
    // No criteria = no filtering
    if (!criteria) {
      return items;
    }

    // Validate criteria first
    this.validateCriteria(criteria);

    // Apply each filter in sequence
    let filtered = items;

    if (criteria.nameContains !== undefined) {
      filtered = this.filterByName(filtered, criteria.nameContains);
    }

    if (criteria.tags !== undefined && criteria.tags.length > 0) {
      filtered = this.filterByTags(filtered, criteria.tags);
    }

    if (criteria.tagsAny !== undefined && criteria.tagsAny.length > 0) {
      filtered = this.filterByTagsAny(filtered, criteria.tagsAny);
    }

    if (criteria.author !== undefined) {
      filtered = this.filterByAuthor(filtered, criteria.author);
    }

    if (criteria.createdAfter !== undefined) {
      filtered = this.filterByCreatedAfter(filtered, criteria.createdAfter);
    }

    if (criteria.createdBefore !== undefined) {
      filtered = this.filterByCreatedBefore(filtered, criteria.createdBefore);
    }

    if (criteria.status !== undefined && criteria.status !== 'all') {
      filtered = this.filterByStatus(filtered, criteria.status);
    }

    if (criteria.descriptionContains !== undefined) {
      filtered = this.filterByDescription(filtered, criteria.descriptionContains);
    }

    if (criteria.category !== undefined) {
      filtered = this.filterByCategory(filtered, criteria.category);
    }

    return filtered;
  }

  /**
   * Build a summary of which filters will be applied
   *
   * Useful for logging and debugging query execution.
   * Returns a sanitized copy of the criteria with count.
   *
   * @param criteria - Filter criteria
   * @returns Summary of applicable filters
   *
   * @example
   * ```typescript
   * const summary = filterService.summarizeFilters(criteria);
   * logger.debug('Applying filters', summary);
   * ```
   */
  summarizeFilters(criteria?: FilterCriteria): AppliedFilters {
    const applied: AppliedFilters = { count: 0 };

    if (!criteria) {
      return applied;
    }

    if (criteria.nameContains !== undefined && criteria.nameContains.trim() !== '') {
      applied.nameContains = criteria.nameContains;
      applied.count++;
    }

    if (criteria.tags !== undefined && criteria.tags.length > 0) {
      applied.tags = [...criteria.tags];
      applied.count++;
    }

    if (criteria.tagsAny !== undefined && criteria.tagsAny.length > 0) {
      applied.tagsAny = [...criteria.tagsAny];
      applied.count++;
    }

    if (criteria.author !== undefined && criteria.author.trim() !== '') {
      applied.author = criteria.author;
      applied.count++;
    }

    if (criteria.createdAfter !== undefined) {
      applied.createdAfter = criteria.createdAfter;
      applied.count++;
    }

    if (criteria.createdBefore !== undefined) {
      applied.createdBefore = criteria.createdBefore;
      applied.count++;
    }

    if (criteria.status !== undefined && criteria.status !== 'all') {
      applied.status = criteria.status;
      applied.count++;
    }

    if (criteria.descriptionContains !== undefined && criteria.descriptionContains.trim() !== '') {
      applied.descriptionContains = criteria.descriptionContains;
      applied.count++;
    }

    if (criteria.category !== undefined && criteria.category.trim() !== '') {
      applied.category = criteria.category;
      applied.count++;
    }

    return applied;
  }

  /**
   * Validate filter criteria without applying them
   *
   * Checks all criteria for:
   * - Valid string lengths
   * - Valid date formats
   * - Valid tag arrays
   * - Valid status values
   *
   * Logs security events for validation failures.
   *
   * @param criteria - Filter criteria to validate
   * @returns True if criteria are valid
   * @throws {Error} If criteria are invalid with descriptive message
   *
   * @example
   * ```typescript
   * try {
   *   filterService.validateCriteria(userInput);
   * } catch (error) {
   *   logger.error('Invalid filter criteria', error);
   * }
   * ```
   */
  validateCriteria(criteria?: FilterCriteria): boolean {
    if (!criteria) {
      return true;
    }

    try {
      // Reject unknown filter keys
      const unknownKeys = Object.keys(criteria).filter(key => !KNOWN_FILTER_KEYS.has(key));
      if (unknownKeys.length > 0) {
        const supported = [...KNOWN_FILTER_KEYS].sort((a, b) => a.localeCompare(b)).join(', ');
        throw new Error(
          `Unknown filter key(s): ${unknownKeys.join(', ')}. Supported filters: ${supported}`
        );
      }

      // Validate nameContains
      if (criteria.nameContains !== undefined) {
        if (typeof criteria.nameContains !== 'string') {
          throw new Error('nameContains must be a string');
        }
        // Use validateSearchQuery which also sanitizes
        validateSearchQuery(criteria.nameContains);
      }

      // Validate tags (AND logic)
      if (criteria.tags !== undefined) {
        this.validateTagArray(criteria.tags, 'tags');
      }

      // Validate tagsAny (OR logic)
      if (criteria.tagsAny !== undefined) {
        this.validateTagArray(criteria.tagsAny, 'tagsAny');
      }

      // Validate author
      if (criteria.author !== undefined) {
        if (typeof criteria.author !== 'string') {
          throw new Error('author must be a string');
        }
        if (criteria.author.length > MAX_AUTHOR_LENGTH) {
          throw new Error(`author exceeds maximum length of ${MAX_AUTHOR_LENGTH} characters`);
        }
      }

      // Validate dates
      if (criteria.createdAfter !== undefined) {
        this.validateISO8601Date(criteria.createdAfter, 'createdAfter');
      }

      if (criteria.createdBefore !== undefined) {
        this.validateISO8601Date(criteria.createdBefore, 'createdBefore');
      }

      // Validate status
      if (criteria.status !== undefined) {
        const validStatuses = ['active', 'inactive', 'all'];
        if (!validStatuses.includes(criteria.status)) {
          throw new Error(`status must be one of: ${validStatuses.join(', ')}`);
        }
      }

      // Validate descriptionContains
      if (criteria.descriptionContains !== undefined) {
        if (typeof criteria.descriptionContains !== 'string') {
          throw new Error('descriptionContains must be a string');
        }
        if (criteria.descriptionContains.length > MAX_DESCRIPTION_FILTER_LENGTH) {
          throw new Error(`descriptionContains exceeds maximum length of ${MAX_DESCRIPTION_FILTER_LENGTH} characters`);
        }
        validateSearchQuery(criteria.descriptionContains);
      }

      // Validate category
      if (criteria.category !== undefined) {
        if (typeof criteria.category !== 'string') {
          throw new Error('category must be a string');
        }
        if (criteria.category.length > MAX_CATEGORY_LENGTH) {
          throw new Error(`category exceeds maximum length of ${MAX_CATEGORY_LENGTH} characters`);
        }
      }

      return true;
    } catch (error) {
      // Log validation failure as security event
      SecurityMonitor.logSecurityEvent({
        type: 'UNICODE_VALIDATION_ERROR',
        severity: 'MEDIUM',
        source: 'FilterService.validateCriteria',
        details: `Filter criteria validation failed: ${error instanceof Error ? error.message : String(error)}`,
        additionalData: {
          criteria: this.sanitizeCriteriaForLogging(criteria),
        },
      });

      // Re-throw for caller to handle
      throw error;
    }
  }

  // ============================================================================
  // Private Filter Methods
  // ============================================================================

  /**
   * Filter elements by name (case-insensitive partial match)
   */
  private filterByName(items: T[], nameContains: string): T[] {
    const normalized = normalizeSearchTerm(nameContains);
    return items.filter((item) => {
      const itemName = normalizeSearchTerm(item.metadata.name);
      return itemName.includes(normalized);
    });
  }

  /**
   * Filter elements by tags (AND logic - must have ALL tags)
   */
  private filterByTags(items: T[], tags: string[]): T[] {
    const normalizedTags = tags.map((tag) => normalizeSearchTerm(tag));

    return items.filter((item) => {
      const itemTags = item.metadata.tags || [];
      const normalizedItemTags = itemTags.map((tag) => normalizeSearchTerm(tag));

      // Element must have ALL required tags
      return normalizedTags.every((requiredTag) =>
        normalizedItemTags.some((itemTag) => itemTag === requiredTag)
      );
    });
  }

  /**
   * Filter elements by tags (OR logic - must have ANY tag)
   */
  private filterByTagsAny(items: T[], tagsAny: string[]): T[] {
    const normalizedTags = tagsAny.map((tag) => normalizeSearchTerm(tag));

    return items.filter((item) => {
      const itemTags = item.metadata.tags || [];
      const normalizedItemTags = itemTags.map((tag) => normalizeSearchTerm(tag));

      // Element must have AT LEAST ONE of the specified tags
      return normalizedTags.some((anyTag) =>
        normalizedItemTags.some((itemTag) => itemTag === anyTag)
      );
    });
  }

  /**
   * Filter elements by author (exact match, case-insensitive)
   */
  private filterByAuthor(items: T[], author: string): T[] {
    const normalizedAuthor = normalizeSearchTerm(author);

    return items.filter((item) => {
      // If element has no author, it doesn't match
      if (!item.metadata.author) {
        return false;
      }
      const itemAuthor = normalizeSearchTerm(item.metadata.author);
      return itemAuthor === normalizedAuthor;
    });
  }

  /**
   * Filter elements created after a date (inclusive)
   */
  private filterByCreatedAfter(items: T[], createdAfter: string): T[] {
    const afterDate = new Date(createdAfter);

    return items.filter((item) => {
      // If element has no created date, it doesn't match
      if (!item.metadata.created) {
        return false;
      }

      const itemDate = new Date(item.metadata.created);
      return itemDate >= afterDate;
    });
  }

  /**
   * Filter elements created before a date (inclusive)
   */
  private filterByCreatedBefore(items: T[], createdBefore: string): T[] {
    const beforeDate = new Date(createdBefore);

    return items.filter((item) => {
      // If element has no created date, it doesn't match
      if (!item.metadata.created) {
        return false;
      }

      const itemDate = new Date(item.metadata.created);
      return itemDate <= beforeDate;
    });
  }

  /**
   * Filter elements by status
   */
  private filterByStatus(items: T[], status: 'active' | 'inactive'): T[] {
    return items.filter((item) => {
      const itemStatus = item.getStatus();

      if (status === 'active') {
        return itemStatus === ElementStatus.ACTIVE || itemStatus === ElementStatus.ACTIVATING;
      } else if (status === 'inactive') {
        return (
          itemStatus === ElementStatus.INACTIVE ||
          itemStatus === ElementStatus.DEACTIVATING ||
          itemStatus === ElementStatus.ERROR ||
          itemStatus === ElementStatus.SUSPENDED
        );
      }

      return false;
    });
  }

  /**
   * Filter elements by description (case-insensitive substring match)
   */
  private filterByDescription(items: T[], descriptionContains: string): T[] {
    const normalized = normalizeSearchTerm(descriptionContains);
    return items.filter((item) => {
      const itemDescription = item.metadata.description
        ? normalizeSearchTerm(item.metadata.description)
        : '';
      return itemDescription.includes(normalized);
    });
  }

  /**
   * Filter elements by category (case-insensitive exact match)
   */
  private filterByCategory(items: T[], category: string): T[] {
    const normalizedCategory = normalizeSearchTerm(category);
    return items.filter((item) => {
      const itemCategory = this.getMetadataField(item, 'category');
      if (typeof itemCategory !== 'string') {
        return false;
      }
      return normalizeSearchTerm(itemCategory) === normalizedCategory;
    });
  }

  /**
   * Safely access an arbitrary metadata field that may not be on the IElementMetadata interface.
   * Used for extension fields like 'category' that exist on some elements.
   * Checks metadata.custom first (standard extensibility), then metadata directly
   * using property descriptor access to avoid unsafe type assertions.
   */
  private getMetadataField(item: T, field: string): unknown {
    if (item.metadata.custom && field in item.metadata.custom) {
      return item.metadata.custom[field];
    }
    const descriptor = Object.getOwnPropertyDescriptor(item.metadata, field);
    return descriptor?.value;
  }

  // ============================================================================
  // Private Validation Helpers
  // ============================================================================

  /**
   * Validate a tag array
   */
  private validateTagArray(tags: unknown, fieldName: string): void {
    if (!Array.isArray(tags)) {
      throw new Error(`${fieldName} must be an array`);
    }

    if (tags.length > MAX_TAGS_PER_FILTER) {
      throw new Error(`${fieldName} exceeds maximum of ${MAX_TAGS_PER_FILTER} tags`);
    }

    for (const tag of tags) {
      if (typeof tag !== 'string') {
        throw new Error(`${fieldName} must contain only strings`);
      }

      // Validate each tag as a search term
      validateSearchQuery(tag);
    }
  }

  /**
   * Validate ISO 8601 date string
   */
  private validateISO8601Date(dateString: string, fieldName: string): void {
    if (typeof dateString !== 'string') {
      throw new Error(`${fieldName} must be a string`);
    }

    // Try to parse as Date
    const date = new Date(dateString);

    if (isNaN(date.getTime())) {
      throw new Error(`${fieldName} must be a valid ISO 8601 date`);
    }

    // Validate ISO 8601 format (basic check)
    // Accepts formats like: 2024-01-01, 2024-01-01T00:00:00Z, etc.
    const iso8601Pattern = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})?)?$/;
    if (!iso8601Pattern.test(dateString)) {
      throw new Error(`${fieldName} must be in ISO 8601 format (e.g., 2024-01-01T00:00:00Z)`);
    }
  }

  /**
   * Sanitize criteria for logging (remove potentially sensitive data)
   */
  private sanitizeCriteriaForLogging(criteria: FilterCriteria): Record<string, unknown> {
    return {
      hasNameContains: criteria.nameContains !== undefined,
      hasTagsFilter: criteria.tags !== undefined && criteria.tags.length > 0,
      hasTagsAnyFilter: criteria.tagsAny !== undefined && criteria.tagsAny.length > 0,
      hasAuthorFilter: criteria.author !== undefined,
      hasCreatedAfterFilter: criteria.createdAfter !== undefined,
      hasCreatedBeforeFilter: criteria.createdBefore !== undefined,
      hasStatusFilter: criteria.status !== undefined,
      status: criteria.status,
      hasDescriptionContainsFilter: criteria.descriptionContains !== undefined,
      hasCategoryFilter: criteria.category !== undefined,
    };
  }
}
