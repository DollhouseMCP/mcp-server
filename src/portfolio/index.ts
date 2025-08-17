/**
 * Portfolio module exports
 */

// Core portfolio management
export { PortfolioManager } from './PortfolioManager.js';
export { PortfolioRepoManager } from './PortfolioRepoManager.js';
export { DefaultElementProvider } from './DefaultElementProvider.js';
export { MigrationManager } from './MigrationManager.js';

// Indexing and search
export { PortfolioIndexManager } from './PortfolioIndexManager.js';
export { GitHubPortfolioIndexer } from './GitHubPortfolioIndexer.js';
export { UnifiedIndexManager } from './UnifiedIndexManager.js';

// Types and interfaces
export {
  ElementType,
  PortfolioConfig,
  PortfolioConfiguration,
  GitHubPortfolioConfig
} from './types.js';

export type {
  IndexEntry,
  PortfolioIndex,
  SearchOptions,
  SearchResult
} from './PortfolioIndexManager.js';

export type {
  GitHubIndexEntry,
  GitHubPortfolioIndex,
  GitHubFetchOptions
} from './GitHubPortfolioIndexer.js';

export type {
  UnifiedIndexEntry,
  UnifiedSearchResult,
  UnifiedIndexStats
} from './UnifiedIndexManager.js';