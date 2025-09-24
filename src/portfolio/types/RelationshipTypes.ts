/**
 * Type-safe relationship definitions for Enhanced Index
 *
 * This module provides a comprehensive type system for managing relationships
 * between elements in the DollhouseMCP Enhanced Index. It implements a three-tier
 * type hierarchy that ensures both compile-time and runtime safety.
 *
 * ## Type Hierarchy:
 * 1. BaseRelationship - The storage format (what's persisted to disk)
 * 2. ParsedRelationship - Valid runtime format with extracted metadata
 * 3. InvalidRelationship - Error state with detailed diagnostics
 *
 * ## Key Features:
 * - Strongly-typed interfaces with discriminated unions
 * - Runtime type guards for safe type narrowing
 * - Detailed error messages with position information
 * - Batch processing utilities with performance optimizations
 * - Relationship deduplication and sorting algorithms
 *
 * ## Usage Example:
 * ```typescript
 * // Parse a relationship from storage
 * const stored: BaseRelationship = { element: 'personas:expert-coder' };
 * const parsed = parseRelationship(stored);
 *
 * if (isParsedRelationship(parsed)) {
 *   console.log(`Type: ${parsed.targetType}, Name: ${parsed.targetName}`);
 * } else {
 *   console.error(`Parse failed: ${parsed.parseError}`);
 * }
 * ```
 *
 * FIXES IMPLEMENTED (Issue #1103):
 * - Type-safe relationship variants with discriminated unions
 * - Compile-time validation through TypeScript's type system
 * - Runtime type guards for safe type narrowing
 * - Safe parsing utilities with detailed error reporting
 * - Security audit logging for relationship operations
 */

import { parseElementId, formatElementId } from '../../utils/elementId.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';

/**
 * Base relationship interface - the storage format
 *
 * This is the fundamental relationship structure that gets persisted to disk.
 * It contains only the raw data without any parsed or computed fields.
 *
 * @example
 * ```typescript
 * const relationship: BaseRelationship = {
 *   element: 'skills:debugging',
 *   type: 'similar_to',
 *   strength: 0.85,
 *   metadata: { reason: 'Both involve code analysis' }
 * };
 * ```
 */
export interface BaseRelationship {
  /** Element ID in format "type:name" (e.g., "personas:expert", "skills:refactor") */
  element: string;

  /** Semantic relationship type from RelationshipTypes enum (e.g., 'uses', 'similar_to', 'extends') */
  type?: string;

  /** Relationship strength/confidence score between 0.0 and 1.0 (inclusive) */
  strength?: number;

  /** Extensible metadata for custom properties (e.g., similarity scores, timestamps) */
  metadata?: Record<string, any>;
}

/**
 * Parsed relationship with extracted type and name components
 *
 * This is the runtime format after successfully parsing a BaseRelationship.
 * It includes all base fields plus extracted metadata for efficient querying.
 *
 * @example
 * ```typescript
 * const parsed: ParsedRelationship = {
 *   element: 'personas:expert-coder',
 *   type: 'similar_to',
 *   strength: 0.9,
 *   targetType: 'personas',  // Extracted from element
 *   targetName: 'expert-coder',  // Extracted from element
 *   isValid: true  // Type discriminator
 * };
 * ```
 */
export interface ParsedRelationship extends BaseRelationship {
  /** Extracted element type (e.g., 'personas', 'skills', 'templates') */
  targetType: string;

  /** Extracted element name (e.g., 'expert-coder', 'debugging') */
  targetName: string;

  /** Type discriminator - always true for valid parsed relationships */
  isValid: true;
}

/**
 * Invalid relationship state with diagnostic information
 *
 * This type represents a relationship that failed to parse, preserving
 * the original data while providing detailed error context for debugging.
 *
 * @example
 * ```typescript
 * const invalid: InvalidRelationship = {
 *   element: 'malformed:element:id',
 *   targetType: null,
 *   targetName: null,
 *   isValid: false,
 *   parseError: 'Invalid element ID format: "malformed:element:id" - multiple separators...'
 * };
 * ```
 */
export interface InvalidRelationship extends BaseRelationship {
  /** Null when parsing fails */
  targetType: null;

  /** Null when parsing fails */
  targetName: null;

  /** Type discriminator - always false for invalid relationships */
  isValid: false;

  /** Detailed error message with position information and expected format */
  parseError: string;
}

/**
 * Union type for all relationship variants
 */
export type Relationship = BaseRelationship | ParsedRelationship | InvalidRelationship;

