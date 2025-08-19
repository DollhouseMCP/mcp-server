/**
 * Shared types for the portfolio system
 */

// ⚠️ CRITICAL: When adding new types here, you MUST also update:
// - validTypes array in src/index.ts (line ~1812)
// - MCP_SUPPORTED_TYPES in src/collection/CollectionBrowser.ts
// - All mapping objects (pluralToSingularMap, pluralToDirMap)
// See docs/development/ADDING_NEW_ELEMENT_TYPES_CHECKLIST.md for complete guide
export enum ElementType {
  PERSONA = 'personas',
  SKILL = 'skills',
  TEMPLATE = 'templates',
  AGENT = 'agents',
  MEMORY = 'memories',
  ENSEMBLE = 'ensembles'
}

export interface PortfolioConfig {
  baseDir?: string;  // Override default location
  createIfMissing?: boolean;
  migrateExisting?: boolean;
}

// Re-export for convenience
export { PortfolioConfig as PortfolioConfiguration };