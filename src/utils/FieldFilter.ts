/**
 * FieldFilter - GraphQL-style field selection for MCP-AQL responses
 *
 * Provides field filtering and name transformation for element responses:
 * - Filters object fields based on a fields array
 * - Transforms field names for LLM consistency (name → element_name)
 * - Supports nested paths (e.g., metadata.author, metadata.tags)
 * - Handles arrays of objects (filter each item)
 * - Provides preset field sets (minimal, standard, full)
 * - Applies Unicode normalization to field names for security (DMCP-SEC-004)
 *
 * PERFORMANCE NOTE:
 * Field selection is applied AFTER handlers return complete data.
 * This design choice:
 * - Keeps handlers simple (no field-awareness needed)
 * - Ensures consistent handler behavior regardless of field selection
 * - Makes preset changes easy without modifying handlers
 * - Has minimal overhead (~0.5ms per 100 elements)
 *
 * Token savings benefit the LLM context window, not internal processing.
 * Empirical measurements show 80-90% token reduction with minimal preset.
 *
 * @see Issue #202 - Implement GraphQL field selection for response token optimization
 * @see tests/unit/utils/FieldFilter.tokenSavings.test.ts - Empirical token savings
 */

import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

// ============================================================================
// Types
// ============================================================================

export interface FieldFilterOptions {
  /** Specific fields to include in response */
  fields?: string[];
  /** Preset field sets: 'minimal', 'standard', 'full' */
  preset?: 'minimal' | 'standard' | 'full';
  /** Transform field names for consistency (default: true) */
  transformNames?: boolean;
}

export interface FieldFilterResult {
  /** The filtered and transformed data */
  data: unknown;
  /** Fields that were requested but not found in data */
  missingFields?: string[];
  /** Whether name transformation was applied */
  transformed: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Field name transformations for LLM consistency.
 * These ensure response field names match input parameter names.
 *
 * Key = internal field name, Value = external field name
 */
export const FIELD_TRANSFORMS: Record<string, string> = {
  name: 'element_name',
};

/**
 * Reverse mapping for field selection.
 * Allows LLM to request either 'name' or 'element_name'.
 *
 * Key = external field name, Value = array of candidate internal paths (tried in order)
 * First match wins — supports both flat objects (name) and IElement objects (metadata.name).
 */
export const FIELD_ALIASES: Record<string, string[]> = {
  element_name: ['name', 'metadata.name'],
  description: ['description', 'metadata.description'],
};

/**
 * Preset field sets for common use cases.
 * null = return all fields (default behavior)
 */
export const FIELD_PRESETS: Record<string, string[] | null> = {
  minimal: ['element_name', 'description'],
  standard: ['element_name', 'description', 'metadata.tags', 'metadata.triggers'],
  full: null,
};

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Normalize a field name for security (DMCP-SEC-004).
 * Applies Unicode normalization to prevent homograph and bypass attacks.
 *
 * @param field - The field name to normalize
 * @returns Normalized field name
 */
function normalizeFieldName(field: string): string {
  const result = UnicodeValidator.normalize(field);
  return result.normalizedContent;
}

/**
 * Normalize an array of field names.
 * Returns both normalized fields and any invalid field warnings.
 *
 * @param fields - Array of field names to normalize
 * @returns Object with normalized fields and optional warnings
 */
export function normalizeFieldNames(fields: string[]): {
  normalized: string[];
  warnings?: string[];
} {
  const normalized: string[] = [];
  const warnings: string[] = [];

  for (const field of fields) {
    const result = UnicodeValidator.normalize(field);
    normalized.push(result.normalizedContent);

    if (result.detectedIssues && result.detectedIssues.length > 0) {
      warnings.push(`Field "${field}": ${result.detectedIssues.join(', ')}`);
    }
  }

  return {
    normalized,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Get value from nested path (e.g., 'metadata.author')
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Set value at nested path, creating intermediate objects as needed
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}

/**
 * Transform field name from internal to external format.
 */
function transformFieldName(name: string): string {
  return FIELD_TRANSFORMS[name] ?? name;
}

/**
 * Resolve field alias to candidate internal paths.
 * Allows LLM to request 'element_name' which maps to ['name', 'metadata.name'] internally.
 * Returns an array of candidate paths to try in order.
 * Applies Unicode normalization for security (DMCP-SEC-004).
 */
function resolveFieldAlias(field: string): string[] {
  // Normalize field name for security
  const normalizedField = normalizeFieldName(field);

  // Check if top-level field has an alias
  const topLevel = normalizedField.split('.')[0];
  const suffix = normalizedField.slice(topLevel.length);
  if (FIELD_ALIASES[topLevel]) {
    return FIELD_ALIASES[topLevel].map(candidate => candidate + suffix);
  }
  return [normalizedField];
}

/**
 * Filter a single object based on requested fields.
 * Tries each candidate path from alias resolution until one yields a value.
 * Uses the user's requested field name (or its transform) as the output key.
 */
function filterObject(
  obj: Record<string, unknown>,
  fields: string[],
  transform: boolean
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    // Resolve alias (element_name → ['name', 'metadata.name'])
    const candidatePaths = resolveFieldAlias(field);

    // Try each candidate path until one yields a value
    let value: unknown;
    let resolvedPath: string | undefined;
    for (const candidate of candidatePaths) {
      value = getNestedValue(obj, candidate);
      if (value !== undefined) {
        resolvedPath = candidate;
        break;
      }
    }

    if (value !== undefined && resolvedPath !== undefined) {
      // Use the user's requested field name as the output key
      // Apply transform only to the requested field name, not the resolved internal path
      const normalizedField = normalizeFieldName(field);
      const topLevel = normalizedField.split('.')[0];
      const outputField = transform
        ? (transformFieldName(topLevel) + normalizedField.slice(topLevel.length))
        : field;
      setNestedValue(result, outputField, value);
    }
  }

  return result;
}

/**
 * Apply name transformations to an entire object (no field filtering).
 * Used when no fields are specified but transformation is enabled.
 */
function transformObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const transformedKey = transformFieldName(key);

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[transformedKey] = transformObject(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[transformedKey] = value.map(item =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? transformObject(item as Record<string, unknown>)
          : item
      );
    } else {
      result[transformedKey] = value;
    }
  }

  return result;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Filter and transform response data based on field selection.
 *
 * @param data - The data to filter (object or array of objects)
 * @param options - Filtering options
 * @returns Filtered and transformed data with metadata
 *
 * @example
 * // With specific fields
 * filterFields({ name: 'test', description: 'desc', content: '...' }, {
 *   fields: ['element_name', 'description']
 * });
 * // Returns: { data: { element_name: 'test', description: 'desc' }, transformed: true }
 *
 * @example
 * // With preset
 * filterFields(data, { preset: 'minimal' });
 * // Returns: { data: { element_name, description }, transformed: true }
 *
 * @example
 * // No fields = transform only
 * filterFields({ name: 'test' }, {});
 * // Returns: { data: { element_name: 'test' }, transformed: true }
 */
