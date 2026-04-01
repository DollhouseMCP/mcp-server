/**
 * PaginationService - Element-agnostic pagination service
 *
 * Provides consistent pagination behavior across all element types following
 * the patterns established in CollectionSearch.ts.
 *
 * Key Features:
 * - 1-indexed pages (page 1 = first page)
 * - Configurable page size with sensible defaults
 * - Complete pagination metadata for UI/API responses
 * - Input validation and security logging
 * - Stateless and injectable via DI
 *
 * Security:
 * - Validates all inputs to prevent DoS attacks
 * - Logs validation failures via SecurityMonitor
 * - Enforces maximum page size limits
 *
 * @see src/types/query/types.ts for interface definitions
 * @see src/collection/CollectionSearch.ts for pagination patterns
 */

import { IPaginationService, PaginationOptions, PaginatedResult, PaginationMetadata } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * Constants for pagination configuration
 */
const PAGINATION_CONSTANTS = {
  /** Default number of items per page (Issue #299: reduced from 25 for token efficiency) */
  DEFAULT_PAGE_SIZE: 20,
  /** Maximum allowed page size to prevent DoS */
  MAX_PAGE_SIZE: 100,
  /** Minimum valid page number (1-indexed) */
  MIN_PAGE: 1,
  /** Minimum valid page size */
  MIN_PAGE_SIZE: 1,
} as const;

/**
 * Implementation of IPaginationService providing element-agnostic pagination
 *
 * This service is stateless and can be safely shared across multiple consumers.
 * It follows the pagination patterns from CollectionSearch.ts:
 * - 1-indexed pages
 * - Default pageSize of 25
 * - Maximum pageSize of 100
 * - Accurate hasNextPage/hasPrevPage calculations
 *
 * @template T - Type of items being paginated (can be any type)
 *
 * @example
 * ```typescript
 * const service = new PaginationService();
 * const result = service.paginate(items, { page: 2, pageSize: 10 });
 * console.log(result.items); // items 11-20
 * console.log(result.pagination.hasNextPage); // true if more items exist
 * ```
 */
