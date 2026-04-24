/**
 * ElementCache - LRU cache management for element managers.
 *
 * Owns the two LRU caches (elements by ID, path-to-ID reverse index),
 * the generation counter, and all cache mutation/eviction helpers.
 * Extracted from BaseElementManager to reduce its size; behaviour is
 * identical — no logic changed, only locality.
 */

import { LRUCache } from '../../cache/LRUCache.js';
import { logger } from '../../utils/logger.js';
import { ElementType } from '../../portfolio/types.js';
import { IElement } from '../../types/elements/IElement.js';
import * as path from 'node:path';
import type { CacheMemoryBudget } from '../../cache/CacheMemoryBudget.js';

/**
 * Host interface: ElementCache calls back into BaseElementManager for
 * path resolution (resolveAbsolutePath lives on the base class because
 * it needs elementDir).
 */
export interface ElementCacheHost {
  resolveAbsolutePath(filePath: string): string;
  readonly elementDir: string;
}

export class ElementCache<T extends IElement> {
  /** Primary cache: ID → Element */
  readonly elements: LRUCache<T>;
  /** Reverse index: Absolute FilePath → Element ID */
  private readonly filePathToId: LRUCache<string>;
  private readonly elementGenerations = new Map<string, number>();
  private cacheGenerationCounter = 0;
  private readonly memoryBudget?: CacheMemoryBudget;

  private static readonly MAX_ELEMENT_CACHE_SIZE = 1000;
  private static readonly MAX_PATH_CACHE_SIZE = 1000;

  constructor(
    private readonly elementType: ElementType,
    private readonly host: ElementCacheHost,
    options: {
      elementCacheTTL: number;
      pathCacheTTL: number;
      memoryBudget?: CacheMemoryBudget;
    },
  ) {
    this.memoryBudget = options.memoryBudget;

    const onSetCallback = this.memoryBudget
      ? () => this.memoryBudget!.enforce()
      : undefined;

    this.elements = new LRUCache<T>({
      name: `elements:${elementType}`,
      maxSize: ElementCache.MAX_ELEMENT_CACHE_SIZE,
      maxMemoryMB: 50,
      ttlMs: options.elementCacheTTL,
      onSet: onSetCallback,
    });

    this.filePathToId = new LRUCache<string>({
      name: `pathIndex:${elementType}`,
      maxSize: ElementCache.MAX_PATH_CACHE_SIZE,
      maxMemoryMB: 10,
      ttlMs: options.pathCacheTTL,
      onSet: onSetCallback,
    });

    if (this.memoryBudget) {
      this.memoryBudget.register(this.elements);
      this.memoryBudget.register(this.filePathToId);
    }
  }

  /**
   * Adds an element to both caches (bidirectional mapping).
   * Also stamps `filename` and `filePath` onto the element object.
   */
  cacheElement(element: T, filePath: string): void {
    const absolutePath = this.host.resolveAbsolutePath(filePath);

    const existingId = this.filePathToId.get(absolutePath);
    if (existingId && existingId !== element.id) {
      this.elements.delete(existingId);
      this.elementGenerations.delete(existingId);
    }

    this.elements.set(element.id, element);
    this.filePathToId.set(absolutePath, element.id);
    const generation = ++this.cacheGenerationCounter;
    this.elementGenerations.set(element.id, generation);

    const relativePath = path.isAbsolute(filePath)
      ? path.relative(this.host.elementDir, filePath)
      : filePath;

    try {
      Object.defineProperty(element, 'filename', {
        value: path.basename(relativePath),
        writable: true,
        enumerable: true,
        configurable: true,
      });
      Object.defineProperty(element, 'filePath', {
        value: relativePath,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } catch (error) {
      logger.debug('Failed to attach filename metadata to element', {
        error: error instanceof Error ? error.message : String(error),
        elementId: element.id,
        filePath: relativePath,
      });
    }
  }

  /**
   * Removes an element from both caches by file path.
   */
  uncacheByPath(filePath: string): void {
    const absolutePath = this.host.resolveAbsolutePath(filePath);
    const elementId = this.filePathToId.get(absolutePath);

    if (elementId !== undefined) {
      this.elements.delete(elementId);
      this.filePathToId.delete(absolutePath);
      this.elementGenerations.delete(elementId);
      logger.debug(`Uncached element ${elementId} from ${absolutePath}`);
    }
  }

  /**
   * Look up a cached element by its absolute file path.
   */
  getCachedByAbsolutePath(absolutePath: string): T | undefined {
    const resolvedPath = this.host.resolveAbsolutePath(absolutePath);
    const elementId = this.filePathToId.get(resolvedPath);
    if (!elementId) return undefined;
    return this.elements.get(elementId);
  }

  /**
   * Return the generation number for an element ID (used in event payloads).
   */
  getGeneration(elementId: string): number | undefined {
    return this.elementGenerations.get(elementId);
  }

  /**
   * Clear all caches and the generation counter.
   */
  clear(): void {
    this.elements.clear();
    this.filePathToId.clear();
    this.elementGenerations.clear();
  }

  /**
   * Cache statistics for debugging.
   */
  getCacheStats(): { elementCount: number; pathMappings: number } {
    return {
      elementCount: this.elements.getStats().size,
      pathMappings: this.filePathToId.getStats().size,
    };
  }

  /**
   * Expose LRU instances for metrics collection.
   */
  getMetricsCaches(): Array<{ name: string; instance: LRUCache<unknown> }> {
    return [
      { name: `elements:${this.elementType}`, instance: this.elements as LRUCache<unknown> },
      { name: `pathIndex:${this.elementType}`, instance: this.filePathToId as LRUCache<unknown> },
    ];
  }

  /**
   * Unregister from the memory budget and clear all caches.
   */
  dispose(): void {
    if (this.memoryBudget) {
      this.memoryBudget.unregister(this.elements);
      this.memoryBudget.unregister(this.filePathToId);
    }
    this.clear();
  }
}
