/**
 * SearchParamsNormalizer - Normalizes search operation parameters
 *
 * Transforms raw search input parameters into the format expected
 * by PortfolioHandler.searchAll().
 *
 * Handles:
 * - Scope → sources array conversion
 * - Pagination (offset/limit → page/pageSize)
 * - Sort parameter normalization
 * - Filter parameter extraction
 *
 * @see Issue #243 - Unified search with normalizer architecture
 */

import type {
  Normalizer,
  NormalizerContext,
  NormalizerResult,
  NormalizedSearchParams,
} from './types.js';

/** Valid scope values for search operations */
const VALID_SCOPES = ['local', 'github', 'collection'] as const;
type ValidScope = typeof VALID_SCOPES[number];

/** Default pagination limit when not specified */
const DEFAULT_PAGE_SIZE = 20;

/** Valid sort order values */
const VALID_SORT_ORDERS = ['asc', 'desc'] as const;

/**
 * Raw input parameters for search operations.
 */
interface RawSearchParams {
  query?: unknown;
  scope?: unknown;
  type?: unknown;
  page?: unknown;
  limit?: unknown;
  pagination?: unknown;
  sort?: unknown;
  sortBy?: unknown;
  sortOrder?: unknown;
  filters?: unknown;
  options?: unknown;
  // Legacy parameter names
  elementType?: unknown;
  fuzzyMatch?: unknown;
  includeKeywords?: unknown;
  includeTags?: unknown;
  includeTriggers?: unknown;
  includeDescriptions?: unknown;
}

/**
 * Normalizer for search operation parameters.
 *
 * Converts various input formats into a consistent structure
 * for the search handler.
 *
 * @example
 * ```typescript
 * const normalizer = new SearchParamsNormalizer();
 * const result = normalizer.normalize({
 *   query: 'creative writer',
 *   scope: ['local', 'collection'],
 *   pagination: { offset: 20, limit: 10 }
 * }, context);
 *
 * // Result:
 * // {
 * //   success: true,
 * //   params: {
 * //     query: 'creative writer',
 * //     sources: ['local', 'collection'],
 * //     page: 3,
 * //     pageSize: 10
 * //   }
 * // }
 * ```
 */
export class SearchParamsNormalizer implements Normalizer<RawSearchParams, NormalizedSearchParams> {
  readonly name = 'searchParams';

  /**
   * Normalize search parameters.
   *
   * @param params - Raw input parameters
   * @param _context - Operation context (unused but available for future use)
   * @returns Normalized parameters or error
   */
  normalize(
    params: RawSearchParams,
    _context: NormalizerContext
  ): NormalizerResult<NormalizedSearchParams> {
    // Validate required query parameter
    if (!params.query || typeof params.query !== 'string' || params.query.trim().length === 0) {
      return {
        success: false,
        error: 'Search query is required and must be a non-empty string. ' +
          'Example: { query: "creative writer" }',
      };
    }

    // Normalize scope to sources array
    const scopeResult = this.normalizeScope(params.scope);
    if (!scopeResult.success) {
      return scopeResult;
    }

    // Normalize pagination
    const pagination = this.normalizePagination(params);
    if ('error' in pagination) {
      return { success: false, error: pagination.error };
    }

    // Normalize sort
    const sort = this.normalizeSort(params);

    // Normalize filters
    const filters = this.normalizeFilters(params.filters);

    // Normalize options
    const options = this.normalizeOptions(params);

    // Build normalized output
    const normalized: NormalizedSearchParams = {
      query: params.query.trim(),
      sources: scopeResult.sources,
      elementType: this.normalizeElementType(params),
      ...pagination,
      ...sort,
    };

    // Only include filters/options if they have values
    if (Object.keys(filters).length > 0) {
      normalized.filters = filters;
    }
    if (Object.keys(options).length > 0) {
      normalized.options = options;
    }

    return { success: true, params: normalized };
  }

  // ===========================================================================
  // Scope Normalization
  // ===========================================================================

  /**
   * Normalize scope parameter to sources array.
   *
   * @param scope - Raw scope value (string, array, 'all', or undefined)
   * @returns Normalized sources array or error
   *
   * @example
   * normalizeScope(undefined)        // => ['local', 'github', 'collection']
   * normalizeScope('all')            // => ['local', 'github', 'collection']
   * normalizeScope('local')          // => ['local']
   * normalizeScope(['local', 'collection']) // => ['local', 'collection']
   */
  private normalizeScope(scope: unknown): { success: true; sources: string[] } | { success: false; error: string } {
    // Default: search all sources
    if (scope === undefined || scope === null || scope === 'all') {
      return { success: true, sources: [...VALID_SCOPES] };
    }

    // Single scope as string
    if (typeof scope === 'string') {
      const validation = this.validateScopes([scope]);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
      return { success: true, sources: [scope] };
    }

    // Multiple scopes as array
    if (Array.isArray(scope)) {
      const validation = this.validateScopes(scope);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
      // Type-safe filter ensures only strings are included (already validated above)
      return { success: true, sources: scope.filter((s): s is string => typeof s === 'string') };
    }

    return {
      success: false,
      error:
        'Invalid scope parameter: must be a string, array of strings, or "all". ' +
        `Valid scopes: ${VALID_SCOPES.join(', ')}. ` +
        'Examples: scope: "local" or scope: ["local", "collection"]',
    };
  }

