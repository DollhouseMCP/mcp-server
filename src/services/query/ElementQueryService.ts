/**
 * ElementQueryService - Orchestrator for element querying
 *
 * Coordinates pagination, filtering, and sorting services to provide
 * a unified query interface for element collections.
 *
 * DESIGN PRINCIPLES:
 * 1. Composition over inheritance - orchestrates independent services
 * 2. Correct operation order: filter → sort → paginate
 * 3. Complete metadata - returns all query context for debugging
 * 4. Stateless - safe for concurrent use and DI injection
 * 5. Validation - validates all inputs before processing
 *
 * OPERATION ORDER:
 * The order of operations is critical for correctness and performance:
 * 1. Filter: Reduce dataset to matching items only
 * 2. Sort: Order the filtered results
 * 3. Paginate: Extract requested page from sorted results
 *
 * This ensures that:
 * - Pagination operates on complete filtered+sorted dataset
 * - Sort operates on filtered dataset (more efficient)
 * - Results are deterministic and reproducible
 *
 * CONCURRENT MODIFICATION BEHAVIOR:
 * This service operates on element snapshots passed via the items parameter.
 * It does not read from disk or track file system changes. If elements are
 * modified on disk between fetch and query, results may be inconsistent with
 * the current file system state. This is expected behavior - the service is
 * stateless and designed for performance. For real-time consistency, callers
 * should re-fetch elements before each query operation.
 *
 * @module ElementQueryService
 */

import { IElement } from '../../types/elements/IElement.js';
import { logger } from '../../utils/logger.js';
import {
  IElementQueryService,
  IPaginationService,
  IFilterService,
  ISortService,
  QueryOptions,
  QueryResult,
  PaginationOptions,
} from './types.js';
import { PaginationService } from './PaginationService.js';
import { FilterService } from './FilterService.js';
import { SortService } from './SortService.js';

/**
 * ElementQueryService implementation
 *
 * Orchestrates three independent services to provide complete query capabilities:
 * - FilterService: Applies filter criteria to element arrays
 * - SortService: Sorts elements by specified fields
 * - PaginationService: Paginates sorted results
 *
 * All services are injected via constructor for testability and flexibility.
 *
 * @template T - Element type extending IElement
 *
 * @example
 * ```typescript
 * // Using factory (recommended)
 * const queryService = createElementQueryService<MyElement>();
 *
 * // Query with all options
 * const result = queryService.query(elements, {
 *   filters: { tags: ['typescript'], status: 'active' },
 *   sort: { sortBy: 'modified', sortOrder: 'desc' },
 *   pagination: { page: 2, pageSize: 25 }
 * });
 *
 * console.log(result.items);           // Paginated items
 * console.log(result.pagination);      // Pagination metadata
 * console.log(result.sorting);         // Applied sorting
 * console.log(result.filters.applied); // Applied filters
 * ```
 */
export class ElementQueryService<T extends IElement = IElement> implements IElementQueryService<T> {
  /**
   * Create a new ElementQueryService with injected dependencies
   *
   * DEPENDENCY INJECTION:
   * All services are provided via constructor to enable:
   * - Easy testing with mocks
   * - Service customization
   * - Container-based DI integration
   *
   * @param paginationService - Service for pagination operations
   * @param filterService - Service for filtering operations
   * @param sortService - Service for sorting operations
   */
  constructor(
    private readonly paginationService: IPaginationService<T>,
    private readonly filterService: IFilterService<T>,
    private readonly sortService: ISortService<T>
  ) {}

