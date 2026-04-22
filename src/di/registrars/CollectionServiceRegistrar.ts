/**
 * CollectionServiceRegistrar
 *
 * Owns the DI wiring for the GitHub collection and portfolio repository
 * services: GitHub API client, auth, rate limiting, collection browsing,
 * searching, caching, and portfolio sync infrastructure.
 *
 * Responsibilities:
 * - GitHubClient, GitHubAuthManager, GitHubRateLimiter
 * - CollectionIndexManager, CollectionBrowser, CollectionSearch
 * - CollectionCache, PersonaDetails, ElementInstaller
 * - PortfolioRepoManager, GitHubPortfolioIndexer
 *
 * @module di/registrars/CollectionServiceRegistrar
 */

import { env } from '../../config/env.js';
import { getPortfolioRepositoryName } from '../../config/portfolioConfig.js';
import { APICache, CollectionCache } from '../../cache/index.js';
import {
  GitHubClient,
  CollectionBrowser,
  CollectionIndexManager,
  CollectionSearch,
  PersonaDetails,
  ElementInstaller,
} from '../../collection/index.js';
import { GitHubAuthManager } from '../../auth/GitHubAuthManager.js';
import { GitHubRateLimiter } from '../../utils/GitHubRateLimiter.js';
import { PortfolioRepoManager } from '../../portfolio/PortfolioRepoManager.js';
import { GitHubPortfolioIndexer } from '../../portfolio/GitHubPortfolioIndexer.js';
import type { DiContainerFacade } from '../DiContainerFacade.js';

export class CollectionServiceRegistrar {
  public register(container: DiContainerFacade): void {
    container.register('GitHubRateLimiter', () => new GitHubRateLimiter(
      container.resolve('TokenManager')
    ));

    // GITHUB & COLLECTION
    // GitHubClient's SSRF allowlist is extended by DOLLHOUSE_COLLECTION_ALLOWLIST
    // when the shared pool is enabled. The default hosts (api.github.com,
    // raw.githubusercontent.com) are always included.
    container.register('GitHubClient', () => new GitHubClient(
      container.resolve<APICache>('APICache'),
      container.resolve('RateLimitTracker'),
      container.resolve('TokenManager'),
      env.DOLLHOUSE_COLLECTION_ALLOWLIST ?? undefined,
    ));

    container.register('GitHubAuthManager', () => new GitHubAuthManager(
      container.resolve<APICache>('APICache'),
      container.resolve('ConfigManager'),
      container.resolve('TokenManager')
    ));

    // CollectionIndexManager's index URL is overridable via DOLLHOUSE_COLLECTION_URL.
    container.register('CollectionIndexManager', () => new CollectionIndexManager({
      fileOperations: container.resolve('FileOperationsService'),
      indexUrl: env.DOLLHOUSE_COLLECTION_URL,
    }));

    container.register('CollectionBrowser', () => new CollectionBrowser(
      container.resolve('GitHubClient'),
      container.resolve('CollectionCache'),
      container.resolve('CollectionIndexManager')
    ));

    // CollectionIndexCache is registered in IndexingServiceRegistrar (runs after
    // this registrar). Safe because this factory is lazy — resolved well after
    // all registrars have run.
    container.register('CollectionSearch', () => new CollectionSearch(
      container.resolve('GitHubClient'),
      container.resolve('CollectionCache'),
      container.resolve('CollectionIndexCache')
    ));

    container.register('CollectionCache', () => new CollectionCache(
      container.resolve('FileOperationsService'),
      container.hasRegistration('PathService')
        ? container.resolve<import('../../paths/PathService.js').PathService>('PathService').resolveDataDir('cache')
        : undefined,
    ));

    container.register('PersonaDetails', () => new PersonaDetails(container.resolve('GitHubClient')));

    container.register('ElementInstaller', () => new ElementInstaller(container.resolve('GitHubClient'), {
      portfolioManager: container.resolve('PortfolioManager'),
      unifiedIndexManager: container.resolve('UnifiedIndexManager'),
      fileOperations: container.resolve('FileOperationsService'),
      sharedPoolInstaller: container.hasRegistration('SharedPoolInstaller')
        ? container.resolve('SharedPoolInstaller')
        : undefined,
    }));

    container.register('PortfolioRepoManager', () => new PortfolioRepoManager(
      container.resolve('TokenManager'),
      getPortfolioRepositoryName()
    ));

    container.register('GitHubPortfolioIndexer', () => new GitHubPortfolioIndexer(
      container.resolve('PortfolioRepoManager')
    ));
  }
}