  /**
   * Validate that all scope values are valid.
   *
   * @param scopes - Array of scope values to validate
   * @returns Validation result
   */
  private validateScopes(scopes: unknown[]): { valid: true } | { valid: false; error: string } {
    const invalidScopes = scopes.filter(
      s => typeof s !== 'string' || !VALID_SCOPES.includes(s as ValidScope)
    );

    if (invalidScopes.length > 0) {
      return {
        valid: false,
        error:
          `Invalid scope value(s): ${invalidScopes.map(s => JSON.stringify(s)).join(', ')}. ` +
          `Valid scopes: ${VALID_SCOPES.join(', ')}`,
      };
    }

    return { valid: true };
  }

  // ===========================================================================
  // Pagination Normalization
  // ===========================================================================

  /**
   * Normalize pagination parameters.
   *
   * Handles both:
   * - Pagination object: { offset, limit }
   * - Top-level params: page, limit
   *
   * Converts offset-based to page-based pagination.
   *
   * @param params - Raw parameters
   * @returns Normalized page and pageSize
   *
   * @example
   * // Offset-based
   * normalizePagination({ pagination: { offset: 20, limit: 10 } })
   * // => { page: 3, pageSize: 10 }
   *
   * // Page-based
   * normalizePagination({ page: 2, limit: 25 })
   * // => { page: 2, pageSize: 25 }
   */
  private normalizePagination(params: RawSearchParams): {
    page?: number;
    pageSize?: number;
  } | { error: string } {
    const pagination = params.pagination as Record<string, unknown> | undefined;

    // Validate pagination values (Issue #227)
    if (pagination && typeof pagination === 'object') {
      if (pagination.offset !== undefined) {
        const offset = Number(pagination.offset);
        if (!Number.isFinite(offset) || !Number.isInteger(offset) || offset < 0) {
          return {
            error: `Invalid pagination: offset must be a whole number, 0 or greater (got: ${JSON.stringify(pagination.offset)}).\n` +
              'Example: { pagination: { offset: 0, limit: 25 } }',
          };
        }
      }
      if (pagination.limit !== undefined) {
        const limit = Number(pagination.limit);
        if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
          return {
            error: `Invalid pagination: limit must be a positive integer (got: ${JSON.stringify(pagination.limit)}).\n` +
              'Example: { pagination: { offset: 0, limit: 25 } }',
          };
        }
      }
    }

    if (params.page !== undefined) {
      const page = Number(params.page);
      if (!Number.isFinite(page) || !Number.isInteger(page) || page <= 0) {
        return {
          error: `Invalid pagination: page must be a positive integer (got: ${JSON.stringify(params.page)}).\n` +
            'Example: { page: 1, limit: 25 }',
        };
      }
    }

