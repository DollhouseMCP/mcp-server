/**
 * Normalizer System Types
 *
 * Provides a schema-driven parameter normalization layer that transforms
 * raw input parameters into handler-ready formats.
 *
 * @see Issue #243 - Unified search with normalizer architecture
 */

/**
 * Context provided to normalizers for parameter transformation.
 *
 * Contains metadata about the operation being performed, allowing
 * normalizers to make context-aware decisions.
 */
export interface NormalizerContext {
  /** The operation name being executed */
  operation: string;
  /** The CRUDE endpoint (CREATE, READ, UPDATE, DELETE, EXECUTE) */
  endpoint: string;
  /** The target handler name */
  handler: string;
  /** The target method name */
  method: string;
  /** Optional element type if applicable */
  elementType?: string;
}

/**
 * Result of a normalization operation.
 *
 * Normalizers return either success with transformed params,
 * or failure with an error message.
 */
export type NormalizerResult<T = Record<string, unknown>> =
  | { success: true; params: T }
  | { success: false; error: string };

/**
 * Interface for parameter normalizers.
 *
 * Normalizers transform raw input parameters into formats expected
 * by handler methods. They can:
 * - Convert parameter formats (e.g., scope string → sources array)
 * - Extract nested parameters (e.g., pagination object → page/pageSize)
 * - Validate and coerce types
 * - Apply defaults
 *
 * @example Implementation
 * ```typescript
 * class SearchParamsNormalizer implements Normalizer {
 *   readonly name = 'searchParams';
 *
 *   normalize(params, context) {
 *     if (!params.query) {
 *       return { success: false, error: 'Query is required' };
 *     }
 *     return {
 *       success: true,
 *       params: {
 *         query: params.query,
 *         sources: this.normalizeScope(params.scope),
 *       }
 *     };
 *   }
 * }
 * ```
 *
 * @example Usage
 * ```typescript
 * const normalizer = NormalizerRegistry.get('searchParams');
 * const result = normalizer.normalize({ query: 'test', scope: 'local' }, context);
 *
 * if (result.success) {
 *   // result.params is ready for the handler
 *   handler.searchAll(result.params);
 * } else {
 *   // result.error contains the validation message
 *   throw new Error(result.error);
 * }
 * ```
 */
export interface Normalizer<
  TInput = Record<string, unknown>,
  TOutput = Record<string, unknown>
> {
  /** Unique identifier for this normalizer */
  readonly name: string;

  /**
   * Transform input parameters into handler-ready format.
   *
   * @param params - Raw input parameters from the request
   * @param context - Operation context for context-aware normalization
   * @returns Normalized parameters or error
   *
   * @example
   * ```typescript
   * const result = normalizer.normalize({ query: 'test' }, context);
   * if (result.success) {
   *   console.log(result.params); // Transformed params
   * } else {
   *   console.error(result.error); // Validation error message
   * }
   * ```
   */
  normalize(
    params: TInput,
    context: NormalizerContext
  ): NormalizerResult<TOutput>;
}

/**
 * Configuration for normalizer behavior.
 *
 * Can be extended by specific normalizers for custom options.
 */
export interface NormalizerConfig {
  /** Whether to strip unknown parameters (default: false) */
  stripUnknown?: boolean;
  /** Whether to apply defaults for missing optional params (default: true) */
  applyDefaults?: boolean;
}

/**
 * Search-specific normalizer output format.
 *
 * Defines the normalized structure for search operations.
 * Includes index signature for Record<string, unknown> compatibility.
 */
export interface NormalizedSearchParams {
  /** The search query string */
  query: string;
  /** Normalized sources array */
  sources: string[];
  /** Element type filter */
  elementType?: string;
  /** Page number (1-based) */
  page?: number;
  /** Results per page */
  pageSize?: number;
  /** Sort field */
  sortBy?: string;
  /** Sort direction */
  sortOrder?: 'asc' | 'desc';
  /** Normalized filters */
  filters?: {
    tags?: string[];
    author?: string;
    createdAfter?: string;
    createdBefore?: string;
  };
  /** Search options */
  options?: {
    fuzzyMatch?: boolean;
    includeKeywords?: boolean;
    includeTags?: boolean;
    includeTriggers?: boolean;
    includeDescriptions?: boolean;
  };
  /** Index signature for Record<string, unknown> compatibility */
  [key: string]: unknown;
}
