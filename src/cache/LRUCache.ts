/**
 * High-performance LRU Cache with memory monitoring and automatic cleanup
 * Optimized for large-scale indexing operations with configurable memory limits
 */

import { logger } from '../utils/logger.js';

export interface LRUCacheOptions {
  maxSize: number;
  maxMemoryMB?: number;
  ttlMs?: number;
  onEviction?: (key: string, value: any) => void;
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
  private readonly maxSize: number;
  private readonly maxMemoryBytes: number;
  private readonly ttlMs: number;
  private readonly onEviction?: (key: string, value: T) => void;

  private cache = new Map<string, CacheNode<T>>();
  private head: CacheNode<T> | null = null;
  private tail: CacheNode<T> | null = null;
  private currentMemoryBytes = 0;

  // Performance counters
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  constructor(options: LRUCacheOptions) {
    this.maxSize = options.maxSize;
    this.maxMemoryBytes = (options.maxMemoryMB || 50) * 1024 * 1024; // Convert MB to bytes
    this.ttlMs = options.ttlMs || 0; // 0 means no TTL
    this.onEviction = options.onEviction;
  }

  /**
   * Get value from cache with automatic cleanup
   */
  get(key: string): T | null {
    const node = this.cache.get(key);
    
    if (!node) {
      this.missCount++;
      return null;
    }

    // Check TTL if enabled
    if (this.ttlMs > 0 && Date.now() - node.timestamp > this.ttlMs) {
      this.delete(key);
      this.missCount++;
      return null;
    }

    // Move to front (most recently used)
    this.moveToFront(node);
    this.hitCount++;
    return node.value;
  }

  /**
   * Set value in cache with automatic eviction
   */
  set(key: string, value: T): void {
    const existingNode = this.cache.get(key);
    
    if (existingNode) {
      // Update existing node
      const oldSize = existingNode.size;
      existingNode.value = value;
      existingNode.timestamp = Date.now();
      existingNode.size = this.estimateSize(value);
      
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
        size: this.estimateSize(value)
      };

      this.cache.set(key, newNode);
      this.currentMemoryBytes += newNode.size;
      this.addToFront(newNode);
    }

    // Evict if necessary
    this.evictIfNecessary();
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
    if (this.onEviction) {
      for (const [key, node] of this.cache) {
        this.onEviction(key, node.value);
      }
    }

    this.cache.clear();
    this.head = null;
    this.tail = null;
    this.currentMemoryBytes = 0;
    this.evictionCount += this.cache.size;
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
   */
  keys(): string[] {
    const keys: string[] = [];
    let current = this.head;
    
    while (current) {
      keys.push(current.key);
      current = current.next;
    }
    
    return keys;
  }

  /**
   * Get current memory usage in MB
   */
  getMemoryUsageMB(): number {
    return this.currentMemoryBytes / (1024 * 1024);
  }

  /**
   * Manually trigger cleanup of expired entries
   */
  cleanup(): number {
    if (this.ttlMs <= 0) {
      return 0;
    }

    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, node] of this.cache) {
      if (now - node.timestamp > this.ttlMs) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.delete(key);
    }

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
    while (this.currentMemoryBytes > this.maxMemoryBytes && this.tail) {
      this.evictLeastRecentlyUsed();
    }

    // Cleanup expired entries if TTL is enabled
    if (this.ttlMs > 0 && Math.random() < 0.1) { // 10% chance to trigger cleanup
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

    if (this.onEviction) {
      this.onEviction(evicted.key, evicted.value);
    }
  }

  private estimateSize(value: T): number {
    try {
      // Simple estimation - can be improved with more sophisticated sizing
      if (value === null || value === undefined) {
        return 8; // Basic pointer size
      }

      if (typeof value === 'string') {
        return value.length * 2; // UTF-16 characters
      }

      if (typeof value === 'number' || typeof value === 'boolean') {
        return 8;
      }

      if (Array.isArray(value)) {
        return value.reduce((acc, item) => acc + this.estimateSize(item), 32); // Array overhead
      }

      if (typeof value === 'object') {
        // Rough estimation for objects
        const jsonStr = JSON.stringify(value);
        return jsonStr.length * 2 + 64; // String size + object overhead
      }

      return 64; // Default size for unknown types
    } catch {
      return 64; // Fallback size
    }
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