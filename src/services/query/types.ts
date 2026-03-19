/**
 * Type definitions for element-agnostic query services
 *
 * This module provides reusable interfaces for querying, filtering, sorting,
 * and paginating any element type in the DollhouseMCP system.
 *
 * Design Principles:
 * 1. Element-agnostic: Works with any T that extends IElement
 * 2. Composable: Services can be used independently or combined
 * 3. Consistent: Follows patterns from src/types/collection.ts
 * 4. Secure: All inputs require validation before use
 *
 * @see src/types/collection.ts for collection-specific pagination patterns
 * @see src/types/elements/IElement.ts for base element interface
 */

import { IElement, IElementMetadata } from '../../types/elements/IElement.js';

// ============================================================================
// Pagination Types
// ============================================================================

/**
 * Pagination configuration options
 *
 * Follows collection.ts patterns:
 * - 1-indexed pages (page 1 is first page)
 * - Default pageSize of 20 (Issue #299)
 * - Maximum pageSize enforced by implementations
 *
 * SECURITY: Validate page and pageSize before use to prevent:
 * - Negative page numbers
 * - Zero or negative page sizes
 * - Excessively large page sizes (DoS risk)
 */
export interface PaginationOptions {
  /**
   * Page number (1-indexed)
   * @default 1
   * @minimum 1
   */
  page?: number;

  /**
   * Number of items per page
   * @default 20
   * @minimum 1
   * @maximum Implementation-defined (typically 100)
   */
  pageSize?: number;
}

/**
 * Pagination metadata returned with query results
 *
 * Provides complete pagination state to enable:
 * - UI pagination controls
 * - Next/previous page navigation
 * - Total result set size awareness
 */
export interface PaginationMetadata {
  /**
   * Current page number (1-indexed)
   */
  page: number;

  /**
   * Number of items per page
   */
  pageSize: number;

  /**
   * Total number of items across all pages
   */
  totalItems: number;

  /**
   * Total number of pages
   */
  totalPages: number;

  /**
   * Whether there is a next page available
   */
  hasNextPage: boolean;

  /**
   * Whether there is a previous page available
   */
  hasPrevPage: boolean;
}

/**
 * Generic paginated result container
 *
 * Wraps any array of items with pagination metadata.
 * Used as base type for more specific result types.
 *
 * @template T - Type of items in the result set
 */
export interface PaginatedResult<T> {
  /**
   * Items for the current page
   */
  items: T[];

  /**
   * Pagination metadata
   */
  pagination: PaginationMetadata;
}

// ============================================================================
// Filtering Types
// ============================================================================

/**
 * Filter criteria for querying elements
 *
 * All criteria are optional and combined with AND logic when multiple
 * filters are specified (except tagsAny which uses OR).
 *
 * SECURITY NOTES:
 * 1. All string inputs MUST be sanitized to prevent injection attacks
 * 2. Date inputs MUST be validated to ensure valid ISO 8601 format
 * 3. Tag arrays MUST be validated to prevent array manipulation attacks
 * 4. Status values MUST be validated against ElementStatus enum
 *
 * @example
 * {
 *   nameContains: 'code review',
 *   tags: ['typescript', 'linting'],  // AND logic: has both tags
 *   tagsAny: ['javascript', 'python'], // OR logic: has either tag
 *   author: 'alice',
 *   createdAfter: '2024-01-01T00:00:00Z',
 *   status: 'active'
 * }
 */
export interface FilterCriteria {
  /**
   * Filter by partial name match (case-insensitive)
   * Implementation should use fuzzy matching or contains logic
   *
   * SECURITY: Sanitize input, limit length to prevent ReDoS
   */
  nameContains?: string;

  /**
   * Filter by tags (AND logic - element must have ALL specified tags)
   *
   * SECURITY: Validate each tag string, limit array size
   */
  tags?: string[];

  /**
   * Filter by tags (OR logic - element must have ANY of the specified tags)
   *
   * SECURITY: Validate each tag string, limit array size
   */
  tagsAny?: string[];

  /**
   * Filter by author username
   *
   * SECURITY: Sanitize input, validate against username pattern
   */
  author?: string;

  /**
   * Filter for elements created after this date (inclusive)
   *
   * SECURITY: Validate ISO 8601 format, ensure valid date
   * @format ISO 8601 date-time string
   */
  createdAfter?: string;

  /**
   * Filter for elements created before this date (inclusive)
   *
   * SECURITY: Validate ISO 8601 format, ensure valid date
   * @format ISO 8601 date-time string
   */
  createdBefore?: string;

