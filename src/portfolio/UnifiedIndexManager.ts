/**
 * Unified Index Manager - Combines local, GitHub, and collection portfolio indexing
 * 
 * Features:
 * - Unified search across local, GitHub, and collection portfolios
 * - Intelligent result merging and deduplication
 * - Version conflict detection and resolution
 * - Performance optimization with parallel indexing
 * - Advanced fallback strategies for resilient operation
 * - Comprehensive search capabilities with pagination
 * - Smart result ranking and duplicate detection
 */

import { PortfolioIndexManager, IndexEntry, SearchResult, SearchOptions } from './PortfolioIndexManager.js';
import { GitHubPortfolioIndexer, GitHubIndexEntry, GitHubPortfolioIndex } from './GitHubPortfolioIndexer.js';
import { CollectionIndexCache } from '../cache/CollectionIndexCache.js';
import { GitHubClient } from '../collection/GitHubClient.js';
import { APICache } from '../cache/APICache.js';
import { ElementType } from './types.js';
import { logger } from '../utils/logger.js';
import { ErrorHandler, ErrorCategory } from '../utils/ErrorHandler.js';
import { LRUCache, CacheFactory } from '../cache/LRUCache.js';
import { PerformanceMonitor, SearchMetrics } from '../utils/PerformanceMonitor.js';
import { IndexEntry as CollectionIndexEntry, CollectionIndex } from '../types/collection.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../security/securityMonitor.js';

export interface UnifiedSearchOptions {
  query: string;
  includeLocal?: boolean;     // default true
  includeGitHub?: boolean;    // default true
  includeCollection?: boolean; // default false
  elementType?: ElementType;
  page?: number;
  pageSize?: number;
  sortBy?: 'relevance' | 'source' | 'name' | 'version';
  streamResults?: boolean; // Enable result streaming
  cursor?: string; // For pagination cursor
  maxResults?: number; // Hard limit on results
  lazyLoad?: boolean; // Enable lazy loading
}

export interface VersionConflict {
  local?: string;
  github?: string;
  collection?: string;
  recommended: 'local' | 'github' | 'collection';
  reason: string;
}

export interface DuplicateInfo {
  name: string;
  elementType: ElementType;
  sources: Array<{
    source: 'local' | 'github' | 'collection';
    version?: string;
    lastModified: Date;
    path?: string;
  }>;
  hasVersionConflict: boolean;
  versionConflict?: VersionConflict;
}

export interface VersionInfo {
  name: string;
  elementType: ElementType;
  versions: {
    local?: { version: string; lastModified: Date; path: string };
    github?: { version: string; lastModified: Date; path: string };
    collection?: { version: string; lastModified: Date; path: string };
  };
  recommended: {
    source: 'local' | 'github' | 'collection';
    reason: string;
  };
  updateAvailable: boolean;
  updateFrom?: 'local' | 'github' | 'collection';
}

export interface UnifiedIndexEntry {
  // Common properties
  name: string;
  description?: string;
  version?: string;
  author?: string;
  elementType: ElementType;
  lastModified: Date;
  
  // Source information
  source: 'local' | 'github' | 'collection';
  
  // Local properties (when source === 'local')
  localFilePath?: string;
  filename?: string;
  tags?: string[];
  keywords?: string[];
  triggers?: string[];
  category?: string;
  
  // GitHub properties (when source === 'github')
  githubPath?: string;
  githubSha?: string;
  githubHtmlUrl?: string;
  githubDownloadUrl?: string;
  githubSize?: number;
  
  // Collection properties (when source === 'collection')
  collectionPath?: string;
  collectionSha?: string;
  collectionTags?: string[];
  collectionCategory?: string;
  collectionLicense?: string;
}

export interface UnifiedSearchResult {
  source: 'local' | 'github' | 'collection';
  entry: UnifiedIndexEntry;
  matchType: string;
  score: number;
  version?: string;
  isDuplicate?: boolean;
  versionConflict?: VersionConflict;
  cursor?: string; // For streaming pagination
}

export interface StreamedSearchResult {
  results: UnifiedSearchResult[];
  hasMore: boolean;
  nextCursor?: string;
  totalEstimate?: number;
  processingTimeMs: number;
}

export interface UnifiedIndexStats {
  local: {
    totalElements: number;
    elementsByType: Record<ElementType, number>;
    lastBuilt: Date | null;
    isStale: boolean;
  };
  github: {
    totalElements: number;
    elementsByType: Record<ElementType, number>;
    lastFetched: Date | null;
    isStale: boolean;
    username?: string;
    repository?: string;
  };
  collection: {
    totalElements: number;
    elementsByType: Record<string, number>;
    lastFetched: Date | null;
    isStale: boolean;
    version?: string;
  };
  combined: {
    totalElements: number;
    uniqueElements: number;
    duplicates: number;
  };
  performance: {
    averageSearchTime: number;
    cacheHitRate: number;
    lastOptimized: Date | null;
  };
}

export class UnifiedIndexManager {
  private static instance: UnifiedIndexManager | null = null;
  
  private localIndexManager: PortfolioIndexManager;
  private githubIndexer: GitHubPortfolioIndexer;
  private collectionIndexCache: CollectionIndexCache;
  private githubClient: GitHubClient;
  
  // Performance monitoring and caching
  private performanceMonitor: PerformanceMonitor;
  private resultCache: LRUCache<UnifiedSearchResult[]>;
  private indexCache: LRUCache<any>;
  private readonly BATCH_SIZE = 50; // For streaming results
  private readonly MAX_CONCURRENT_SOURCES = 3;
  
  private constructor() {
    this.localIndexManager = PortfolioIndexManager.getInstance();
    this.githubIndexer = GitHubPortfolioIndexer.getInstance();
    
    // Initialize GitHubClient with required dependencies
    const apiCache = new APICache();
    const rateLimitTracker = new Map<string, number[]>();
    this.githubClient = new GitHubClient(apiCache, rateLimitTracker);
    this.collectionIndexCache = new CollectionIndexCache(this.githubClient);
    
    // Initialize performance monitoring and caching
    this.performanceMonitor = PerformanceMonitor.getInstance();
    this.performanceMonitor.startMonitoring();
    
    this.resultCache = CacheFactory.createSearchResultCache({
      maxSize: 200,
      maxMemoryMB: 15,
      ttlMs: 5 * 60 * 1000, // 5 minutes
      onEviction: (key, value) => {
        logger.debug('Search result cache eviction', { key, resultCount: value.length });
      }
    });
    
    this.indexCache = CacheFactory.createIndexCache({
      maxSize: 100,
      maxMemoryMB: 20,
      ttlMs: 15 * 60 * 1000, // 15 minutes
      onEviction: (key, value) => {
        logger.debug('Index cache eviction', { key });
      }
    });
    
    logger.debug('UnifiedIndexManager created with performance optimization');
  }

