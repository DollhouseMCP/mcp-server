/**
 * Generic caching utility for tool discovery with TTL and memory limits
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { logger } from './logger.js';

export interface CacheEntry<T> {
  value: T;
  timestamp: number;
  hits: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  maxSize: number;
  hitRate: number;
}

/**
 * Generic cache with TTL support and memory limit protection
 */
export class ToolCache<T = any> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private stats = {
    hits: 0,
    misses: 0
  };

  constructor(maxEntries: number = 100, ttlMinutes: number = 1) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMinutes * 60 * 1000; // Convert minutes to milliseconds
  }

  /**
   * Get cached value if valid, otherwise return undefined
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // Check if entry has expired
    const now = Date.now();
    if (now - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      this.stats.misses++;
      logger.debug('ToolCache: Cache entry expired', { key, age: now - entry.timestamp });
      return undefined;
    }

    // Entry is valid
    entry.hits++;
    this.stats.hits++;
    logger.debug('ToolCache: Cache hit', { key, hits: entry.hits, age: now - entry.timestamp });
    return entry.value;
  }

  /**
   * Set cached value with automatic memory limit enforcement
   */
  set(key: string, value: T): void {
    const now = Date.now();
    
    // Enforce memory limit by removing oldest entries if needed
    while (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      this.evictOldest();
    }

    this.cache.set(key, {
      value,
      timestamp: now,
      hits: 0
    });

    logger.debug('ToolCache: Cache set', { key, cacheSize: this.cache.size });
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Clear specific cache entry
   */
  delete(key: string): boolean {
    const deleted = this.cache.delete(key);
    if (deleted) {
      logger.debug('ToolCache: Cache entry deleted', { key });
    }
    return deleted;
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    this.cache.clear();
    this.stats.hits = 0;
    this.stats.misses = 0;
    logger.debug('ToolCache: Cache cleared');
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const totalRequests = this.stats.hits + this.stats.misses;
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      size: this.cache.size,
      maxSize: this.maxEntries,
      hitRate: totalRequests > 0 ? this.stats.hits / totalRequests : 0
    };
  }

  /**
   * Remove oldest entries when cache is full
   */
  private evictOldest(): void {
    if (this.cache.size === 0) return;

    // Find the oldest entry (lowest timestamp)
    let oldestKey: string | undefined;
    let oldestTimestamp = Date.now();

    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      logger.debug('ToolCache: Evicted oldest entry', { key: oldestKey, age: Date.now() - oldestTimestamp });
    }
  }

  /**
   * Clean up expired entries (can be called periodically)
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug('ToolCache: Cleaned up expired entries', { cleaned, remaining: this.cache.size });
    }

    return cleaned;
  }
}

/**
 * Specialized cache for MCP Tool discovery results
 */
export class ToolDiscoveryCache extends ToolCache<Tool[]> {
  private static readonly CACHE_KEY = 'tool_discovery_list';

  constructor() {
    // 1-minute TTL, max 100 entries (though we'll likely only use 1 key)
    super(100, 1);
  }

  /**
   * Get cached tool list
   */
  getToolList(): Tool[] | undefined {
    const startTime = Date.now();
    const result = this.get(ToolDiscoveryCache.CACHE_KEY);
    const duration = Date.now() - startTime;
    
    if (result) {
      logger.info('ToolDiscoveryCache: Retrieved cached tool list', { 
        toolCount: result.length, 
        duration: `${duration}ms`,
        stats: this.getStats()
      });
    }
    
    return result;
  }

  /**
   * Cache tool list
   */
  setToolList(tools: Tool[]): void {
    const startTime = Date.now();
    this.set(ToolDiscoveryCache.CACHE_KEY, tools);
    const duration = Date.now() - startTime;
    
    logger.info('ToolDiscoveryCache: Cached tool list', { 
      toolCount: tools.length, 
      duration: `${duration}ms`,
      stats: this.getStats()
    });
  }

  /**
   * Invalidate cached tool list
   */
  invalidateToolList(): void {
    const deleted = this.delete(ToolDiscoveryCache.CACHE_KEY);
    if (deleted) {
      logger.info('ToolDiscoveryCache: Invalidated cached tool list');
    }
  }

  /**
   * Log performance metrics
   */
  logPerformance(): void {
    const stats = this.getStats();
    logger.info('ToolDiscoveryCache: Performance metrics', {
      hitRate: `${(stats.hitRate * 100).toFixed(1)}%`,
      hits: stats.hits,
      misses: stats.misses,
      cacheSize: stats.size,
      efficiency: stats.hits > 0 ? 'GOOD' : 'NEEDS_WARMUP'
    });
  }
}