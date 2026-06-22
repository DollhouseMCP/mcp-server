/**
 * List Elements Handler - Token-Efficient Listings
 *
 * Issues #299, #309: All list_elements calls go through the query pipeline
 * with default pagination (page 1, pageSize 20). Returns structured data
 * that FieldFilter can process for token optimization.
 *
 * Legacy text-format mode has been removed. The response is now a structured
 * object with { items, pagination, sorting, filters } that MCPAQLHandler's
 * applyFieldSelection can filter with presets (minimal/standard/full).
 */

import { ElementType } from '../../portfolio/PortfolioManager.js';
import { ElementCrudContext } from './types.js';
import { logger } from '../../utils/logger.js';
import { QueryOptions, QueryResult, AggregationOptions } from '../../services/query/types.js';
import { aggregateElements, validateAggregationOptions } from '../../services/query/AggregationService.js';
import type { AggregationResult } from '../../services/query/AggregationService.js';
import { IElement } from '../../types/elements/IElement.js';
import { ELEMENT_TYPE_MAP, toSingularLabel } from '../../utils/elementTypeNormalization.js';

/** Default page size for list_elements when no pagination specified (Issue #299) */
const DEFAULT_LIST_PAGE_SIZE = 20;

/**
 * Normalize flat/mixed params into proper QueryOptions structure.
 *
 * Supports multiple input formats for convenience:
 * - Nested: { pagination: { page: 2, pageSize: 25 }, filters: {...}, sort: {...} }
 * - Flat pagination: { page: 2, pageSize: 25 }
 * - Flat limit/offset: { limit: 25, offset: 50 } (offset=50, limit=25 → page 3)
 * - Flat filters: { nameContains: 'test', tags: ['a', 'b'] }
 * - Flat sort: { sortBy: 'modified', sortOrder: 'desc' }
 *
 * Issue #204: MCP-AQL Pagination, filtering, and sorting
 */
/**
 * Validate pagination input before normalization.
 * Returns an error string if invalid, or null if valid.
 *
 * Issue #227: Reject invalid pagination parameter combinations
 */
function validatePaginationInput(options: Record<string, unknown>): string | null {
  // Check nested pagination object
  if (options.pagination && typeof options.pagination === 'object') {
    const p = options.pagination as Record<string, unknown>;
    if (typeof p.page === 'number' && (!Number.isFinite(p.page) || !Number.isInteger(p.page) || p.page <= 0)) {
      return `Invalid pagination: page must be a positive integer (got: ${p.page}).\nExample: { pagination: { page: 1, pageSize: 25 } }`;
    }
    if (typeof p.pageSize === 'number' && (!Number.isFinite(p.pageSize) || !Number.isInteger(p.pageSize) || p.pageSize <= 0)) {
      return `Invalid pagination: pageSize must be a positive integer (got: ${p.pageSize}).\nExample: { pagination: { page: 1, pageSize: 25 } }`;
    }
    return null;
  }

  // Check flat params
  if (typeof options.page === 'number' && (!Number.isFinite(options.page) || !Number.isInteger(options.page) || options.page <= 0)) {
    return `Invalid pagination: page must be a positive integer (got: ${options.page}).\nExample: { page: 1, pageSize: 25 }`;
  }
  if (typeof options.pageSize === 'number' && (!Number.isFinite(options.pageSize) || !Number.isInteger(options.pageSize) || options.pageSize <= 0)) {
    return `Invalid pagination: pageSize must be a positive integer (got: ${options.pageSize}).\nExample: { page: 1, pageSize: 25 }`;
  }
  if (typeof options.limit === 'number' && (!Number.isFinite(options.limit) || !Number.isInteger(options.limit) || options.limit <= 0)) {
    return `Invalid pagination: limit must be a positive integer (got: ${options.limit}).\nExample: { limit: 25, offset: 0 }`;
  }
  if (typeof options.offset === 'number' && (!Number.isFinite(options.offset) || !Number.isInteger(options.offset) || options.offset < 0)) {
    return `Invalid pagination: offset must be a whole number, 0 or greater (got: ${options.offset}).\nExample: { limit: 25, offset: 0 }`;
  }

  // Reject conflicting page + offset (ambiguous intent)
  const hasPage = typeof options.page === 'number';
  const hasOffset = typeof options.offset === 'number';
  if (hasPage && hasOffset) {
    return "Conflicting pagination: cannot use both 'page' and 'offset'.\nUse either page-based ({ page: 2, pageSize: 25 }) or offset-based ({ offset: 50, limit: 25 }).";
  }

  return null;
}