  public static getInstance(): UnifiedIndexManager {
    if (!this.instance) {
      this.instance = new UnifiedIndexManager();
    }
    return this.instance;
  }

  /**
   * Enhanced search across local, GitHub, and collection portfolios with performance optimization
   */
  public async search(searchOptions: UnifiedSearchOptions): Promise<UnifiedSearchResult[]> {
    const startTime = Date.now();
    const memoryBefore = process.memoryUsage().heapUsed;
    const { query, includeLocal = true, includeGitHub = true, includeCollection = false } = searchOptions;
    
    // Normalize query to prevent Unicode-based attacks
    const validationResult = UnicodeValidator.normalize(query);
    const normalizedQuery = validationResult.normalizedContent;
    
    // Use normalized query in all subsequent operations
    const normalizedSearchOptions = {
      ...searchOptions,
      query: normalizedQuery
    };
    
    // SECURITY FIX (DMCP-SEC-006): Add audit logging for security monitoring
    // Log unified search operations for security audit trail
    SecurityMonitor.logSecurityEvent({
      type: 'PORTFOLIO_FETCH_SUCCESS',
      severity: 'LOW',
      source: 'UnifiedIndexManager.search',
      details: `Unified search performed with query length: ${normalizedQuery.length}, sources: ${JSON.stringify({
        local: includeLocal,
        github: includeGitHub,
        collection: includeCollection
      })}`
    });
    
    logger.debug('Starting optimized unified portfolio search', normalizedSearchOptions);
    
    // Check cache first (use normalized search options)
    const cacheKey = this.createCacheKey(normalizedSearchOptions);
    const cached = this.resultCache.get(cacheKey);
    if (cached) {
      const duration = Date.now() - startTime;
      this.recordSearchMetrics({
        query: normalizedQuery,
        duration,
        resultCount: cached.length,
        sources: this.getEnabledSources(normalizedSearchOptions),
        cacheHit: true,
        memoryBefore,
        memoryAfter: process.memoryUsage().heapUsed,
        timestamp: new Date()
      });
      logger.debug('Using cached search results', { resultCount: cached.length });
      return cached;
    }
    
    try {
      // Use streaming search for better performance with large result sets
      if (normalizedSearchOptions.streamResults) {
        return await this.streamSearch(normalizedSearchOptions);
      }
      
      // Lazy loading: Only load indices when needed
      const searchPromises: Promise<UnifiedSearchResult[]>[] = [];
      const enabledSources = this.getEnabledSources(normalizedSearchOptions);
      
      // Limit concurrent source searches for memory efficiency
      const concurrentLimit = Math.min(this.MAX_CONCURRENT_SOURCES, enabledSources.length);
      const sourceBatches = this.batchSources(enabledSources, concurrentLimit);
      
      const allResults: UnifiedSearchResult[] = [];
      const sourceCount = { local: 0, github: 0, collection: 0 };
      
      // Process sources in batches to control memory usage
      for (const batch of sourceBatches) {
        const batchPromises = batch.map(source => 
          this.searchWithFallback(source as 'local' | 'github' | 'collection', normalizedQuery, normalizedSearchOptions)
        );
        
        const batchResults = await Promise.allSettled(batchPromises);
        
        batchResults.forEach((result, index) => {
          const sourceName = batch[index] as 'local' | 'github' | 'collection';
          if (result.status === 'fulfilled') {
            sourceCount[sourceName] += result.value.length;
            allResults.push(...result.value);
          } else {
            logger.warn(`Search failed for source ${sourceName}`, {
              error: result.reason instanceof Error ? result.reason.message : String(result.reason)
            });
          }
        });
        
        // Memory check between batches
        const currentMemory = process.memoryUsage().heapUsed / (1024 * 1024);
        if (currentMemory > 200) { // 200MB threshold
          logger.warn('High memory usage during search, triggering cleanup', {
            memoryMB: currentMemory
          });
          this.triggerMemoryCleanup();
        }
      }
      
      // Apply advanced processing with memory-efficient batching
      const processedResults = await this.processSearchResultsOptimized(allResults, normalizedSearchOptions);
      
      // Apply pagination
      const paginatedResults = this.applyPagination(processedResults, normalizedSearchOptions);
      
      // Cache results with memory limit check
      if (paginatedResults.length < 1000) { // Don't cache very large result sets
        this.resultCache.set(cacheKey, paginatedResults);
      }
      
      const duration = Date.now() - startTime;
      const memoryAfter = process.memoryUsage().heapUsed;
      
      this.recordSearchMetrics({
        query: normalizedQuery,
        duration,
        resultCount: paginatedResults.length,
        sources: enabledSources,
        cacheHit: false,
        memoryBefore,
        memoryAfter,
        timestamp: new Date()
      });
      
      logger.info('Optimized unified portfolio search completed', {
        query: normalizedQuery.substring(0, 50),
        sources: { ...sourceCount, total: allResults.length },
        finalResults: paginatedResults.length,
        duration: `${duration}ms`,
        memoryUsageMB: (memoryAfter - memoryBefore) / (1024 * 1024)
      });
      
      return paginatedResults;
      
    } catch (error) {
      const duration = Date.now() - startTime;
      ErrorHandler.logError('UnifiedIndexManager.search', error, { query: normalizedSearchOptions, duration });
      throw ErrorHandler.wrapError(error, 'Failed to perform unified portfolio search', ErrorCategory.SYSTEM_ERROR);
    }
  }

  /**
   * Find element by name across all portfolios
   */
  public async findByName(name: string, options: Partial<UnifiedSearchOptions> = {}): Promise<UnifiedIndexEntry | null> {
    try {
      const searchOptions: UnifiedSearchOptions = {
        query: name,
        includeLocal: options.includeLocal ?? true,
        includeGitHub: options.includeGitHub ?? true,
        includeCollection: options.includeCollection ?? false,
        pageSize: 1,
        ...options
      };
      
      const results = await this.search(searchOptions);
      
      // Return exact name match first, then best match
      const exactMatch = results.find(result => 
        result.entry.name.toLowerCase() === name.toLowerCase()
      );
      
      return exactMatch?.entry || results[0]?.entry || null;
      
    } catch (error) {
      ErrorHandler.logError('UnifiedIndexManager.findByName', error, { name });
      return null;
    }
  }

