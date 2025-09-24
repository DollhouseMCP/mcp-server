/**
 * Type-safe relationship definitions for Enhanced Index
 *
 * Provides strongly-typed relationship interfaces with proper validation
 * and type guards to prevent runtime errors.
 *
 * FIXES IMPLEMENTED (Issue #1103):
 * - Type-safe relationship variants
 * - Compile-time validation
 * - Runtime type guards
 * - Safe parsing utilities
 */

import { parseElementId, formatElementId } from '../../utils/elementId.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';

/**
 * Base relationship interface - the stored format
 */
export interface BaseRelationship {
  element: string;                     // Element ID in format "type:name"
  type?: string;                       // Relationship type (e.g., 'uses', 'similar_to')
  strength?: number;                   // Relationship strength/confidence (0-1)
  metadata?: Record<string, any>;      // Extensible metadata
}

/**
 * Parsed relationship with extracted type and name
 * This is the runtime format after parsing
 */
export interface ParsedRelationship extends BaseRelationship {
  targetType: string;                  // Extracted element type
  targetName: string;                  // Extracted element name
  isValid: true;                       // Type discriminator
}

/**
 * Invalid relationship - when parsing fails
 */
export interface InvalidRelationship extends BaseRelationship {
  targetType: null;
  targetName: null;
  isValid: false;
  parseError: string;
}

/**
 * Union type for all relationship variants
 */
export type Relationship = BaseRelationship | ParsedRelationship | InvalidRelationship;

/**
 * Type guard to check if a relationship has been parsed
 */
export function isParsedRelationship(rel: Relationship): rel is ParsedRelationship {
  return 'isValid' in rel && rel.isValid === true &&
         'targetType' in rel && rel.targetType !== null &&
         'targetName' in rel && rel.targetName !== null;
}

/**
 * Type guard to check if a relationship is invalid
 */
export function isInvalidRelationship(rel: Relationship): rel is InvalidRelationship {
  return 'isValid' in rel && rel.isValid === false;
}

/**
 * Type guard to check if a relationship is just the base type
 */
export function isBaseRelationship(rel: Relationship): rel is BaseRelationship {
  return !('isValid' in rel);
}

/**
 * Safely parse a base relationship into a parsed relationship
 * Returns InvalidRelationship if parsing fails
 */
export function parseRelationship(rel: BaseRelationship): ParsedRelationship | InvalidRelationship {
  if (!rel.element) {
    return {
      ...rel,
      targetType: null,
      targetName: null,
      isValid: false,
      parseError: 'Missing element ID'
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
  if (strength !== undefined && (strength < 0 || strength > 1)) {
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