/**
 * High-performance LRU Cache with memory monitoring and automatic cleanup
 * Optimized for large-scale indexing operations with configurable memory limits
 */

import { SecurityMonitor } from '../security/securityMonitor.js';
import {
  CACHE_SIZE_ESTIMATION_CONFIG,
  getValidatedSampleSize
} from '../config/performance-constants.js';

export type SizeEstimationMode = 'fast' | 'balanced' | 'accurate';

export interface LRUCacheOptions {
  name?: string;
  maxSize: number;
  maxMemoryMB?: number;
  ttlMs?: number;
  onEviction?: (key: string, value: any) => void;
  onSet?: () => void;
  sizeEstimationMode?: SizeEstimationMode;
}

export interface CacheStats {
  size: number;
  maxSize: number;
  hitCount: number;
  missCount: number;
  evictionCount: number;
  memoryUsageMB: number;
  hitRate: number;
}

interface CacheNode<T> {
  key: string;
  value: T;
  prev: CacheNode<T> | null;
  next: CacheNode<T> | null;
  timestamp: number;
  size: number; // Estimated size in bytes
}

export class LRUCache<T> {
  private static hasLoggedInit = false;
  private static logListener?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;

  static addLogListener(fn: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void): () => void {
    LRUCache.logListener = fn;
    return () => { LRUCache.logListener = undefined; };
  }

  private readonly name: string;
  private readonly maxSize: number;
  private readonly maxMemoryBytes: number;
  private readonly ttlMs: number;
  private readonly onEviction?: (key: string, value: T) => void;
  private readonly onSet?: () => void;
  private readonly sizeEstimationMode: SizeEstimationMode;

  private cache = new Map<string, CacheNode<T>>();
  private head: CacheNode<T> | null = null;
  private tail: CacheNode<T> | null = null;
  private currentMemoryBytes = 0;
  private nextExpiryTimestamp = Infinity;
  private lastActivityTime = 0;

  // Performance counters
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  // Constants for fast estimation - using centralized configuration
  private static readonly PRIMITIVE_SIZE = CACHE_SIZE_ESTIMATION_CONFIG.PRIMITIVE_SIZE;
  private static readonly OBJECT_BASE_OVERHEAD = CACHE_SIZE_ESTIMATION_CONFIG.OBJECT_BASE_OVERHEAD;
  private static readonly ARRAY_BASE_OVERHEAD = CACHE_SIZE_ESTIMATION_CONFIG.ARRAY_BASE_OVERHEAD;
  private static readonly FIELD_OVERHEAD = CACHE_SIZE_ESTIMATION_CONFIG.FIELD_OVERHEAD;
  private static readonly ELEMENT_ESTIMATE = CACHE_SIZE_ESTIMATION_CONFIG.ELEMENT_ESTIMATE;
  private static readonly BALANCED_SAMPLE_SIZE = getValidatedSampleSize();

  constructor(options: LRUCacheOptions) {
    this.name = options.name ?? 'unnamed';
    this.maxSize = options.maxSize;
    this.maxMemoryBytes = (options.maxMemoryMB || 50) * 1024 * 1024; // Convert MB to bytes
    this.ttlMs = options.ttlMs || 0; // 0 means no TTL
    this.onEviction = options.onEviction;
    this.onSet = options.onSet;
    this.sizeEstimationMode = options.sizeEstimationMode || 'fast';

    // FIX: DMCP-SEC-006 - Audit cache initialization (log once per server lifetime)
    if (!LRUCache.hasLoggedInit) {
      SecurityMonitor.logSecurityEvent({
        type: 'PORTFOLIO_INITIALIZATION',
        severity: 'LOW',
        source: 'LRUCache.constructor',
        details: `Cache initialized with maxSize=${this.maxSize}, maxMemoryMB=${options.maxMemoryMB || 50}, ttl=${this.ttlMs}ms`,
        additionalData: {
          maxSize: this.maxSize,
          maxMemoryMB: options.maxMemoryMB || 50,
          ttlMs: this.ttlMs,
          sizeEstimationMode: this.sizeEstimationMode
        }
      });
      LRUCache.hasLoggedInit = true;
    }
  }

