/**
 * AggregationService - Server-side count and group_by aggregation for elements
 *
 * Provides lightweight aggregation queries that return counts and groupings
 * without fetching full paginated item lists. This saves ~98% of tokens
 * compared to listing all items when only counts are needed.
 *
 * Issue #309: Token-efficient aggregation
 *
 * DESIGN:
 * - Uses FilterService.filter() directly (not full query pipeline) for efficiency
 * - Deduplicates array values in group_by to prevent double-counting
 * - Validates group_by fields against a whitelist to prevent internal field exposure
 * - Stateless and safe for concurrent use
 *
 * @module services/query/AggregationService
 */

import { IElement } from '../../types/elements/IElement.js';
import { FilterCriteria, AggregationOptions, getMetadataField } from './types.js';
import { FilterService } from './FilterService.js';
import { logger } from '../../utils/logger.js';

/**
 * Result of an aggregation query.
 *
 * @example
 * ```typescript
 * // Count only:
 * { count: 42, element_type: 'persona' }
 *
 * // Count with group_by:
 * { count: 42, element_type: 'persona', groups: { 'assistant': 15, 'creative': 12, 'technical': 15 } }
 * ```
 */
export interface AggregationResult {
  /** Total number of elements matching filters (or all elements if no filters) */
  count: number;
  /** Element type that was aggregated */
  element_type: string;
  /** Group counts when group_by is specified. Maps field values to occurrence counts. */
  groups?: Record<string, number>;
}

/**
 * Metadata fields allowed for group_by aggregation.
 *
 * Only these fields can be used with group_by to prevent:
 * - Exposure of internal/sensitive metadata fields
 * - Arbitrary property enumeration attacks
 * - Grouping on fields that produce meaningless results (e.g., timestamps)
 */
const ALLOWED_GROUP_BY_FIELDS = new Set([
  'category',
  'author',
  'tags',
  'status',
  'version',
]);

/**
 * Aggregate elements with optional filtering and grouping.
 *
 * Uses FilterService.filter() directly for efficiency — skips the sort and
 * paginate steps that the full query pipeline would apply, since aggregation
 * only needs to count elements, not order or slice them.
 *
 * @param elements - Full element array to aggregate over
 * @param elementType - Element type string for the result
 * @param options - Aggregation options (count, group_by)
 * @param filters - Optional filter criteria to apply before aggregating
 * @returns Aggregation result with count and optional groups
 *
 * @example
 * ```typescript
 * // Count all personas
 * const result = aggregateElements(personas, 'persona', { count: true });
 * // → { count: 42, element_type: 'persona' }
 *
 * // Count personas grouped by category
 * const grouped = aggregateElements(personas, 'persona',
 *   { count: true, group_by: 'category' });
 * // → { count: 42, element_type: 'persona', groups: { assistant: 15, creative: 27 } }
 *
 * // Count with filters
 * const filtered = aggregateElements(personas, 'persona',
 *   { count: true, group_by: 'tags' },
 *   { status: 'active' });
 * // → { count: 10, element_type: 'persona', groups: { typescript: 5, python: 3, rust: 2 } }
 * ```
 */
export function aggregateElements(
  elements: IElement[],
  elementType: string,
  options: AggregationOptions,
  filters?: FilterCriteria
): AggregationResult {
  // Apply filters directly via FilterService (no sort/paginate needed)
  const filterService = new FilterService<IElement>();
  const filtered = filters ? filterService.filter(elements, filters) : elements;

  logger.debug('AggregationService.aggregate', {
    inputCount: elements.length,
    filteredCount: filtered.length,
    hasGroupBy: !!options.group_by,
    elementType,
  });

  const result: AggregationResult = {
    count: filtered.length,
    element_type: elementType,
  };

  // group_by support with field validation and array deduplication
  if (options.group_by) {
    const field = options.group_by;

    // Validate field against whitelist
    if (!ALLOWED_GROUP_BY_FIELDS.has(field)) {
      const allowed = [...ALLOWED_GROUP_BY_FIELDS].sort().join(', ');
      throw new Error(
        `Invalid group_by field '${field}'. Allowed fields: ${allowed}`
      );
    }

    const groups: Record<string, number> = {};

    for (const el of filtered) {
      const value = getMetadataField(el, field);

      if (Array.isArray(value)) {
        // Deduplicate array values to prevent double-counting
        // e.g., tags: ['a', 'a', 'b'] → counts 'a' once, 'b' once for this element
        const unique = [...new Set(value.map(String))];
        for (const v of unique) {
          groups[v] = (groups[v] || 0) + 1;
        }
      } else {
        const key = value != null ? String(value) : 'unknown';
        groups[key] = (groups[key] || 0) + 1;
      }
    }

    result.groups = groups;
  }

  return result;
}

/**
 * Validate aggregation options before execution.
 *
 * @param options - Aggregation options to validate
 * @returns null if valid, error message string if invalid
 */
export function validateAggregationOptions(options: AggregationOptions): string | null {
  if (options.group_by) {
    if (typeof options.group_by !== 'string') {
      return 'aggregate.group_by must be a string';
    }
    if (!ALLOWED_GROUP_BY_FIELDS.has(options.group_by)) {
      const allowed = [...ALLOWED_GROUP_BY_FIELDS].sort().join(', ');
      return `Invalid group_by field '${options.group_by}'. Allowed fields: ${allowed}`;
    }
  }
  return null;
}

/**
 * Get the set of allowed group_by fields (for introspection/documentation).
 */
export function getAllowedGroupByFields(): string[] {
  return [...ALLOWED_GROUP_BY_FIELDS].sort();
}
