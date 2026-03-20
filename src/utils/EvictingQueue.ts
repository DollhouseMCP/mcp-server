/**
 * A bounded FIFO queue that evicts the oldest item when at capacity.
 *
 * Wraps a plain array with push/shift semantics — the standard pattern
 * for bounded event logs where reads (.filter, .slice, .map, for...of)
 * dominate. V8 already optimizes Array.shift() for this pattern.
 */
export class EvictingQueue<T> {
  private items: T[] = [];

  constructor(private readonly maxSize: number) {
    if (maxSize < 1) throw new Error('EvictingQueue capacity must be >= 1');
  }

  /** Add an item. If at capacity, the oldest item is evicted. */
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.maxSize) {
      this.items.shift();
    }
  }

  /** Number of items currently in the queue. */
  get size(): number { return this.items.length; }

  /** Maximum capacity. */
  get capacity(): number { return this.maxSize; }

  /** Get the underlying array (read-only view). Oldest first. */
  toArray(): readonly T[] { return this.items; }

  /** Remove all items. */
  clear(): void { this.items = []; }

  /** Replace contents with a new array (for time-based pruning). */
  reset(items: T[]): void {
    this.items = items.length > this.maxSize
      ? items.slice(-this.maxSize)
      : [...items];
  }

  /** Support for...of iteration. */
  [Symbol.iterator](): Iterator<T> { return this.items[Symbol.iterator](); }

  /** JSON serialization — produces plain array. */
  toJSON(): T[] { return [...this.items]; }
}