  /**
   * Execute a complete query operation with full metadata
   *
   * OPERATION ORDER:
   * 1. Validate all query options
   * 2. Filter items based on criteria
   * 3. Sort filtered items
   * 4. Paginate sorted items
   * 5. Build complete result with metadata
   *
   * The returned QueryResult includes:
   * - items: The paginated subset of matching items
   * - pagination: Complete pagination metadata
   * - sorting: Applied sorting configuration
   * - filters: Summary of applied filters
   *
   * SNAPSHOT SEMANTICS:
   * This method operates on the items array passed to it at the time of the call.
   * It does not re-read elements from disk or track file system changes. If elements
   * are modified on disk between when they are fetched and when this method is called,
   * the results will reflect the state at fetch time, not the current file system state.
   * This is expected behavior for a stateless query service. For real-time consistency,
   * callers should re-fetch elements immediately before calling this method.
   *
   * @param items - Array of elements to query (snapshot at time of call)
   * @param options - Complete query configuration
   * @returns Query result with items and complete metadata
   * @throws {Error} If query options are invalid
   *
   * @example
   * ```typescript
   * const result = queryService.query(allPersonas, {
   *   filters: {
   *     nameContains: 'code',
   *     tags: ['typescript'],
   *     status: 'active'
   *   },
   *   sort: {
   *     sortBy: 'modified',
   *     sortOrder: 'desc'
   *   },
   *   pagination: {
   *     page: 1,
   *     pageSize: 10
   *   }
   * });
   *
   * // Use result
   * console.log(`Showing ${result.items.length} of ${result.pagination.totalItems} items`);
   * console.log(`Sorted by ${result.sorting.sortBy} (${result.sorting.sortOrder})`);
   * console.log(`Applied ${result.filters.applied.count} filters`);
   * ```
   */
  public query(items: T[], options?: QueryOptions): QueryResult<T> {
    // Step 1: Validate all options
    this.validateOptions(options);

    // Step 2: Apply filters
    const filteredItems = this.filterService.filter(items, options?.filters);
    const appliedFilters = this.filterService.summarizeFilters(options?.filters);

    // Step 3: Sort filtered items
    const sortedItems = this.sortService.sort(filteredItems, options?.sort);
    const appliedSorting = {
      sortBy: options?.sort?.sortBy ?? this.sortService.getDefaultSorting().sortBy,
      sortOrder: options?.sort?.sortOrder ?? this.sortService.getDefaultSorting().sortOrder,
    };

    // Step 4: Paginate sorted items
    const paginatedResult = this.paginationService.paginate(sortedItems, options?.pagination);

    // Step 5: Build complete query result
    const result: QueryResult<T> = {
      items: paginatedResult.items,
      pagination: paginatedResult.pagination,
      sorting: appliedSorting,
      filters: {
        applied: appliedFilters,
      },
    };

    return result;
  }

  /**
   * Execute query and return only the items (no metadata)
   *
   * Convenience method for cases where you only need the items
   * and don't care about pagination metadata, applied filters, etc.
   *
   * This is equivalent to calling query() and extracting result.items,
   * but may be more convenient for simple use cases.
   *
   * @param items - Array of elements to query
   * @param options - Complete query configuration
   * @returns Array of items matching query (paginated)
   * @throws {Error} If query options are invalid
   *
   * @example
   * ```typescript
   * // Get just the items, ignore metadata
   * const items = queryService.queryItems(allPersonas, {
   *   filters: { status: 'active' },
   *   sort: { sortBy: 'name' }
   * });
   *
   * // Use items directly
   * items.forEach(item => console.log(item.metadata.name));
   * ```
   */
  public queryItems(items: T[], options?: QueryOptions): T[] {
    const result = this.query(items, options);
    return result.items;
  }

  /**
   * Get the default query options
   *
   * Returns a complete QueryOptions object with all defaults filled in.
   * Useful for:
   * - Understanding what defaults are used
   * - Building option objects incrementally
   * - Testing and documentation
   *
   * @returns Default query configuration with all fields specified
   *
   * @example
   * ```typescript
   * const defaults = queryService.getDefaultOptions();
   * console.log(defaults);
   * // {
   * //   pagination: { page: 1, pageSize: 25 },
   * //   filters: {},
   * //   sort: { sortBy: 'name', sortOrder: 'asc' }
   * // }
   *
   * // Use as base for custom options
   * const customOptions = {
   *   ...defaults,
   *   filters: { status: 'active' }
   * };
   * ```
   */
  public getDefaultOptions(): Required<QueryOptions> {
    const defaultSorting = this.sortService.getDefaultSorting();

    return {
      pagination: {
        page: 1,
        pageSize: 20,
      },
      filters: {},
      sort: {
        sortBy: defaultSorting.sortBy,
        sortOrder: defaultSorting.sortOrder,
      },
      aggregate: {},
    };
  }

