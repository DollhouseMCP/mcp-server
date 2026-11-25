/**
 * GitHub Portfolio Indexer - Fetches and indexes user's GitHub portfolio for fast searching
 * 
 * Features:
 * - Singleton pattern for efficient resource usage
 * - Smart caching with TTL and invalidation after user actions
 * - GraphQL/REST API integration for efficient fetching
 * - Rate limiting and authentication handling
 * - Fallback strategy for resilient operation
 * - Performance optimized for 1000+ portfolio elements
 */

import { PortfolioRepoManager } from './PortfolioRepoManager.js';
import { ElementType } from './types.js';
import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { ErrorHandler, ErrorCategory } from '../utils/ErrorHandler.js';
import { APICache } from '../cache/APICache.js';
import { visitSequentially } from '../utils/visitSequentially.js';
import { requireCompleteCollection, type CollectionReport, type CollectionFailure } from '../elements/base/CollectionReport.js';
import { elementReadFailure, GuardedReadConflict } from '../elements/base/ElementReadError.js';

export interface GitHubIndexEntry {
  path: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  elementType: ElementType;
  sha: string; // File SHA for change detection
  htmlUrl: string; // Link to GitHub
  downloadUrl: string;
  lastModified: Date;
  size: number;
}

export interface GitHubPortfolioIndex {
  username: string;
  repository: string;
  lastUpdated: Date;
  elements: Map<ElementType, GitHubIndexEntry[]>;
  totalElements: number;
  sha: string; // Latest commit SHA
  rateLimitInfo?: {
    remaining: number;
    resetTime: Date;
  };
}

export interface GitHubFetchOptions {
  force?: boolean;
  maxElements?: number;
  elementTypes?: ElementType[];
  useGraphQL?: boolean;
}

export class GitHubPortfolioIndexer {
  private readonly cacheByUser = new Map<string, GitHubPortfolioIndex>();
  private readonly lastFetchByUser = new Map<string, Date>();
  private readonly ttl = 15 * 60 * 1000; // 15 minutes
  private readonly recentUserActionByUser = new Map<string, boolean>();
  private readonly actionTimestampByUser = new Map<string, Date>();
  private readonly actionGracePeriod = 2 * 60 * 1000; // 2 minutes after action
  
  private readonly portfolioRepoManager: PortfolioRepoManager;
  private readonly apiCache: APICache;
  private readonly rateLimitTracker: Map<string, number[]>;
  private readonly graphQLFeatureEnabled: boolean;
  
  constructor(
    portfolioRepoManager?: PortfolioRepoManager,
    private readonly userKeyProvider: () => string = () => 'system',
  ) {
    this.apiCache = new APICache(); // Uses default settings
    this.rateLimitTracker = new Map();
    this.portfolioRepoManager = portfolioRepoManager!;
    const graphQLEnv = process.env.DOLLHOUSE_GITHUB_GRAPHQL?.toLowerCase();
    this.graphQLFeatureEnabled = graphQLEnv === 'true' || graphQLEnv === '1';
    if (this.graphQLFeatureEnabled) {
      logger.info('GitHubPortfolioIndexer: GraphQL fetch enabled via DOLLHOUSE_GITHUB_GRAPHQL');
    }

    logger.debug('GitHubPortfolioIndexer created');
  }

  /**
   * Main method to get GitHub portfolio index
   */
  public async getIndex(force = false): Promise<GitHubPortfolioIndex> {
    return requireCompleteCollection(await this.getIndexReport(force))[0];
  }

  public async getIndexReport(force = false): Promise<CollectionReport<GitHubPortfolioIndex>> {
    const userKey = this.currentUserKey();
    const cachedIndex = this.cacheByUser.get(userKey);
    const lastFetch = this.lastFetchByUser.get(userKey) ?? null;
    if (!force && !this.shouldFetchFresh(userKey) && cachedIndex && this.isCacheValid(userKey)) {
      GitHubPortfolioIndexer.logCachedIndex(cachedIndex, lastFetch);
      return { items: [cachedIndex], failures: [], complete: true };
    }
    return this.fetchFreshWithFallback(cachedIndex, lastFetch);
  }

  private static logCachedIndex(cachedIndex: GitHubPortfolioIndex, lastFetch: Date | null): void {
    logger.debug('Returning cached GitHub portfolio index', {
      username: cachedIndex.username,
      totalElements: cachedIndex.totalElements,
      age: lastFetch ? Date.now() - lastFetch.getTime() : 'unknown'
    });
  }