  /**
   * Filter by element status
   * - 'active': Only active elements
   * - 'inactive': Only inactive elements
   * - 'all': All elements regardless of status (default)
   *
   * SECURITY: Validate against ElementStatus enum values
   */
  status?: 'active' | 'inactive' | 'all';

  /**
   * Filter by partial description match (case-insensitive substring)
   *
   * SECURITY: Sanitize input, limit length to prevent ReDoS
   */
  descriptionContains?: string;

  /**
   * Filter by category (case-insensitive exact match on metadata.category)
   *
   * SECURITY: Sanitize input, limit length
   */
  category?: string;
}

/**
 * Applied filter summary for query results
 *
 * Reports which filters were actually applied to help users
 * understand the result set.
 */
export interface AppliedFilters {
  /**
   * Name filter that was applied
   */
  nameContains?: string;

  /**
   * Tags that were required (AND logic)
   */
  tags?: string[];

  /**
   * Tags where any match was required (OR logic)
   */
  tagsAny?: string[];

  /**
   * Author filter that was applied
   */
  author?: string;

  /**
   * Created after date filter
   */
  createdAfter?: string;

  /**
   * Created before date filter
   */
  createdBefore?: string;

  /**
   * Status filter that was applied
   */
  status?: 'active' | 'inactive' | 'all';

  /**
   * Description filter that was applied
   */
  descriptionContains?: string;

  /**
   * Category filter that was applied
   */
  category?: string;

  /**
   * Total number of filters applied
   */
  count: number;
}

// ============================================================================
// Sorting Types
// ============================================================================

/**
 * Sort order direction
 */
export type SortOrder = 'asc' | 'desc';

/**
 * Fields available for sorting
 *
 * Standard fields available on all elements:
 * - name: Element name (from metadata)
 * - created: Creation timestamp (from metadata)
 * - modified: Last modification timestamp (from metadata)
 * - version: Semantic version (from metadata)
 *
 * Element-specific fields:
 * - retention: Memory-specific retention policy field
 *
 * Implementations should handle missing fields gracefully
 * (e.g., sort nulls last).
 */
export type SortableField = 'name' | 'created' | 'modified' | 'version' | 'retention';

/**
 * Sorting configuration options
 *
 * SECURITY: Validate sortBy against SortableField enum to prevent
 * arbitrary field access or injection attacks.
 */
export interface SortOptions {
  /**
   * Field to sort by
   * @default 'name'
   */
  sortBy?: SortableField;

  /**
   * Sort order direction
   * @default 'asc'
   */
  sortOrder?: SortOrder;
}

/**
 * Applied sorting metadata for query results
 *
 * Reports the actual sorting that was applied to the result set.
 */
export interface AppliedSorting {
  /**
   * Field that was used for sorting
   */
  sortBy: SortableField;

  /**
   * Sort order that was applied
   */
  sortOrder: SortOrder;
}

// ============================================================================
// Combined Query Types
// ============================================================================

/**
 * Aggregation options for count/group_by queries (Issue #309).
 * When present, the query returns aggregation results instead of paginated items.
 */
export interface AggregationOptions {
  /**
   * If true, return only the count of matching elements (no items).
   */
  count?: boolean;

  /**
   * Group results by a metadata field (e.g., 'category', 'author', 'tags').
   * Returns a Record<string, number> mapping field values to counts.
   */
  group_by?: string;
}

/**
 * Complete query options combining pagination, filtering, and sorting
 *
 * All options are optional. Defaults:
 * - Pagination: page=1, pageSize=20
 * - Filters: none applied
 * - Sort: sortBy='name', sortOrder='asc'
 * - Aggregate: none (returns items). When set, returns count/groups instead.
 *
 * @example
 * ```typescript
 * // Paginated listing
 * { pagination: { page: 2, pageSize: 10 }, filters: { tags: ['typescript'] }, sort: { sortBy: 'modified', sortOrder: 'desc' } }
 *
 * // Count aggregation
 * { aggregate: { count: true } }
 *
 * // Grouped count
 * { aggregate: { count: true, group_by: 'category' }, filters: { status: 'active' } }
 * ```
 */
export interface QueryOptions {
  /**
   * Pagination configuration
   */
  pagination?: PaginationOptions;

  /**
   * Filter criteria
   */
  filters?: FilterCriteria;

  /**
   * Sorting configuration
   */
  sort?: SortOptions;