export function filterFields(
  data: unknown,
  options: FieldFilterOptions = {}
): FieldFilterResult {
  const transform = options.transformNames !== false;

  // Resolve fields from direct specification or preset
  // Explicit fields take precedence over preset
  let fields: string[] | null = null;
  if (options.fields && options.fields.length > 0) {
    fields = options.fields;
  } else if (options.preset && FIELD_PRESETS[options.preset] !== undefined) {
    fields = FIELD_PRESETS[options.preset];
  }

  // Handle null/undefined
  if (data === null || data === undefined) {
    return { data, transformed: false };
  }

  // Handle arrays
  if (Array.isArray(data)) {
    const filtered = data.map(item => {
      if (item !== null && typeof item === 'object') {
        if (fields) {
          return filterObject(item as Record<string, unknown>, fields, transform);
        }
        return transform ? transformObject(item as Record<string, unknown>) : item;
      }
      return item;
    });
    return { data: filtered, transformed: transform };
  }

  // Handle objects
  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (fields) {
      return {
        data: filterObject(obj, fields, transform),
        transformed: transform,
      };
    }
    return {
      data: transform ? transformObject(obj) : obj,
      transformed: transform,
    };
  }

  // Primitives pass through
  return { data, transformed: false };
}

/**
 * Check if a preset name is valid.
 * Applies Unicode normalization for security (DMCP-SEC-004).
 */
export function isValidPreset(preset: string): preset is 'minimal' | 'standard' | 'full' {
  const normalizedPreset = normalizeFieldName(preset);
  return normalizedPreset in FIELD_PRESETS;
}

/**
 * Get fields for a preset name.
 * Applies Unicode normalization for security (DMCP-SEC-004).
 */
export function getPresetFields(preset: 'minimal' | 'standard' | 'full'): string[] | null {
  const normalizedPreset = normalizeFieldName(preset);
  return FIELD_PRESETS[normalizedPreset] ?? null;
}
