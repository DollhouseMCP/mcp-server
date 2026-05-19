/**
 * InMemorySharedCacheStore
 *
 * Non-durable in-process backend keyed by cacheKey. Map of entries; lost
 * on restart. Tests + dev opt-in.
 *
 * @module storage/sharedCache/InMemorySharedCacheStore
 */

import type {
  ISharedCacheStore,
  SharedCacheEntry,
  SharedCacheWriteEntry,
} from './ISharedCacheStore.js';

export class InMemorySharedCacheStore implements ISharedCacheStore {
  private readonly entries = new Map<string, SharedCacheEntry>();

  async get(cacheKey: string): Promise<SharedCacheEntry | null> {
    assertValidCacheKey(cacheKey);
    const stored = this.entries.get(cacheKey);
    return stored ? cloneEntry(stored) : null;
  }

  async set(entry: SharedCacheWriteEntry): Promise<void> {
    assertValidCacheKey(entry.cacheKey);
    this.entries.set(entry.cacheKey, {
      cacheKey: entry.cacheKey,
      // Deep-clone the payload so caller mutations don't leak into stored state.
      payload: clonePayload(entry.payload),
      etag: entry.etag,
      lastModified: entry.lastModified,
      version: entry.version,
      checksum: entry.checksum,
      fetchedAt: Date.now(),
      expiresAt: entry.expiresAt,
    });
  }

  async delete(cacheKey: string): Promise<boolean> {
    assertValidCacheKey(cacheKey);
    return this.entries.delete(cacheKey);
  }

  async sweepExpired(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt < now) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

function cloneEntry(e: SharedCacheEntry): SharedCacheEntry {
  return {
    cacheKey: e.cacheKey,
    payload: clonePayload(e.payload),
    etag: e.etag,
    lastModified: e.lastModified,
    version: e.version,
    checksum: e.checksum,
    fetchedAt: e.fetchedAt,
    expiresAt: e.expiresAt,
  };
}

function clonePayload(p: unknown): unknown {
  // structuredClone handles plain objects, arrays, primitives, Date, Map, Set —
  // everything we'd reasonably cache. Throws on functions/closures (which is
  // the right behavior — they shouldn't be in a cache).
  return structuredClone(p);
}

// Cache keys live in URLs, file paths, and SQL identifiers. Restrict to
// a conservative set so any of those uses is safe without per-call escaping.
const CACHE_KEY_RE = /^[a-zA-Z0-9._-]{1,128}$/;
function assertValidCacheKey(cacheKey: string): void {
  if (typeof cacheKey !== 'string' || !CACHE_KEY_RE.test(cacheKey)) {
    throw new Error(
      `ISharedCacheStore: cacheKey must match /^[a-zA-Z0-9._-]{1,128}$/; got ${
        typeof cacheKey === 'string' ? `"${cacheKey}"` : typeof cacheKey
      }`,
    );
  }
}
