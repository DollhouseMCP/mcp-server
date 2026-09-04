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
  getCacheNamespace(): string;
}

export class ElementCache<T extends IElement> {
  /** Primary cache: namespace + runtime ID + storage path → Element. */
  readonly elements: LRUCache<T>;
  /**
   * Storage-identity index: Absolute FilePath → primary-cache key.
   *
   * Runtime IDs are derived from a name slug and timestamp, so distinct
   * elements can collide when they are constructed in the same millisecond.
   * Including the storage path in the primary key keeps those entries distinct.
   * Path lookups always dereference the primary cache so its TTL and eviction
   * policy remain authoritative.
   */
  private readonly filePathToId: LRUCache<string>;
  /** Durable reverse metadata for rebuilding an independently-expired path index. */
  private readonly elementKeyToPaths = new Map<string, Set<string>>();
  /** O(1) durable path lookup used to rebuild an expired LRU path entry. */
  private readonly pathToElementKey = new Map<string, string>();
  /** O(1) object-identity lookup when one parsed element is bound to another path. */
  private readonly elementToKey = new WeakMap<T, string>();
  /** Scoped runtime ID → primary keys; normally one entry, collision-safe by design. */
  private readonly elementIdToKeys = new Map<string, Set<string>>();
  /** Primary key → scoped runtime ID, used for O(1) eviction cleanup. */
  private readonly elementKeyToId = new Map<string, string>();
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
      onEviction: (elementKey, element) => this.removeElementKeyMetadata(elementKey, element),
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

  private key(rawKey: string): string {
    return `${this.host.getCacheNamespace()}:${rawKey}`;
  }

  private keyPrefix(): string {
    return `${this.host.getCacheNamespace()}:`;
  }

  private elementKey(elementId: string, absolutePath: string): string {
    return this.key(`${elementId}:${absolutePath}`);
  }

  private removeElementKeyMetadata(elementKey: string, element: T): void {
    const pathKeys = this.elementKeyToPaths.get(elementKey);
    this.elementKeyToPaths.delete(elementKey);
    this.elementGenerations.delete(elementKey);
    if (this.elementToKey.get(element) === elementKey) {
      this.elementToKey.delete(element);
    }
    const elementIdKey = this.elementKeyToId.get(elementKey);
    this.elementKeyToId.delete(elementKey);
    if (elementIdKey) {
      const elementKeys = this.elementIdToKeys.get(elementIdKey);
      elementKeys?.delete(elementKey);
      if (elementKeys?.size === 0) this.elementIdToKeys.delete(elementIdKey);
    }
    for (const pathKey of pathKeys ?? []) {
      if (this.pathToElementKey.get(pathKey) === elementKey) {
        this.pathToElementKey.delete(pathKey);
      }
      if (this.filePathToId.get(pathKey) === elementKey) {
        this.filePathToId.delete(pathKey);
      }
    }
  }

  private findElementKeyByPath(pathKey: string): string | undefined {
    const elementKey = this.pathToElementKey.get(pathKey);
    if (!elementKey) return undefined;
    const element = this.elements.get(elementKey);
    if (!element) return undefined;
    this.filePathToId.set(pathKey, elementKey);
    return elementKey;
  }

