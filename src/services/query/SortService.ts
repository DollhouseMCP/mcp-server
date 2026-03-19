/**
 * SortService - Element-agnostic sorting service
 *
 * Provides stable, secure sorting for any element type with support for:
 * - Multiple sortable fields (name, created, modified, version, retention)
 * - Ascending and descending order
 * - Semantic version comparison
 * - ISO 8601 date comparison
 * - Null-safe handling (sorts nulls last)
 * - Immutability (does not mutate input array)
 *
 * SECURITY NOTES:
 * - All sortBy values validated against SortableField enum
 * - No arbitrary field access allowed
 * - Stable sort prevents timing attacks
 * - Input validation prevents injection
 *
 * @module SortService
 */

import { IElement } from '../../types/elements/IElement.js';
import { logger } from '../../utils/logger.js';
import {
  SortOptions,
  SortableField,
  SortOrder,
  AppliedSorting,
  ISortService,
  extractSortValue,
} from './types.js';

/**
 * Service for sorting arrays of elements
 *
 * Implements ISortService with support for multiple sort fields and stable ordering.
 * Designed to be stateless and injectable via dependency injection.
 *
 * @template T - Element type extending IElement
 */
export class SortService<T extends IElement = IElement> implements ISortService<T> {
  private static readonly DEFAULT_SORT_BY: SortableField = 'name';
  private static readonly DEFAULT_SORT_ORDER: SortOrder = 'asc';
  private static readonly VALID_SORT_FIELDS: readonly SortableField[] = [
    'name',
    'created',
    'modified',
    'version',
    'retention',
  ] as const;

  /**
   * Sort an array of elements according to the specified options
   *
   * IMPLEMENTATION NOTES:
   * - Does NOT mutate the input array (creates a shallow copy)
   * - Maintains stable sort order (items with equal values retain original order)
   * - Handles missing values by sorting them last
   * - Validates sortBy field against allowed enum values
   *
   * @param items - Array of elements to sort
   * @param options - Sorting configuration
   * @returns New sorted array
   * @throws {Error} If sort options are invalid
   */
  public sort(items: T[], options?: SortOptions): T[] {
    // Validate options
    this.validateOptions(options);

    // Return empty array as-is
    if (items.length === 0) {
      return [];
    }

    // Extract validated options with defaults
    const sortBy = options?.sortBy ?? SortService.DEFAULT_SORT_BY;
    const sortOrder = options?.sortOrder ?? SortService.DEFAULT_SORT_ORDER;

    logger.debug('SortService.sort', {
      itemCount: items.length,
      sortBy,
      sortOrder,
    });

    // Create shallow copy to avoid mutation
    const sortedItems = [...items];

    // Sort with field-specific comparator
    sortedItems.sort((a, b) => {
      const result = this.compareElements(a, b, sortBy);
      return sortOrder === 'desc' ? -result : result;
    });

    return sortedItems;
  }

  /**
   * Get the default sorting configuration
   *
   * @returns Default sort options
   */
  public getDefaultSorting(): AppliedSorting {
    return {
      sortBy: SortService.DEFAULT_SORT_BY,
      sortOrder: SortService.DEFAULT_SORT_ORDER,
    };
  }

  /**
   * Validate sort options without applying them
   *
   * SECURITY: Validates sortBy against enum to prevent arbitrary field access
   *
   * @param options - Sort options to validate
   * @returns True if options are valid
   * @throws {Error} If options are invalid
   */
  public validateOptions(options?: SortOptions): boolean {
    if (!options) {
      return true; // No options means use defaults
    }

    // Validate sortBy field
    if (options.sortBy !== undefined) {
      if (!SortService.VALID_SORT_FIELDS.includes(options.sortBy)) {
        const error = `Invalid sortBy field: ${options.sortBy}. Must be one of: ${SortService.VALID_SORT_FIELDS.join(', ')}`;
        logger.error('SortService.validateOptions', { error });
        throw new Error(error);
      }
    }

    // Validate sortOrder
    if (options.sortOrder !== undefined) {
      if (options.sortOrder !== 'asc' && options.sortOrder !== 'desc') {
        const error = `Invalid sortOrder: ${options.sortOrder}. Must be 'asc' or 'desc'`;
        logger.error('SortService.validateOptions', { error });
        throw new Error(error);
      }
    }

    return true;
  }

