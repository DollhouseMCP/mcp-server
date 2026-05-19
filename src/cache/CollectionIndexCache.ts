/**
 * Smart cache for collection index with conditional fetching and performance optimization
 */

import * as path from 'path';
import { CollectionIndex, CachedIndex } from '../types/collection.js';
import { logger } from '../utils/logger.js';
import { GitHubClient } from '../collection/GitHubClient.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { LRUCache, CacheFactory } from './LRUCache.js';
import { PerformanceMonitor } from '../utils/PerformanceMonitor.js';
import { IFileOperationsService } from '../services/FileOperationsService.js';
import type { ISharedCacheStore } from '../storage/sharedCache/ISharedCacheStore.js';

export interface CollectionIndexCacheConfig {
  githubClient: GitHubClient;
  baseDir: string;
  performanceMonitor: PerformanceMonitor;
  fileOperations: IFileOperationsService;
  /**
   * Optional shared-cache store. When present, the disk-cache load/save/clear
   * paths route through it instead of `<baseDir>/.dollhousemcp/cache/...`.
   * Falls back to the legacy direct-file path when null (covers unit tests
   * that skip the DI bootstrap).
   *
   * Parallel to `CollectionIndexManager.config.cache` — Phase H's original
   * scope wired CollectionIndexManager but missed this sibling cache, which
   * `CollectionSearch.searchFromIndex` exercises via the
   * `search_collection_enhanced` MCP operation.
   */
  cache?: ISharedCacheStore;
}

export class CollectionIndexCache {
  private static readonly CACHE_KEY = 'collection-index-cache';

  private cache: CachedIndex | null = null;
  private readonly TTL = 15 * 60 * 1000; // 15 minutes in milliseconds
  private readonly INDEX_URL = 'https://dollhousemcp.github.io/collection/collection-index.json';
  private cacheDir: string;
  private cacheFile: string;
  private githubClient: GitHubClient;
  private performanceMonitor: PerformanceMonitor;
  private memoryCache: LRUCache<any>;
  private fetchPromise: Promise<CollectionIndex> | null = null; // Prevent concurrent fetches

  // File operations service for secure file I/O
  private readonly fileOperations: IFileOperationsService;
  // Phase 4.5: shared-cache store. When set, takes precedence over the
  // legacy filesystem cacheFile path. Null when running outside the DI
  // bootstrap (some unit tests).
  private readonly sharedCache: ISharedCacheStore | null;

  /**
   * Two construction signatures supported for backwards compatibility:
   *
   * 1. **Legacy positional** (`githubClient, baseDir, performanceMonitor,
   *    fileOperations`) — used by existing call sites and tests.
   * 2. **Config-object** (`CollectionIndexCacheConfig`) — used by DI
   *    registration so the optional `cache: ISharedCacheStore` can be
   *    threaded in without breaking the positional callers.
   *
   * Detect via duck-typing on the first arg.
   */
  constructor(config: CollectionIndexCacheConfig);
  constructor(
    githubClient: GitHubClient,
    baseDir: string,
    performanceMonitor: PerformanceMonitor,
    fileOperations: IFileOperationsService,
  );
  constructor(
    arg0: CollectionIndexCacheConfig | GitHubClient,
    baseDir?: string,
    performanceMonitor?: PerformanceMonitor,
    fileOperations?: IFileOperationsService,
  ) {
    if (arg0 && typeof arg0 === 'object' && 'githubClient' in arg0) {
      this.githubClient = arg0.githubClient;
      this.cacheDir = path.join(arg0.baseDir, '.dollhousemcp', 'cache');
      this.cacheFile = path.join(this.cacheDir, 'collection-index-cache.json');
      this.performanceMonitor = arg0.performanceMonitor;
      this.fileOperations = arg0.fileOperations;
      this.sharedCache = arg0.cache ?? null;
    } else {
      this.githubClient = arg0 as GitHubClient;
      this.cacheDir = path.join(baseDir!, '.dollhousemcp', 'cache');
      this.cacheFile = path.join(this.cacheDir, 'collection-index-cache.json');
      this.performanceMonitor = performanceMonitor!;
      this.fileOperations = fileOperations!;
      this.sharedCache = null;
    }

    // Initialize memory cache for frequently accessed data
    this.memoryCache = CacheFactory.createAPICache({
      maxSize: 50,
      maxMemoryMB: 10,
      ttlMs: 5 * 60 * 1000, // 5 minutes
      onEviction: (key, _value) => {
        logger.debug('Collection memory cache eviction', { key });
      }
    });

    logger.debug('CollectionIndexCache initialized', {
      ttlMs: this.TTL,
      cacheBackend: this.sharedCache ? 'shared-cache-store' : 'filesystem-direct',
      cacheTarget: this.sharedCache ? `(store: ${CollectionIndexCache.CACHE_KEY})` : this.cacheFile,
    });
  }
  