  /**
   * Aggregation options (Issue #309).
   * When present, returns count/group_by results instead of paginated items.
   */
  aggregate?: AggregationOptions;
}

/**
 * Complete query result with items, pagination, sorting, and filter metadata
 *
 * Extends PaginatedResult with additional context about the query
 * that was executed.
 *
 * @template T - Type of items in the result set (must extend IElement)
 */
export interface QueryResult<T extends IElement> extends PaginatedResult<T> {
  /**
   * Sorting that was applied
   */
  sorting: AppliedSorting;

  /**
   * Filters that were applied
   */
  filters: {
    /**
     * Summary of applied filters
     */
    applied: AppliedFilters;
  };
}

// ============================================================================
// Service Interfaces
// ============================================================================

/**
 * Service interface for pagination operations
 *
 * Provides utilities to paginate any array of items with consistent
 * behavior across the application.
 *
 * Implementation requirements:
 * - Validate pagination options
 * - Handle empty arrays gracefully
 * - Return accurate metadata
 * - Use 1-indexed pages
 *
 * @template T - Type of items being paginated
 */
export interface IPaginationService<T> {
  /**
   * Paginate an array of items
   *
   * @param items - Complete array of items to paginate
   * @param options - Pagination configuration
   * @returns Paginated result with metadata
   * @throws {Error} If pagination options are invalid
   */
  paginate(items: T[], options?: PaginationOptions): PaginatedResult<T>;

  /**
   * Calculate pagination metadata without returning items
   *
   * Useful for API responses where you need metadata but already
   * have the items.
   *
   * @param totalItems - Total number of items in full result set
   * @param options - Pagination configuration
   * @returns Pagination metadata only
   */
  calculateMetadata(totalItems: number, options?: PaginationOptions): PaginationMetadata;
}

/**
 * Service interface for filtering operations
 *
 * Provides utilities to filter arrays of elements based on metadata
 * and other criteria.
 *
 * Implementation requirements:
 * - Sanitize all filter inputs
 * - Support partial matches for name
 * - Handle missing metadata fields gracefully
 * - Combine multiple filters with AND logic (except tagsAny)
 * - Return empty array if no items match
 *
 * @template T - Type of items being filtered (must extend IElement)
 */
export interface IFilterService<T extends IElement> {
  /**
   * Filter an array of elements based on criteria
   *
   * @param items - Array of elements to filter
   * @param criteria - Filter criteria to apply
   * @returns Filtered array (may be empty)
   * @throws {Error} If filter criteria contain invalid values
   */
  filter(items: T[], criteria?: FilterCriteria): T[];

  /**
   * Build a summary of which filters will be applied
   *
   * Useful for logging and debugging query execution.
   *
   * @param criteria - Filter criteria
   * @returns Summary of applicable filters
   */
  summarizeFilters(criteria?: FilterCriteria): AppliedFilters;

  /**
   * Validate filter criteria without applying them
   *
   * @param criteria - Filter criteria to validate
   * @returns True if criteria are valid
   * @throws {Error} If criteria are invalid
   */
  validateCriteria(criteria?: FilterCriteria): boolean;
}

/**
 * Service interface for sorting operations
 *
 * Provides utilities to sort arrays of elements by various fields.
 *
 * Implementation requirements:
 * - Validate sort options
 * - Handle missing field values (sort nulls last)
 * - Support case-insensitive string sorting
 * - Support semantic version sorting
 * - Support ISO 8601 date sorting
 * - Maintain stable sort order
 *
 * @template T - Type of items being sorted (must extend IElement)
 */
export interface ISortService<T extends IElement> {
  /**
   * Sort an array of elements
   *
   * @param items - Array of elements to sort
   * @param options - Sorting configuration
   * @returns Sorted array (does not mutate original)
   * @throws {Error} If sort options are invalid
   */
  sort(items: T[], options?: SortOptions): T[];

  /**
   * Get the default sorting configuration
   *
   * @returns Default sort options
   */
  getDefaultSorting(): AppliedSorting;

  /**
   * Validate sort options without applying them
   *
   * @param options - Sort options to validate
   * @returns True if options are valid
   * @throws {Error} If options are invalid
   */
  validateOptions(options?: SortOptions): boolean;
}