    if (params.limit !== undefined && pagination?.limit === undefined) {
      const limit = Number(params.limit);
      if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
        return {
          error: `Invalid pagination: limit must be a positive integer (got: ${JSON.stringify(params.limit)}).\n` +
            'Example: { page: 1, limit: 25 }',
        };
      }
    }

    // Reject conflicting page + offset (ambiguous intent)
    const hasPage = params.page !== undefined;
    const hasOffset = pagination?.offset !== undefined;
    if (hasPage && hasOffset) {
      return {
        error: "Conflicting pagination: cannot use both 'page' and 'offset'.\n" +
          'Use either page-based ({ page: 2, limit: 25 }) or offset-based ({ pagination: { offset: 50, limit: 25 } }).',
      };
    }

    // If pagination object with offset is provided, convert to page number
    if (pagination?.offset !== undefined) {
      const offset = Number(pagination.offset) || 0;
      const limit = Number(pagination.limit) || DEFAULT_PAGE_SIZE;
      return {
        page: Math.floor(offset / limit) + 1,
        pageSize: limit,
      };
    }

    // Otherwise use top-level values or pagination.limit
    const page = params.page !== undefined ? Number(params.page) : undefined;
    const pageSize =
      (pagination?.limit !== undefined ? Number(pagination.limit) : undefined) ||
      (params.limit !== undefined ? Number(params.limit) : undefined);

    const result: { page?: number; pageSize?: number } = {};
    if (page !== undefined && !isNaN(page)) {
      result.page = page;
    }
    if (pageSize !== undefined && !isNaN(pageSize)) {
      result.pageSize = pageSize;
    }

    return result;
  }

  // ===========================================================================
  // Sort Normalization
  // ===========================================================================

  /**
   * Normalize sort parameters.
   *
   * Handles:
   * - sort object: { field, order }
   * - sortBy/sortOrder top-level params
   *
   * @param params - Raw parameters
   * @returns Normalized sortBy and sortOrder
   *
   * @example
   * normalizeSort({ sort: { field: 'name', order: 'desc' } })
   * // => { sortBy: 'name', sortOrder: 'desc' }
   *
   * normalizeSort({ sortBy: 'created', sortOrder: 'asc' })
   * // => { sortBy: 'created', sortOrder: 'asc' }
   */
  private normalizeSort(params: RawSearchParams): {
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  } {
    const result: { sortBy?: string; sortOrder?: 'asc' | 'desc' } = {};

    // Check for sort object
    const sort = params.sort as Record<string, unknown> | undefined;
    if (sort) {
      if (typeof sort.field === 'string') {
        result.sortBy = sort.field;
      }
      if (typeof sort.order === 'string' && VALID_SORT_ORDERS.includes(sort.order as 'asc' | 'desc')) {
        result.sortOrder = sort.order as 'asc' | 'desc';
      }
    }

    // Top-level params override sort object
    if (typeof params.sortBy === 'string') {
      result.sortBy = params.sortBy;
    }
    if (typeof params.sortOrder === 'string' && VALID_SORT_ORDERS.includes(params.sortOrder as 'asc' | 'desc')) {
      result.sortOrder = params.sortOrder as 'asc' | 'desc';
    }

    return result;
  }

  // ===========================================================================
  // Filter Normalization
  // ===========================================================================

  /**
   * Normalize filter parameters.
   *
   * Extracts and validates filter values.
   *
   * @param filters - Raw filters object
   * @returns Normalized filters
   *
   * @example
   * normalizeFilters({ tags: ['ai', 'creative'], author: 'user123' })
   * // => { tags: ['ai', 'creative'], author: 'user123' }
   */
  private normalizeFilters(filters: unknown): NonNullable<NormalizedSearchParams['filters']> {
    const result: NonNullable<NormalizedSearchParams['filters']> = {};

    if (!filters || typeof filters !== 'object') {
      return result;
    }

    const f = filters as Record<string, unknown>;

    // Tags filter
    if (Array.isArray(f.tags)) {
      const validTags = f.tags.filter((t): t is string => typeof t === 'string');
      if (validTags.length > 0) {
        result.tags = validTags;
      }
    }

    // Author filter
    if (typeof f.author === 'string' && f.author.trim()) {
      result.author = f.author.trim();
    }

    // Date filters
    if (typeof f.createdAfter === 'string') {
      result.createdAfter = f.createdAfter;
    }
    if (typeof f.createdBefore === 'string') {
      result.createdBefore = f.createdBefore;
    }

    return result;
  }

  // ===========================================================================
  // Options Normalization
  // ===========================================================================

  /**
   * Normalize search options.
   *
   * Handles both options object and legacy top-level boolean params.
   *
   * @param params - Raw parameters
   * @returns Normalized options
   */
  private normalizeOptions(params: RawSearchParams): NonNullable<NormalizedSearchParams['options']> {
    const result: NonNullable<NormalizedSearchParams['options']> = {};

    // Check for options object
    const options = params.options as Record<string, unknown> | undefined;

    // Helper to get boolean value from options or legacy params
    const getBoolean = (optKey: string, legacyKey: keyof RawSearchParams): boolean | undefined => {
      if (options && typeof options[optKey] === 'boolean') {
        return options[optKey] as boolean;
      }
      if (typeof params[legacyKey] === 'boolean') {
        return params[legacyKey] as boolean;
      }
      return undefined;
    };

    // Map options
    const fuzzyMatch = getBoolean('fuzzyMatch', 'fuzzyMatch');
    const includeKeywords = getBoolean('includeKeywords', 'includeKeywords');
    const includeTags = getBoolean('includeTags', 'includeTags');
    const includeTriggers = getBoolean('includeTriggers', 'includeTriggers');
    const includeDescriptions = getBoolean('includeDescriptions', 'includeDescriptions');

    if (fuzzyMatch !== undefined) result.fuzzyMatch = fuzzyMatch;
    if (includeKeywords !== undefined) result.includeKeywords = includeKeywords;
    if (includeTags !== undefined) result.includeTags = includeTags;
    if (includeTriggers !== undefined) result.includeTriggers = includeTriggers;
    if (includeDescriptions !== undefined) result.includeDescriptions = includeDescriptions;

    return result;
  }

  // ===========================================================================
  // Element Type Normalization
  // ===========================================================================

  /**
   * Normalize element type parameter.
   *
   * Handles both 'type' and legacy 'elementType' params.
   *
   * @param params - Raw parameters
   * @returns Normalized element type or undefined
   */
  private normalizeElementType(params: RawSearchParams): string | undefined {
    if (typeof params.type === 'string') {
      return params.type;
    }
    if (typeof params.elementType === 'string') {
      return params.elementType;
    }
    return undefined;
  }
}