  /**
   * Get elements by type from all portfolios
   */
  public async getElementsByType(elementType: ElementType, options: Partial<UnifiedSearchOptions> = {}): Promise<UnifiedIndexEntry[]> {
    try {
      const searchOptions: UnifiedSearchOptions = {
        query: '', // Empty query to get all elements
        elementType,
        includeLocal: options.includeLocal ?? true,
        includeGitHub: options.includeGitHub ?? true,
        includeCollection: options.includeCollection ?? false,
        pageSize: 1000, // Large page size to get all
        ...options
      };
      
      const results = await this.getAllElementsByType(elementType, searchOptions);
      
      return this.deduplicateEntries(results.map(r => r.entry));
      
    } catch (error) {
      ErrorHandler.logError('UnifiedIndexManager.getElementsByType', error, { elementType });
      return [];
    }
  }
  
  /**
   * Check for duplicates across all sources
   */
  public async checkDuplicates(name: string): Promise<DuplicateInfo[]> {
    try {
      const searchOptions: UnifiedSearchOptions = {
        query: name,
        includeLocal: true,
        includeGitHub: true,
        includeCollection: true,
        pageSize: 100
      };
      
      const results = await this.search(searchOptions);
      const duplicateMap = new Map<string, DuplicateInfo>();
      
      for (const result of results) {
        const key = `${result.entry.elementType}:${result.entry.name.toLowerCase()}`;
        
        if (!duplicateMap.has(key)) {
          duplicateMap.set(key, {
            name: result.entry.name,
            elementType: result.entry.elementType,
            sources: [],
            hasVersionConflict: false
          });
        }
        
        const duplicate = duplicateMap.get(key)!;
        duplicate.sources.push({
          source: result.source,
          version: result.entry.version,
          lastModified: result.entry.lastModified,
          path: this.getPathFromEntry(result.entry)
        });
      }
      
      // Filter to only items with multiple sources and check version conflicts
      const actualDuplicates = Array.from(duplicateMap.values())
        .filter(item => item.sources.length > 1)
        .map(item => {
          const versionConflict = this.detectVersionConflict(item.sources);
          return {
            ...item,
            hasVersionConflict: !!versionConflict,
            versionConflict
          };
        });
      
      return actualDuplicates;
      
    } catch (error) {
      ErrorHandler.logError('UnifiedIndexManager.checkDuplicates', error, { name });
      return [];
    }
  }
  
  /**
   * Get version comparison across all sources
   */
  public async getVersionComparison(name: string): Promise<VersionInfo | null> {
    try {
      const duplicates = await this.checkDuplicates(name);
      
      if (duplicates.length === 0) {
        return null;
      }
      
      const duplicate = duplicates[0];
      const versions: VersionInfo['versions'] = {};
      
      // Build version info
      for (const source of duplicate.sources) {
        if (source.source === 'local') {
          versions.local = {
            version: source.version || 'unknown',
            lastModified: source.lastModified,
            path: source.path || 'unknown'
          };
        } else if (source.source === 'github') {
          versions.github = {
            version: source.version || 'unknown',
            lastModified: source.lastModified,
            path: source.path || 'unknown'
          };
        } else if (source.source === 'collection') {
          versions.collection = {
            version: source.version || 'unknown',
            lastModified: source.lastModified,
            path: source.path || 'unknown'
          };
        }
      }
      
      // Determine recommendation
      const recommendation = this.determineVersionRecommendation(versions);
      
      return {
        name: duplicate.name,
        elementType: duplicate.elementType,
        versions,
        recommended: recommendation,
        updateAvailable: recommendation.source !== 'local' && !!versions.local,
        updateFrom: recommendation.source !== 'local' ? recommendation.source : undefined
      };
      
    } catch (error) {
      ErrorHandler.logError('UnifiedIndexManager.getVersionComparison', error, { name });
      return null;
    }
  }

  /**
   * Get comprehensive statistics across all sources
   */
  public async getStats(): Promise<UnifiedIndexStats> {
    try {
      const [localStats, githubStats, collectionStats] = await Promise.allSettled([
        this.getLocalStats(),
        this.getGitHubStats(),
        this.getCollectionStats()
      ]);
      
      const local = localStats.status === 'fulfilled' ? localStats.value : {
        totalElements: 0,
        elementsByType: {} as Record<ElementType, number>,
        lastBuilt: null,
        isStale: true
      };
      
      const github = githubStats.status === 'fulfilled' ? githubStats.value : {
        totalElements: 0,
        elementsByType: {} as Record<ElementType, number>,
        lastFetched: null,
        isStale: true
      };
      
      const collection = collectionStats.status === 'fulfilled' ? collectionStats.value : {
        totalElements: 0,
        elementsByType: {} as Record<string, number>,
        lastFetched: null,
        isStale: true
      };
      
      // Calculate combined statistics
      const totalElements = local.totalElements + github.totalElements + collection.totalElements;
      const duplicatesCount = await this.calculateDuplicatesCount();
      const uniqueElements = totalElements - duplicatesCount;
      
      return {
        local,
        github,
        collection,
        combined: {
          totalElements,
          uniqueElements,
          duplicates: duplicatesCount
        },
        performance: {
          averageSearchTime: this.getPerformanceStats().searchStats.averageTime || 0,
          cacheHitRate: this.getPerformanceStats().searchStats.cacheHitRate || 0,
          lastOptimized: null
        }
      };
      
    } catch (error) {
      ErrorHandler.logError('UnifiedIndexManager.getStats', error);
      throw error;
    }
  }