  private async fetchFreshWithFallback(
    cachedIndex: GitHubPortfolioIndex | undefined,
    lastFetch: Date | null
  ): Promise<CollectionReport<GitHubPortfolioIndex>> {
    try {
      return await this.fetchFresh();
    } catch (error) {
      logger.warn('Failed to fetch fresh GitHub portfolio index, checking for stale cache', {
        error: error instanceof Error ? error.message : String(error)
      });
      if (cachedIndex) {
        logger.info('Returning stale GitHub portfolio cache as fallback', {
          username: cachedIndex.username,
          age: lastFetch ? Date.now() - lastFetch.getTime() : 'unknown'
        });
        const failure = elementReadFailure(error, 'github');
        if (failure instanceof GuardedReadConflict) throw failure;
        return { items: [cachedIndex], failures: [{ reference: 'github', error: failure }], complete: false };
      }
      throw elementReadFailure(error, 'github');
    }
  }

  /**
   * Invalidate cache after user actions
   */
  public invalidateAfterAction(action: string): void {
    logger.info('Invalidating GitHub portfolio cache after user action', { action });
    
    const userKey = this.currentUserKey();
    this.recentUserActionByUser.set(userKey, true);
    this.actionTimestampByUser.set(userKey, new Date());
    
    // Log security event for audit trail
    SecurityMonitor.logSecurityEvent({
      type: 'PORTFOLIO_CACHE_INVALIDATION',
      severity: 'LOW',
      source: 'GitHubPortfolioIndexer.invalidateAfterAction',
      details: `Cache invalidated after user action: ${action}`,
      metadata: { action }
    });
  }

  /**
   * Clear all cached data
   */
  public clearCache(): void {
    this.cacheByUser.clear();
    this.lastFetchByUser.clear();
    this.recentUserActionByUser.clear();
    this.actionTimestampByUser.clear();
    this.apiCache.clear();
    
    logger.info('GitHub portfolio cache cleared');
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): {
    hasCachedData: boolean;
    lastFetch: Date | null;
    isStale: boolean;
    recentUserAction: boolean;
    totalElements: number;
  } {
    return {
      hasCachedData: this.cacheByUser.has(this.currentUserKey()),
      lastFetch: this.lastFetchByUser.get(this.currentUserKey()) ?? null,
      isStale: !this.isCacheValid(this.currentUserKey()),
      recentUserAction: this.recentUserActionByUser.get(this.currentUserKey()) ?? false,
      totalElements: this.cacheByUser.get(this.currentUserKey())?.totalElements || 0
    };
  }

  private currentUserKey(): string {
    return this.userKeyProvider();
  }

  /**
   * Fetch fresh data from GitHub
   */
  private async fetchFresh(): Promise<CollectionReport<GitHubPortfolioIndex>> {
    const startTime = Date.now();
    logger.info('Fetching fresh GitHub portfolio index...');

    try {
      // Get GitHub username from token
      const username = await this.getGitHubUsername();
      const repository = this.portfolioRepoManager.getRepositoryName();
      
      // Check if portfolio repository exists
      const repoExists = await this.portfolioRepoManager.checkPortfolioExists(username);
      if (!repoExists) {
        logger.info('GitHub portfolio repository does not exist', { username });
        return { items: [this.createEmptyIndex(username, repository)], failures: [], complete: true };
      }
      
      // Fetch repository content using GitHub API
      const report = await this.fetchRepositoryContent(username, repository);
      const index = report.items[0];
      if (!report.complete) return report;
      
      // Update cache
      const userKey = this.currentUserKey();
      this.cacheByUser.set(userKey, index);
      this.lastFetchByUser.set(userKey, new Date());
      this.recentUserActionByUser.delete(userKey);
      this.actionTimestampByUser.delete(userKey);
      
      const duration = Date.now() - startTime;
      logger.info('GitHub portfolio index fetched successfully', {
        username,
        totalElements: index.totalElements,
        duration: `${duration}ms`,
        rateLimitRemaining: index.rateLimitInfo?.remaining
      });
      
      // Log security event
      SecurityMonitor.logSecurityEvent({
        type: 'PORTFOLIO_FETCH_SUCCESS',
        severity: 'LOW',
        source: 'GitHubPortfolioIndexer.fetchFresh',
        details: `Fetched GitHub portfolio with ${index.totalElements} elements in ${duration}ms`,
        metadata: { username, duration, totalElements: index.totalElements }
      });
      
      return report;
      
    } catch (error) {
      const duration = Date.now() - startTime;
      ErrorHandler.logError('GitHubPortfolioIndexer.fetchFresh', error, { duration });
      throw ErrorHandler.wrapError(error, 'Failed to fetch GitHub portfolio index', ErrorCategory.NETWORK_ERROR);
    }
  }

