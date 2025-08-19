/**
 * Central configuration for all element types
 * 
 * This file serves as the single source of truth for element type configurations.
 * When adding new element types, update this config and use the derived arrays
 * to ensure consistency across the codebase.
 */

import { ElementType } from '../portfolio/types.js';

/**
 * Complete configuration for each element type
 */
export const ELEMENT_TYPE_CONFIG = {
  [ElementType.PERSONA]: {
    plural: 'personas',
    directory: 'personas',
    mcpSupported: true,
    hasManager: true,
    icon: '👤',
    description: 'Behavioral profiles that define AI personality and interaction style'
  },
  [ElementType.SKILL]: {
    plural: 'skills',
    directory: 'skills', 
    mcpSupported: true,
    hasManager: true,
    icon: '🛠️',
    description: 'Discrete capabilities for specific tasks'
  },
  [ElementType.TEMPLATE]: {
    plural: 'templates',
    directory: 'templates',
    mcpSupported: true,
    hasManager: true,
    icon: '📄',
    description: 'Reusable content structures with variable substitution'
  },
  [ElementType.AGENT]: {
    plural: 'agents',
    directory: 'agents',
    mcpSupported: true,
    hasManager: true,
    icon: '🤖',
    description: 'Autonomous goal-oriented actors with decision-making capabilities'
  },
  [ElementType.MEMORY]: {
    plural: 'memories',
    directory: 'memories',
    mcpSupported: false, // Hidden from MCP per Issue #144
    hasManager: false,   // Not yet implemented
    icon: '🧠',
    description: 'Persistent context storage for continuity and learning'
  },
  [ElementType.ENSEMBLE]: {
    plural: 'ensembles',
    directory: 'ensembles',
    mcpSupported: false, // Hidden from MCP per Issue #144
    hasManager: false,   // Not yet implemented
    icon: '🎭',
    description: 'Groups of elements working together as a cohesive unit'
  }
} as const;

/**
 * Derived arrays for validation and filtering
 * These are automatically generated from the config above
 */

// Element types that are exposed via MCP tools
export const MCP_SUPPORTED_TYPES = Object.entries(ELEMENT_TYPE_CONFIG)
  .filter(([, config]) => config.mcpSupported)
  .map(([type]) => type as ElementType);

// Plural forms for MCP validation (used in browseCollection validTypes array)
export const VALID_TYPES_ARRAY = MCP_SUPPORTED_TYPES.map(
  type => ELEMENT_TYPE_CONFIG[type].plural
);

// Mapping from plural forms to ElementType values
export const PLURAL_TO_ELEMENT_TYPE_MAP = Object.fromEntries(
  Object.entries(ELEMENT_TYPE_CONFIG).map(([type, config]) => [
    config.plural, type as ElementType
  ])
);

// Mapping from singular forms to directory names  
export const SINGULAR_TO_DIRECTORY_MAP = Object.fromEntries(
  Object.entries(ELEMENT_TYPE_CONFIG).map(([type, config]) => [
    type.toLowerCase().replace('s', ''), // Convert 'personas' -> 'persona' 
    config.directory
  ])
);

/**
 * Utility functions
 */

export function isElementTypeSupported(type: ElementType): boolean {
  return ELEMENT_TYPE_CONFIG[type]?.mcpSupported ?? false;
}

export function getElementTypeConfig(type: ElementType) {
  return ELEMENT_TYPE_CONFIG[type];
}

export function getAllSupportedTypes(): ElementType[] {
  return MCP_SUPPORTED_TYPES;
}

export function getValidTypesForMCP(): string[] {
  return VALID_TYPES_ARRAY;
}

/**
 * Migration note: To use this centralized config:
 * 
 * 1. Replace hardcoded arrays with imports from this file:
 *    - Replace validTypes in src/index.ts with VALID_TYPES_ARRAY
 *    - Replace MCP_SUPPORTED_TYPES in CollectionBrowser.ts with import
 *    - Replace mapping objects with imports from this file
 * 
 * 2. Update components to use utility functions instead of hardcoded checks
 * 
 * 3. When adding new types, only update ELEMENT_TYPE_CONFIG above
 */