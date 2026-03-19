/**
 * Element Query Services - Barrel exports
 *
 * This module provides a complete query system for element collections,
 * including pagination, filtering, sorting, and orchestration.
 *
 * SERVICES:
 * - PaginationService: Paginate any array with metadata
 * - FilterService: Filter elements by metadata criteria
 * - SortService: Sort elements by various fields
 * - ElementQueryService: Orchestrate all three services
 *
 * USAGE:
 * For most use cases, use createElementQueryService() factory:
 *
 * ```typescript
 * import { createElementQueryService } from './services/query/index.js';
 *
 * const queryService = createElementQueryService<MyElement>();
 * const result = queryService.query(items, {
 *   filters: { status: 'active' },
 *   sort: { sortBy: 'modified', sortOrder: 'desc' },
 *   pagination: { page: 1, pageSize: 20 }
 * });
 * ```
 *
 * For custom DI or testing, use individual services:
 *
 * ```typescript
 * import { PaginationService, FilterService, SortService } from './services/query/index.js';
 *
 * const mockFilter = new MockFilterService();
 * const queryService = new ElementQueryService(
 *   new PaginationService(),
 *   mockFilter,
 *   new SortService()
 * );
 * ```
 *
 * @module services/query
 */

// ============================================================================
// Type Exports
// ============================================================================

export type {
  // Pagination types
  PaginationOptions,
  PaginationMetadata,
  PaginatedResult,
  // Filtering types
  FilterCriteria,
  AppliedFilters,
  // Sorting types
  SortOrder,
  SortableField,
  SortOptions,
  AppliedSorting,
  // Combined query types
  QueryOptions,
  QueryResult,
  // Service interfaces
  IPaginationService,
  IFilterService,
  ISortService,
  IElementQueryService,
} from './types.js';

// Export helper functions
export { hasFilterableMetadata, hasMetadataField, getMetadataField, extractSortValue } from './types.js';

// Export aggregation types and options
export type { AggregationOptions } from './types.js';

// ============================================================================
// Service Exports
// ============================================================================

// PaginationService
export { PaginationService, createPaginationService, paginationService } from './PaginationService.js';

// FilterService
import { FilterService as FilterServiceClass } from './FilterService.js';
export { FilterService } from './FilterService.js';

/**
 * Factory function to create a new FilterService instance
 *
 * @template T - Element type extending IElement
 * @returns New FilterService instance
 */
export function createFilterService<T extends import('../../types/elements/IElement.js').IElement>() {
  return new FilterServiceClass<T>();
}

// SortService
import { SortService as SortServiceClass } from './SortService.js';
export { SortService } from './SortService.js';

/**
 * Factory function to create a new SortService instance
 *
 * @template T - Element type extending IElement
 * @returns New SortService instance
 */
export function createSortService<T extends import('../../types/elements/IElement.js').IElement>() {
  return new SortServiceClass<T>();
}

// ElementQueryService (orchestrator)
export {
  ElementQueryService,
  createElementQueryService,
  elementQueryService,
} from './ElementQueryService.js';

// AggregationService (Issue #309)
export {
  aggregateElements,
  validateAggregationOptions,
  getAllowedGroupByFields,
} from './AggregationService.js';
export type { AggregationResult } from './AggregationService.js';
