/**
 * Central registry of element type test configurations
 *
 * This is the single source of truth for element type test configurations.
 * Each element type (personas, skills, templates, agents, memories, ensembles)
 * will have a configuration entry added here in Phase 2.
 *
 * Usage:
 * - The main test suite iterates over this registry with describe.each()
 * - Each config drives test generation via capability flags
 * - Adding a new element type = add one config entry, tests auto-run
 *
 * Architecture:
 * - Capability-based: Tests selected by capability flags, not type checks
 * - Generic: No hardcoded type-specific logic
 * - Extensible: Clear pattern for adding new element types
 * - Migration-ready: Can consume from schema definitions in the future
 *
 * @example
 * ```typescript
 * import { ELEMENT_TYPE_REGISTRY } from './elementTypeRegistry.js';
 *
 * describe.each(ELEMENT_TYPE_REGISTRY)(
 *   'CRUD+Activate: $displayName',
 *   (config) => {
 *     // Tests automatically generated based on config.capabilities
 *   }
 * );
 * ```
 */

import { ElementTypeTestConfig } from './types.js';
import { PERSONA_CONFIG } from './personaConfig.js';
import { SKILL_CONFIG } from './skillConfig.js';
import { TEMPLATE_CONFIG } from './templateConfig.js';
import { AGENT_CONFIG } from './agentConfig.js';
import { MEMORY_CONFIG } from './memoryConfig.js';
import { ENSEMBLE_CONFIG } from './ensembleConfig.js';

/**
 * Registry of all element type test configurations
 *
 * This array contains configurations for all 6 element types:
 * - Personas - Behavioral profiles that define AI personality
 * - Skills - Discrete capabilities for specific tasks
 * - Templates - Reusable content structures with variable substitution
 * - Agents - Autonomous goal-oriented actors with decision-making
 * - Memories - Persistent context storage for continuity
 * - Ensembles - Orchestration of multiple elements working together
 *
 * Each config includes:
 * - Identity (type, displayName)
 * - Test data generation (factory, validExamples, invalidExamples)
 * - Field specifications (requiredFields, editableFields, nestedFields)
 * - Capabilities (supportsActivation, supportsNesting, hasStateFile, supportsReferences)
 * - Validation rules (validators)
 *
 * @see ElementTypeTestConfig for full configuration interface
 */
export const ELEMENT_TYPE_REGISTRY: ElementTypeTestConfig[] = [
  PERSONA_CONFIG,
  SKILL_CONFIG,
  TEMPLATE_CONFIG,
  AGENT_CONFIG,
  MEMORY_CONFIG,
  ENSEMBLE_CONFIG
];

/**
 * Get configuration for a specific element type
 *
 * @param type - ElementType to get configuration for
 * @returns Configuration or undefined if not registered
 */
export function getConfigForType(type: string): ElementTypeTestConfig | undefined {
  return ELEMENT_TYPE_REGISTRY.find(config => config.type === type);
}

/**
 * Get all configurations that have a specific capability
 *
 * @param capability - Capability key to filter by
 * @returns Array of configurations with that capability
 *
 * @example
 * ```typescript
 * // Get all element types that support activation
 * const activatableTypes = getConfigsWithCapability('supportsActivation');
 * ```
 */
export function getConfigsWithCapability(
  capability: keyof import('./types.js').ElementCapabilities
): ElementTypeTestConfig[] {
  return ELEMENT_TYPE_REGISTRY.filter(
    config => config.capabilities[capability] !== undefined
  );
}

/**
 * Check if any element types are registered
 *
 * @returns True if registry has configurations
 */
export function hasRegisteredTypes(): boolean {
  return ELEMENT_TYPE_REGISTRY.length > 0;
}

/**
 * Get count of registered element types
 *
 * @returns Number of configurations in registry
 */
export function getRegisteredTypeCount(): number {
  return ELEMENT_TYPE_REGISTRY.length;
}