  /**
   * Validate query options without executing query
   *
   * Validates all three option types:
   * - Pagination options via PaginationService
   * - Filter criteria via FilterService
   * - Sort options via SortService
   *
   * Use this to validate user input before executing a query,
   * or to test option validity during development.
   *
   * @param options - Query options to validate
   * @returns True if all options are valid
   * @throws {Error} If any options are invalid with descriptive message
   *
   * @example
   * ```typescript
   * try {
   *   queryService.validateOptions(userOptions);
   *   // Options are valid, proceed with query
   *   const result = queryService.query(items, userOptions);
   * } catch (error) {
   *   // Options are invalid, show error to user
   *   console.error('Invalid query options:', error.message);
   * }
   * ```
   */
  public validateOptions(options?: QueryOptions): boolean {
    if (!options) {
      return true; // No options is valid (use defaults)
    }

    try {
      // Validate filter criteria
      if (options.filters) {
        this.filterService.validateCriteria(options.filters);
      }

      // Validate sort options
      if (options.sort) {
        this.sortService.validateOptions(options.sort);
      }

      // Validate pagination options
      // PaginationService validates in paginate(), but we can validate structure here
      if (options.pagination) {
        this.validatePaginationStructure(options.pagination);
      }

      return true;
    } catch (error) {
      logger.error('ElementQueryService.validateOptions failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Validate pagination options structure
   *
   * Performs basic type and range validation for pagination options.
   * The PaginationService will perform additional validation during
   * actual pagination, but this catches obvious errors early.
   *
   * @param pagination - Pagination options to validate
   * @throws {Error} If pagination options are invalid
   *
   * @private
   */
  private validatePaginationStructure(pagination: PaginationOptions): void {
    if (pagination.page !== undefined) {
      if (!Number.isInteger(pagination.page) || pagination.page < 1) {
        throw new Error('Pagination page must be a positive integer');
      }
    }

    if (pagination.pageSize !== undefined) {
      if (!Number.isInteger(pagination.pageSize) || pagination.pageSize < 1) {
        throw new Error('Pagination pageSize must be a positive integer');
      }
    }
  }
}

/**
 * Factory function to create a new ElementQueryService instance
 *
 * Creates a complete ElementQueryService with all dependencies instantiated.
 * This is the recommended way to create a query service for most use cases.
 *
 * For custom dependency injection or testing, you can construct
 * ElementQueryService directly with mock services.
 *
 * @template T - Element type extending IElement
 * @returns New ElementQueryService instance with all dependencies
 *
 * @example
 * ```typescript
 * // Create service for a specific element type
 * const personaQueryService = createElementQueryService<Persona>();
 * const skillQueryService = createElementQueryService<Skill>();
 *
 * // Use immediately
 * const results = personaQueryService.query(personas, {
 *   filters: { status: 'active' },
 *   sort: { sortBy: 'name' },
 *   pagination: { page: 1, pageSize: 10 }
 * });
 * ```
 */
export function createElementQueryService<T extends IElement>(): IElementQueryService<T> {
  const paginationService = new PaginationService<T>();
  const filterService = new FilterService<T>();
  const sortService = new SortService<T>();

  return new ElementQueryService<T>(paginationService, filterService, sortService);
}

/**
 * Singleton instance for convenience
 *
 * Provides a ready-to-use query service for cases where DI is not needed
 * or when sharing a single instance across the application is acceptable.
 *
 * Since the service is stateless, sharing is safe for concurrent use.
 *
 * @example
 * ```typescript
 * import { elementQueryService } from './ElementQueryService.js';
 *
 * const result = elementQueryService.query(items, options);
 * ```
 */
export const elementQueryService = createElementQueryService<IElement>();
