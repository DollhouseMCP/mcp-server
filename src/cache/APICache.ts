/**
 * API caching implementation for reducing redundant network requests.
 * Backed by a shared LRU cache to prevent unbounded memory growth.
 */

import { SECURITY_LIMITS } from '../security/constants.js';
import { CacheFactory, LRUCache, type CacheStats } from './LRUCache.js';

export interface APICacheOptions {
  maxEntries?: number;
  maxMemoryMB?: number;
  ttlMs?: number;
  onEviction?: (key: string, value: any) => void;
}

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_MEMORY_MB = 10;

export class APICache {
  private cache: LRUCache<any>;

  constructor(options: APICacheOptions = {}) {
    this.cache = CacheFactory.createAPICache({
      maxSize: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
      maxMemoryMB: options.maxMemoryMB ?? DEFAULT_MAX_MEMORY_MB,
      ttlMs: options.ttlMs ?? SECURITY_LIMITS.CACHE_TTL_MS,
      onEviction: options.onEviction
    });
  }

  /**
   * Retrieve cached data if still valid.
   */
  get<T = any>(key: string): T | null {
    const value = this.cache.get(key);
    return value === undefined ? null : (value as T);
  }

  /**
   * Cache data with automatic eviction and TTL handling.
   */
  set<T = any>(key: string, data: T): void {
    this.cache.set(key, data);
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size.
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Inspect cache statistics for observability/testing.
   */
  getStats(): CacheStats {
    return this.cache.getStats();
  }
}