function normalizeQueryOptions(options: Record<string, unknown>): QueryOptions | { error: string } {
  // Validate pagination input first (Issue #227)
  const validationError = validatePaginationInput(options);
  if (validationError) {
    return { error: validationError };
  }

  const normalized: QueryOptions = {};

  // Normalize pagination
  // Priority: nested pagination > limit/offset > flat page/pageSize
  if (options.pagination && typeof options.pagination === 'object') {
    normalized.pagination = options.pagination as QueryOptions['pagination'];
  } else {
    const pagination: QueryOptions['pagination'] = {};

    // Support limit/offset style (convert to page/pageSize)
    if (typeof options.limit === 'number' && options.limit > 0) {
      pagination.pageSize = options.limit;
      if (typeof options.offset === 'number' && options.offset >= 0) {
        // Convert offset to page number (1-indexed)
        pagination.page = Math.floor(options.offset / options.limit) + 1;
      }
    }

    // Support flat page/pageSize (overrides limit/offset if both present)
    if (typeof options.page === 'number' && options.page > 0) {
      pagination.page = options.page;
    }
    if (typeof options.pageSize === 'number' && options.pageSize > 0) {
      pagination.pageSize = options.pageSize;
    }

    if (Object.keys(pagination).length > 0) {
      normalized.pagination = pagination;
    }
  }

  // Normalize filters
  // Priority: nested filters/filter > flat filter fields
  if (options.filters && typeof options.filters === 'object') {
    normalized.filters = options.filters as QueryOptions['filters'];
  } else if (options.filter && typeof options.filter === 'object') {
    // Support singular 'filter' as alias for 'filters'
    normalized.filters = options.filter as QueryOptions['filters'];
  } else {
    // Support flat filter fields
    const filters: NonNullable<QueryOptions['filters']> = {};

    if (typeof options.nameContains === 'string') {
      filters.nameContains = options.nameContains;
    }
    if (Array.isArray(options.tags) && options.tags.length > 0) {
      filters.tags = options.tags as string[];
    }
    if (Array.isArray(options.tagsAny) && options.tagsAny.length > 0) {
      filters.tagsAny = options.tagsAny as string[];
    }
    if (typeof options.author === 'string') {
      filters.author = options.author;
    }
    if (typeof options.createdAfter === 'string') {
      filters.createdAfter = options.createdAfter;
    }
    if (typeof options.createdBefore === 'string') {
      filters.createdBefore = options.createdBefore;
    }
    if (options.status === 'active' || options.status === 'inactive' || options.status === 'all') {
      filters.status = options.status;
    }
    if (typeof options.descriptionContains === 'string') {
      filters.descriptionContains = options.descriptionContains;
    }
    if (typeof options.category === 'string') {
      filters.category = options.category;
    }

    if (Object.keys(filters).length > 0) {
      normalized.filters = filters;
    }
  }

  // Normalize sort
  // Priority: nested sort > flat sortBy/sortOrder
  if (options.sort && typeof options.sort === 'object') {
    normalized.sort = options.sort as QueryOptions['sort'];
  } else {
    const sort: NonNullable<QueryOptions['sort']> = {};

    if (typeof options.sortBy === 'string') {
      sort.sortBy = options.sortBy as 'name' | 'created' | 'modified' | 'version' | 'retention';
    }
    if (options.sortOrder === 'asc' || options.sortOrder === 'desc') {
      sort.sortOrder = options.sortOrder;
    }

    if (Object.keys(sort).length > 0) {
      normalized.sort = sort;
    }
  }

  // Normalize aggregation (Issue #309)
  if (options.aggregate && typeof options.aggregate === 'object') {
    normalized.aggregate = options.aggregate as AggregationOptions;
  }

  return normalized;
}

/**
 * Clean up undefined values from options to prevent validation issues
 */
function cleanQueryOptions(options: QueryOptions): QueryOptions {
  const clean: QueryOptions = {};

  if (options.pagination) {
    const pagination: Partial<QueryOptions['pagination']> = {};
    if (options.pagination.page !== undefined) pagination.page = options.pagination.page;
    if (options.pagination.pageSize !== undefined) pagination.pageSize = options.pagination.pageSize;
    if (Object.keys(pagination).length > 0) clean.pagination = pagination;
  }

  if (options.sort) {
    const sort: Partial<NonNullable<QueryOptions['sort']>> = {};
    if (options.sort.sortBy !== undefined) sort.sortBy = options.sort.sortBy;
    if (options.sort.sortOrder !== undefined) sort.sortOrder = options.sort.sortOrder;
    if (Object.keys(sort).length > 0) clean.sort = sort;
  }

  if (options.filters) {
    const filters: Partial<NonNullable<QueryOptions['filters']>> = {};
    if (options.filters.nameContains !== undefined) filters.nameContains = options.filters.nameContains;
    if (options.filters.tags !== undefined && options.filters.tags.length > 0) filters.tags = options.filters.tags;
    if (options.filters.tagsAny !== undefined && options.filters.tagsAny.length > 0) filters.tagsAny = options.filters.tagsAny;
    if (options.filters.author !== undefined) filters.author = options.filters.author;
    if (options.filters.createdAfter !== undefined) filters.createdAfter = options.filters.createdAfter;
    if (options.filters.createdBefore !== undefined) filters.createdBefore = options.filters.createdBefore;
    if (options.filters.status !== undefined) filters.status = options.filters.status;
    if (options.filters.descriptionContains !== undefined) filters.descriptionContains = options.filters.descriptionContains;
    if (options.filters.category !== undefined) filters.category = options.filters.category;
    if (Object.keys(filters).length > 0) clean.filters = filters;
  }

  if (options.aggregate) {
    clean.aggregate = options.aggregate;
  }

  return clean;
}