  /**
   * Fetch repository content from GitHub API
   */
  private async fetchRepositoryContent(username: string, repository: string): Promise<CollectionReport<GitHubPortfolioIndex>> {
    if (this.graphQLFeatureEnabled) {
      try {
        return { items: [await this.fetchWithGraphQL(username, repository)], failures: [], complete: true };
      } catch (graphqlError) {
        logger.debug('GraphQL fetch failed, falling back to REST API', {
          error: graphqlError instanceof Error ? graphqlError.message : String(graphqlError)
        });
      }
    } else {
      logger.debug('GraphQL portfolio fetch disabled; using REST API');
    }

    return await this.fetchWithREST(username, repository);
  }

  /**
   * Fetch using GraphQL for better performance
   * Portfolio GraphQL is unavailable; the caller falls back to REST.
   */
  private fetchWithGraphQL(username: string, repository: string): Promise<GitHubPortfolioIndex> {
    // GraphQL query stub - will be used when GraphQL endpoint is implemented
    const _query = `
      query GetPortfolioContent($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          defaultBranchRef {
            target {
              ... on Commit {
                oid
                history(first: 1) {
                  nodes {
                    committedDate
                  }
                }
              }
            }
          }
          object(expression: "HEAD:") {
            ... on Tree {
              entries {
                name
                type
                object {
                  ... on Tree {
                    entries {
                      name
                      type
                      oid
                      object {
                        ... on Blob {
                          byteSize
                          text
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        rateLimit {
          remaining
          resetAt
        }
      }
    `;

    // GraphQL variables stub - will be used when GraphQL endpoint is implemented
    const _variables = { owner: username, name: repository };

    // GraphQL endpoint not yet implemented with PortfolioRepoManager
    // For now, just throw to fall back to REST
    // Note: In a real implementation, you would send POST request with _query and _variables
    return Promise.reject(new Error('GraphQL not yet implemented for portfolio operations'));
  }

  /**
   * Fetch using REST API with pagination
   */
  private async fetchWithREST(username: string, repository: string): Promise<CollectionReport<GitHubPortfolioIndex>> {
    const normalizedUsername = UnicodeValidator.normalize(username).normalizedContent;

    // Construct repository path (repository parameter is always just the repo name)
    const repoPath = `${normalizedUsername}/${repository}`;

    // Get repository info and latest commit
    await this.portfolioRepoManager.githubRequest(
      `/repos/${repoPath}`
    );

    const latestCommit = await this.portfolioRepoManager.githubRequest(
      `/repos/${repoPath}/commits/HEAD`
    );
    
    // Initialize index
    const index: GitHubPortfolioIndex = {
      username: normalizedUsername,
      repository,
      lastUpdated: new Date(latestCommit.commit.committer.date),
      elements: new Map(),
      totalElements: 0,
      sha: latestCommit.sha
    };
    
    // Initialize element type maps
    for (const elementType of Object.values(ElementType)) {
      index.elements.set(elementType, []);
    }
    
    // Fetch content for each element type
    logger.info(`Fetching content for all element types from GitHub portfolio...`);
    const failures: CollectionFailure[] = [];

    await visitSequentially(Object.values(ElementType).values(), async elementType => {
      try {
        logger.debug(`Fetching ${elementType} from GitHub...`);
        const report = await this.fetchElementTypeContent(repoPath, elementType);
        const entries = report.items;
        failures.push(...report.failures);
        index.elements.set(elementType, entries);
        index.totalElements += entries.length;
        
        if (entries.length > 0) {
          logger.info(`✅ Found ${entries.length} ${elementType} in GitHub portfolio`);
        } else {
          logger.debug(`📁 No ${elementType} found (directory may not exist yet)`);
        }
      } catch (error) {
        logger.warn(`❌ Failed to fetch ${elementType} from GitHub portfolio`, {
          error: error instanceof Error ? error.message : String(error),
          elementType
        });
        const failure = elementReadFailure(error, elementType);
        if (failure instanceof GuardedReadConflict) throw failure;
        failures.push({ reference: elementType, error: failure });
      }
    });
    
    return { items: [index], failures, complete: failures.length === 0 };
  }

