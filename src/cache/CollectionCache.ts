/**
 * Persistent cache for collection data to support offline/anonymous browsing
 */

import * as path from 'path';
import { logger } from '../utils/logger.js';
import type { IFileOperationsService } from '../services/FileOperationsService.js';
import type { ISharedCacheStore } from '../storage/sharedCache/ISharedCacheStore.js';
import { resolveDataDirectory } from '../paths/resolveDataDirectory.js';

export interface CollectionItem {
  name: string;
  path: string;
  sha: string;
  content?: string;
  last_modified?: string;
}

export interface CollectionCacheEntry {
  items: CollectionItem[];
  timestamp: number;
  etag?: string;
}

export interface CollectionCacheConfig {
  fileOperations: IFileOperationsService;
  /** Exact canonical cache directory, normally supplied by PathService. */
  cacheDir?: string;
  /** Legacy home/base directory whose cache subdirectory should be derived. */
  baseDir?: string;
  sharedCache?: ISharedCacheStore;
}

/**
 * Persistent cache for collection data that supports offline browsing
 */
export class CollectionCache {
  private cacheDir: string;
  private cacheFile: string;
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for collection cache

  // Single shared-cache key for the whole browse cache (one entry: {items}).
  // Distinct from CollectionIndexManager's 'collection-index' and
  // CollectionIndexCache's 'collection-index-cache' keys.
  private static readonly SHARED_CACHE_KEY = 'collection-browse-cache';

  // File operations service for secure file I/O
  private readonly fileOperations: IFileOperationsService;

  // Backend-honesty seam. When injected (DB/hosted mode), all persistence
  // routes through the shared cache store instead of the filesystem, so DB-mode
  // deployments never write the browse cache to disk. When null (CLI/local),
  // the legacy filesystem path below is used unchanged.
  private readonly sharedCache: ISharedCacheStore | null;

  constructor(config: CollectionCacheConfig);
  constructor(fileOperations: IFileOperationsService, baseDir?: string, sharedCache?: ISharedCacheStore);
  constructor(
    configOrFileOperations: CollectionCacheConfig | IFileOperationsService,
    legacyBaseDir?: string,
    legacySharedCache?: ISharedCacheStore,
  ) {
    const config: CollectionCacheConfig = 'fileOperations' in configOrFileOperations
      ? configOrFileOperations
      : {
          fileOperations: configOrFileOperations,
          baseDir: legacyBaseDir,
          sharedCache: legacySharedCache,
        };
    this.fileOperations = config.fileOperations;
    this.sharedCache = config.sharedCache ?? null;
    this.cacheDir = path.resolve(this.resolveCacheDir(config.cacheDir, config.baseDir));
    if (this.cacheDir.includes('\0')) {
      throw new Error('Collection cache directory contains a null byte');
    }
    this.cacheFile = path.resolve(this.cacheDir, 'collection-cache.json');
    if (path.dirname(this.cacheFile) !== this.cacheDir) {
      throw new Error('Collection cache file must remain inside the configured cache directory');
    }

    logger.debug('CollectionCache initialized', {
      cacheFile: this.cacheFile,
      backend: this.sharedCache ? 'shared' : 'filesystem',
    });
  }

  private resolveCacheDir(exactCacheDir?: string, legacyBaseDir?: string): string {
    if (exactCacheDir) {
      return exactCacheDir;
    }
    if (process.env.DOLLHOUSE_CACHE_DIR?.trim()) {
      return resolveDataDirectory('cache');
    }
    return legacyBaseDir
      ? path.join(legacyBaseDir, '.dollhousemcp', 'cache')
      : resolveDataDirectory('cache');
  }

  /** Cache-health reporting must inspect the same canonical file this instance uses. */
  getCacheFilePath(): string {
    return this.cacheFile;
  }
  
  /**
   * Initialize cache directory
   */
  private async ensureCacheDir(): Promise<void> {
    try {
      await this.fileOperations.createDirectory(this.cacheDir);
    } catch (error) {
      logger.error(`Failed to create cache directory: ${error}`);
      throw error;
    }
  }
  