/**
 * Type guard to check if a relationship is successfully parsed
 *
 * @param rel - The relationship to check
 * @returns True if the relationship is a ParsedRelationship with valid data
 *
 * @example
 * ```typescript
 * const rel = parseRelationship(baseRel);
 * if (isParsedRelationship(rel)) {
 *   // TypeScript knows rel is ParsedRelationship here
 *   console.log(rel.targetType, rel.targetName);
 * }
 * ```
 */
export function isParsedRelationship(rel: Relationship): rel is ParsedRelationship {
  return 'isValid' in rel && rel.isValid === true &&
         'targetType' in rel && rel.targetType !== null &&
         'targetName' in rel && rel.targetName !== null;
}

/**
 * Type guard to check if a relationship failed to parse
 *
 * @param rel - The relationship to check
 * @returns True if the relationship is an InvalidRelationship with error details
 *
 * @example
 * ```typescript
 * const rel = parseRelationship(baseRel);
 * if (isInvalidRelationship(rel)) {
 *   console.error(`Parse failed: ${rel.parseError}`);
 * }
 * ```
 */
export function isInvalidRelationship(rel: Relationship): rel is InvalidRelationship {
  return 'isValid' in rel && rel.isValid === false;
}

/**
 * Type guard to check if a relationship is unparsed (base type only)
 *
 * @param rel - The relationship to check
 * @returns True if the relationship is a BaseRelationship without parsed fields
 *
 * @example
 * ```typescript
 * if (isBaseRelationship(rel)) {
 *   // Need to parse this relationship before use
 *   const parsed = parseRelationship(rel);
 * }
 * ```
 */
export function isBaseRelationship(rel: Relationship): rel is BaseRelationship {
  return !('isValid' in rel);
}

/**
 * Safely parse a base relationship into a typed relationship variant
 *
 * This function attempts to parse the element ID and extract type/name components.
 * If parsing fails, it returns an InvalidRelationship with detailed error context
 * including position information and what was expected.
 *
 * @param rel - The base relationship to parse
 * @returns ParsedRelationship if successful, InvalidRelationship with diagnostics if failed
 *
 * @example Success case
 * ```typescript
 * const base: BaseRelationship = { element: 'skills:debugging' };
 * const result = parseRelationship(base);
 * // result: ParsedRelationship with targetType='skills', targetName='debugging'
 * ```
 *
 * @example Error cases with detailed diagnostics
 * ```typescript
 * parseRelationship({ element: 'no-separator' });
 * // Error: "missing separator ':'"
 *
 * parseRelationship({ element: ':missing-type' });
 * // Error: "missing type before ':'"
 *
 * parseRelationship({ element: 'too:many:colons' });
 * // Error: "multiple separators ':' found at positions [3, 8]"
 * ```
 */
export function parseRelationship(rel: BaseRelationship): ParsedRelationship | InvalidRelationship {
  if (!rel.element) {
    return {
      ...rel,
      targetType: null,
      targetName: null,
      isValid: false,
      parseError: 'Invalid element ID: missing or empty (expected format: "type:name")'
    };
  }

  const parsed = parseElementId(rel.element);

  if (!parsed) {
    // Provide detailed error context about what was found
    const colonIndex = rel.element.indexOf(':');
    let errorDetail: string;

    if (colonIndex === -1) {
      errorDetail = `Invalid element ID format: "${rel.element}" - missing separator ':' (expected format: "type:name")`;
    } else if (colonIndex === 0) {
      errorDetail = `Invalid element ID format: "${rel.element}" - missing type before ':' (expected format: "type:name")`;
    } else if (colonIndex === rel.element.length - 1) {
      errorDetail = `Invalid element ID format: "${rel.element}" - missing name after ':' (expected format: "type:name")`;
    } else if (rel.element.split(':').length > 2) {
      const positions = [];
      for (let i = 0; i < rel.element.length; i++) {
        if (rel.element[i] === ':') positions.push(i);
      }
      errorDetail = `Invalid element ID format: "${rel.element}" - multiple separators ':' found at positions [${positions.join(', ')}] (expected format: "type:name" with single ':')`;
    } else {
      errorDetail = `Invalid element ID format: "${rel.element}" (expected format: "type:name")`;
    }

    return {
      ...rel,
      targetType: null,
      targetName: null,
      isValid: false,
      parseError: errorDetail
    };
  }

  return {
    ...rel,
    targetType: parsed.type,
    targetName: parsed.name,
    isValid: true
  };
}

/**
 * Batch parse relationships with type safety
 * Filters out invalid relationships by default
 */