  /**
   * Get value from cache with automatic cleanup
   */
  get(key: string): T | undefined {
    const node = this.cache.get(key);

    if (!node) {
      this.missCount++;
      return undefined;
    }

    // Check TTL if enabled
    if (this.ttlMs > 0 && Date.now() - node.timestamp > this.ttlMs) {
      this.delete(key);
      this.missCount++;
      return undefined;
    }

    // Move to front (most recently used)
    this.moveToFront(node);
    this.hitCount++;
    this.lastActivityTime = Date.now();
    return node.value;
  }

  /**
   * Set value in cache with automatic eviction
   */
  set(key: string, value: T, sizeHint?: number): this {
    const existingNode = this.cache.get(key);

    if (existingNode) {
      // Update existing node
      const oldSize = existingNode.size;
      existingNode.value = value;
      existingNode.timestamp = Date.now();
      existingNode.size = sizeHint ?? this.estimateSize(value);

      this.currentMemoryBytes += existingNode.size - oldSize;
      this.moveToFront(existingNode);
    } else {
      // Create new node
      const newNode: CacheNode<T> = {
        key,
        value,
        prev: null,
        next: null,
        timestamp: Date.now(),
        size: sizeHint ?? this.estimateSize(value)
      };

      this.cache.set(key, newNode);
      this.currentMemoryBytes += newNode.size;
      this.addToFront(newNode);
    }

    // Track earliest expiry for deterministic TTL cleanup
    if (this.ttlMs > 0) {
      const expiry = Date.now() + this.ttlMs;
      if (expiry < this.nextExpiryTimestamp) {
        this.nextExpiryTimestamp = expiry;
      }
    }

    // Evict if necessary
    this.evictIfNecessary();

    this.lastActivityTime = Date.now();

    // Notify budget coordinator (if registered)
    if (this.onSet) {
      this.onSet();
    }

    return this;
  }

  /**
   * Delete specific key from cache
   */
  delete(key: string): boolean {
    const node = this.cache.get(key);
    if (!node) {
      return false;
    }

    this.removeNode(node);
    this.cache.delete(key);
    this.currentMemoryBytes -= node.size;

    if (this.onEviction) {
      this.onEviction(key, node.value);
    }

    return true;
  }

  /**
   * Check if key exists in cache
   */
  has(key: string): boolean {
    const node = this.cache.get(key);
    if (!node) {
      return false;
    }

    // Check TTL
    if (this.ttlMs > 0 && Date.now() - node.timestamp > this.ttlMs) {
      this.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Clear all entries from cache
   */
  clear(): void {
    const entriesCleared = this.cache.size;

    if (this.onEviction) {
      for (const [key, node] of this.cache) {
        this.onEviction(key, node.value);
      }
    }

    this.cache.clear();
    this.head = null;
    this.tail = null;
    this.currentMemoryBytes = 0;
    this.nextExpiryTimestamp = Infinity;
    this.evictionCount += this.cache.size;

    if (entriesCleared > 0) {
      LRUCache.logListener?.('debug', 'Clear cache', {
        cacheName: this.name,
        entriesCleared,
      });

      // FIX: DMCP-SEC-006 - Audit cache clearing
      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_CLEARED',
        severity: 'LOW',
        source: 'LRUCache.clear',
        details: `Cache cleared: ${entriesCleared} entries removed`,
        additionalData: { entriesCleared }
      });
    }
  }

  /**
   * Get current cache size (number of entries)
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitCount: this.hitCount,
      missCount: this.missCount,
      evictionCount: this.evictionCount,
      memoryUsageMB: this.currentMemoryBytes / (1024 * 1024),
      hitRate: this.hitCount + this.missCount > 0 ? this.hitCount / (this.hitCount + this.missCount) : 0
    };
  }

  /**
   * Get all keys in access order (most recent first)
   * Returns an array for compatibility with Map behavior and array indexing
   */
  keys(): string[] & IterableIterator<string> {
    const result: string[] = [];
    let current = this.head;
    while (current) {
      result.push(current.key);
      current = current.next;
    }

    // Add iterator interface to support both array and iterator usage
    let index = 0;
    const iterator = {
      [Symbol.iterator]: () => iterator,
      next: () => {
        if (index < result.length) {
          return { value: result[index++], done: false };
        }
        return { done: true } as IteratorResult<string>;
      }
    };

    // Merge array methods with iterator
    return Object.assign(result, iterator) as string[] & IterableIterator<string>;
  }

