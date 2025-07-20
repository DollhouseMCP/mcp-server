/**
 * Shared types for the portfolio system
 */

export enum ElementType {
  PERSONA = 'personas',
  SKILL = 'skills',
  TEMPLATE = 'templates',
  ENSEMBLE = 'ensembles',
  AGENT = 'agents',
  MEMORY = 'memories'
}

export interface PortfolioConfig {
  baseDir?: string;  // Override default location
  createIfMissing?: boolean;
  migrateExisting?: boolean;
}

// Re-export for convenience
export { PortfolioConfig as PortfolioConfiguration };