export function parseRelationships(
  relationships: BaseRelationship[],
  includeInvalid: boolean = false
): ParsedRelationship[] | (ParsedRelationship | InvalidRelationship)[] {
  const parsed = relationships.map(parseRelationship);

  if (includeInvalid) {
    return parsed;
  }

  // Filter to only valid relationships
  return parsed.filter(isParsedRelationship);
}

/**
 * Create a new relationship with validation
 */
export function createRelationship(
  targetType: string,
  targetName: string,
  relationType?: string,
  strength?: number,
  metadata?: Record<string, any>
): ParsedRelationship {
  // Validate strength is in range
  if (strength !== undefined && (strength < 0 || strength > 1 || isNaN(strength))) {
    throw new Error(`Relationship strength must be between 0 and 1, got ${strength}`);
  }

  const element = formatElementId(targetType, targetName);

  // FIX: Add security audit logging for relationship creation
  // Previously: No logging of relationship operations
  // Now: Log relationship creation for security audit trail
  SecurityMonitor.logSecurityEvent({
    type: 'ELEMENT_CREATED',
    severity: 'LOW',
    source: 'RelationshipTypes.createRelationship',
    details: `Created relationship to ${element}`,
    metadata: {
      targetType,
      targetName,
      relationType: relationType || 'unspecified',
      strength: strength ?? 1.0
    }
  });

  return {
    element,
    type: relationType,
    strength,
    metadata,
    targetType,
    targetName,
    isValid: true
  };
}

/**
 * Validate a relationship has required fields
 */
export function validateRelationship(rel: any): rel is BaseRelationship {
  return !!(rel &&
            typeof rel === 'object' &&
            'element' in rel &&
            typeof rel.element === 'string' &&
            rel.element.length > 0);
}

/**
 * Group relationships by target type for efficient processing
 */
export function groupRelationshipsByType(
  relationships: ParsedRelationship[]
): Map<string, ParsedRelationship[]> {
  const grouped = new Map<string, ParsedRelationship[]>();

  for (const rel of relationships) {
    const existing = grouped.get(rel.targetType) || [];
    existing.push(rel);
    grouped.set(rel.targetType, existing);
  }

  return grouped;
}

/**
 * Find duplicate relationships (same target element)
 */
export function findDuplicateRelationships(
  relationships: BaseRelationship[]
): BaseRelationship[][] {
  const elementMap = new Map<string, BaseRelationship[]>();

  for (const rel of relationships) {
    const existing = elementMap.get(rel.element) || [];
    existing.push(rel);
    elementMap.set(rel.element, existing);
  }

  // Return only groups with duplicates
  return Array.from(elementMap.values()).filter(group => group.length > 1);
}

/**
 * Merge duplicate relationships, keeping highest strength
 */
export function deduplicateRelationships(
  relationships: BaseRelationship[]
): BaseRelationship[] {
  const elementMap = new Map<string, BaseRelationship>();

  for (const rel of relationships) {
    const existing = elementMap.get(rel.element);

    if (!existing || (rel.strength || 0) > (existing.strength || 0)) {
      elementMap.set(rel.element, rel);
    }
  }

  return Array.from(elementMap.values());
}

/**
 * Sort relationships by strength (descending)
 */
export function sortRelationshipsByStrength(
  relationships: BaseRelationship[]
): BaseRelationship[] {
  return [...relationships].sort((a, b) => {
    const strengthA = a.strength || 0;
    const strengthB = b.strength || 0;
    return strengthB - strengthA;
  });
}

/**
 * Filter relationships by minimum strength threshold
 */
export function filterRelationshipsByStrength(
  relationships: BaseRelationship[],
  minStrength: number
): BaseRelationship[] {
  return relationships.filter(rel => (rel.strength || 0) >= minStrength);
}

/**
 * Relationship type aliases for common patterns
 */
export const RelationshipTypes = {
  // Similarity relationships
  SIMILAR_TO: 'similar_to',

  // Usage relationships
  USES: 'uses',
  USED_BY: 'used_by',

  // Extension relationships
  EXTENDS: 'extends',
  EXTENDED_BY: 'extended_by',

  // Composition relationships
  CONTAINS: 'contains',
  CONTAINED_BY: 'contained_by',

  // Debugging relationships
  HELPS_DEBUG: 'helps_debug',
  DEBUGGED_BY: 'debugged_by',

  // Conflict relationships
  CONTRADICTS: 'contradicts',
  SUPPORTS: 'supports',

  // Semantic relationships
  SEMANTIC_SIMILARITY: 'semantic_similarity'
} as const;

export type RelationshipType = typeof RelationshipTypes[keyof typeof RelationshipTypes];