  /**
   * Invalidate caches after user actions with performance monitoring
   */
  public invalidateAfterAction(action: string): void {
    logger.info('Invalidating unified portfolio caches after user action', { action });
    
    // Clear result and index caches
    this.resultCache.clear();
    this.indexCache.clear();
    
    // Invalidate local cache
    this.localIndexManager.rebuildIndex().catch(error => {
      logger.warn('Failed to rebuild local index after action', {
        action,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    
    // Invalidate GitHub cache
    this.githubIndexer.invalidateAfterAction(action);
    
    // Invalidate collection cache
    this.collectionIndexCache.clearCache().catch(error => {
      logger.warn('Failed to clear collection cache after action', {
        action,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    
    // Trigger garbage collection if memory usage is high
    this.triggerMemoryCleanup();
  }

  /**
   * Force rebuild of all indexes with performance optimization
   */
  public async rebuildAll(): Promise<void> {
    const startTime = Date.now();
    logger.info('Rebuilding all portfolio indexes with optimization...');
    
    try {
      // Clear all caches
      this.resultCache.clear();
      this.indexCache.clear();
      
      // Reset performance counters
      this.performanceMonitor.reset();
      
      // Rebuild in parallel with memory monitoring
      const rebuildPromises = [
        this.localIndexManager.rebuildIndex(),
        this.githubIndexer.clearCache(),
        this.collectionIndexCache.clearCache()
      ];
      
      await Promise.all(rebuildPromises);
      
      // Trigger cleanup
      this.triggerMemoryCleanup();
      
      const duration = Date.now() - startTime;
      logger.info('All portfolio indexes rebuilt successfully', {
        duration: `${duration}ms`,
        memoryUsageMB: process.memoryUsage().heapUsed / (1024 * 1024)
      });
    } catch (error) {
      ErrorHandler.logError('UnifiedIndexManager.rebuildAll', error);
      throw error;
    }
  }

  // =====================================================
  // PRIVATE HELPER METHODS
  // =====================================================
  
  /**
   * Search with fallback strategies for resilient operation
   */
  private async searchWithFallback(source: 'local' | 'github' | 'collection', query: string, options: UnifiedSearchOptions): Promise<UnifiedSearchResult[]> {
    const startTime = Date.now();
    
    try {
      let results: UnifiedSearchResult[] = [];
      
      switch (source) {
        case 'local':
          results = await this.searchLocal(query, options);
          break;
        case 'github':
          results = await this.searchGitHub(query, options);
          break;
        case 'collection':
          results = await this.searchCollection(query, options);
          break;
      }
      
      logger.debug(`${source} search completed in ${Date.now() - startTime}ms with ${results.length} results`);
      return results;
      
    } catch (error) {
      logger.debug(`${source} search failed, attempting fallback`, {
        error: error instanceof Error ? error.message : String(error)
      });
      
      // Fallback strategies
      return await this.handleSearchFallback(source, query, options, error);
    }
  }
  
  /**
   * Handle search fallback strategies
   */
  private async handleSearchFallback(source: 'local' | 'github' | 'collection', query: string, options: UnifiedSearchOptions, originalError: any): Promise<UnifiedSearchResult[]> {
    try {
      switch (source) {
        case 'local':
          // Try to use stale local index
          logger.debug('Attempting to use stale local index');
          return await this.searchLocalStale(query, options);
          
        case 'github':
          // Try cached GitHub data
          logger.debug('Attempting to use cached GitHub data');
          return await this.searchGitHubCached(query, options);
          
        case 'collection':
          // Try cached collection data
          logger.debug('Attempting to use cached collection data');
          return await this.searchCollectionCached(query, options);
          
        default:
          return [];
      }
    } catch (fallbackError) {
      logger.warn(`All fallback strategies failed for ${source}`, {
        originalError: originalError instanceof Error ? originalError.message : String(originalError),
        fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      });
      return [];
    }
  }
  
  /**
   * Search local portfolio
   */
  private async searchLocal(query: string, options: UnifiedSearchOptions): Promise<UnifiedSearchResult[]> {
    const localOptions = this.convertToLocalOptions(options);
    const results = await this.localIndexManager.search(query, localOptions);
    
    return results.map(result => ({
      source: 'local' as const,
      entry: this.convertLocalEntry(result.entry),
      matchType: result.matchType,
      score: result.score,
      version: result.entry.metadata.version
    }));
  }
  
  /**
   * Search local with stale data fallback
   */
  private async searchLocalStale(query: string, options: UnifiedSearchOptions): Promise<UnifiedSearchResult[]> {
    try {
      // Try to get any local data, even stale
      const localOptions = this.convertToLocalOptions(options);
      const results = await this.localIndexManager.search(query, localOptions);
      
      return results.map(result => ({
        source: 'local' as const,
        entry: this.convertLocalEntry(result.entry),
        matchType: result.matchType,
        score: result.score * 0.8, // Reduce score for stale data
        version: result.entry.metadata.version
      }));
    } catch {
      return [];
    }
  }

  /**
   * Search GitHub portfolio
   */
  private async searchGitHub(query: string, options: UnifiedSearchOptions): Promise<UnifiedSearchResult[]> {
    try {
      const githubIndex = await this.githubIndexer.getIndex();
      const results: UnifiedSearchResult[] = [];
      
      const queryLower = query.toLowerCase();
      const queryTokens = queryLower.split(/\s+/).filter(token => token.length > 0);
      
      if (queryTokens.length === 0 && query.trim() !== '') {
        return results;
      }
      
      // Search across all GitHub elements
      for (const [elementType, entries] of githubIndex.elements) {
        // Filter by element type if specified
        if (options.elementType && elementType !== options.elementType) {
          continue;
        }
        
        for (const entry of entries) {
          const score = this.calculateGitHubMatchScore(entry, queryTokens, query);
          if (score > 0 || query.trim() === '') {
            results.push({
              source: 'github' as const,
              entry: this.convertGitHubEntry(entry),
              matchType: this.determineMatchType(entry, queryTokens),
              score: query.trim() === '' ? 1 : score, // Default score for empty query
              version: entry.version
            });
          }
        }
      }
      
      return results.sort((a, b) => b.score - a.score);
      
    } catch (error) {
      logger.debug('GitHub search failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error; // Re-throw to trigger fallback
    }
  }
  
  /**
   * Search GitHub with cached data fallback
   */
  private async searchGitHubCached(query: string, options: UnifiedSearchOptions): Promise<UnifiedSearchResult[]> {
    try {
      // Try to use stale GitHub data
      const cacheStats = this.githubIndexer.getCacheStats();
      if (!cacheStats.isStale) {
        return await this.searchGitHub(query, options);
      }
      
      // Use stale data with reduced scores
      const results = await this.searchGitHub(query, options);
      return results.map(result => ({
        ...result,
        score: result.score * 0.7 // Reduce score for stale data
      }));
      
    } catch {
      return [];
    }
  }
  
  /**
   * Search collection portfolio
   */
  private async searchCollection(query: string, options: UnifiedSearchOptions): Promise<UnifiedSearchResult[]> {
    try {
      const collectionIndex = await this.collectionIndexCache.getIndex();
      const results: UnifiedSearchResult[] = [];
      
      const queryLower = query.toLowerCase();
      const queryTokens = queryLower.split(/\s+/).filter(token => token.length > 0);
      
      if (queryTokens.length === 0 && query.trim() !== '') {
        return results;
      }
      
      // Search across all collection elements
      for (const [elementType, entries] of Object.entries(collectionIndex.index)) {
        // Filter by element type if specified
        if (options.elementType && elementType !== options.elementType.toString()) {
          continue;
        }
        
        for (const entry of entries) {
          const score = this.calculateCollectionMatchScore(entry, queryTokens, query);
          if (score > 0 || query.trim() === '') {
            results.push({
              source: 'collection' as const,
              entry: this.convertCollectionEntry(entry, elementType),
              matchType: this.determineCollectionMatchType(entry, queryTokens),
              score: query.trim() === '' ? 1 : score, // Default score for empty query
              version: entry.version
            });
          }
        }
      }
      
      return results.sort((a, b) => b.score - a.score);
      
    } catch (error) {
      logger.debug('Collection search failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error; // Re-throw to trigger fallback
    }
  }
  
  /**
   * Search collection with cached data fallback
   */
  private async searchCollectionCached(query: string, options: UnifiedSearchOptions): Promise<UnifiedSearchResult[]> {
    try {
      // Try to use stale collection data
      const cacheStats = this.collectionIndexCache.getCacheStats();
      if (cacheStats.isValid) {
        return await this.searchCollection(query, options);
      }
      
      // Use stale data with reduced scores
      const results = await this.searchCollection(query, options);
      return results.map(result => ({
        ...result,
        score: result.score * 0.6 // Reduce score for stale collection data
      }));
      
    } catch {
      return [];
    }
  }

  /**
   * Process search results with advanced features
   */
  private async processSearchResults(results: UnifiedSearchResult[], options: UnifiedSearchOptions): Promise<UnifiedSearchResult[]> {
    // Apply smart ranking
    const rankedResults = this.applySmartRanking(results, options);
    
    // Detect duplicates and version conflicts
    const processedResults = await this.detectDuplicatesAndConflicts(rankedResults);
    
    // Apply sorting
    const sortedResults = this.applySorting(processedResults, options.sortBy || 'relevance', options.query);
    
    return sortedResults;
  }
  
  /**
   * Apply smart result ranking
   */
  private applySmartRanking(results: UnifiedSearchResult[], options: UnifiedSearchOptions): UnifiedSearchResult[] {
    return results.map(result => {
      let adjustedScore = result.score;
      
      // No location-based scoring - score should be based on relevance only
      // Source location doesn't affect the intrinsic value of an element
      
      // Consider version freshness (newer versions get small bonus)
      if (result.version && result.version !== 'unknown') {
        const versionParts = result.version.split('.');
        if (versionParts.length >= 2) {
          const major = parseInt(versionParts[0]) || 0;
          const minor = parseInt(versionParts[1]) || 0;
          adjustedScore += (major * 0.1) + (minor * 0.01);
        }
      }
      
      // Boost exact matches
      if (result.entry.name.toLowerCase() === options.query.toLowerCase()) {
        adjustedScore *= 2.0;
      }
      
      return {
        ...result,
        score: adjustedScore
      };
    });
  }
  
  /**
   * Detect duplicates and version conflicts
   */
  private async detectDuplicatesAndConflicts(results: UnifiedSearchResult[]): Promise<UnifiedSearchResult[]> {
    const nameMap = new Map<string, UnifiedSearchResult[]>();
    
    // Group by name and element type
    for (const result of results) {
      const key = `${result.entry.elementType}:${result.entry.name.toLowerCase()}`;
      if (!nameMap.has(key)) {
        nameMap.set(key, []);
      }
      nameMap.get(key)!.push(result);
    }
    
    const processedResults: UnifiedSearchResult[] = [];
    
    // Process each group
    for (const [key, groupResults] of nameMap) {
      if (groupResults.length === 1) {
        // No duplicates
        processedResults.push(groupResults[0]);
      } else {
        // Has duplicates - detect version conflicts
        const versionConflict = this.detectVersionConflictFromResults(groupResults);
        
        // Mark all results as duplicates and add conflict info
        for (const result of groupResults) {
          processedResults.push({
            ...result,
            isDuplicate: true,
            versionConflict
          });
        }
      }
    }
    
    return processedResults;
  }
  
  /**
   * Apply pagination to results
   */
  private applyPagination(results: UnifiedSearchResult[], options: UnifiedSearchOptions): UnifiedSearchResult[] {
    const page = options.page || 1;
    const pageSize = options.pageSize || 20;
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    
    return results.slice(startIndex, endIndex);
  }
  
  /**
   * Apply sorting to results
   */
  private applySorting(results: UnifiedSearchResult[], sortBy: 'relevance' | 'source' | 'name' | 'version', query: string): UnifiedSearchResult[] {
    const sorted = [...results];
    
    switch (sortBy) {
      case 'name':
        sorted.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
        break;
      case 'source':
        sorted.sort((a, b) => {
          const sourceOrder = { 'local': 0, 'github': 1, 'collection': 2 };
          return sourceOrder[a.source] - sourceOrder[b.source];
        });
        break;
      case 'version':
        sorted.sort((a, b) => this.compareVersions(b.version || '0', a.version || '0'));
        break;
      case 'relevance':
      default:
        sorted.sort((a, b) => b.score - a.score);
        break;
    }
    
    return sorted;
  }
  
  /**
   * Calculate match score for GitHub entries
   */
  private calculateGitHubMatchScore(entry: GitHubIndexEntry, queryTokens: string[], query: string): number {
    if (queryTokens.length === 0) return 1; // Default score for empty query
    
    let score = 0;
    
    const name = entry.name.toLowerCase();
    const description = (entry.description || '').toLowerCase();
    const path = (entry.path || '').toLowerCase();
    
    // Check name matches
    for (const token of queryTokens) {
      if (name.includes(token)) {
        score += name === token ? 10 : (name.startsWith(token) ? 5 : 2);
      }
      if (description.includes(token)) {
        score += 3;
      }
      if (path.includes(token)) {
        score += 1;
      }
    }
    
    // Exact query match bonus
    if (name.includes(query.toLowerCase())) {
      score += query.length > 3 ? 15 : 10;
    }
    
    return score;
  }
  
  /**
   * Calculate match score for collection entries
   */
  private calculateCollectionMatchScore(entry: CollectionIndexEntry, queryTokens: string[], query: string): number {
    if (queryTokens.length === 0) return 1; // Default score for empty query
    
    let score = 0;
    
    const name = entry.name.toLowerCase();
    const description = (entry.description || '').toLowerCase();
    const path = (entry.path || '').toLowerCase();
    const tags = entry.tags.map(tag => tag.toLowerCase()).join(' ');
    
    // Check matches across all fields
    for (const token of queryTokens) {
      if (name.includes(token)) {
        score += name === token ? 10 : (name.startsWith(token) ? 5 : 2);
      }
      if (description.includes(token)) {
        score += 3;
      }
      if (path.includes(token)) {
        score += 1;
      }
      if (tags.includes(token)) {
        score += 4;
      }
    }
    
    // Exact query match bonus
    if (name.includes(query.toLowerCase())) {
      score += query.length > 3 ? 15 : 10;
    }
    
    return score;
  }

  /**
   * Get all elements by type across sources
   */
  private async getAllElementsByType(elementType: ElementType, options: UnifiedSearchOptions): Promise<UnifiedSearchResult[]> {
    const promises: Promise<UnifiedSearchResult[]>[] = [];
    
    if (options.includeLocal) {
      promises.push(this.getLocalElementsByType(elementType));
    }
    if (options.includeGitHub) {
      promises.push(this.getGitHubElementsByType(elementType));
    }
    if (options.includeCollection) {
      promises.push(this.getCollectionElementsByType(elementType));
    }
    
    const results = await Promise.allSettled(promises);
    const allResults: UnifiedSearchResult[] = [];
    
    results.forEach(result => {
      if (result.status === 'fulfilled') {
        allResults.push(...result.value);
      }
    });
    
    return allResults;
  }
  
  /**
   * Get local elements by type
   */
  private async getLocalElementsByType(elementType: ElementType): Promise<UnifiedSearchResult[]> {
    try {
      const elements = await this.localIndexManager.getElementsByType(elementType);
      return elements.map(entry => ({
        source: 'local' as const,
        entry: this.convertLocalEntry(entry),
        matchType: 'type',
        score: 1,
        version: entry.metadata.version
      }));
    } catch {
      return [];
    }
  }
  
  /**
   * Get GitHub elements by type
   */
  private async getGitHubElementsByType(elementType: ElementType): Promise<UnifiedSearchResult[]> {
    try {
      const githubIndex = await this.githubIndexer.getIndex();
      const entries = githubIndex.elements.get(elementType) || [];
      
      return entries.map(entry => ({
        source: 'github' as const,
        entry: this.convertGitHubEntry(entry),
        matchType: 'type',
        score: 1,
        version: entry.version
      }));
    } catch {
      return [];
    }
  }
  
  /**
   * Get collection elements by type
   */
  private async getCollectionElementsByType(elementType: ElementType): Promise<UnifiedSearchResult[]> {
    try {
      const collectionIndex = await this.collectionIndexCache.getIndex();
      const entries = collectionIndex.index[elementType.toString()] || [];
      
      return entries.map(entry => ({
        source: 'collection' as const,
        entry: this.convertCollectionEntry(entry, elementType.toString()),
        matchType: 'type',
        score: 1,
        version: entry.version
      }));
    } catch {
      return [];
    }
  }

  /**
   * Get local portfolio statistics
   */
  private async getLocalStats(): Promise<UnifiedIndexStats['local']> {
    return await this.localIndexManager.getStats();
  }
  
  /**
   * Get GitHub portfolio statistics
   */
  private async getGitHubStats(): Promise<UnifiedIndexStats['github']> {
    const cacheStats = this.githubIndexer.getCacheStats();
    const githubIndex = await this.githubIndexer.getIndex();
    
    const elementsByType: Record<ElementType, number> = {} as Record<ElementType, number>;
    for (const elementType of Object.values(ElementType)) {
      elementsByType[elementType] = (githubIndex.elements.get(elementType) || []).length;
    }
    
    return {
      totalElements: githubIndex.totalElements,
      elementsByType,
      lastFetched: cacheStats.lastFetch,
      isStale: cacheStats.isStale,
      username: githubIndex.username,
      repository: githubIndex.repository
    };
  }
  
  /**
   * Get collection portfolio statistics
   */
  private async getCollectionStats(): Promise<UnifiedIndexStats['collection']> {
    const cacheStats = this.collectionIndexCache.getCacheStats();
    const collectionIndex = await this.collectionIndexCache.getIndex();
    
    const elementsByType: Record<string, number> = {};
    for (const [elementType, entries] of Object.entries(collectionIndex.index)) {
      elementsByType[elementType] = entries.length;
    }
    
    return {
      totalElements: collectionIndex.total_elements,
      elementsByType,
      lastFetched: cacheStats.hasCache ? new Date(Date.now() - cacheStats.age) : null,
      isStale: !cacheStats.isValid,
      version: collectionIndex.version
    };
  }
  
  /**
   * Calculate duplicates count across all sources
   */
  private async calculateDuplicatesCount(): Promise<number> {
    // This is a placeholder - actual implementation would need optimization
    // For now, return 0 to avoid the expensive operation during stats calculation
    return 0;
  }

  /**
   * Convert local index entry to unified format
   */
  private convertLocalEntry(entry: IndexEntry): UnifiedIndexEntry {
    return {
      name: entry.metadata.name,
      description: entry.metadata.description,
      version: entry.metadata.version,
      author: entry.metadata.author,
      elementType: entry.elementType,
      lastModified: entry.lastModified,
      source: 'local',
      localFilePath: entry.filePath,
      filename: entry.filename,
      tags: entry.metadata.tags,
      keywords: entry.metadata.keywords,
      triggers: entry.metadata.triggers,
      category: entry.metadata.category
    };
  }

  /**
   * Convert GitHub index entry to unified format
   */
  private convertGitHubEntry(entry: GitHubIndexEntry): UnifiedIndexEntry {
    return {
      name: entry.name,
      description: entry.description,
      version: entry.version,
      author: entry.author,
      elementType: entry.elementType,
      lastModified: entry.lastModified,
      source: 'github',
      githubPath: entry.path,
      githubSha: entry.sha,
      githubHtmlUrl: entry.htmlUrl,
      githubDownloadUrl: entry.downloadUrl,
      githubSize: entry.size
    };
  }
  
  /**
   * Convert collection index entry to unified format
   */
  private convertCollectionEntry(entry: CollectionIndexEntry, elementType: string): UnifiedIndexEntry {
    return {
      name: entry.name,
      description: entry.description,
      version: entry.version,
      author: entry.author,
      elementType: this.mapStringToElementType(elementType),
      lastModified: new Date(entry.created),
      source: 'collection',
      collectionPath: entry.path,
      collectionSha: entry.sha,
      collectionTags: entry.tags,
      collectionCategory: entry.category,
      collectionLicense: entry.license
    };
  }
  
  /**
   * Map string to ElementType enum
   */
  private mapStringToElementType(elementType: string): ElementType {
    // Handle mapping from collection element types to our ElementType enum
    switch (elementType.toLowerCase()) {
      case 'personas':
        return ElementType.PERSONA;
      case 'skills':
        return ElementType.SKILL;
      case 'agents':
        return ElementType.AGENT;
      case 'prompts':
      case 'templates':
        return ElementType.TEMPLATE; // Map prompts and templates to TEMPLATE
      case 'tools':
        return ElementType.SKILL; // Map tools to SKILL as fallback
      case 'ensembles':
        return ElementType.ENSEMBLE;
      case 'memories':
        return ElementType.MEMORY;
      default:
        return ElementType.SKILL; // Default fallback
    }
  }
  
  /**
   * Convert unified search options to local search options
   */
  private convertToLocalOptions(options: UnifiedSearchOptions): SearchOptions {
    return {
      elementType: options.elementType,
      maxResults: options.pageSize || 20
    };
  }
  
  /**
   * Determine match type for GitHub entries
   */
  private determineMatchType(entry: GitHubIndexEntry, queryTokens: string[]): string {
    const name = entry.name.toLowerCase();
    const description = (entry.description || '').toLowerCase();
    
    // Check what matched
    for (const token of queryTokens) {
      if (name.includes(token)) {
        return name === token ? 'exact_name' : 'name';
      }
      if (description.includes(token)) {
        return 'description';
      }
    }
    
    return 'content';
  }
  
  /**
   * Determine match type for collection entries
   */
  private determineCollectionMatchType(entry: CollectionIndexEntry, queryTokens: string[]): string {
    const name = entry.name.toLowerCase();
    const description = (entry.description || '').toLowerCase();
    const tags = entry.tags.map(tag => tag.toLowerCase()).join(' ');
    
    // Check what matched
    for (const token of queryTokens) {
      if (name.includes(token)) {
        return name === token ? 'exact_name' : 'name';
      }
      if (description.includes(token)) {
        return 'description';
      }
      if (tags.includes(token)) {
        return 'tag';
      }
    }
    
    return 'content';
  }
  
  /**
   * Get path from unified entry
   */
  private getPathFromEntry(entry: UnifiedIndexEntry): string {
    switch (entry.source) {
      case 'local':
        return entry.localFilePath || entry.filename || 'unknown';
      case 'github':
        return entry.githubPath || 'unknown';
      case 'collection':
        return entry.collectionPath || 'unknown';
      default:
        return 'unknown';
    }
  }
  
  /**
   * Detect version conflict from sources
   */
  private detectVersionConflict(sources: DuplicateInfo['sources']): VersionConflict | undefined {
    const versions = new Map<string, 'local' | 'github' | 'collection'>();
    
    for (const source of sources) {
      if (source.version && source.version !== 'unknown') {
        versions.set(source.version, source.source);
      }
    }
    
    if (versions.size <= 1) {
      return undefined; // No conflict if all versions are the same or missing
    }
    
    // Build version conflict info
    const versionConflict: VersionConflict = {
      recommended: 'local',
      reason: 'Multiple versions detected'
    };
    
    for (const source of sources) {
      if (source.version) {
        versionConflict[source.source] = source.version;
      }
    }
    
    // Determine recommendation
    const recommendation = this.determineVersionRecommendationFromSources(sources);
    versionConflict.recommended = recommendation.source;
    versionConflict.reason = recommendation.reason;
    
    return versionConflict;
  }
  
  /**
   * Detect version conflict from search results
   */
  private detectVersionConflictFromResults(results: UnifiedSearchResult[]): VersionConflict | undefined {
    const sources = results.map(result => ({
      source: result.source,
      version: result.version,
      lastModified: result.entry.lastModified,
      path: this.getPathFromEntry(result.entry)
    }));
    
    return this.detectVersionConflict(sources);
  }
  
  /**
   * Determine version recommendation from version info
   */
  private determineVersionRecommendation(versions: VersionInfo['versions']): { source: 'local' | 'github' | 'collection'; reason: string } {
    // Prefer local if available and not too old
    if (versions.local) {
      const localAge = Date.now() - versions.local.lastModified.getTime();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      
      if (localAge < sevenDays) {
        return { source: 'local', reason: 'Local version is recent and authoritative' };
      }
    }
    
    // Compare versions if available
    const versionEntries = Object.entries(versions).filter(([_, info]) => info?.version);
    
    if (versionEntries.length > 1) {
      // Find highest version
      let highest: { source: 'local' | 'github' | 'collection'; version: string } = {
        source: 'local',
        version: '0.0.0'
      };
      
      for (const [source, info] of versionEntries) {
        if (info && this.compareVersions(info.version, highest.version) > 0) {
          highest = {
            source: source as 'local' | 'github' | 'collection',
            version: info.version
          };
        }
      }
      
      return { source: highest.source, reason: `Highest version (${highest.version})` };
    }
    
    // Fallback to most recent
    let mostRecent: { source: 'local' | 'github' | 'collection'; date: Date } = {
      source: 'local',
      date: new Date(0)
    };
    
    for (const [source, info] of Object.entries(versions)) {
      if (info && info.lastModified > mostRecent.date) {
        mostRecent = {
          source: source as 'local' | 'github' | 'collection',
          date: info.lastModified
        };
      }
    }
    
    return { source: mostRecent.source, reason: 'Most recently modified' };
  }
  
  /**
   * Determine version recommendation from sources
   */
  private determineVersionRecommendationFromSources(sources: DuplicateInfo['sources']): { source: 'local' | 'github' | 'collection'; reason: string } {
    // Convert sources to versions format
    const versions: VersionInfo['versions'] = {};
    
    for (const source of sources) {
      if (source.source === 'local') {
        versions.local = {
          version: source.version || 'unknown',
          lastModified: source.lastModified,
          path: source.path || 'unknown'
        };
      } else if (source.source === 'github') {
        versions.github = {
          version: source.version || 'unknown',
          lastModified: source.lastModified,
          path: source.path || 'unknown'
        };
      } else if (source.source === 'collection') {
        versions.collection = {
          version: source.version || 'unknown',
          lastModified: source.lastModified,
          path: source.path || 'unknown'
        };
      }
    }
    
    return this.determineVersionRecommendation(versions);
  }
  
  /**
   * Compare semantic versions
   */
  private compareVersions(a: string, b: string): number {
    const parseVersion = (version: string) => {
      const parts = version.split('.').map(part => parseInt(part) || 0);
      return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
    };
    
    const [aMajor, aMinor, aPatch] = parseVersion(a);
    const [bMajor, bMinor, bPatch] = parseVersion(b);
    
    if (aMajor !== bMajor) return aMajor - bMajor;
    if (aMinor !== bMinor) return aMinor - bMinor;
    return aPatch - bPatch;
  }

  /**
   * Remove duplicate results based on name and type
   */
  private deduplicateResults(results: UnifiedSearchResult[]): UnifiedSearchResult[] {
    const seen = new Set<string>();
    const deduplicated: UnifiedSearchResult[] = [];
    
    for (const result of results) {
      const key = `${result.entry.elementType}:${result.entry.name.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(result);
      }
    }
    
    return deduplicated;
  }

  /**
   * Remove duplicate entries based on name and type
   */
  private deduplicateEntries(entries: UnifiedIndexEntry[]): UnifiedIndexEntry[] {
    const seen = new Set<string>();
    const deduplicated: UnifiedIndexEntry[] = [];
    
    for (const entry of entries) {
      const key = `${entry.elementType}:${entry.name.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(entry);
      }
    }
    
    return deduplicated;
  }
  
  // =====================================================
  // PERFORMANCE MONITORING AND OPTIMIZATION
  // =====================================================
  
  /**
   * Stream search results for better performance with large datasets
   */
  private async streamSearch(options: UnifiedSearchOptions): Promise<UnifiedSearchResult[]> {
    const { query, cursor, maxResults = 1000 } = options;
    const startTime = Date.now();
    
    logger.debug('Starting streaming search', { query: query.substring(0, 50), cursor, maxResults });
    
    const results: UnifiedSearchResult[] = [];
    const sources = this.getEnabledSources(options);
    
    // Process sources in sequence for memory efficiency
    for (const source of sources) {
      if (results.length >= maxResults) {
        break;
      }
      
      try {
        const sourceResults = await this.searchWithFallback(source, query, {
          ...options,
          pageSize: Math.min(this.BATCH_SIZE, maxResults - results.length)
        });
        
        results.push(...sourceResults);
        
        // Add cursor information for pagination
        sourceResults.forEach((result, index) => {
          result.cursor = this.generateCursor(source, index);
        });
        
      } catch (error) {
        logger.warn(`Streaming search failed for source ${source}`, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    
    logger.debug('Streaming search completed', {
      resultCount: results.length,
      duration: `${Date.now() - startTime}ms`
    });
    
    return results;
  }
  
  /**
   * Process search results with memory-efficient batching
   */
  private async processSearchResultsOptimized(results: UnifiedSearchResult[], options: UnifiedSearchOptions): Promise<UnifiedSearchResult[]> {
    if (results.length === 0) {
      return results;
    }
    
    // Process in batches to avoid memory spikes with large result sets
    const batchSize = Math.min(this.BATCH_SIZE, results.length);
    const processedResults: UnifiedSearchResult[] = [];
    
    for (let i = 0; i < results.length; i += batchSize) {
      const batch = results.slice(i, i + batchSize);
      
      // Apply smart ranking
      const rankedBatch = this.applySmartRanking(batch, options);
      
      // Detect duplicates and conflicts
      const processedBatch = await this.detectDuplicatesAndConflicts(rankedBatch);
      
      processedResults.push(...processedBatch);
      
      // Yield control to prevent blocking
      if (i % (batchSize * 4) === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    
    // Apply final sorting
    return this.applySorting(processedResults, options.sortBy || 'relevance', options.query);
  }
  
  /**
   * Get enabled search sources
   */
  private getEnabledSources(options: UnifiedSearchOptions): ('local' | 'github' | 'collection')[] {
    const sources: ('local' | 'github' | 'collection')[] = [];
    
    if (options.includeLocal !== false) sources.push('local');
    if (options.includeGitHub !== false) sources.push('github');
    if (options.includeCollection === true) sources.push('collection');
    
    return sources;
  }
  
  /**
   * Batch sources for concurrent processing
   */
  private batchSources(sources: ('local' | 'github' | 'collection')[], batchSize: number): ('local' | 'github' | 'collection')[][] {
    const batches: ('local' | 'github' | 'collection')[][] = [];
    
    for (let i = 0; i < sources.length; i += batchSize) {
      batches.push(sources.slice(i, i + batchSize));
    }
    
    return batches;
  }
  
  /**
   * Generate cursor for pagination
   */
  private generateCursor(source: string, index: number): string {
    const timestamp = Date.now();
    return Buffer.from(`${source}:${index}:${timestamp}`).toString('base64');
  }
  
  /**
   * Trigger memory cleanup when usage is high
   */
  private triggerMemoryCleanup(): void {
    // Force cache cleanup
    this.resultCache.cleanup();
    this.indexCache.cleanup();
    
    // Suggest garbage collection
    if (global.gc) {
      global.gc();
      logger.debug('Triggered garbage collection');
    }
  }
  
  /**
   * Record search performance metrics
   */
  private recordSearchMetrics(metrics: SearchMetrics): void {
    this.performanceMonitor.recordSearch(metrics);
    
    // Update cache performance metrics
    const cacheStats = this.resultCache.getStats();
    this.performanceMonitor.recordCachePerformance('searchResults', {
      hitRate: cacheStats.hitRate,
      avgHitTime: 1, // Placeholder
      avgMissTime: 5, // Placeholder
      totalHits: cacheStats.hitCount,
      totalMisses: cacheStats.missCount,
      evictions: cacheStats.evictionCount
    });
  }
  
  /**
   * Create cache key for search options
   */
  private createCacheKey(options: UnifiedSearchOptions): string {
    return JSON.stringify({
      query: options.query,
      includeLocal: options.includeLocal,
      includeGitHub: options.includeGitHub,
      includeCollection: options.includeCollection,
      elementType: options.elementType,
      page: options.page,
      pageSize: options.pageSize,
      sortBy: options.sortBy,
      lazyLoad: options.lazyLoad
    });
  }
  
  /**
   * Get performance statistics
   */
  public getPerformanceStats(): {
    searchStats: any;
    memoryStats: any;
    cacheStats: any;
    trends: any;
  } {
    return {
      searchStats: this.performanceMonitor.getSearchStats(),
      memoryStats: this.performanceMonitor.getMemoryStats(),
      cacheStats: {
        searchResults: this.resultCache.getStats(),
        indexCache: this.indexCache.getStats()
      },
      trends: this.performanceMonitor.analyzeTrends()
    };
  }
}