  /**
   * Fetch content for a specific element type
   */
  private async fetchElementTypeContent(
    repoPath: string,
    elementType: ElementType
  ): Promise<CollectionReport<GitHubIndexEntry>> {
    try {
      const contents = await this.portfolioRepoManager.githubRequest(
        `/repos/${repoPath}/contents/${elementType}`
      );
      if (!Array.isArray(contents)) {
        throw new TypeError('GitHub directory response is not an array');
      }

      return await this.createEntriesFromDirectoryContents(elementType, contents);
    } catch (error) {
      if (this.isGitHubNotFoundError(error)) {
        logger.debug(`Directory ${elementType} not found in GitHub repository (this is normal if not yet created)`);
        return { items: [], failures: [], complete: true };
      }
      if (error instanceof Error) {
        logger.debug(`Error fetching ${elementType}: ${error.message}`);
      }
      logger.warn(`Unexpected error fetching ${elementType}:`, error);
      throw error;
    }
  }

  private async createEntriesFromDirectoryContents(
    elementType: ElementType,
    contents: any[]
  ): Promise<CollectionReport<GitHubIndexEntry>> {
    const entries: GitHubIndexEntry[] = [];
    const failures: CollectionFailure[] = [];
    const maxConcurrent = 5;
    const offsets = Array.from({ length: Math.ceil(contents.length / maxConcurrent) }, (_, index) => index * maxConcurrent);
    await visitSequentially(offsets.values(), async i => {
      const batchResults = await this.createIndexEntriesBatch(
        elementType,
        contents.slice(i, i + maxConcurrent)
      );
      entries.push(...batchResults.items);
      failures.push(...batchResults.failures);
      if (i + maxConcurrent < contents.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });
    return { items: entries, failures, complete: failures.length === 0 };
  }

  private async createIndexEntriesBatch(
    elementType: ElementType,
    batch: any[]
  ): Promise<CollectionReport<GitHubIndexEntry>> {
    const files = batch.filter(item => item.type === 'file' && item.name.endsWith('.md'));
    const results = await Promise.allSettled(files.map(item => this.createGitHubIndexEntry(elementType, item)));
    const items: GitHubIndexEntry[] = [];
    const failures: CollectionFailure[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') items.push(result.value);
      else {
        const reference = files[index].path;
        const error = elementReadFailure(result.reason, reference);
        if (error instanceof GuardedReadConflict) throw error;
        failures.push({ reference, error });
      }
    });
    return { items, failures, complete: failures.length === 0 };
  }

  private isGitHubNotFoundError(error: unknown): boolean {
    return error instanceof Error &&
      (error.message.includes('404') || error.message.includes('Not Found'));
  }

  /**
   * Create GitHub index entry from API response
   */
  private async createGitHubIndexEntry(
    elementType: ElementType,
    fileInfo: any
  ): Promise<GitHubIndexEntry> {
    // Parse metadata from filename or fetch content if needed
    // FIX: Keep original filename format to match local file expectations
    // Previously: .replaceAll(/-/g, ' ') converted hyphens to spaces causing sync mismatch
    const name = fileInfo.name.replace('.md', '');
      
    const entry: GitHubIndexEntry = {
      path: fileInfo.path,
      name,
      elementType,
      sha: fileInfo.sha,
      htmlUrl: fileInfo.html_url,
      downloadUrl: fileInfo.download_url,
      lastModified: new Date(), // GitHub API doesn't provide file modification time directly
      size: fileInfo.size || 0
    };
    await this.hydrateSmallFileMetadata(entry, fileInfo);
    return entry;
  }

  private async hydrateSmallFileMetadata(entry: GitHubIndexEntry, fileInfo: any): Promise<void> {
    if (!fileInfo.size || fileInfo.size >= 10000) {
      return;
    }
    const response = await fetch(fileInfo.download_url);
    if (!response.ok) throw new Error(`GitHub content request failed (${response.status})`);
    const content = await response.text();
    const metadata = this.parseMetadataFromContent(content);
    GitHubPortfolioIndexer.applyParsedMetadata(entry, metadata);
  }

