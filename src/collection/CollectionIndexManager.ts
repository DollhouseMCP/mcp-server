/**
 * Collection Index Manager with Background Refresh and Robust Caching
 * 
 * This manager implements:
 * - 1-hour TTL with local file caching
 * - Background refresh without blocking operations
 * - Exponential backoff retry logic
 * - Configurable timeouts via environment variables
 * - Return stale cache while refreshing in background
 * - Comprehensive error handling for production use
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { CollectionIndex } from '../types/collection';
import { logger } from '../utils/logger.js';

export interface CollectionIndexCacheEntry {
  data: CollectionIndex;
  timestamp: number;
  etag?: string;
  lastModified?: string;
  version: string;
  checksum: string;
}

export interface CollectionIndexManagerConfig {
  ttlMs?: number;
  fetchTimeoutMs?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  cacheDir?: string;
}

export class CollectionIndexManager {
  private readonly INDEX_URL = 'https://raw.githubusercontent.com/DollhouseMCP/collection/main/public/collection-index.json';
  private readonly TTL_MS: number;
  private readonly FETCH_TIMEOUT_MS: number;
  private readonly MAX_RETRIES: number;
  private readonly BASE_RETRY_DELAY_MS: number;
  private readonly MAX_RETRY_DELAY_MS: number;
  private readonly CACHE_FILE: string;
  
  private cachedIndex: CollectionIndexCacheEntry | null = null;
  private backgroundRefreshPromise: Promise<void> | null = null;
  private isRefreshing = false;
  private circuitBreakerFailures = 0;
  private circuitBreakerLastFailure = 0;
  private readonly CIRCUIT_BREAKER_THRESHOLD = 5;
  private readonly CIRCUIT_BREAKER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  private readonly REFRESH_THRESHOLD = 0.8; // Refresh when 80% of TTL has passed
  private readonly JITTER_FACTOR = 0.25; // ±25% randomness for jitter
  
  // Default configuration constants
  private readonly DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
  private readonly DEFAULT_MAX_RETRIES = 3;
  private readonly DEFAULT_BASE_RETRY_DELAY_MS = 1000;
  private readonly DEFAULT_MAX_RETRY_DELAY_MS = 30000;
  private readonly DEFAULT_FETCH_TIMEOUT_MS = 5000; // 5 seconds
  private readonly CHECKSUM_LENGTH = 8;
  private readonly JSON_INDENT = 2;
  
  constructor(config: CollectionIndexManagerConfig = {}) {
    // Configuration with environment variable overrides
    this.TTL_MS = config.ttlMs || this.DEFAULT_TTL_MS;
    this.FETCH_TIMEOUT_MS = this.parseFetchTimeout(config.fetchTimeoutMs);
    this.MAX_RETRIES = config.maxRetries || this.DEFAULT_MAX_RETRIES;
    this.BASE_RETRY_DELAY_MS = config.baseRetryDelayMs || this.DEFAULT_BASE_RETRY_DELAY_MS;
    this.MAX_RETRY_DELAY_MS = config.maxRetryDelayMs || this.DEFAULT_MAX_RETRY_DELAY_MS;
    
    // Cache directory - use ~/.dollhouse/cache/collection-index.json as specified
    const cacheDir = config.cacheDir || path.join(os.homedir(), '.dollhouse', 'cache');
    this.CACHE_FILE = path.join(cacheDir, 'collection-index.json');
    
    logger.debug('CollectionIndexManager initialized', {
      ttlMs: this.TTL_MS,
      fetchTimeoutMs: this.FETCH_TIMEOUT_MS,
      cacheFile: this.CACHE_FILE,
      maxRetries: this.MAX_RETRIES
    });
  }
  
  /**
   * Parse fetch timeout from config or environment variable
   */
  private parseFetchTimeout(configValue?: number): number {
    // Check environment variable first
    const envTimeout = process.env.COLLECTION_FETCH_TIMEOUT;
    if (envTimeout) {
      const parsed = parseInt(envTimeout, 10);
      if (!isNaN(parsed) && parsed > 0) {
        logger.debug(`Using COLLECTION_FETCH_TIMEOUT from environment: ${parsed}ms`);
        return parsed;
      }
      logger.warn(`Invalid COLLECTION_FETCH_TIMEOUT value: ${envTimeout}, using default`);
    }
    
    // Fall back to config value or default
    return configValue || this.DEFAULT_FETCH_TIMEOUT_MS;
  }
  
  /**
   * Get collection index with stale-while-revalidate pattern
   * Returns cached data immediately if available, refreshes in background
   */
  async getIndex(): Promise<CollectionIndex> {
    try {
      // Load from memory cache first
      if (!this.cachedIndex) {
        await this.loadFromDisk();
      }
      
      // Check if we should return stale cache while refreshing
      const shouldRefresh = this.shouldRefreshCache();
      
      if (this.cachedIndex && !this.isCacheExpired()) {
        // Cache is valid, return immediately
        logger.debug('Returning valid cached collection index');
        
        // Start background refresh if needed but not already running
        if (shouldRefresh && !this.isRefreshing) {
          this.startBackgroundRefresh();
        }
        
        return this.cachedIndex.data;
      }
      
      // If we have stale cache, return it while refreshing in background
      if (this.cachedIndex && this.isCacheExpired()) {
        logger.debug('Returning stale cache while refreshing in background');
        
        // Start background refresh if not already running
        if (!this.isRefreshing) {
          this.startBackgroundRefresh();
        }
        
        return this.cachedIndex.data;
      }
      
      // No cache available, must fetch synchronously
      logger.debug('No cache available, fetching collection index synchronously');
      const freshIndex = await this.fetchWithRetry();
      await this.updateCache(freshIndex);
      return freshIndex.data;
      
    } catch (error) {
      logger.error('Failed to get collection index', { error: this.getErrorMessage(error) });
      
      // If we have any cached data (even expired), return it as last resort
      if (this.cachedIndex) {
        logger.warn('Returning expired cache as last resort');
        return this.cachedIndex.data;
      }
      
      throw new Error(`Collection index not available: ${this.getErrorMessage(error)}`);
    }
  }
  
  /**
   * Force refresh the collection index
   */
  async forceRefresh(): Promise<CollectionIndex> {
    logger.debug('Force refreshing collection index');
    
    try {
      const freshIndex = await this.fetchWithRetry();
      await this.updateCache(freshIndex);
      return freshIndex.data;
    } catch (error) {
      logger.error('Force refresh failed', { error: this.getErrorMessage(error) });
      
      // If we have cached data, return it
      if (this.cachedIndex) {
        logger.warn('Force refresh failed, returning cached data');
        return this.cachedIndex.data;
      }
      
      throw error;
    }
  }
  
  /**
   * Check if cache should be refreshed (within TTL but getting close to expiry)
   */
  private shouldRefreshCache(): boolean {
    if (!this.cachedIndex) return true;
    
    const age = Date.now() - this.cachedIndex.timestamp;
    const refreshThreshold = this.TTL_MS * this.REFRESH_THRESHOLD;
    
    return age > refreshThreshold;
  }
  
  /**
   * Check if cache is expired
   */
  private isCacheExpired(): boolean {
    if (!this.cachedIndex) return true;
    
    const age = Date.now() - this.cachedIndex.timestamp;
    return age > this.TTL_MS;
  }
  
  /**
   * Start background refresh without blocking
   */
  private startBackgroundRefresh(): void {
    if (this.isRefreshing) {
      logger.debug('Background refresh already in progress');
      return;
    }
    
    // Check circuit breaker
    if (this.isCircuitBreakerOpen()) {
      logger.debug('Circuit breaker open, skipping background refresh');
      return;
    }
    
    this.isRefreshing = true;
    
    this.backgroundRefreshPromise = this.performBackgroundRefresh()
      .catch(error => {
        logger.debug('Background refresh failed', { error: this.getErrorMessage(error) });
        this.recordCircuitBreakerFailure();
      })
      .finally(() => {
        this.isRefreshing = false;
        this.backgroundRefreshPromise = null;
      });
  }
  
  /**
   * Perform background refresh
   */
  private async performBackgroundRefresh(): Promise<void> {
    logger.debug('Starting background refresh of collection index');
    
    try {
      const freshIndex = await this.fetchWithRetry();
      await this.updateCache(freshIndex);
      
      // Reset circuit breaker on success
      this.circuitBreakerFailures = 0;
      
      logger.debug('Background refresh completed successfully');
    } catch (error) {
      logger.debug('Background refresh failed', { error: this.getErrorMessage(error) });
      throw error;
    }
  }
  
  /**
   * Fetch collection index with retry logic and exponential backoff
   */
  private async fetchWithRetry(): Promise<{ data: CollectionIndex; etag?: string; lastModified?: string }> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const delay = this.calculateRetryDelay(attempt);
          logger.debug(`Retrying fetch in ${delay}ms (attempt ${attempt + 1}/${this.MAX_RETRIES + 1})`);
          await this.sleep(delay);
        }
        
        return await this.fetchCollectionIndex();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.debug(`Fetch attempt ${attempt + 1} failed`, { 
          error: this.getErrorMessage(lastError),
          willRetry: attempt < this.MAX_RETRIES
        });
      }
    }
    
    throw lastError || new Error('All fetch attempts failed');
  }
  
  /**
   * Calculate retry delay with exponential backoff and jitter
   */
  private calculateRetryDelay(attempt: number): number {
    // Exponential backoff: baseDelay * (2 ^ attempt)
    const exponentialDelay = this.BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
    
    // Cap at maximum delay
    const cappedDelay = Math.min(exponentialDelay, this.MAX_RETRY_DELAY_MS);
    
    // Add jitter to prevent thundering herd
    return this.addJitter(cappedDelay);
  }
  
  /**
   * Add jitter (±25% randomness) to a delay to prevent thundering herd problems
   */
  private addJitter(delay: number): number {
    const jitter = delay * this.JITTER_FACTOR * (Math.random() - 0.5);
    return Math.max(0, delay + jitter);
  }
  
  /**
   * Fetch collection index from GitHub
   */
  private async fetchCollectionIndex(): Promise<{ data: CollectionIndex; etag?: string; lastModified?: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.FETCH_TIMEOUT_MS);
    
    try {
      // Build headers for conditional requests
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        'User-Agent': 'DollhouseMCP/1.0',
        'Cache-Control': 'no-cache'
      };
      
      // Add conditional headers if we have cached data
      if (this.cachedIndex?.etag) {
        headers['If-None-Match'] = this.cachedIndex.etag;
      }
      if (this.cachedIndex?.lastModified) {
        headers['If-Modified-Since'] = this.cachedIndex.lastModified;
      }
      
      logger.debug('Fetching collection index', { 
        url: this.INDEX_URL,
        timeout: this.FETCH_TIMEOUT_MS,
        hasEtag: !!this.cachedIndex?.etag
      });
      
      const response = await fetch(this.INDEX_URL, {
        headers,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      // Handle 304 Not Modified
      if (response.status === 304 && this.cachedIndex) {
        logger.debug('Collection index not modified (304), updating cache timestamp');
        this.cachedIndex.timestamp = Date.now();
        await this.saveToDisk();
        return {
          data: this.cachedIndex.data,
          etag: this.cachedIndex.etag,
          lastModified: this.cachedIndex.lastModified
        };
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const indexData = await response.json() as CollectionIndex;
      
      // Validate the index structure
      this.validateIndexStructure(indexData);
      
      const etag = response.headers.get('etag') || undefined;
      const lastModified = response.headers.get('last-modified') || undefined;
      
      logger.debug('Collection index fetched successfully', {
        totalElements: indexData.total_elements,
        version: indexData.version,
        hasEtag: !!etag
      });
      
      return { data: indexData, etag, lastModified };
      
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Fetch timeout after ${this.FETCH_TIMEOUT_MS}ms`);
      }
      
      throw error;
    }
  }
  
  /**
   * Validate collection index structure
   */
  private validateIndexStructure(index: any): asserts index is CollectionIndex {
    if (!index || typeof index !== 'object') {
      throw new Error('Invalid index: not an object');
    }
    
    if (typeof index.version !== 'string') {
      throw new Error('Invalid index: missing or invalid version');
    }
    
    if (typeof index.generated !== 'string') {
      throw new Error('Invalid index: missing or invalid generated timestamp');
    }
    
    if (typeof index.total_elements !== 'number') {
      throw new Error('Invalid index: missing or invalid total_elements');
    }
    
    if (!index.index || typeof index.index !== 'object') {
      throw new Error('Invalid index: missing or invalid index object');
    }
    
    if (!index.metadata || typeof index.metadata !== 'object') {
      throw new Error('Invalid index: missing or invalid metadata');
    }
  }
  
  /**
   * Update cache with new data
   */
  private async updateCache(fetchResult: { data: CollectionIndex; etag?: string; lastModified?: string }): Promise<void> {
    const checksum = this.calculateChecksum(fetchResult.data);
    
    this.cachedIndex = {
      data: fetchResult.data,
      timestamp: Date.now(),
      etag: fetchResult.etag,
      lastModified: fetchResult.lastModified,
      version: fetchResult.data.version,
      checksum
    };
    
    await this.saveToDisk();
    
    logger.debug('Collection index cache updated', {
      version: fetchResult.data.version,
      totalElements: fetchResult.data.total_elements,
      checksum
    });
  }
  
  /**
   * Calculate checksum for data integrity verification
   */
  private calculateChecksum(data: CollectionIndex): string {
    // Simple checksum based on key properties
    const checksumData = {
      version: data.version,
      generated: data.generated,
      total_elements: data.total_elements
    };
    return Buffer.from(JSON.stringify(checksumData)).toString('base64').substring(0, this.CHECKSUM_LENGTH);
  }
  
  /**
   * Load cache from disk
   */
  private async loadFromDisk(): Promise<void> {
    try {
      const data = await fs.readFile(this.CACHE_FILE, 'utf8');
      const cached = JSON.parse(data) as CollectionIndexCacheEntry;
      
      // Validate cache structure
      if (!cached.data || !cached.timestamp || !cached.version) {
        logger.debug('Invalid cache structure, ignoring');
        return;
      }
      
      // Verify checksum if available
      if (cached.checksum) {
        const expectedChecksum = this.calculateChecksum(cached.data);
        if (cached.checksum !== expectedChecksum) {
          logger.debug('Cache checksum mismatch, ignoring cached data');
          return;
        }
      }
      
      this.cachedIndex = cached;
      
      const age = Date.now() - cached.timestamp;
      const isExpired = age > this.TTL_MS;
      
      logger.debug('Loaded collection index from disk cache', {
        version: cached.version,
        age: Math.round(age / 1000),
        isExpired,
        totalElements: cached.data.total_elements
      });
      
    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        logger.debug('Failed to load cache from disk', { error: this.getErrorMessage(error) });
      }
    }
  }
  
  /**
   * Save cache to disk
   */
  private async saveToDisk(): Promise<void> {
    if (!this.cachedIndex) return;
    
    try {
      // Ensure cache directory exists
      await fs.mkdir(path.dirname(this.CACHE_FILE), { recursive: true });
      
      const cacheData = JSON.stringify(this.cachedIndex, null, this.JSON_INDENT);
      await fs.writeFile(this.CACHE_FILE, cacheData, 'utf8');
      
      logger.debug('Collection index cache saved to disk');
    } catch (error) {
      logger.debug('Failed to save cache to disk', { error: this.getErrorMessage(error) });
      // Don't throw - cache persistence failures shouldn't break functionality
    }
  }
  
  /**
   * Circuit breaker logic
   */
  private isCircuitBreakerOpen(): boolean {
    if (this.circuitBreakerFailures < this.CIRCUIT_BREAKER_THRESHOLD) {
      return false;
    }
    
    const timeSinceLastFailure = Date.now() - this.circuitBreakerLastFailure;
    return timeSinceLastFailure < this.CIRCUIT_BREAKER_TIMEOUT_MS;
  }
  
  private recordCircuitBreakerFailure(): void {
    this.circuitBreakerFailures++;
    this.circuitBreakerLastFailure = Date.now();
    
    if (this.circuitBreakerFailures >= this.CIRCUIT_BREAKER_THRESHOLD) {
      logger.warn('Circuit breaker opened due to repeated failures', {
        failures: this.circuitBreakerFailures,
        timeoutMs: this.CIRCUIT_BREAKER_TIMEOUT_MS
      });
    }
  }
  
  /**
   * Utility methods
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
  
  /**
   * Get cache statistics for monitoring
   */
  getCacheStats(): {
    isValid: boolean;
    age: number;
    hasCache: boolean;
    version?: string;
    totalElements?: number;
    isRefreshing: boolean;
    circuitBreakerFailures: number;
    circuitBreakerOpen: boolean;
  } {
    if (!this.cachedIndex) {
      return {
        isValid: false,
        age: 0,
        hasCache: false,
        isRefreshing: this.isRefreshing,
        circuitBreakerFailures: this.circuitBreakerFailures,
        circuitBreakerOpen: this.isCircuitBreakerOpen()
      };
    }
    
    const age = Date.now() - this.cachedIndex.timestamp;
    
    return {
      isValid: !this.isCacheExpired(),
      age: Math.round(age / 1000), // age in seconds
      hasCache: true,
      version: this.cachedIndex.version,
      totalElements: this.cachedIndex.data.total_elements,
      isRefreshing: this.isRefreshing,
      circuitBreakerFailures: this.circuitBreakerFailures,
      circuitBreakerOpen: this.isCircuitBreakerOpen()
    };
  }
  
  /**
   * Clear all cache data
   */
  async clearCache(): Promise<void> {
    this.cachedIndex = null;
    this.circuitBreakerFailures = 0;
    
    try {
      await fs.unlink(this.CACHE_FILE);
      logger.debug('Collection index cache file deleted');
    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        logger.debug('Failed to delete cache file', { error: this.getErrorMessage(error) });
      }
    }
  }
  
  /**
   * Wait for any ongoing background refresh to complete
   */
  async waitForBackgroundRefresh(): Promise<void> {
    if (this.backgroundRefreshPromise) {
      await this.backgroundRefreshPromise;
    }
  }
}