  /**
   * Get all values in access order (most recent first)
   * Returns an array for compatibility with Map behavior and array indexing
   */
  values(): T[] & IterableIterator<T> {
    const result: T[] = [];
    let current = this.head;
    while (current) {
      result.push(current.value);
      current = current.next;
    }

    // Add iterator interface to support both array and iterator usage
    let index = 0;
    const iterator = {
      [Symbol.iterator]: () => iterator,
      next: () => {
        if (index < result.length) {
          return { value: result[index++], done: false };
        }
        return { done: true } as IteratorResult<T>;
      }
    };

    // Merge array methods with iterator
    return Object.assign(result, iterator) as T[] & IterableIterator<T>;
  }

  /**
   * Get all entries in access order (most recent first)
   * Returns an array for compatibility with Map behavior and array indexing
   */
  entries(): Array<[string, T]> & IterableIterator<[string, T]> {
    const result: Array<[string, T]> = [];
    let current = this.head;
    while (current) {
      result.push([current.key, current.value]);
      current = current.next;
    }

    // Add iterator interface to support both array and iterator usage
    let index = 0;
    const iterator = {
      [Symbol.iterator]: () => iterator,
      next: () => {
        if (index < result.length) {
          return { value: result[index++], done: false };
        }
        return { done: true } as IteratorResult<[string, T]>;
      }
    };

    // Merge array methods with iterator
    return Object.assign(result, iterator) as Array<[string, T]> & IterableIterator<[string, T]>;
  }

  /**
   * Execute a callback for each entry in the cache
   */
  forEach(callback: (value: T, key: string, map: this) => void, thisArg?: any): void {
    let current = this.head;
    while (current) {
      callback.call(thisArg, current.value, current.key, this);
      current = current.next;
    }
  }

  /**
   * Iterator for entries (for Map compatibility)
   */
  *[Symbol.iterator](): IterableIterator<[string, T]> {
    let current = this.head;
    while (current) {
      yield [current.key, current.value];
      current = current.next;
    }
  }

  /**
   * String tag for Map compatibility
   */
  get [Symbol.toStringTag](): string {
    return 'LRUCache';
  }

  /**
   * Get current memory usage in MB
   */
  getMemoryUsageMB(): number {
    return this.currentMemoryBytes / (1024 * 1024);
  }

  /**
   * Get current memory usage in bytes
   */
  getMemoryUsageBytes(): number {
    return this.currentMemoryBytes;
  }

  /**
   * Get the cache name (set via constructor options)
   */
  getName(): string {
    return this.name;
  }

  /**
   * Get the timestamp of the most recent get() hit or set() call.
   * Used by CacheMemoryBudget to identify the coldest (least-active) cache.
   * Returns 0 if the cache has never been accessed.
   */
  getLastActivityTimestamp(): number {
    return this.lastActivityTime;
  }

  /**
   * Evict the least recently used entry from the cache.
   * Used by CacheMemoryBudget to enforce global memory limits.
   * @returns true if an entry was evicted, false if the cache was empty
   */
  evictOne(): boolean {
    if (!this.tail) {
      return false;
    }
    this.evictLeastRecentlyUsed();
    return true;
  }

  /**
   * Manually trigger cleanup of expired entries.
   * Recomputes nextExpiryTimestamp from remaining entries.
   */
  cleanup(): number {
    if (this.ttlMs <= 0) {
      return 0;
    }

    const now = Date.now();
    const keysToDelete: string[] = [];
    let earliestRemaining = Infinity;

    for (const [key, node] of this.cache) {
      const expiry = node.timestamp + this.ttlMs;
      if (now >= expiry) {
        keysToDelete.push(key);
      } else if (expiry < earliestRemaining) {
        earliestRemaining = expiry;
      }
    }

    for (const key of keysToDelete) {
      this.delete(key);
    }

    this.nextExpiryTimestamp = earliestRemaining;
    return keysToDelete.length;
  }

