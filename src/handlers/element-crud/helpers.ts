/**
 * FIX: DMCP-SEC-006 - Security audit suppression
 * This file contains only helper utilities for element operations.
 * No audit logging is required - logging happens in the calling handlers.
 * @security-audit-suppress DMCP-SEC-006
 */

import { slugify } from '../../utils/filesystem.js';
import { ElementType } from '../../portfolio/PortfolioManager.js';
import { logger } from '../../utils/logger.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import {
  ELEMENT_TYPE_MAP,
  ALL_ELEMENT_TYPES,
  formatElementTypesList as sharedFormatElementTypesList,
} from '../../utils/elementTypeNormalization.js';
import { parseElementPolicy } from '../mcp-aql/policies/ElementPolicies.js';
import { findPatternConflicts } from '../../utils/patternMatcher.js';

export function findElementFlexibly<T extends { metadata?: { name?: string } }>(
  name: string,
  elementList: T[]
): T | undefined {
  if (!name || !Array.isArray(elementList) || elementList.length === 0) {
    return undefined;
  }

  const searchNameLower = name.toLowerCase();
  const searchNameSlug = slugify(name);

  let element = elementList.find(
    (e) => e.metadata?.name?.toLowerCase() === searchNameLower
  );

  if (!element) {
    element = elementList.find((e) => {
      const elementSlug = slugify(e.metadata?.name || '');
      return elementSlug === searchNameSlug || elementSlug === searchNameLower;
    });
  }

  if (!element) {
    element = elementList.find((e) => {
      const elementName = e.metadata?.name || '';
      const elementSlug = slugify(elementName);
      return (
        elementSlug.includes(searchNameSlug) ||
        elementName.toLowerCase().includes(searchNameLower)
      );
    });
  }

  return element;
}