  private attachPathMetadata(element: T, relativePath: string): void {
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

  private retireConflictingEntries(element: T, pathKey: string, elementKey: string): void {
    const existingElementKey = this.filePathToId.get(pathKey)
      ?? this.findElementKeyByPath(pathKey);
    if (existingElementKey && existingElementKey !== elementKey) {
      this.elements.delete(existingElementKey);
    }

    // LRUCache.set() replaces an existing value in place and therefore does
    // not invoke onEviction. Retire the displaced object's reverse identity
    // explicitly before overwriting the shared primary key.
    const displacedElement = this.elements.get(elementKey);
    if (
      displacedElement
      && displacedElement !== element
      && this.elementToKey.get(displacedElement) === elementKey
    ) {
      this.elementToKey.delete(displacedElement);
    }
  }

  private bindElementPath(elementKey: string, pathKey: string): void {
    const pathKeys = this.elementKeyToPaths.get(elementKey) ?? new Set<string>();
    // One parsed element represents one durable storage path at a time. When
    // it is rebound, discard obsolete path aliases so secondary metadata stays
    // bounded and cannot resolve the element through a stale location.
    for (const oldPathKey of pathKeys) {
      if (oldPathKey === pathKey) continue;
      if (this.pathToElementKey.get(oldPathKey) === elementKey) {
        this.pathToElementKey.delete(oldPathKey);
      }
      if (this.filePathToId.get(oldPathKey) === elementKey) {
        this.filePathToId.delete(oldPathKey);
      }
      pathKeys.delete(oldPathKey);
    }
    pathKeys.add(pathKey);
    this.elementKeyToPaths.set(elementKey, pathKeys);
    this.pathToElementKey.set(pathKey, elementKey);
  }

  private bindElementId(element: T, elementKey: string): void {
    this.elementToKey.set(element, elementKey);
    const elementIdKey = this.key(element.id);
    const elementKeys = this.elementIdToKeys.get(elementIdKey) ?? new Set<string>();
    elementKeys.add(elementKey);
    this.elementIdToKeys.set(elementIdKey, elementKeys);
    this.elementKeyToId.set(elementKey, elementIdKey);
  }

  /**
   * Adds an element to both caches (bidirectional mapping).
   * Also stamps `filename` and `filePath` onto the element object.
   */
  cacheElement(element: T, filePath: string): void {
    const absolutePath = this.host.resolveAbsolutePath(filePath);

    const relativePath = path.isAbsolute(filePath)
      ? path.relative(this.host.elementDir, filePath)
      : filePath;
    this.attachPathMetadata(element, relativePath);

    const pathKey = this.key(absolutePath);
    const indexedElementKey = this.elementToKey.get(element);
    const existingKeyForElement = indexedElementKey?.startsWith(this.keyPrefix())
      ? indexedElementKey
      : undefined;
    const elementKey = existingKeyForElement ?? this.elementKey(element.id, absolutePath);
    this.retireConflictingEntries(element, pathKey, elementKey);
    this.bindElementPath(elementKey, pathKey);
    this.bindElementId(element, elementKey);
    this.elements.set(elementKey, element);
    if (!this.elements.has(elementKey)) return;
    this.filePathToId.set(pathKey, elementKey);
    if (!this.elements.has(elementKey)) {
      this.filePathToId.delete(pathKey);
      return;
    }
    const generation = ++this.cacheGenerationCounter;
    this.elementGenerations.set(elementKey, generation);
  }

  /**
   * Removes an element from both caches by file path.
   */
  uncacheByPath(filePath: string): void {
    const absolutePath = this.host.resolveAbsolutePath(filePath);
    const pathKey = this.key(absolutePath);
    const elementKey = this.filePathToId.get(pathKey)
      ?? this.findElementKeyByPath(pathKey);

    if (elementKey !== undefined) {
      this.elements.delete(elementKey);
      logger.debug(`Uncached element ${elementKey} from ${absolutePath}`);
    }
    this.filePathToId.delete(pathKey);
  }

  /**
   * Look up a cached element by its absolute file path.
   */
  getCachedByAbsolutePath(absolutePath: string): T | undefined {
    const resolvedPath = this.host.resolveAbsolutePath(absolutePath);
    const pathKey = this.key(resolvedPath);
    const elementKey = this.filePathToId.get(pathKey)
      ?? this.findElementKeyByPath(pathKey);
    if (!elementKey) return undefined;

    const element = this.elements.get(elementKey);
    if (!element) this.filePathToId.delete(pathKey);
    return element;
  }

  getCachedByPath(filePath: string): T | undefined {
    return this.getCachedByAbsolutePath(filePath);
  }

  /**
   * Trigger LRU bookkeeping for an element ID already known to be cached.
   * Promotes the entry to most-recently-used and bumps the LRU's internal
   * hit counter. Use after a `getScopedValues()`-based iteration when the
   * caller has identified the matching element but still needs the LRU to
   * see the access.
   */
  touchById(id: string): T | undefined {
    for (const elementKey of this.elementIdToKeys.get(this.key(id)) ?? []) {
      const liveElement = this.elements.get(elementKey);
      if (liveElement) return liveElement;
    }
    return undefined;
  }

  getScopedValues(): T[] {
    const prefix = this.keyPrefix();
    return this.elements
      .entries()
      .filter(([key]) => key.startsWith(prefix))
      .map(([, element]) => element);
  }

  /**
   * Return the generation number for an element ID (used in event payloads).
   */
  getGeneration(elementId: string): number | undefined {
    let latest: number | undefined;
    for (const elementKey of this.elementIdToKeys.get(this.key(elementId)) ?? []) {
      if (!this.elements.get(elementKey)) continue;
      const generation = this.elementGenerations.get(elementKey);
      if (generation !== undefined && (latest === undefined || generation > latest)) {
        latest = generation;
      }
    }
    return latest;
  }

  /**
   * Clear all caches and the generation counter.
   */
  clear(): void {
    this.elements.clear();
    this.filePathToId.clear();
    this.elementKeyToPaths.clear();
    this.pathToElementKey.clear();
    this.elementIdToKeys.clear();
    this.elementKeyToId.clear();
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
