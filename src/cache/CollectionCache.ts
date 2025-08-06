/**
 * Persistent cache for collection data to support offline/anonymous browsing
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../utils/logger.js';
import { PathValidator } from '../security/pathValidator.js';
import { SecurityMonitor } from '../security/securityMonitor.js';

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
  
  constructor(baseDir: string = process.cwd()) {
    this.cacheDir = path.join(baseDir, '.dollhousemcp', 'cache');
    this.cacheFile = path.join(this.cacheDir, 'collection-cache.json');
  }
  
  /**
   * Initialize cache directory
   */
  private async ensureCacheDir(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
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
      
      const data = await fs.readFile(this.cacheFile, 'utf8');
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
      await fs.writeFile(this.cacheFile, data, 'utf8');
      
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
      .replace(/[-_\s]+/g, ' ')  // Convert dashes, underscores to spaces
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
      await fs.unlink(this.cacheFile);
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