export function sanitizeMetadata(metadata: Record<string, any> | undefined): Record<string, any> {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }

  // FIX: DMCP-SEC-006 - Add security audit logging for sanitization
  SecurityMonitor.logSecurityEvent({
    type: 'ELEMENT_VALIDATED',
    severity: 'LOW',
    source: 'helpers.sanitizeMetadata',
    details: 'Metadata sanitized for element creation/update',
    additionalData: { fieldCount: Object.keys(metadata).length }
  });

  const dangerousProperties = ['__proto__', 'constructor', 'prototype'];
  const sanitized: Record<string, any> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (dangerousProperties.includes(key)) {
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      sanitized[key] = sanitizeMetadata(value as Record<string, any>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

// Delegate to shared normalization utility (Issue #433)
const ELEMENT_TYPE_ALIASES = ELEMENT_TYPE_MAP;

const ELEMENT_TYPE_LABELS: Record<ElementType, { singular: string; plural: string }> = {
  [ElementType.PERSONA]: { singular: 'persona', plural: 'personas' },
  [ElementType.SKILL]: { singular: 'skill', plural: 'skills' },
  [ElementType.TEMPLATE]: { singular: 'template', plural: 'templates' },
  [ElementType.AGENT]: { singular: 'agent', plural: 'agents' },
  [ElementType.MEMORY]: { singular: 'memory', plural: 'memories' },
  [ElementType.ENSEMBLE]: { singular: 'ensemble', plural: 'ensembles' }
};

export function normalizeElementTypeInput(rawType: string | null | undefined): { type: ElementType | null; aliasUsed: boolean } {
  if (!rawType || typeof rawType !== 'string') {
    return { type: null, aliasUsed: false };
  }

  const normalizedKey = rawType.trim().toLowerCase();
  const resolvedType = ELEMENT_TYPE_ALIASES[normalizedKey];

  if (!resolvedType) {
    return { type: null, aliasUsed: false };
  }

  const aliasUsed = !ALL_ELEMENT_TYPES.includes(rawType as ElementType) && normalizedKey !== resolvedType;
  if (aliasUsed) {
    logger.warn(`Using singular element type '${rawType}' is deprecated. Please use '${resolvedType}' instead.`);
  }

  return { type: resolvedType, aliasUsed };
}

export function formatValidElementTypesList(): string {
  return sharedFormatElementTypesList();
}

export function getElementTypeLabel(type: ElementType, options: { plural?: boolean } = {}): string {
  const label = ELEMENT_TYPE_LABELS[type];
  if (!label) {
    return options.plural ? type : type.replace(/s$/, '');
  }
  return options.plural ? label.plural : label.singular;
}

export function getElementFilename(type: ElementType, name: string): string {
  const safeSlug = slugify(name || '') || 'untitled';
  const extension = type === ElementType.MEMORY ? '.yaml' : '.md';
  return `${safeSlug}${extension}`;
}

export interface ElementManagerOperations<T> {
  list?: () => Promise<T[]>;
  find?: (predicate: (candidate: T) => boolean) => Promise<T | undefined>;
  load?: (filePath: string) => Promise<T>;
}

/**
 * Known metadata properties for each element type.
 * Used by both `detectUnknownMetadataProperties()` (create/edit warnings)
 * and `editElement()` (field routing to metadata vs element object).
 *
 * IMPORTANT: Both camelCase and snake_case variants must be listed where
 * applicable, since LLMs may send either form. The lookup uses exact
 * string matching via `Set.has()`.
 *
 * @example
 * // Common properties shared across all types:
 * 'name', 'description', 'author', 'version', 'tags', 'gatekeeper'
 *
 * @example
 * // Type-specific properties (only valid for that element type):
 * Agent: 'goal', 'activates', 'tools', 'autonomy', 'resilience'
 * Skill: 'domains', 'category', 'prerequisites'
 * Ensemble: 'elements', 'activationStrategy', 'activation_strategy'
 */
export const KNOWN_METADATA_PROPERTIES: Record<ElementType, Set<string>> = {
  [ElementType.PERSONA]: new Set([
    // Common metadata
    'name', 'description', 'author', 'version', 'tags', 'created', 'modified',
    // Gatekeeper policy (all element types)
    'gatekeeper',
    // Persona-specific
    'triggers', 'tone', 'voice', 'domain', 'context', 'style', 'instructions',
    'personality', 'expertise', 'communication_style', 'communicationStyle'
  ]),
  [ElementType.SKILL]: new Set([
    // Common metadata
    'name', 'description', 'author', 'version', 'tags', 'created', 'modified',
    // Gatekeeper policy (all element types)
    'gatekeeper',
    // Skill-specific
    'triggers', 'domain', 'domains', 'category', 'examples', 'prerequisites',
    'content', 'usage', 'capabilities'
  ]),
  [ElementType.TEMPLATE]: new Set([
    // Common metadata
    'name', 'description', 'author', 'version', 'tags', 'created', 'modified',
    // Gatekeeper policy (all element types)
    'gatekeeper',
    // Template-specific
    'variables', 'template', 'category', 'outputFormat', 'output_format',
    'content', 'format', 'schema'
  ]),
  [ElementType.AGENT]: new Set([
    // Common metadata
    'name', 'description', 'author', 'version', 'tags', 'created', 'modified',
    // Gatekeeper policy (all element types)
    'gatekeeper',
    // Agent V1 fields (legacy, still supported)
    'goals', 'constraints', 'capabilities', 'triggers', 'state', 'actions',
    'decisionFramework', 'decision_framework', 'skills',
    // Agent V2 fields (v2.0.0 Agentic Loop Redesign)
    'goal', 'activates', 'tools', 'systemPrompt', 'system_prompt',
    'autonomy', 'resilience', 'successCriteria', 'success_criteria',
    // Issue #585: Body content fields (stored in extensions.instructions)
    'content', 'instructions',
    // V1 backward compatibility
    'specializations', 'riskTolerance', 'risk_tolerance',
    'learningEnabled', 'learning_enabled', 'maxConcurrentGoals', 'max_concurrent_goals'
  ]),
  [ElementType.MEMORY]: new Set([
    // Common metadata
    'name', 'description', 'author', 'version', 'tags', 'created', 'modified',
    // Gatekeeper policy (all element types)
    'gatekeeper',
    // Memory-specific
    'id', 'entries', 'retentionPolicy', 'retention_policy', 'maxEntries',
    'max_entries', 'category', 'scope'
  ]),
  [ElementType.ENSEMBLE]: new Set([
    // Common metadata
    'name', 'description', 'author', 'version', 'tags', 'created', 'modified',
    // Gatekeeper policy (all element types)
    'gatekeeper',
    // Ensemble-specific - NOTE: 'elements' is correct, NOT 'members'
    'elements', 'activationStrategy', 'activation_strategy',
    'conflictResolution', 'conflict_resolution',
    'contextSharing', 'context_sharing',
    'resourceLimits', 'resource_limits',
    'allowNested', 'allow_nested',
    'maxNestingDepth', 'max_nesting_depth'
  ])
};

/**
 * Common typos and their corrections for better LLM feedback.
 *
 * IMPORTANT: All keys MUST be lowercase. The lookup uses `key.toLowerCase()`
 * to ensure case-insensitive matching.
 *
 * @example
 * // Global correction (applies to all element types):
 * 'discription': { correct: 'description' }
 *
 * @example
 * // Type-specific correction (only applies to specified types):
 * 'members': { correct: 'elements', elementTypes: [ElementType.ENSEMBLE] }
 */
const PROPERTY_CORRECTIONS: Record<string, { correct: string; elementTypes?: ElementType[] }> = {
  // Ensemble: 'members' is a common mistake - should be 'elements'
  'members': { correct: 'elements', elementTypes: [ElementType.ENSEMBLE] },
  'member': { correct: 'elements', elementTypes: [ElementType.ENSEMBLE] },
  // Common typos
  'discription': { correct: 'description' },
  'desciption': { correct: 'description' },
  'auther': { correct: 'author' },
  'tages': { correct: 'tags' },
  'varibles': { correct: 'variables', elementTypes: [ElementType.TEMPLATE] },
  'activiation': { correct: 'activation' },
  'stratergy': { correct: 'strategy' },
  'elemets': { correct: 'elements', elementTypes: [ElementType.ENSEMBLE] },
  // Snake_case vs camelCase mismatches
  'activationstrategy': { correct: 'activationStrategy', elementTypes: [ElementType.ENSEMBLE] },
  'conflictresolution': { correct: 'conflictResolution', elementTypes: [ElementType.ENSEMBLE] },
  'contextsharing': { correct: 'contextSharing', elementTypes: [ElementType.ENSEMBLE] }
};

/**
 * Result of checking metadata for unknown properties.
 */
export interface UnknownPropertyWarning {
  property: string;
  suggestion?: string;
  message: string;
}

/**
 * Validate a gatekeeper policy in element metadata.
 * Returns warnings (not throws) for invalid policy structures,
 * so LLMs get immediate feedback about malformed policies.
 *
 * @param metadata - The metadata object containing the gatekeeper policy
 * @returns Array of warnings for invalid policy structure (empty if valid)
 */
export function validateGatekeeperPolicy(
  metadata: Record<string, unknown>
): UnknownPropertyWarning[] {
  if (!metadata.gatekeeper) {
    return [];
  }

  try {
    const policy = parseElementPolicy(metadata);
    const warnings: UnknownPropertyWarning[] = [];

    // Issue #674: Warn when an operation appears in both allow and confirm lists
    // The most restrictive policy (confirm) will apply, but the overlap is likely a mistake
    if (policy?.allow?.length && policy?.confirm?.length) {
      const allowSet = new Set(policy.allow);
      for (const op of policy.confirm) {
        if (allowSet.has(op)) {
          warnings.push({
            property: 'gatekeeper',
            message: `Operation '${op}' appears in both allow and confirm — most restrictive policy (confirm) will apply.`,
          });
        }
      }
    }

    // Issue #625 Phase 2: Detect allow/deny pattern conflicts
    if (policy?.externalRestrictions) {
      const { allowPatterns, denyPatterns } = policy.externalRestrictions;
      if (allowPatterns?.length && denyPatterns?.length) {
        const conflicts = findPatternConflicts(denyPatterns, allowPatterns);
        for (const conflict of conflicts) {
          warnings.push({
            property: 'gatekeeper.externalRestrictions',
            message: `Pattern conflict (deny takes precedence): ${conflict}`,
          });
        }
      }
    }

    return warnings;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [{
      property: 'gatekeeper',
      message: message,
    }];
  }
}

/**
 * Check metadata for unknown properties and return warnings.
 * This helps LLMs correct their behavior in real-time when they use wrong property names.
 *
 * @param elementType - The type of element being created/edited
 * @param metadata - The metadata object to check
 * @returns Array of warnings for unknown properties
 */
export function detectUnknownMetadataProperties(
  elementType: ElementType,
  metadata: Record<string, unknown> | undefined
): UnknownPropertyWarning[] {
  if (!metadata || typeof metadata !== 'object') {
    return [];
  }

  const knownProperties = KNOWN_METADATA_PROPERTIES[elementType];
  if (!knownProperties) {
    return [];
  }

  const warnings: UnknownPropertyWarning[] = [];

  for (const key of Object.keys(metadata)) {
    // Skip if it's a known property
    if (knownProperties.has(key)) {
      continue;
    }

    // Check if it's a known typo with a correction
    const correction = PROPERTY_CORRECTIONS[key.toLowerCase()];
    if (correction) {
      // Check if correction applies to this element type
      const appliesToType = !correction.elementTypes ||
        correction.elementTypes.includes(elementType);

      if (appliesToType) {
        warnings.push({
          property: key,
          suggestion: correction.correct,
          message: `Unknown property '${key}' - did you mean '${correction.correct}'?`
        });
        continue;
      }
    }

    // Generic unknown property warning
    warnings.push({
      property: key,
      message: `Unknown property '${key}' for ${getElementTypeLabel(elementType)} - this property will be ignored`
    });
  }

  // Validate gatekeeper policy structure if present
  if (metadata.gatekeeper) {
    warnings.push(...validateGatekeeperPolicy(metadata));
  }

  return warnings;
}

/**
 * Format unknown property warnings for MCP response.
 * Returns a warning block that can be prepended to success messages.
 */
export function formatUnknownPropertyWarnings(warnings: UnknownPropertyWarning[]): string {
  if (warnings.length === 0) {
    return '';
  }

  const lines = ['⚠️ **Metadata Warnings:**'];
  for (const warning of warnings) {
    if (warning.suggestion) {
      lines.push(`   • ${warning.message} Use '${warning.suggestion}' instead.`);
    } else {
      lines.push(`   • ${warning.message}`);
    }
  }
  lines.push(''); // Empty line after warnings

  return lines.join('\n');
}

/**
 * Format element resolution warnings for MCP response.
 * Surfaces disambiguation and not-found info from resolveElementTypes()
 * so the user can fix missing element_type fields.
 *
 * Follows the same pattern as formatUnknownPropertyWarnings().
 */
export function formatElementResolutionWarnings(result: { ambiguous: Array<{ element_name: string; found_in: string[] }>; notFound: string[] }): string {
  if (result.ambiguous.length === 0 && result.notFound.length === 0) {
    return '';
  }

  const lines = ['⚠️ **Element Resolution Warnings:**'];

  for (const item of result.ambiguous) {
    lines.push(
      `   • '${item.element_name}' exists as multiple types (${item.found_in.join(', ')}) — specify element_type to disambiguate`
    );
  }

  for (const name of result.notFound) {
    lines.push(
      `   • '${name}' not found in portfolio — provide element_type explicitly or ensure the element exists`
    );
  }

  lines.push(''); // Empty line after warnings
  return lines.join('\n');
}

export async function resolveElementByName<T>(
  manager: ElementManagerOperations<T> | null | undefined,
  type: ElementType,
  name: string
): Promise<T | undefined> {
  if (!manager) {
    return undefined;
  }

  if (typeof manager.list === 'function') {
    const elements = await manager.list();
    if (Array.isArray(elements) && elements.length > 0) {
      const found = findElementFlexibly(name, elements as any[]);
      if (found) {
        return found as T;
      }
    }
  }

  if (typeof manager.find === 'function') {
    const lowered = name.toLowerCase();
    const slug = slugify(name);
    const found = await manager.find((candidate: any) => {
      const candidateName = candidate?.metadata?.name;
      if (typeof candidateName !== 'string') {
        return false;
      }
      const candidateSlug = slugify(candidateName);
      return candidateName.toLowerCase() === lowered || candidateSlug === slug;
    });
    if (found) {
      return found;
    }
  }

  if (typeof manager.load === 'function') {
    const candidateFilename = getElementFilename(type, name);
    try {
      return await manager.load(candidateFilename);
    } catch (error) {
      logger.debug(`[ElementCRUD] Direct load failed for ${type}:${name}`, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  logger.debug(`[ElementCRUD] Unable to locate ${type}:${name} via available manager operations.`);
  return undefined;
}
