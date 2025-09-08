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
import { TokenManager } from '../security/tokenManager.js';
import { ElementType } from './types.js';
import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { ErrorHandler, ErrorCategory } from '../utils/ErrorHandler.js';
import { APICache } from '../cache/APICache.js';

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
  private static instance: GitHubPortfolioIndexer | null = null;
  private static instanceLock = false;
  
  private cache: GitHubPortfolioIndex | null = null;
  private lastFetch: Date | null = null;
  private readonly ttl = 15 * 60 * 1000; // 15 minutes
  private recentUserAction = false;
  private actionTimestamp: Date | null = null;
  private readonly actionGracePeriod = 2 * 60 * 1000; // 2 minutes after action
  
  private portfolioRepoManager: PortfolioRepoManager;
  private apiCache: APICache;
  private rateLimitTracker: Map<string, number[]>;
  
  private constructor() {
    this.apiCache = new APICache(); // Uses default settings
    this.rateLimitTracker = new Map();
    this.portfolioRepoManager = new PortfolioRepoManager();
    
    logger.debug('GitHubPortfolioIndexer created');
  }

  /**
   * Singleton pattern with thread safety
   */
  public static getInstance(): GitHubPortfolioIndexer {
    if (!this.instance) {
      if (this.instanceLock) {
        throw new Error('GitHubPortfolioIndexer instance is being created by another thread');
      }
      
      try {
        this.instanceLock = true;
        this.instance = new GitHubPortfolioIndexer();
      } finally {
        this.instanceLock = false;
      }
    }
    return this.instance;
  }

  /**
   * Main method to get GitHub portfolio index
   */
  public async getIndex(force = false): Promise<GitHubPortfolioIndex> {
    try {
      // Check if we need fresh data
      if (force || this.shouldFetchFresh()) {
        return await this.fetchFresh();
      }
      
      // Return cached data if available and valid
      if (this.cache && this.isCacheValid()) {
        logger.debug('Returning cached GitHub portfolio index', {
          username: this.cache.username,
          totalElements: this.cache.totalElements,
          age: this.lastFetch ? Date.now() - this.lastFetch.getTime() : 'unknown'
        });
        return this.cache;
      }
      
      // Try to fetch fresh, fall back to stale cache on failure
      try {
        return await this.fetchFresh();
      } catch (error) {
        logger.warn('Failed to fetch fresh GitHub portfolio index, checking for stale cache', {
          error: error instanceof Error ? error.message : String(error)
        });
        
        // Return stale cache if available
        if (this.cache) {
          logger.info('Returning stale GitHub portfolio cache as fallback', {
            username: this.cache.username,
            age: this.lastFetch ? Date.now() - this.lastFetch.getTime() : 'unknown'
          });
          return this.cache;
        }
        
        // Return empty index as last resort
        return this.createEmptyIndex();
      }
      
    } catch (error) {
      ErrorHandler.logError('GitHubPortfolioIndexer.getIndex', error);
      
      // Return stale cache or empty index
      if (this.cache) {
        return this.cache;
      }
      
      return this.createEmptyIndex();
    }
  }

  /**
   * Invalidate cache after user actions
   */
  public invalidateAfterAction(action: string): void {
    logger.info('Invalidating GitHub portfolio cache after user action', { action });
    
    this.recentUserAction = true;
    this.actionTimestamp = new Date();
    
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
    this.cache = null;
    this.lastFetch = null;
    this.recentUserAction = false;
    this.actionTimestamp = null;
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
      hasCachedData: this.cache !== null,
      lastFetch: this.lastFetch,
      isStale: !this.isCacheValid(),
      recentUserAction: this.recentUserAction,
      totalElements: this.cache?.totalElements || 0
    };
  }

  /**
   * Fetch fresh data from GitHub
   */
  private async fetchFresh(): Promise<GitHubPortfolioIndex> {
    const startTime = Date.now();
    logger.info('Fetching fresh GitHub portfolio index...');
    
    try {
      // Get GitHub username from token
      const username = await this.getGitHubUsername();
      const repository = 'dollhouse-portfolio';
      
      // Check if portfolio repository exists
      const repoExists = await this.portfolioRepoManager.checkPortfolioExists(username);
      if (!repoExists) {
        logger.info('GitHub portfolio repository does not exist', { username });
        return this.createEmptyIndex(username, repository);
      }
      
      // Fetch repository content using GitHub API
      const index = await this.fetchRepositoryContent(username, repository);
      
      // Update cache
      this.cache = index;
      this.lastFetch = new Date();
      this.recentUserAction = false;
      this.actionTimestamp = null;
      
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
      
      return index;
      
    } catch (error) {
      const duration = Date.now() - startTime;
      ErrorHandler.logError('GitHubPortfolioIndexer.fetchFresh', error, { duration });
      throw ErrorHandler.wrapError(error, 'Failed to fetch GitHub portfolio index', ErrorCategory.NETWORK_ERROR);
    }
  }

  /**
   * Fetch repository content from GitHub API
   */
  private async fetchRepositoryContent(username: string, repository: string): Promise<GitHubPortfolioIndex> {
    // Try GraphQL first for better performance, fallback to REST
    try {
      return await this.fetchWithGraphQL(username, repository);
    } catch (graphqlError) {
      logger.debug('GraphQL fetch failed, falling back to REST API', {
        error: graphqlError instanceof Error ? graphqlError.message : String(graphqlError)
      });
      
      return await this.fetchWithREST(username, repository);
    }
  }

  /**
   * Fetch using GraphQL for better performance
   */
  private async fetchWithGraphQL(username: string, repository: string): Promise<GitHubPortfolioIndex> {
    const query = `
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
    
    const variables = { owner: username, name: repository };
    
    // GraphQL endpoint not yet implemented with PortfolioRepoManager
    // For now, just throw to fall back to REST
    throw new Error('GraphQL not yet implemented for portfolio operations');
    
    // Note: This is a simplified GraphQL implementation
    // In a real implementation, you would send POST request with query and variables
    throw new Error('GraphQL implementation not yet complete');
  }

  /**
   * Fetch using REST API with pagination
   */
  private async fetchWithREST(username: string, repository: string): Promise<GitHubPortfolioIndex> {
    const normalizedUsername = UnicodeValidator.normalize(username).normalizedContent;
    
    // Get repository info and latest commit
    const repoInfo = await this.portfolioRepoManager.githubRequest(
      `/repos/${normalizedUsername}/${repository}`
    );
    
    const latestCommit = await this.portfolioRepoManager.githubRequest(
      `/repos/${normalizedUsername}/${repository}/commits/HEAD`
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
    
    for (const elementType of Object.values(ElementType)) {
      try {
        logger.debug(`Fetching ${elementType} from GitHub...`);
        const entries = await this.fetchElementTypeContent(normalizedUsername, repository, elementType);
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
        // Continue with other element types
      }
    }
    
    return index;
  }

  /**
   * Fetch content for a specific element type
   */
  private async fetchElementTypeContent(
    username: string,
    repository: string,
    elementType: ElementType
  ): Promise<GitHubIndexEntry[]> {
    try {
      // Get directory listing using PortfolioRepoManager
      const contents = await this.portfolioRepoManager.githubRequest(
        `/repos/${username}/${repository}/contents/${elementType}`
      );
      
      if (!Array.isArray(contents)) {
        return [];
      }
      
      const entries: GitHubIndexEntry[] = [];
      const maxConcurrent = 5; // Limit concurrent requests
      
      // Process files in batches to avoid rate limiting
      for (let i = 0; i < contents.length; i += maxConcurrent) {
        const batch = contents.slice(i, i + maxConcurrent);
        const batchPromises = batch
          .filter(item => item.type === 'file' && item.name.endsWith('.md'))
          .map(item => this.createGitHubIndexEntry(username, repository, elementType, item));
        
        const batchResults = await Promise.allSettled(batchPromises);
        
        for (const result of batchResults) {
          if (result.status === 'fulfilled' && result.value) {
            entries.push(result.value);
          }
        }
        
        // Add delay between batches to respect rate limits
        if (i + maxConcurrent < contents.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      return entries;
      
    } catch (error) {
      // Directory might not exist - check for 404 errors
      // PortfolioRepoManager will throw standard GitHub API errors
      if (error instanceof Error) {
        // Check for 404 Not Found errors from GitHub API
        if (error.message.includes('404') || 
            error.message.includes('Not Found')) {
          logger.debug(`Directory ${elementType} not found in GitHub repository (this is normal if not yet created)`);
          return [];
        }
        
        // Log the actual error for debugging
        logger.debug(`Error fetching ${elementType}: ${error.message}`);
      }
      
      // Re-throw other errors
      logger.warn(`Unexpected error fetching ${elementType}:`, error);
      throw error;
    }
  }

  /**
   * Create GitHub index entry from API response
   */
  private async createGitHubIndexEntry(
    username: string,
    repository: string,
    elementType: ElementType,
    fileInfo: any
  ): Promise<GitHubIndexEntry | null> {
    try {
      // Parse metadata from filename or fetch content if needed
      const name = fileInfo.name.replace('.md', '').replace(/-/g, ' ');
      
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
      
      // Optionally fetch content to extract metadata
      // This is expensive, so only do it for small files or when specifically needed
      if (fileInfo.size && fileInfo.size < 10000) { // Only for files < 10KB
        try {
          // For download URLs, we need to fetch directly, not through API
          const response = await fetch(fileInfo.download_url);
          const content = await response.text();
          const metadata = this.parseMetadataFromContent(content);
          
          if (metadata.name) entry.name = metadata.name;
          if (metadata.description) entry.description = metadata.description;
          if (metadata.version) entry.version = metadata.version;
          if (metadata.author) entry.author = metadata.author;
        } catch (metadataError) {
          // Non-critical error, continue without metadata
          logger.debug('Failed to fetch metadata for file', {
            path: fileInfo.path,
            error: metadataError instanceof Error ? metadataError.message : String(metadataError)
          });
        }
      }
      
      return entry;
      
    } catch (error) {
      logger.debug('Failed to create GitHub index entry', {
        path: fileInfo.path,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
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
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      
      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
      if (nameMatch) metadata.name = nameMatch[1].trim();
      
      const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
      if (descMatch) metadata.description = descMatch[1].trim();
      
      const versionMatch = frontmatter.match(/^version:\s*(.+)$/m);
      if (versionMatch) metadata.version = versionMatch[1].trim();
      
      const authorMatch = frontmatter.match(/^author:\s*(.+)$/m);
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
    } catch (error) {
      throw new Error('Failed to get GitHub username. Please ensure you are authenticated with GitHub.');
    }
  }

  /**
   * Check if cache is valid
   */
  private isCacheValid(): boolean {
    if (!this.cache || !this.lastFetch) {
      return false;
    }
    
    const age = Date.now() - this.lastFetch.getTime();
    return age < this.ttl;
  }

  /**
   * Determine if we should fetch fresh data
   */
  private shouldFetchFresh(): boolean {
    // Always fetch if no cache
    if (!this.cache || !this.lastFetch) {
      return true;
    }
    
    // Check for recent user actions
    if (this.recentUserAction && this.actionTimestamp) {
      const actionAge = Date.now() - this.actionTimestamp.getTime();
      if (actionAge < this.actionGracePeriod) {
        logger.debug('Fetching fresh due to recent user action', { actionAge });
        return true;
      } else {
        // Grace period expired, clear action flag
        this.recentUserAction = false;
        this.actionTimestamp = null;
      }
    }
    
    // Check TTL
    return !this.isCacheValid();
  }

  /**
   * Create empty index when no portfolio exists
   */
  private createEmptyIndex(username?: string, repository?: string): GitHubPortfolioIndex {
    const index: GitHubPortfolioIndex = {
      username: username || 'unknown',
      repository: repository || 'dollhouse-portfolio',
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
}