  /**
   * Get the collection index with performance optimization and lazy loading
   */
  async getIndex(lazyLoad: boolean = false): Promise<CollectionIndex> {
    const startTime = Date.now();
    const memoryBefore = process.memoryUsage().heapUsed;
    
    try {
      // Check memory cache first for fastest access
      const memoryCached = this.memoryCache.get('collection-index');
      if (memoryCached && this.isValid()) {
        logger.debug('Using memory cached collection index');
        this.recordPerformanceMetrics(startTime, memoryBefore, 'memory-hit');
        return memoryCached;
      }
      
      // Check if we have valid disk cached data
      if (this.isValid()) {
        logger.debug('Using valid disk cached collection index');
        const result = this.cache!.data;
        this.memoryCache.set('collection-index', result);
        this.recordPerformanceMetrics(startTime, memoryBefore, 'disk-hit');
        return result;
      }
      
      // Prevent concurrent fetches
      if (this.fetchPromise) {
        logger.debug('Waiting for ongoing collection index fetch');
        return await this.fetchPromise;
      }
      
      // Lazy loading: Only fetch if not in lazy mode or absolutely necessary
      if (lazyLoad && this.cache?.data) {
        logger.debug('Using stale cache in lazy load mode');
        this.recordPerformanceMetrics(startTime, memoryBefore, 'lazy-stale');
        return this.cache.data;
      }
      
      // Create fetch promise to prevent concurrent requests
      this.fetchPromise = this.fetchFreshWithFallback();
      
      try {
        const result = await this.fetchPromise;
        this.memoryCache.set('collection-index', result);
        this.recordPerformanceMetrics(startTime, memoryBefore, 'fresh-fetch');
        return result;
      } finally {
        this.fetchPromise = null;
      }
      
    } catch (error) {
      logger.error('Failed to get collection index:', error);
      
      // Try loading from persistent cache as last resort
      const persistentCache = await this.loadFromDisk();
      if (persistentCache) {
        logger.debug('Using persistent cache as last resort');
        this.cache = persistentCache;
        const result = persistentCache.data;
        this.memoryCache.set('collection-index', result);
        this.recordPerformanceMetrics(startTime, memoryBefore, 'disk-fallback');
        return result;
      }
      
      throw error;
    }
  }
  
  /**
   * Check if current cache is valid (within TTL)
   */
  private isValid(): boolean {
    if (!this.cache) {
      return false;
    }
    
    const age = Date.now() - this.cache.fetchedAt.getTime();
    return age < this.TTL;
  }
  
  /**
   * Fetch fresh index from GitHub with conditional requests
   */
  private async fetchFresh(): Promise<CollectionIndex | null> {
    try {
      // Build headers for conditional request
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        'User-Agent': 'DollhouseMCP/1.0'
      };
      
      // Add conditional headers if we have cache
      if (this.cache?.etag) {
        headers['If-None-Match'] = this.cache.etag;
      }
      if (this.cache?.lastModified) {
        headers['If-Modified-Since'] = this.cache.lastModified;
      }
      
      // Use fetch directly for better control over conditional requests
      const response = await fetch(this.INDEX_URL, { headers });
      
      // 304 Not Modified - use cached data
      if (response.status === 304) {
        if (this.cache) {
          // Update timestamp to extend cache validity
          this.cache.fetchedAt = new Date();
          await this.saveToDisk(this.cache);
          logger.debug('Collection index not modified - refreshed cache timestamp');
          return this.cache.data;
        }
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const indexData = await response.json() as CollectionIndex;
      
      // Validate the index structure
      if (!this.validateIndexStructure(indexData)) {
        throw new Error('Invalid collection index structure received');
      }
      
      // Create new cache entry
      const newCache: CachedIndex = {
        data: indexData,
        fetchedAt: new Date(),
        etag: response.headers.get('etag') || undefined,
        lastModified: response.headers.get('last-modified') || undefined
      };
      
      this.cache = newCache;
      
      // Save to persistent cache in background
      this.saveToDisk(newCache).catch(error => {
        logger.debug('Failed to save index cache to disk:', error);
      });
      
      logger.debug(`Fresh collection index fetched with ${indexData.total_elements} elements`);
      return indexData;
      
    } catch (error) {
      logger.debug('Failed to fetch fresh collection index:', error);
      return null;
    }
  }
  