  // Private methods

  private moveToFront(node: CacheNode<T>): void {
    if (node === this.head) {
      return; // Already at front
    }

    // Remove from current position
    this.removeNode(node);
    
    // Add to front
    this.addToFront(node);
  }

  private addToFront(node: CacheNode<T>): void {
    node.prev = null;
    node.next = this.head;

    if (this.head) {
      this.head.prev = node;
    }
    
    this.head = node;

    if (!this.tail) {
      this.tail = node;
    }
  }

  private removeNode(node: CacheNode<T>): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }

    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
  }

  private evictIfNecessary(): void {
    // Evict by size
    while (this.cache.size > this.maxSize) {
      this.evictLeastRecentlyUsed();
    }

    // Evict by memory
    if (this.currentMemoryBytes > this.maxMemoryBytes && this.tail) {
      LRUCache.logListener?.('warn', 'Memory limit exceeded', {
        cacheName: this.name,
        memoryUsageMB: this.currentMemoryBytes / (1024 * 1024),
        maxMemoryMB: this.maxMemoryBytes / (1024 * 1024),
      });
      while (this.currentMemoryBytes > this.maxMemoryBytes && this.tail) {
        this.evictLeastRecentlyUsed();
      }
    }

    // Deterministic TTL cleanup: fires exactly when an entry has expired
    if (this.ttlMs > 0 && Date.now() >= this.nextExpiryTimestamp) {
      this.cleanup();
    }
  }

  private evictLeastRecentlyUsed(): void {
    if (!this.tail) {
      return;
    }

    const evicted = this.tail;
    this.removeNode(evicted);
    this.cache.delete(evicted.key);
    this.currentMemoryBytes -= evicted.size;
    this.evictionCount++;

    LRUCache.logListener?.('debug', 'Evict entry', {
      cacheName: this.name,
      key: evicted.key,
      size: evicted.size,
      cacheSize: this.cache.size,
    });

    if (this.onEviction) {
      this.onEviction(evicted.key, evicted.value);
    }
  }

  /**
   * Estimates the memory size of a value using configurable accuracy modes:
   * - fast: O(1) heuristics based on type and property count (2-5x faster than JSON.stringify)
   * - balanced: Samples first N properties for better accuracy (moderate speed)
   * - accurate: Uses JSON.stringify for precise size (slowest, original behavior)
   */
  private estimateSize(value: T): number {
    try {
      switch (this.sizeEstimationMode) {
        case 'fast':
          return this.estimateSizeFast(value);
        case 'balanced':
          return this.estimateSizeBalanced(value);
        case 'accurate':
          return this.estimateSizeAccurate(value);
        default:
          return this.estimateSizeFast(value);
      }
    } catch {
      return LRUCache.OBJECT_BASE_OVERHEAD; // Fallback
    }
  }

  /**
   * Fast O(1) size estimation using heuristics
   * Achieves 2-5x speedup over JSON.stringify with reasonable accuracy (50-200%)
   */
  private estimateSizeFast(value: T): number {
    if (value === null || value === undefined) {
      return LRUCache.PRIMITIVE_SIZE;
    }

    const type = typeof value;

    if (type === 'string') {
      return (value as unknown as string).length * 2; // UTF-16 characters
    }

    if (type === 'number' || type === 'boolean') {
      return LRUCache.PRIMITIVE_SIZE;
    }

    if (Array.isArray(value)) {
      // Fast estimate: base overhead + element count * average element size
      // Assumes average element is ~64 bytes (works well for mixed content)
      return LRUCache.ARRAY_BASE_OVERHEAD + value.length * LRUCache.ELEMENT_ESTIMATE;
    }

    if (type === 'object') {
      // Fast estimate: base overhead + key count * average field overhead
      // Each field assumed to take ~48 bytes (key string + value + pointer)
      const keyCount = Object.keys(value as object).length;
      return LRUCache.OBJECT_BASE_OVERHEAD + keyCount * LRUCache.FIELD_OVERHEAD;
    }

    return LRUCache.OBJECT_BASE_OVERHEAD;
  }

  /**
   * Balanced estimation: Samples first N properties for improved accuracy
   * Provides better accuracy than fast mode with moderate performance cost
   */
  private estimateSizeBalanced(value: T): number {
    if (value === null || value === undefined) {
      return LRUCache.PRIMITIVE_SIZE;
    }

    const type = typeof value;

    if (type === 'string') {
      return (value as unknown as string).length * 2;
    }

    if (type === 'number' || type === 'boolean') {
      return LRUCache.PRIMITIVE_SIZE;
    }

    if (Array.isArray(value)) {
      const sampleSize = Math.min(value.length, LRUCache.BALANCED_SAMPLE_SIZE);
      if (sampleSize === 0) {
        return LRUCache.ARRAY_BASE_OVERHEAD;
      }

      // Sample first N elements and extrapolate
      let sampleTotal = 0;
      for (let i = 0; i < sampleSize; i++) {
        sampleTotal += this.estimateSizeFast(value[i]);
      }
      const avgSize = sampleTotal / sampleSize;
      return LRUCache.ARRAY_BASE_OVERHEAD + value.length * avgSize;
    }

    if (type === 'object') {
      const keys = Object.keys(value as object);
      const sampleSize = Math.min(keys.length, LRUCache.BALANCED_SAMPLE_SIZE);

      if (sampleSize === 0) {
        return LRUCache.OBJECT_BASE_OVERHEAD;
      }

      // Sample first N properties and extrapolate
      let sampleTotal = 0;
      for (let i = 0; i < sampleSize; i++) {
        const key = keys[i];
        const propValue = (value as any)[key];
        // Key size + value size + pointer overhead
        sampleTotal += key.length * 2 + this.estimateSizeFast(propValue) + 16;
      }
      const avgFieldSize = sampleTotal / sampleSize;
      return LRUCache.OBJECT_BASE_OVERHEAD + keys.length * avgFieldSize;
    }

    return LRUCache.OBJECT_BASE_OVERHEAD;
  }

  /**
   * Accurate estimation using JSON.stringify (original behavior)
   * Slowest but most accurate, O(n) where n is the size of the object
   */
  private estimateSizeAccurate(value: T): number {
    if (value === null || value === undefined) {
      return LRUCache.PRIMITIVE_SIZE;
    }

    if (typeof value === 'string') {
      return (value as unknown as string).length * 2;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return LRUCache.PRIMITIVE_SIZE;
    }

    if (Array.isArray(value)) {
      return value.reduce((acc, item) => acc + this.estimateSizeAccurate(item), LRUCache.ARRAY_BASE_OVERHEAD);
    }

    if (typeof value === 'object') {
      const jsonStr = JSON.stringify(value);
      return jsonStr.length * 2 + LRUCache.OBJECT_BASE_OVERHEAD;
    }

    return LRUCache.OBJECT_BASE_OVERHEAD;
  }
}

/**
 * Factory for creating optimized LRU caches for different use cases
 */
export class CacheFactory {
  /**
   * Create cache optimized for search results
   */
  static createSearchResultCache<T>(options?: Partial<LRUCacheOptions>): LRUCache<T> {
    return new LRUCache<T>({
      maxSize: 100,
      maxMemoryMB: 10,
      ttlMs: 5 * 60 * 1000, // 5 minutes
      ...options
    });
  }

  /**
   * Create cache optimized for index data
   */
  static createIndexCache<T>(options?: Partial<LRUCacheOptions>): LRUCache<T> {
    return new LRUCache<T>({
      maxSize: 50,
      maxMemoryMB: 25,
      ttlMs: 15 * 60 * 1000, // 15 minutes
      ...options
    });
  }

  /**
   * Create cache optimized for API responses
   */
  static createAPICache<T>(options?: Partial<LRUCacheOptions>): LRUCache<T> {
    return new LRUCache<T>({
      maxSize: 200,
      maxMemoryMB: 5,
      ttlMs: 10 * 60 * 1000, // 10 minutes
      ...options
    });
  }
}