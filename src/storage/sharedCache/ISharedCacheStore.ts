/**
 * ISharedCacheStore
 *
 * Operator-shared cache for network-fetched payloads that are NOT per-user.
 * First consumer is `CollectionIndexManager` (today: filesystem cache at
 * `~/.dollhouse/cache/collection-index.json`; this store replaces that
 * file in DB-backend mode).
 *
 * Mirrors the shape of `IAuthStorageLayer`'s generic K/V escape hatch
 * but with first-class HTTP conditional-refresh fields (etag, lastModified)
 * since the cache exists to make conditional re-fetches cheap.
 *
 * Three backends (InMemory + Filesystem + Postgres), backend selected by
 * `createSharedCacheStore`. All three pass
 * `tests/integration/storage/shared-cache-parity.test.ts`.
 *
 * @module storage/sharedCache/ISharedCacheStore
 */

/**
 * A cache entry as returned by `get()`. Includes timestamps so callers can
 * apply their own TTL logic (e.g. `CollectionIndexManager` refreshes at
 * 80% of its TTL window).
 */
export interface SharedCacheEntry {
  cacheKey: string;
  /** The cached value (typically a JSON-serializable object). */
  payload: unknown;
  /** HTTP `ETag` from the upstream response — used for `If-None-Match` on refresh. */
  etag?: string;
  /** HTTP `Last-Modified` from the upstream response — used for `If-Modified-Since`. */
  lastModified?: string;
  /** Optional payload version (e.g. CollectionIndex's `version` field). */
  version?: string;
  /** Optional payload checksum for cheap equality / corruption checks. */
  checksum?: string;
  /** Epoch ms of the most recent `set()`. Populated by the implementation. */
  fetchedAt: number;
  /** Epoch ms when the entry should be considered stale. `null`/`undefined` = no TTL. */
  expiresAt?: number;
}

/**
 * Write-side payload. `fetchedAt` is stamped by the implementation on
 * every `set()`; the caller never supplies it. `expiresAt` is optional —
 * when omitted, the entry has no TTL and lives until explicitly deleted
 * or until `sweepExpired()` finds nothing to delete.
 */
export interface SharedCacheWriteEntry {
  cacheKey: string;
  payload: unknown;
  etag?: string;
  lastModified?: string;
  version?: string;
  checksum?: string;
  expiresAt?: number;
}

/**
 * Storage contract for the shared cache. All methods async.
 *
 * Atomicity / consistency per backend:
 *   - InMemory: synchronous Map.get / Map.set / Map.delete.
 *   - Filesystem: one file per cache_key under `<rootDir>/<sanitized-key>.json`,
 *     atomic write-temp + rename via `FileLockManager`.
 *   - Postgres: single-statement `INSERT ... ON CONFLICT (cache_key) DO UPDATE`.
 *
 * `get()` returns whatever is stored — it does NOT auto-expire. Callers
 * inspect `expiresAt` themselves and decide whether to use the value.
 * (Auto-expiry-on-get would surprise consumers who want to inspect the
 * stale value to re-validate via `If-None-Match` rather than re-fetch.)
 */
export interface ISharedCacheStore {
  /**
   * Read a cache entry by key. Returns `null` when no entry exists for
   * the key. Does NOT filter expired entries — see contract note above.
   */
  get(cacheKey: string): Promise<SharedCacheEntry | null>;

  /**
   * Upsert a cache entry. Replaces any existing entry at the same
   * `cacheKey`. `fetchedAt` is stamped by the implementation.
   */
  set(entry: SharedCacheWriteEntry): Promise<void>;

  /**
   * Delete an entry by key. Returns `true` if a row was removed,
   * `false` if no row existed for the key.
   */
  delete(cacheKey: string): Promise<boolean>;

  /**
   * Bulk-delete all entries with `expiresAt < now`. Returns the count
   * removed. Idempotent and safe to call concurrently. Operators
   * running long-lived deployments should call this on a timer
   * (recommended via `LifecycleService`, ~every 1-6 hours).
   */
  sweepExpired(): Promise<number>;
}