  /**
   * Validate the structure of a collection index
   */
  private validateIndexStructure(index: any): index is CollectionIndex {
    return (
      index &&
      typeof index === 'object' &&
      typeof index.version === 'string' &&
      typeof index.generated === 'string' &&
      typeof index.total_elements === 'number' &&
      index.index &&
      typeof index.index === 'object' &&
      index.metadata &&
      typeof index.metadata === 'object'
    );
  }
  
  /**
   * Save cache to persistent storage. When a shared-cache store is wired,
   * routes through it (Postgres or filesystem-backed per the storage
   * backend). Otherwise falls back to the legacy direct-file path under
   * `<baseDir>/.dollhousemcp/cache/`.
   *
   * Earlier shape swallowed write errors silently — that hid the read-only-root
   * container failure on the PoC. Now logs at warn for store failures so
   * operators see when persistence isn't actually happening; still doesn't
   * throw, since cache persistence is best-effort.
   */
  private async saveToDisk(cache: CachedIndex): Promise<void> {
    if (this.sharedCache) {
      try {
        const expiresAt = cache.fetchedAt.getTime() + this.TTL;
        // SharedCacheWriteEntry: fetchedAt is stamped by the implementation,
        // so we don't pass it on the write side; expiresAt drives TTL.
        await this.sharedCache.set({
          cacheKey: CollectionIndexCache.CACHE_KEY,
          payload: cache.data as unknown as Record<string, unknown>,
          etag: cache.etag,
          lastModified: cache.lastModified,
          expiresAt,
        });
        logger.debug('Collection index cache saved via shared-cache store');
      } catch (error) {
        // Surface store failures at warn so operators see when persistence
        // isn't happening — the legacy code swallowed silently, which hid
        // the read-only-root container failure on the PoC.
        logger.warn('[CollectionIndexCache] failed to save via shared-cache store', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    try {
      await this.ensureCacheDir();

      const cacheData = {
        ...cache,
        fetchedAt: cache.fetchedAt.toISOString() // Serialize date
      };

      const data = JSON.stringify(cacheData, null, 2);
      await this.fileOperations.writeFile(this.cacheFile, data, {
        source: 'CollectionIndexCache.saveToDisk'
      });

      logger.debug('Collection index cache saved to disk');
    } catch (error) {
      logger.warn('[CollectionIndexCache] failed to save to disk', {
        error: error instanceof Error ? error.message : String(error),
        path: this.cacheFile,
      });
      // Don't throw - cache persistence failures shouldn't break functionality
    }
  }

  /**
   * Load cache from persistent storage. Mirrors `saveToDisk`'s branching:
   * shared-cache store when wired, else the legacy file path.
   */
  private async loadFromDisk(): Promise<CachedIndex | null> {
    if (this.sharedCache) {
      try {
        const entry = await this.sharedCache.get(CollectionIndexCache.CACHE_KEY);
        if (!entry) return null;
        return {
          data: entry.payload as unknown as CollectionIndex,
          fetchedAt: new Date(entry.fetchedAt),
          etag: entry.etag,
          lastModified: entry.lastModified,
        };
      } catch (error) {
        logger.debug('[CollectionIndexCache] shared-cache load failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }

    try {
      // Basic security check for path traversal
      if (this.cacheFile.includes('..') || this.cacheFile.includes('\0')) {
        SecurityMonitor.logSecurityEvent({
          type: 'PATH_TRAVERSAL_ATTEMPT',
          severity: 'HIGH',
          source: 'CollectionIndexCache.loadFromDisk',
          details: `Potential path traversal attempt detected: ${this.cacheFile.substring(0, 100)}`
        });
        return null;
      }

      const data = await this.fileOperations.readFile(this.cacheFile, {
        source: 'CollectionIndexCache.loadFromDisk'
      });
      const cacheData = JSON.parse(data);

      return {
        ...cacheData,
        fetchedAt: new Date(cacheData.fetchedAt) // Deserialize date
      };
    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        logger.debug('Failed to load collection index cache from disk:', error);
      }
      return null;
    }
  }
  
  /**
   * Ensure cache directory exists
   */
  private async ensureCacheDir(): Promise<void> {
    try {
      await this.fileOperations.createDirectory(this.cacheDir);
    } catch (error) {
      logger.error('Failed to create cache directory:', error);
      throw error;
    }
  }
  
  /**
   * Clear all cache data with performance monitoring
   */
  async clearCache(): Promise<void> {
    const startTime = Date.now();

    this.cache = null;
    this.memoryCache.clear();

    // Cancel any ongoing fetch
    this.fetchPromise = null;

    if (this.sharedCache) {
      try {
        await this.sharedCache.delete(CollectionIndexCache.CACHE_KEY);
        logger.debug('Collection index cache cleared from shared-cache store');
      } catch (error) {
        logger.debug('[CollectionIndexCache] shared-cache delete failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      try {
        await this.fileOperations.deleteFile(this.cacheFile, undefined, {
          source: 'CollectionIndexCache.clearCache'
        });
        logger.debug('Collection index cache cleared from disk');
      } catch (error) {
        if ((error as any).code !== 'ENOENT') {
          logger.debug('Failed to clear collection index cache:', error);
        }
      }
    }

    logger.debug('Collection cache cleared', {
      duration: Date.now() - startTime,
      memoryFreed: this.memoryCache.getMemoryUsageMB()
    });
  }
  
  /**
   * Get comprehensive cache statistics for debugging and monitoring
   */
  getCacheStats(): { 
    isValid: boolean; 
    age: number; 
    hasCache: boolean; 
    elements: number;
    memoryCache: any;
    performanceMetrics: any;
  } {
    if (!this.cache) {
      return { 
        isValid: false, 
        age: 0, 
        hasCache: false, 
        elements: 0,
        memoryCache: this.memoryCache.getStats(),
        performanceMetrics: null
      };
    }
    
    const age = Date.now() - this.cache.fetchedAt.getTime();
    return {
      isValid: this.isValid(),
      age,
      hasCache: true,
      elements: this.cache.data.total_elements,
      memoryCache: this.memoryCache.getStats(),
      performanceMetrics: {
        cacheHitRate: this.calculateCacheHitRate(),
        averageAccessTime: this.calculateAverageAccessTime()
      }
    };
  }

  /**
   * Clear in-memory cache state without touching disk.
   */
  clear(): void {
    this.cache = null;
    this.memoryCache.clear();
    this.fetchPromise = null;
  }
  
  // =====================================================
  // PRIVATE HELPER METHODS FOR PERFORMANCE
  // =====================================================
  
  /**
   * Fetch fresh index with comprehensive fallback strategy
   */
  private async fetchFreshWithFallback(): Promise<CollectionIndex> {
    try {
      // Try to fetch fresh index
      const freshIndex = await this.fetchFresh();
      if (freshIndex) {
        logger.debug('Collection index fetched successfully');
        return freshIndex;
      }
    } catch (error) {
      logger.warn('Fresh fetch failed, trying fallback', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    
    // Fall back to stale cache if available
    if (this.cache?.data) {
      logger.debug('Using stale cached collection index as fallback');
      return this.cache.data;
    }
    
    throw new Error('No collection index available - fresh fetch failed and no cache exists');
  }
  
  /**
   * Record performance metrics for cache operations
   */
  private recordPerformanceMetrics(startTime: number, memoryBefore: number, operation: string): void {
    const duration = Date.now() - startTime;
    const memoryAfter = process.memoryUsage().heapUsed;
    
    logger.debug('Collection cache operation completed', {
      operation,
      duration,
      memoryUsageMB: (memoryAfter - memoryBefore) / (1024 * 1024)
    });
    
    // Record cache performance metrics
    this.performanceMonitor.recordCachePerformance('collectionIndex', {
      hitRate: operation.includes('hit') ? 1 : 0,
      avgHitTime: operation.includes('hit') ? duration : 0,
      avgMissTime: operation.includes('hit') ? 0 : duration,
      totalHits: operation.includes('hit') ? 1 : 0,
      totalMisses: operation.includes('hit') ? 0 : 1,
      evictions: 0
    });
  }
  
  /**
   * Calculate cache hit rate (placeholder for future implementation)
   */
  private calculateCacheHitRate(): number {
    // This would be implemented with actual metrics tracking
    return this.memoryCache.getStats().hitRate;
  }
  
  /**
   * Calculate average access time (placeholder for future implementation)
   */
  private calculateAverageAccessTime(): number {
    // This would be implemented with actual timing metrics
    return 5; // Placeholder value
  }
}
