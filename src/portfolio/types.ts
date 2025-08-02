/**
 * Shared types for the portfolio system
 */

export enum ElementType {
  PERSONA = 'persona',
  SKILL = 'skill',
  TEMPLATE = 'template',
  AGENT = 'agent',
  MEMORY = 'memory',
  ENSEMBLE = 'ensemble'
}

export interface PortfolioConfig {
  baseDir?: string;  // Override default location
  createIfMissing?: boolean;
  migrateExisting?: boolean;
}

// Re-export for convenience
export { PortfolioConfig as PortfolioConfiguration };