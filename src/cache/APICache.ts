/**
 * API caching implementation for reducing redundant network requests
 */

import { SECURITY_LIMITS } from '../security/constants.js';
import { CacheEntry } from '../types/cache.js';

export class APICache {
  private cache = new Map<string, CacheEntry>();
  
  /**
   * Retrieve cached data if still valid
   */
  get(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    if (Date.now() - entry.timestamp > SECURITY_LIMITS.CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.data;
  }
  
  /**
   * Cache data with current timestamp
   */
  set(key: string, data: any): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }
  
  /**
   * Clear all cached entries
   */
  clear(): void {
    this.cache.clear();
  }
  
  /**
   * Get current cache size
   */
  size(): number {
    return this.cache.size;
  }
}