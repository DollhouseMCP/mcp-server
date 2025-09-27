/**
 * Utility functions for element ID parsing and formatting
 *
 * FIXES IMPLEMENTED (Issue #1099):
 * - Centralized element ID parsing logic
 * - Consistent separator usage (':')
 * - Validation and error handling
 * - Type-safe interfaces
 */

export const ELEMENT_ID_SEPARATOR = ':';

export interface ParsedElementId {
  type: string;
  name: string;
}

/**
 * Parse an element ID into its type and name components
 *
 * @param id Element ID in format "type:name"
 * @returns Parsed element ID or null if invalid
 */
export function parseElementId(id: string): ParsedElementId | null {
  if (!id || typeof id !== 'string') {
    return null;
  }

  const parts = id.split(ELEMENT_ID_SEPARATOR);
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }

  return {
    type: parts[0],
    name: parts[1]
  };
}

/**
 * Parse an element ID, throwing an error if invalid
 *
 * @param id Element ID in format "type:name"
 * @returns Parsed element ID
 * @throws Error if ID is invalid
 */
export function parseElementIdStrict(id: string): ParsedElementId {
  const parsed = parseElementId(id);
  if (!parsed) {
    throw new Error(`Invalid element ID format: "${id}". Expected "type:name"`);
  }
  return parsed;
}

/**
 * Parse an element ID with fallback values for invalid IDs
 *
 * @param id Element ID to parse
 * @param defaultType Default type if parsing fails
 * @param defaultName Default name if parsing fails (defaults to the original ID)
 * @returns Parsed element ID with fallbacks
 */
export function parseElementIdWithFallback(
  id: string,
  defaultType: string = 'unknown',
  defaultName?: string
): ParsedElementId {
  const parsed = parseElementId(id);
  if (parsed) {
    return parsed;
  }

  return {
    type: defaultType,
    name: defaultName ?? id
  };
}

/**
 * Format an element ID from type and name components
 *
 * @param type Element type
 * @param name Element name
 * @returns Formatted element ID
 */
export function formatElementId(type: string, name: string): string {
  if (!type || !name) {
    throw new Error('Both type and name are required to format element ID');
  }

  // Check for separator in type or name
  if (type.includes(ELEMENT_ID_SEPARATOR)) {
    throw new Error(`Element type cannot contain separator "${ELEMENT_ID_SEPARATOR}": ${type}`);
  }
  if (name.includes(ELEMENT_ID_SEPARATOR)) {
    throw new Error(`Element name cannot contain separator "${ELEMENT_ID_SEPARATOR}": ${name}`);
  }

  return `${type}${ELEMENT_ID_SEPARATOR}${name}`;
}

/**
 * Validate an element ID format
 *
 * @param id Element ID to validate
 * @returns true if valid, false otherwise
 */
export function isValidElementId(id: string): boolean {
  return parseElementId(id) !== null;
}

/**
 * Extract element IDs from an array of strings, filtering out invalid ones
 *
 * @param ids Array of potential element IDs
 * @returns Array of valid parsed element IDs
 */
export function parseElementIds(ids: string[]): ParsedElementId[] {
  return ids
    .map(id => parseElementId(id))
    .filter((parsed): parsed is ParsedElementId => parsed !== null);
}

/**
 * Batch parse element IDs with detailed error reporting
 *
 * @param ids Array of element IDs to parse
 * @returns Object with valid parsed IDs and errors for invalid ones
 */
export function batchParseElementIds(ids: string[]): {
  valid: Array<ParsedElementId & { originalId: string }>;
  invalid: Array<{ id: string; reason: string }>;
} {
  const valid: Array<ParsedElementId & { originalId: string }> = [];
  const invalid: Array<{ id: string; reason: string }> = [];

  for (const id of ids) {
    const parsed = parseElementId(id);
    if (parsed) {
      valid.push({ ...parsed, originalId: id });
    } else {
      let reason = 'Invalid format';
      if (!id) {
        reason = 'Empty ID';
      } else if (typeof id !== 'string') {
        reason = 'Not a string';
      } else if (!id.includes(ELEMENT_ID_SEPARATOR)) {
        reason = `Missing separator "${ELEMENT_ID_SEPARATOR}"`;
      } else {
        const parts = id.split(ELEMENT_ID_SEPARATOR);
        if (parts.length > 2) {
          reason = 'Multiple separators found';
        } else if (!parts[0]) {
          reason = 'Missing type';
        } else if (!parts[1]) {
          reason = 'Missing name';
        }
      }
      invalid.push({ id, reason });
    }
  }

  return { valid, invalid };
}