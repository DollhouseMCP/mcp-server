/**
 * Normalizers Module
 *
 * Provides a schema-driven parameter normalization layer for MCP-AQL operations.
 *
 * Normalizers transform raw input parameters into formats expected by handlers,
 * enabling consistent parameter handling across the schema-driven dispatch system.
 *
 * @example
 * ```typescript
 * import { NormalizerRegistry, SearchParamsNormalizer } from './normalizers/index.js';
 *
 * // Register normalizers at startup
 * NormalizerRegistry.register(new SearchParamsNormalizer());
 *
 * // Use in schema
 * search: {
 *   normalizer: 'searchParams',
 *   ...
 * }
 * ```
 *
 * @see Issue #243 - Unified search with normalizer architecture
 */

// Types
export type {
  Normalizer,
  NormalizerContext,
  NormalizerResult,
  NormalizerConfig,
  NormalizedSearchParams,
} from './types.js';

// Registry
export { NormalizerRegistry } from './NormalizerRegistry.js';

// Normalizers
export { SearchParamsNormalizer } from './SearchParamsNormalizer.js';

/**
 * Initialize all built-in normalizers.
 *
 * Call this during application startup to register
 * the standard normalizers.
 */
import { NormalizerRegistry } from './NormalizerRegistry.js';
import { SearchParamsNormalizer } from './SearchParamsNormalizer.js';

export function initializeNormalizers(): void {
  // Only register if not already registered (idempotent)
  if (!NormalizerRegistry.has('searchParams')) {
    NormalizerRegistry.register(new SearchParamsNormalizer());
  }
}