  /**
   * Load collection data from persistent cache
   */
  async loadCache(): Promise<CollectionCacheEntry | null> {
    if (this.sharedCache) {
      return this.loadFromSharedCache(this.sharedCache);
    }

    try {
      const data = await this.fileOperations.readFile(this.cacheFile, {
        source: 'CollectionCache.loadCache',
        maxSize: 50 * 1024 * 1024 // 50MB for collection cache
      });
      const cache: CollectionCacheEntry = JSON.parse(data);

      // Check if cache is expired
      if (Date.now() - cache.timestamp > this.CACHE_TTL_MS) {
        logger.debug('Collection cache expired, will refresh from GitHub');
        return null;
      }

      logger.debug(`Loaded ${cache.items.length} items from collection cache`);
      return cache;
    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        logger.debug(`Failed to load collection cache: ${error}`);
      }
      return null;
    }
  }
  
  /**
   * Save collection data to persistent cache
   */
  async saveCache(items: CollectionItem[], etag?: string): Promise<void> {
    if (this.sharedCache) {
      await this.saveToSharedCache(this.sharedCache, items, etag);
      return;
    }

    try {
      await this.ensureCacheDir();

      const cacheEntry: CollectionCacheEntry = {
        items,
        timestamp: Date.now(),
        etag
      };

      const data = JSON.stringify(cacheEntry, null, 2);
      await this.fileOperations.writeFile(this.cacheFile, data, {
        source: 'CollectionCache.saveCache',
        maxSize: 50 * 1024 * 1024 // 50MB for collection cache
      });

      logger.debug(`Saved ${items.length} items to collection cache`);

      // SECURITY FIX: Add audit logging for cache write operations
      logger.debug('Security audit: Cache write operation completed successfully');

      // Log operation completed successfully
      logger.debug(`Cache file operation completed with ${items.length} items`);
    } catch (error) {
      logger.error(`Failed to save collection cache: ${error}`);
      // Don't throw - caching failures shouldn't break functionality
    }
  }
  
  /**
   * Search cached collection items with fuzzy matching
   */
  async searchCache(query: string): Promise<CollectionItem[]> {
    const cache = await this.loadCache();
    if (!cache) {
      return [];
    }
    
    const normalizedQuery = this.normalizeSearchTerm(query);
    return cache.items.filter(item => {
      // Search in filename and path with normalization
      const normalizedName = this.normalizeSearchTerm(item.name);
      const normalizedPath = this.normalizeSearchTerm(item.path);
      
      return normalizedName.includes(normalizedQuery) || 
             normalizedPath.includes(normalizedQuery) ||
             (item.content && this.normalizeSearchTerm(item.content).includes(normalizedQuery));
    });
  }
  
  /**
   * Normalize search terms for better matching (handles spaces, dashes, etc.)
   */
  private normalizeSearchTerm(term: string): string {
    return term.toLowerCase()
      .replaceAll(/[-_\s]+/g, ' ')  // Convert dashes, underscores to spaces
      .replace(/\.md$/, '')       // Remove .md extension
      .trim();
  }
  
  /**
   * Get cached collection items by type/path
   */
  async getItemsByPath(pathPrefix: string): Promise<CollectionItem[]> {
    const cache = await this.loadCache();
    if (!cache) {
      return [];
    }
    
    return cache.items.filter(item => item.path.startsWith(pathPrefix));
  }
  
  /**
   * Check if cache exists and is valid
   */
  async isCacheValid(): Promise<boolean> {
    const cache = await this.loadCache();
    return cache !== null;
  }
  
  /**
   * Clear the cache
   */
  async clearCache(): Promise<void> {
    if (this.sharedCache) {
      try {
        await this.sharedCache.delete(CollectionCache.SHARED_CACHE_KEY);
        logger.debug('Collection cache cleared (shared cache store)');
      } catch (error) {
        logger.debug(`Failed to clear collection cache from shared store: ${error}`);
      }
      return;
    }

    try {
      await this.fileOperations.deleteFile(this.cacheFile, undefined, {
        source: 'CollectionCache.clearCache'
      });
      logger.debug('Collection cache cleared');
    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        logger.debug(`Failed to clear collection cache: ${error}`);
      }
    }
  }

  /**
   * Load the browse cache from the shared cache store (backend-honest path).
   * Mirrors the filesystem loadCache contract: returns null when absent or
   * past its TTL so callers refresh from GitHub.
   */
  private async loadFromSharedCache(store: ISharedCacheStore): Promise<CollectionCacheEntry | null> {
    try {
      const entry = await store.get(CollectionCache.SHARED_CACHE_KEY);
      if (!entry) {
        return null;
      }

      // Honor the TTL the same way the filesystem path does.
      if (typeof entry.expiresAt === 'number' && Date.now() > entry.expiresAt) {
        logger.debug('Collection cache expired (shared store), will refresh from GitHub');
        return null;
      }

      const payload = entry.payload as { items?: CollectionItem[] } | null;
      const items = Array.isArray(payload?.items) ? payload.items : [];
      logger.debug(`Loaded ${items.length} items from collection cache (shared store)`);
      return { items, timestamp: entry.fetchedAt, etag: entry.etag };
    } catch (error) {
      logger.debug(`Failed to load collection cache from shared store: ${error}`);
      return null;
    }
  }

  /**
   * Persist the browse cache to the shared cache store (backend-honest path).
   * Swallows errors like the filesystem path — caching failures must not break
   * browsing.
   */
  private async saveToSharedCache(store: ISharedCacheStore, items: CollectionItem[], etag?: string): Promise<void> {
    try {
      await store.set({
        cacheKey: CollectionCache.SHARED_CACHE_KEY,
        payload: { items },
        etag,
        expiresAt: Date.now() + this.CACHE_TTL_MS
      });
      logger.debug(`Saved ${items.length} items to collection cache (shared store)`);
    } catch (error) {
      logger.error(`Failed to save collection cache to shared store: ${error}`);
      // Don't throw - caching failures shouldn't break functionality
    }
  }
  
  /**
   * Get cache stats for debugging
   */
  async getCacheStats(): Promise<{ itemCount: number; cacheAge: number; isValid: boolean }> {
    const cache = await this.loadCache();
    if (!cache) {
      return { itemCount: 0, cacheAge: 0, isValid: false };
    }
    
    return {
      itemCount: cache.items.length,
      cacheAge: Date.now() - cache.timestamp,
      isValid: Date.now() - cache.timestamp <= this.CACHE_TTL_MS
    };
  }
}
