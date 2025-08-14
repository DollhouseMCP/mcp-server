/**
 * Shared types for the portfolio system
 */

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

// GitHub Portfolio Indexer types
export interface GitHubPortfolioConfig {
  enableGitHubIndexing?: boolean;
  refreshIntervalMs?: number;
  maxCacheSize?: number;
  useGraphQL?: boolean;
  fetchMetadata?: boolean;
}

// Re-export for convenience
export { PortfolioConfig as PortfolioConfiguration };