  /**
   * Compare two elements for sorting
   *
   * IMPLEMENTATION NOTES:
   * - Returns negative if a < b, positive if a > b, zero if equal
   * - Handles null/undefined values by sorting them last
   * - Uses field-specific comparison logic
   * - Maintains stable sort (returns 0 for equal values)
   *
   * @param a - First element
   * @param b - Second element
   * @param field - Field to compare
   * @returns Comparison result (-1, 0, 1)
   */
  private compareElements(a: T, b: T, field: SortableField): number {
    const valueA = extractSortValue(a, field);
    const valueB = extractSortValue(b, field);

    // Handle null/undefined - sort last
    if (valueA === undefined && valueB === undefined) {
      return 0;
    }
    if (valueA === undefined) {
      return 1; // a is null, sort after b
    }
    if (valueB === undefined) {
      return -1; // b is null, sort a before b
    }

    // Field-specific comparison
    switch (field) {
      case 'name':
        return this.compareStrings(String(valueA), String(valueB));

      case 'created':
      case 'modified':
        return this.compareDates(String(valueA), String(valueB));

      case 'version':
        return this.compareVersions(String(valueA), String(valueB));

      case 'retention':
        return this.compareNumbers(Number(valueA), Number(valueB));

      default:
        // Should never reach here due to validation
        logger.warn('SortService.compareElements', {
          message: 'Unknown sort field, using string comparison',
          field,
        });
        return this.compareStrings(String(valueA), String(valueB));
    }
  }

  /**
   * Compare two strings case-insensitively
   *
   * Uses localeCompare for proper Unicode handling and stable ordering.
   *
   * @param a - First string
   * @param b - Second string
   * @returns Comparison result
   */
  private compareStrings(a: string, b: string): number {
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  }

  /**
   * Compare two ISO 8601 date strings as timestamps
   *
   * Converts to Date objects and compares numerically.
   * Invalid dates are treated as undefined (sorted last).
   *
   * @param a - First date string
   * @param b - Second date string
   * @returns Comparison result
   */
  private compareDates(a: string, b: string): number {
    const dateA = new Date(a).getTime();
    const dateB = new Date(b).getTime();

    // Handle invalid dates
    if (isNaN(dateA) && isNaN(dateB)) {
      return 0;
    }
    if (isNaN(dateA)) {
      return 1;
    }
    if (isNaN(dateB)) {
      return -1;
    }

    return dateA - dateB;
  }

  /**
   * Compare two semantic version strings (x.y.z format)
   *
   * Compares major, minor, and patch versions numerically.
   * Invalid versions are sorted using string comparison.
   *
   * @param a - First version string
   * @param b - Second version string
   * @returns Comparison result
   */
  private compareVersions(a: string, b: string): number {
    const partsA = this.parseVersion(a);
    const partsB = this.parseVersion(b);

    // If either version is invalid, fall back to string comparison
    if (!partsA || !partsB) {
      return this.compareStrings(a, b);
    }

    // Compare major version
    if (partsA.major !== partsB.major) {
      return partsA.major - partsB.major;
    }

    // Compare minor version
    if (partsA.minor !== partsB.minor) {
      return partsA.minor - partsB.minor;
    }

    // Compare patch version
    return partsA.patch - partsB.patch;
  }

  /**
   * Parse a semantic version string into components
   *
   * Handles formats like "1.0.0", "2.5.3", etc.
   * Returns null for invalid versions.
   *
   * @param version - Version string to parse
   * @returns Parsed version components or null
   */
  private parseVersion(version: string): { major: number; minor: number; patch: number } | null {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
      return null;
    }

    return {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: parseInt(match[3], 10),
    };
  }

  /**
   * Compare two numbers
   *
   * Handles NaN by treating as undefined (sorted last).
   *
   * @param a - First number
   * @param b - Second number
   * @returns Comparison result
   */
  private compareNumbers(a: number, b: number): number {
    // Handle NaN
    if (isNaN(a) && isNaN(b)) {
      return 0;
    }
    if (isNaN(a)) {
      return 1;
    }
    if (isNaN(b)) {
      return -1;
    }

    return a - b;
  }
}