  private static applyParsedMetadata(
    entry: GitHubIndexEntry,
    metadata: { name?: string; description?: string; version?: string; author?: string }
  ): void {
    if (metadata.name) entry.name = metadata.name;
    if (metadata.description) entry.description = metadata.description;
    if (metadata.version) entry.version = metadata.version;
    if (metadata.author) entry.author = metadata.author;
  }

  /**
   * Parse metadata from file content (frontmatter)
   */
  private parseMetadataFromContent(content: string): {
    name?: string;
    description?: string;
    version?: string;
    author?: string;
  } {
    const metadata: any = {};
    
    // Simple frontmatter parsing (could use a proper YAML parser)
    const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(content);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      
      // Match values with a single optional space and a value that
      // explicitly excludes line breaks. Avoids the `\s* … .+` overlap
      // that regexp/no-super-linear-backtracking flags as polynomial
      // ReDoS — `?` is a bounded 0-or-1 quantifier with no character
      // exchange against `[^\r\n]+`.
      const nameMatch = /^name:[ \t]?([^\r\n]+)$/m.exec(frontmatter);
      if (nameMatch) metadata.name = nameMatch[1].trim();

      const descMatch = /^description:[ \t]?([^\r\n]+)$/m.exec(frontmatter);
      if (descMatch) metadata.description = descMatch[1].trim();

      const versionMatch = /^version:[ \t]?([^\r\n]+)$/m.exec(frontmatter);
      if (versionMatch) metadata.version = versionMatch[1].trim();

      const authorMatch = /^author:[ \t]?([^\r\n]+)$/m.exec(frontmatter);
      if (authorMatch) metadata.author = authorMatch[1].trim();
    }
    
    return metadata;
  }

  /**
   * Get GitHub username from authenticated token
   */
  private async getGitHubUsername(): Promise<string> {
    try {
      const userInfo = await this.portfolioRepoManager.githubRequest('/user');
      return userInfo.login;
    } catch {
      throw new Error('Failed to get GitHub username. Please ensure you are authenticated with GitHub.');
    }
  }

  /**
   * Check if cache is valid
   */
  private isCacheValid(userKey: string = this.currentUserKey()): boolean {
    const lastFetch = this.lastFetchByUser.get(userKey);
    if (!this.cacheByUser.has(userKey) || !lastFetch) {
      return false;
    }
    
    const age = Date.now() - lastFetch.getTime();
    return age < this.ttl;
  }

  /**
   * Determine if we should fetch fresh data
   */
  private shouldFetchFresh(userKey: string = this.currentUserKey()): boolean {
    // Always fetch if no cache
    if (!this.cacheByUser.has(userKey) || !this.lastFetchByUser.has(userKey)) {
      return true;
    }
    
    // Check for recent user actions
    const recentUserAction = this.recentUserActionByUser.get(userKey) ?? false;
    const actionTimestamp = this.actionTimestampByUser.get(userKey) ?? null;
    if (recentUserAction && actionTimestamp) {
      const actionAge = Date.now() - actionTimestamp.getTime();
      if (actionAge < this.actionGracePeriod) {
        logger.debug('Fetching fresh due to recent user action', { actionAge });
        return true;
      } else {
        // Grace period expired, clear action flag
        this.recentUserActionByUser.delete(userKey);
        this.actionTimestampByUser.delete(userKey);
      }
    }
    
    // Check TTL
    return !this.isCacheValid(userKey);
  }

  /**
   * Create empty index when no portfolio exists
   */
  private createEmptyIndex(username?: string, repository?: string): GitHubPortfolioIndex {
    const index: GitHubPortfolioIndex = {
      username: username || 'unknown',
      repository: repository || this.portfolioRepoManager.getRepositoryName(),
      lastUpdated: new Date(),
      elements: new Map(),
      totalElements: 0,
      sha: ''
    };
    
    // Initialize empty element type maps
    for (const elementType of Object.values(ElementType)) {
      index.elements.set(elementType, []);
    }
    
    return index;
  }

  public dispose(): void {
    this.clearCache();
    this.apiCache.clear();
    this.rateLimitTracker.clear();
  }


}
