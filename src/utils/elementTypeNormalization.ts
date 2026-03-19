/**
 * Shared element type normalization utilities.
 *
 * Provides a single canonical mapping from both singular and plural
 * element type names to ElementType enum values. All code paths that
 * accept user-provided element type strings should use these utilities
 * to ensure consistent behaviour.
 *
 * Issue #433 - Singular element type names rejected in search/portfolio operations
 */

import { ElementType } from '../portfolio/types.js';

/**
 * Canonical mapping from user-facing type strings (singular and plural)
 * to ElementType enum values. Keys are lowercase.
 */
export const ELEMENT_TYPE_MAP: Record<string, ElementType> = {
  // Singular forms
  persona: ElementType.PERSONA,
  skill: ElementType.SKILL,
  template: ElementType.TEMPLATE,
  agent: ElementType.AGENT,
  memory: ElementType.MEMORY,
  ensemble: ElementType.ENSEMBLE,
  // Plural forms (canonical enum values)
  personas: ElementType.PERSONA,
  skills: ElementType.SKILL,
  templates: ElementType.TEMPLATE,
  agents: ElementType.AGENT,
  memories: ElementType.MEMORY,
  ensembles: ElementType.ENSEMBLE,
};

/** All canonical ElementType values (plural forms). */
export const ALL_ELEMENT_TYPES: ElementType[] = Object.values(ElementType);

// Runtime validation: every ElementType enum value must appear as a value in ELEMENT_TYPE_MAP.
// Catches cases where a new ElementType is added to the enum but the map is not updated.
for (const enumValue of ALL_ELEMENT_TYPES) {
  const mappedValues = Object.values(ELEMENT_TYPE_MAP);
  if (!mappedValues.includes(enumValue)) {
    throw new Error(
      `elementTypeNormalization: ElementType '${enumValue}' is missing from ELEMENT_TYPE_MAP. ` +
      `Update ELEMENT_TYPE_MAP to include both singular and plural entries for this type.`
    );
  }
}

/** Singular labels for each ElementType. */
export const SINGULAR_LABELS: Record<ElementType, string> = {
  [ElementType.PERSONA]: 'persona',
  [ElementType.SKILL]: 'skill',
  [ElementType.TEMPLATE]: 'template',
  [ElementType.AGENT]: 'agent',
  [ElementType.MEMORY]: 'memory',
  [ElementType.ENSEMBLE]: 'ensemble',
};

/**
 * Convert an ElementType enum value to its singular label.
 * e.g. ElementType.PERSONA ("personas") → "persona"
 */
export function toSingularLabel(type: ElementType): string {
  return SINGULAR_LABELS[type] ?? type;
}

/**
 * Normalize a user-provided element type string to an ElementType enum value.
 *
 * Accepts both singular (`"memory"`) and plural (`"memories"`) forms,
 * case-insensitively. Returns `null` for unrecognised input.
 */
export function normalizeElementType(input: string | null | undefined): ElementType | null {
  if (!input || typeof input !== 'string') {
    return null;
  }
  return ELEMENT_TYPE_MAP[input.trim().toLowerCase()] ?? null;
}

/**
 * Format a human-readable list of valid element types for error messages.
 */
export function formatElementTypesList(): string {
  const singularList = Object.values(SINGULAR_LABELS).join(', ');
  const pluralList = ALL_ELEMENT_TYPES.join(', ');
  return `${singularList} (plural forms also accepted: ${pluralList})`;
}
