/**
 * Deep merge utility for objects
 *
 * Provides a pure, reusable deep merge function with optional security filtering.
 *
 * @module utils/deepMerge
 */

/**
 * Options for deep merge behavior
 */
export interface DeepMergeOptions {
  /**
   * Properties to skip during merge (e.g., dangerous properties like __proto__)
   */
  skipProperties?: string[];

  /**
   * Read-only fields that should be skipped during merge
   */
  readOnlyFields?: Set<string>;
}

/**
 * Check if a value is a plain object (not null, not array)
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate DeepMergeOptions at runtime
 *
 * @param options - Options to validate
 * @throws Error if options are malformed
 */
function validateOptions(options: DeepMergeOptions): void {
  if (options.skipProperties !== undefined) {
    if (!Array.isArray(options.skipProperties)) {
      throw new TypeError('DeepMergeOptions.skipProperties must be an array of strings');
    }
    for (const prop of options.skipProperties) {
      if (typeof prop !== 'string') {
        throw new TypeError(`DeepMergeOptions.skipProperties contains non-string value: ${typeof prop}`);
      }
    }
  }

  if (options.readOnlyFields !== undefined) {
    if (!(options.readOnlyFields instanceof Set)) {
      throw new TypeError('DeepMergeOptions.readOnlyFields must be a Set<string>');
    }
  }
}

/**
 * Deep merge two objects
 *
 * Merge semantics:
 * - Plain objects are merged recursively
 * - Arrays replace entirely (not merged element-by-element)
 * - Primitives replace
 * - Dangerous/read-only properties are optionally skipped
 *
 * @param target - The target object to merge into
 * @param source - The source object to merge from
 * @param options - Optional merge behavior configuration
 * @returns New merged object (does not mutate inputs)
 *
 * @example
 * ```typescript
 * // Basic merge
 * const result = deepMerge({ a: 1 }, { b: 2 });
 * // => { a: 1, b: 2 }
 *
 * // Nested merge
 * const result = deepMerge(
 *   { settings: { theme: 'light', size: 10 } },
 *   { settings: { theme: 'dark' } }
 * );
 * // => { settings: { theme: 'dark', size: 10 } }
 *
 * // With security filtering
 * const result = deepMerge(target, source, {
 *   skipProperties: ['__proto__', 'constructor'],
 *   readOnlyFields: new Set(['id', 'type'])
 * });
 *
 * // With type preservation
 * interface Config { theme: string; size: number; }
 * const result = deepMerge<Config>(defaultConfig, userConfig);
 * ```
 */
export function deepMerge<T extends object = Record<string, unknown>>(
  target: T,
  source: Partial<T> | Record<string, unknown>,
  options?: DeepMergeOptions
): T {
  // Validate options at runtime if provided
  if (options) {
    validateOptions(options);
  }

  const result = { ...target } as Record<string, unknown>;
  const skipProperties = options?.skipProperties ?? [];
  const readOnlyFields = options?.readOnlyFields;

  for (const key of Object.keys(source)) {
    // Skip dangerous properties
    if (skipProperties.includes(key)) {
      continue;
    }

    // Skip read-only fields
    if (readOnlyFields?.has(key)) {
      continue;
    }

    const sourceValue = (source as Record<string, unknown>)[key];
    const targetValue = result[key];

    // If both are plain objects, merge recursively
    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      result[key] = deepMerge(targetValue, sourceValue, options);
    } else {
      // Arrays and primitives replace entirely
      result[key] = sourceValue;
    }
  }

  return result as T;
}

/**
 * Default dangerous properties that should never be merged
 * These can be used to prevent prototype pollution attacks
 */
export const DANGEROUS_PROPERTIES = [
  '__proto__',
  'constructor',
  'prototype',
];

/**
 * Create a deep merge function with preset options
 *
 * Useful for creating a configured merger that can be reused
 *
 * @param options - Preset options for all merges
 * @returns A configured deep merge function
 *
 * @example
 * ```typescript
 * const secureMerge = createDeepMerge({
 *   skipProperties: DANGEROUS_PROPERTIES,
 *   readOnlyFields: new Set(['id', 'type'])
 * });
 *
 * const result = secureMerge(target, source);
 * ```
 */
export function createDeepMerge(options: DeepMergeOptions) {
  return (target: Record<string, unknown>, source: Record<string, unknown>) =>
    deepMerge(target, source, options);
}