export class PaginationService<T = any> implements IPaginationService<T> {
  /**
   * Paginate an array of items
   *
   * @param items - Complete array of items to paginate
   * @param options - Pagination configuration (page, pageSize)
   * @returns Paginated result with items and metadata
   * @throws {Error} If pagination options are invalid
   *
   * @example
   * ```typescript
   * const service = new PaginationService();
   *
   * // Basic usage with defaults (page 1, pageSize 25)
   * const result1 = service.paginate(items);
   *
   * // Custom page and page size
   * const result2 = service.paginate(items, { page: 3, pageSize: 50 });
   *
   * // Access results
   * console.log(result2.items); // Items 101-150
   * console.log(result2.pagination.totalPages); // Total number of pages
   * console.log(result2.pagination.hasNextPage); // true if page 4 exists
   * ```
   */
  public paginate(items: T[], options?: PaginationOptions): PaginatedResult<T> {
    // Apply defaults
    const page = options?.page ?? PAGINATION_CONSTANTS.MIN_PAGE;
    const pageSize = options?.pageSize ?? PAGINATION_CONSTANTS.DEFAULT_PAGE_SIZE;

    // Validate inputs
    this.validatePaginationOptions(page, pageSize);

    // Calculate pagination boundaries
    const totalItems = items.length;
    const totalPages = Math.ceil(totalItems / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;

    // Extract items for current page
    // Handle edge cases:
    // - Empty arrays: slice returns []
    // - Page beyond data: slice returns []
    // - pageSize larger than total: slice returns remaining items
    const pageItems = items.slice(startIndex, endIndex);

    // Calculate navigation flags
    const hasNextPage = endIndex < totalItems;
    const hasPrevPage = page > 1;

    // Build metadata
    const metadata: PaginationMetadata = {
      page,
      pageSize,
      totalItems,
      totalPages,
      hasNextPage,
      hasPrevPage,
    };

    return {
      items: pageItems,
      pagination: metadata,
    };
  }

  /**
   * Calculate pagination metadata without returning items
   *
   * Useful for API responses where you need metadata but already
   * have the items, or when you need to provide pagination info
   * before fetching the actual data.
   *
   * @param totalItems - Total number of items in full result set
   * @param options - Pagination configuration (page, pageSize)
   * @returns Pagination metadata only
   * @throws {Error} If pagination options are invalid
   *
   * @example
   * ```typescript
   * const service = new PaginationService();
   *
   * // Calculate metadata for a known total count
   * const metadata = service.calculateMetadata(237, { page: 5, pageSize: 25 });
   * console.log(metadata.totalPages); // 10
   * console.log(metadata.hasNextPage); // true (pages 6-10 exist)
   * console.log(metadata.hasPrevPage); // true (pages 1-4 exist)
   * ```
   */
  public calculateMetadata(totalItems: number, options?: PaginationOptions): PaginationMetadata {
    logger.debug('PaginationService.calculateMetadata called', {
      totalItems,
      options,
    });

    // Validate totalItems
    if (totalItems < 0) {
      const error = new Error('Total items count must be non-negative');
      logger.error('PaginationService.calculateMetadata: Invalid total items count', {
        totalItems,
        reason: 'Negative total items count',
      });
      throw error;
    }

    // Apply defaults
    const page = options?.page ?? PAGINATION_CONSTANTS.MIN_PAGE;
    const pageSize = options?.pageSize ?? PAGINATION_CONSTANTS.DEFAULT_PAGE_SIZE;

    // Validate inputs
    this.validatePaginationOptions(page, pageSize);

    // Calculate metadata
    const totalPages = Math.ceil(totalItems / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const hasNextPage = endIndex < totalItems;
    const hasPrevPage = page > 1;

    const metadata: PaginationMetadata = {
      page,
      pageSize,
      totalItems,
      totalPages,
      hasNextPage,
      hasPrevPage,
    };

    logger.debug('PaginationService.calculateMetadata completed', metadata);

    return metadata;
  }

  /**
   * Validate pagination options
   *
   * Ensures that page and pageSize values are within acceptable ranges
   * to prevent DoS attacks and invalid pagination states.
   *
   * Security considerations:
   * - Page must be >= 1 (1-indexed)
   * - PageSize must be >= 1
   * - PageSize must be <= MAX_PAGE_SIZE (prevents memory exhaustion)
   *
   * @param page - Page number to validate
   * @param pageSize - Page size to validate
   * @throws {Error} If validation fails
   *
   * @private
   */
  private validatePaginationOptions(page: number, pageSize: number): void {
    // Validate page number
    if (!Number.isInteger(page) || page < PAGINATION_CONSTANTS.MIN_PAGE) {
      const error = new Error(
        `Page number must be an integer >= ${PAGINATION_CONSTANTS.MIN_PAGE}, got: ${page}`
      );
      logger.error('PaginationService validation failed: Invalid page number', {
        page,
        minPage: PAGINATION_CONSTANTS.MIN_PAGE,
        reason: 'Page number must be a positive integer',
      });
      throw error;
    }

    // Validate page size minimum
    if (!Number.isInteger(pageSize) || pageSize < PAGINATION_CONSTANTS.MIN_PAGE_SIZE) {
      const error = new Error(
        `Page size must be an integer >= ${PAGINATION_CONSTANTS.MIN_PAGE_SIZE}, got: ${pageSize}`
      );
      logger.error('PaginationService validation failed: Invalid page size (too small)', {
        pageSize,
        minPageSize: PAGINATION_CONSTANTS.MIN_PAGE_SIZE,
        reason: 'Page size must be a positive integer',
      });
      throw error;
    }

    // Validate page size maximum (DoS prevention)
    if (pageSize > PAGINATION_CONSTANTS.MAX_PAGE_SIZE) {
      const error = new Error(
        `Page size must be <= ${PAGINATION_CONSTANTS.MAX_PAGE_SIZE}, got: ${pageSize}`
      );
      logger.error('PaginationService validation failed: Excessive page size', {
        pageSize,
        maxPageSize: PAGINATION_CONSTANTS.MAX_PAGE_SIZE,
        reason: 'Page size exceeds maximum allowed (DoS prevention)',
      });
      throw error;
    }
  }
}

/**
 * Factory function to create a new PaginationService instance
 *
 * Useful for dependency injection scenarios where you want to ensure
 * a fresh instance per consumer.
 *
 * @template T - Type of items being paginated
 * @returns New PaginationService instance
 *
 * @example
 * ```typescript
 * const paginationService = createPaginationService<MyElementType>();
 * const result = paginationService.paginate(items, { page: 1, pageSize: 25 });
 * ```
 */
export function createPaginationService<T = any>(): IPaginationService<T> {
  return new PaginationService<T>();
}

/**
 * Singleton instance for convenience
 *
 * Use this when you don't need DI or when sharing a single instance
 * across the application is acceptable. Since the service is stateless,
 * sharing is safe.
 *
 * @example
 * ```typescript
 * import { paginationService } from './PaginationService.js';
 *
 * const result = paginationService.paginate(items, { page: 2, pageSize: 50 });
 * ```
 */
export const paginationService = new PaginationService();