/**
 * Structured item shape returned by list_elements.
 * Designed for token efficiency — includes only the fields LLMs typically need.
 */
export interface ListElementItem {
  name: string;
  description: string;
  type: string;
  version?: string;
  tags?: string[];
  created?: string;
  author?: string;
}

/**
 * Structured response shape for list_elements.
 * Replaces the old MCP text format with structured data that FieldFilter can process.
 */
export interface ListElementsResult {
  items: ListElementItem[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
  sorting: {
    sortBy: string;
    sortOrder: string;
  };
  filters?: {
    applied: Record<string, unknown> & {
      count: number;
    };
  };
  element_type: string;
  /** Issue #708: Count of elements that exist on disk but failed validation. */
  warnings?: {
    invalid_elements_count: number;
  };
}

/**
 * Structured error response — consistent with structured success responses.
 * Replaces the old MCP text format for validation errors.
 */
export interface StructuredError {
  error: string;
  code: 'VALIDATION_ERROR' | 'UNKNOWN_TYPE' | 'INTERNAL_ERROR';
}

export type { AggregationResult };

export async function listElements(
  context: ElementCrudContext,
  type: string,
  options?: QueryOptions | Record<string, unknown>
): Promise<ListElementsResult | AggregationResult | StructuredError> {
  await context.ensureInitialized();

  const normalizedType = ELEMENT_TYPE_MAP[type.trim().toLowerCase()];

  try {
    // Normalize options (supports flat params, nested params, or no params)
    const rawOptions = (options as Record<string, unknown>) || {};
    const normalizedOptions = normalizeQueryOptions(rawOptions);

    // Check for validation errors (Issue #227)
    if ('error' in normalizedOptions) {
      return {
        error: normalizedOptions.error,
        code: 'VALIDATION_ERROR' as const,
      };
    }

    if (!normalizedType) {
      return unknownType(type);
    }

    // Extract include_public flag. The MCP-AQL dispatcher maps
    // `include_public` (schema) → `includePublic` (internal) via the
    // schema's `mapTo`/`sources` machinery; test harnesses and alternate
    // entry points may pass either name directly or nested under `params`.
    //
    // The gate is strict boolean identity (`=== true`). The schema validator
    // (OperationSchema: include_public as type 'boolean') rejects non-boolean
    // inputs before the handler runs. If that check is ever bypassed — a
    // string `"true"`, the number 1, a truthy object — the request must not
    // coincidentally enable cross-user discovery. Only a literal `true` flips
    // the flag.
    const readFlag = (source: Record<string, unknown> | undefined): unknown =>
      source?.include_public ?? source?.includePublic;
    const optsObj = options as Record<string, unknown> | undefined;
    const rawFlag =
      readFlag(optsObj) ?? readFlag(optsObj?.params as Record<string, unknown> | undefined);
    const includePublic = rawFlag === true;

    // Get raw elements from the appropriate manager
    const elements = await getElementsForType(context, normalizedType, { includePublic });

    if (elements.length === 0) {
      return emptyElementsResponse(normalizedType);
    }

    // Clean the options to remove undefined values
    const cleanOptions = cleanQueryOptions(normalizedOptions);

    // Handle aggregation requests (Issue #309)
    if (cleanOptions.aggregate && (cleanOptions.aggregate.count || cleanOptions.aggregate.group_by)) {
      return handleAggregation(context, elements as IElement[], normalizedType, cleanOptions);
    }

    // Apply query service (filter → sort → paginate) with default pagination
    if (!cleanOptions.pagination) {
      cleanOptions.pagination = { page: 1, pageSize: DEFAULT_LIST_PAGE_SIZE };
    } else if (!cleanOptions.pagination.pageSize) {
      cleanOptions.pagination.pageSize = DEFAULT_LIST_PAGE_SIZE;
    }

    const result = context.elementQueryService.query(elements as IElement[], cleanOptions);

    // Issue #708: Include count of invalid elements in list response
    const invalidCount = getInvalidElementCount(context, normalizedType);

    // Return structured data (not MCP text format) so FieldFilter can process it
    return formatStructuredResult(result, normalizedType, invalidCount);
  } catch (error) {
    logger.error('ElementCRUDHandler.listElements', { error, type });
    return {
      error: `Failed to list ${type}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'INTERNAL_ERROR' as const,
    };
  }
}

/**
 * Get elements from the appropriate manager based on type.
 *
 * @param options.includePublic - When true, the result includes public
 *   elements owned by other users (DB mode only today; file mode ignores
 *   this until Step 4.5 delivers the per-user/shared layout).
 */
async function getElementsForType(
  context: ElementCrudContext,
  type: ElementType,
  options?: { includePublic?: boolean }
): Promise<any[]> {
  switch (type) {
    case ElementType.PERSONA:
      return context.personaManager.list(options);
    case ElementType.SKILL:
      return context.skillManager.list(options);
    case ElementType.TEMPLATE:
      return context.templateManager.list(options);
    case ElementType.AGENT:
      return context.agentManager.list(options);
    case ElementType.MEMORY:
      return context.memoryManager.list(options);
    case ElementType.ENSEMBLE:
      return context.ensembleManager.list(options);
    default:
      return [];
  }
}

/**
 * Issue #708: Get the count of invalid elements for a given type.
 */
function getInvalidElementCount(
  context: ElementCrudContext,
  type: ElementType
): number {
  let manager: { getInvalidElements?: () => unknown[] } | undefined;
  switch (type) {
    case ElementType.PERSONA: manager = context.personaManager; break;
    case ElementType.SKILL: manager = context.skillManager; break;
    case ElementType.TEMPLATE: manager = context.templateManager; break;
    case ElementType.AGENT: manager = context.agentManager; break;
    case ElementType.MEMORY: manager = context.memoryManager; break;
    case ElementType.ENSEMBLE: manager = context.ensembleManager; break;
  }
  if (manager && typeof manager.getInvalidElements === 'function') {
    return manager.getInvalidElements().length;
  }
  return 0;
}

/**
 * Convert QueryResult into a structured response with concise per-item data.
 * This replaces the old text-format response. The structured shape allows
 * MCPAQLHandler.applyFieldSelection() to further reduce tokens via presets.
 */
function formatStructuredResult(
  result: QueryResult<IElement>,
  type: ElementType,
  invalidElementCount = 0
): ListElementsResult {
  const { items, pagination, sorting, filters } = result;

  const response: ListElementsResult = {
    items: items.map((item) => ({
      name: item.metadata?.name || 'Unknown',
      description: item.metadata?.description || '',
      type,
      version: item.metadata?.version || item.version,
      tags: item.metadata?.tags,
      created: item.metadata?.created || '',
      author: item.metadata?.author || '',
    })),
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      totalItems: pagination.totalItems,
      totalPages: pagination.totalPages,
      hasNextPage: pagination.hasNextPage,
      hasPrevPage: pagination.hasPrevPage,
    },
    sorting: {
      sortBy: sorting.sortBy,
      sortOrder: sorting.sortOrder,
    },
    filters: filters.applied.count > 0 ? { applied: { ...filters.applied } } : undefined,
    element_type: toSingularLabel(type),
  };

  // Issue #708: Include warning when elements failed to load
  if (invalidElementCount > 0) {
    response.warnings = { invalid_elements_count: invalidElementCount };
  }

  return response;
}

/**
 * Handle aggregation requests (Issue #309).
 * Delegates to shared AggregationService for count and group_by.
 */
function handleAggregation(
  _context: ElementCrudContext,
  elements: IElement[],
  type: ElementType,
  options: QueryOptions
): AggregationResult | StructuredError {
  if (!options.aggregate) {
    return { count: elements.length, element_type: toSingularLabel(type) };
  }

  // Validate aggregation options
  const validationError = validateAggregationOptions(options.aggregate);
  if (validationError) {
    return {
      error: validationError,
      code: 'VALIDATION_ERROR' as const,
    };
  }

  return aggregateElements(elements, toSingularLabel(type), options.aggregate, options.filters);
}

/**
 * Empty response for each element type — returns structured data with zero items
 */
function emptyElementsResponse(type: ElementType): ListElementsResult {
  return {
    items: [],
    pagination: {
      page: 1,
      pageSize: DEFAULT_LIST_PAGE_SIZE,
      totalItems: 0,
      totalPages: 0,
      hasNextPage: false,
      hasPrevPage: false,
    },
    sorting: {
      sortBy: 'name',
      sortOrder: 'asc',
    },
    element_type: toSingularLabel(type),
  };
}

function unknownType(type: string): StructuredError {
  return {
    error: `Unknown element type '${type}'. Available types: ${Object.values(ElementType).join(', ')} (or legacy plural forms: personas, skills, templates, agents)`,
    code: 'UNKNOWN_TYPE',
  };
}
