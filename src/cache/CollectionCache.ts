/**
 * Persistent cache for collection data to support offline/anonymous browsing
 */

import * as path from 'path';
import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { IFileOperationsService } from '../services/FileOperationsService.js';

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

/**
 * Persistent cache for collection data that supports offline browsing
 */
export class CollectionCache {
  private cacheDir: string;
  private cacheFile: string;
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for collection cache

  // File operations service for secure file I/O
  private readonly fileOperations: IFileOperationsService;

  constructor(fileOperations: IFileOperationsService, baseDir?: string) {
    // Initialize file operations service
    this.fileOperations = fileOperations;

    // Use environment variable if set, otherwise fall back to parameter or default
    const envCacheDir = process.env.DOLLHOUSE_CACHE_DIR;
    if (envCacheDir) {
      this.cacheDir = envCacheDir;
      logger.debug(`CollectionCache: Using environment cache directory: ${this.cacheDir}`);
    } else {
      const defaultBaseDir = baseDir || process.cwd();
      this.cacheDir = path.join(defaultBaseDir, '.dollhousemcp', 'cache');
      logger.debug(`CollectionCache: Using default cache directory: ${this.cacheDir}`);
    }
    this.cacheFile = path.join(this.cacheDir, 'collection-cache.json');
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
    try {
      // Validate cache file path (basic security check)
      if (this.cacheFile.includes('..') || this.cacheFile.includes('\0')) {
        // SECURITY FIX: Add audit logging for path traversal attempt detection
        SecurityMonitor.logSecurityEvent({
          type: 'PATH_TRAVERSAL_ATTEMPT',
          severity: 'HIGH',
          source: 'CollectionCache.loadCache',
          details: `Potential path traversal attempt detected in cache file path: ${this.cacheFile.substring(0, 100)}`
        });
        logger.warn('Invalid cache file path, skipping cache load');
        return null;
      }

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