/**
 * Combined service interface for element querying
 *
 * Orchestrates pagination, filtering, and sorting into a single
 * cohesive query operation.
 *
 * Implementation requirements:
 * - Validate all query options
 * - Apply operations in correct order: filter → sort → paginate
 * - Return complete query result with metadata
 * - Log query execution for debugging
 * - Handle empty result sets gracefully
 *
 * CONCURRENT MODIFICATION BEHAVIOR:
 * Query services operate on a snapshot of elements passed to them.
 * They are stateless and do not track file system changes. If elements
 * are modified on disk between fetch and query, results may be inconsistent
 * with the current file system state. For real-time consistency, callers
 * should re-fetch elements before each query.
 *
 * @template T - Type of elements being queried (must extend IElement)
 */
export interface IElementQueryService<T extends IElement> {
  /**
   * Execute a complete query operation
   *
   * Order of operations:
   * 1. Filter items based on criteria
   * 2. Sort filtered items
   * 3. Paginate sorted items
   *
   * SNAPSHOT SEMANTICS:
   * This method operates on the array of elements passed to it at the time
   * of the call. It does not track file system changes or re-read elements.
   * If elements are modified between fetch and query, results reflect the
   * state at fetch time, not query time. This is expected behavior for a
   * stateless service.
   *
   * @param items - Array of elements to query (snapshot at time of call)
   * @param options - Complete query configuration
   * @returns Query result with items and metadata
   * @throws {Error} If query options are invalid
   */
  query(items: T[], options?: QueryOptions): QueryResult<T>;

  /**
   * Execute query and return only the items (no metadata)
   *
   * Convenience method for cases where you only need the items.
   *
   * @param items - Array of elements to query
   * @param options - Complete query configuration
   * @returns Array of items matching query
   */
  queryItems(items: T[], options?: QueryOptions): T[];

  /**
   * Get the default query options
   *
   * @returns Default query configuration
   */
  getDefaultOptions(): Required<QueryOptions>;

  /**
   * Validate query options without executing query
   *
   * @param options - Query options to validate
   * @returns True if options are valid
   * @throws {Error} If options are invalid
   */
  validateOptions(options?: QueryOptions): boolean;
}

// ============================================================================
// Helper Types
// ============================================================================

/**
 * Type guard to check if an element has required metadata for filtering
 *
 * @param element - Element to check
 * @returns True if element has valid metadata
 */
export function hasFilterableMetadata(element: unknown): element is { metadata: IElementMetadata } {
  return (
    typeof element === 'object' &&
    element !== null &&
    'metadata' in element &&
    typeof (element as any).metadata === 'object' &&
    (element as any).metadata !== null
  );
}

/**
 * Type guard to check if metadata has a specific field
 *
 * @param metadata - Metadata object
 * @param field - Field name to check
 * @returns True if field exists and is not undefined
 */
export function hasMetadataField<K extends keyof IElementMetadata>(
  metadata: IElementMetadata,
  field: K
): metadata is IElementMetadata & Required<Pick<IElementMetadata, K>> {
  return metadata[field] !== undefined;
}

/**
 * Safely extract an arbitrary metadata field value from an element.
 *
 * Replaces the unsafe double cast pattern:
 *   `el.metadata as unknown as Record<string, unknown>`
 *
 * Handles both known IElementMetadata fields and arbitrary metadata
 * properties that element types may add (e.g., category on skills).
 *
 * @param element - Element to read from
 * @param field - Metadata field name to extract
 * @returns The field value, or undefined if the element lacks metadata or the field
 *
 * @example
 * ```typescript
 * const category = getMetadataField(element, 'category'); // unknown
 * const tags = getMetadataField(element, 'tags');         // unknown
 * ```
 */
export function getMetadataField(element: IElement, field: string): unknown {
  if (!hasFilterableMetadata(element)) {
    return undefined;
  }
  // IElementMetadata doesn't have an index signature, so we go through unknown
  // to safely access arbitrary metadata fields that element types may add.
  const metadata = element.metadata as unknown as Record<string, unknown>;
  return metadata[field];
}

/**
 * Extract sortable value from element for a given field
 *
 * Safely extracts the value used for sorting, handling missing fields
 * and element-specific fields (like retention for memories).
 *
 * @param element - Element to extract value from
 * @param field - Field to extract
 * @returns Value to use for sorting, or undefined if not available
 */
export function extractSortValue(element: IElement, field: SortableField): string | number | undefined {
  switch (field) {
    case 'name':
      return element.metadata.name;
    case 'created':
      return element.metadata.created;
    case 'modified':
      return element.metadata.modified;
    case 'version':
      return element.metadata.version;
    case 'retention':
      // Element-specific field - check if element has it
      if ('retention' in element && typeof (element as any).retention === 'string') {
        return (element as any).retention;
      }
      return undefined;
    default:
      return undefined;
  }
}
