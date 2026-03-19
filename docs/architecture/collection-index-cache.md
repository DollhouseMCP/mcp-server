# Collection Index Cache

**Last Updated:** October 2025  
**Audience:** Engineers touching community collection search or caching behavior.  
**Primary file:** `src/cache/CollectionIndexCache.ts`

---

## 1. Purpose

`CollectionIndexCache` provides a resilient client for the community collection index (`https://dollhousemcp.github.io/collection/collection-index.json`). It ensures:

- Minimal network usage via conditional requests (ETag / Last-Modified).  
- Graceful degradation using disk snapshots when offline.  
- Consistent API for callers (`getIndex()`).

It supplies data to `UnifiedIndexManager` and `CollectionSearch` so `search_all` and collection browsing work without pausing on every call.

---

## 2. Cache Layers

1. **In-memory LRU (`memoryCache`)** – fastest path; TTL default 5 minutes.  
2. **In-process snapshot (`this.cache`)** – retains last loaded index with fetched-at timestamp.  
3. **Persistent disk cache** – stored under `~/.dollhousemcp/cache/collection-index-cache.json`. Used when network fetch fails.

---

## 3. Fetch Algorithm

`getIndex(lazyLoad?: boolean)` executes:

1. **Memory hit:** return if entry exists and still valid (`isValid()` uses TTL = 15 minutes).  
2. **Disk hit:** if in-memory is stale but disk snapshot still within TTL, load it.  
3. **In-flight fetch:** if another call is already fetching, await the same promise (`fetchPromise`).  
4. **Conditional network request:** use stored `etag` and `lastModified` headers; a 304 response updates timestamps without downloading body.  
5. **Fallback:** if network fails, attempt disk snapshot; otherwise throw error.

`lazyLoad` allows callers to accept stale cache (e.g., to avoid blocking UI) while a background fetch refreshes data.

---

## 4. Validation & Persistence

- `validateIndexStructure()` ensures the downloaded JSON conforms to `CollectionIndex` (basic shape check).  
- On successful fetch, data saves asynchronously to disk. Errors when writing are logged but do not fail the operation.

Security considerations:
- Unicode normalization performed via `UnicodeValidator` before writing (guarding against homoglyph attacks).  
- `SecurityMonitor` records path traversal attempts when loading from disk to prevent cache poisoning.

---

## 5. Configuration

- TTL (default 15 minutes) is hard-coded in the class but could be made configurable via `IndexConfigManager` in future.  
- `CacheFactory.createAPICache()` sets memory cache size (max 50 entries, ~10 MB).  
- Base directory defaults to `process.cwd()`; DI can override in tests.

---

## 6. Consumers

- `UnifiedIndexManager` – merges collection entries with local/GitHub results.  
- `CollectionSearch` – exposes collection-only search operations.

Both expect `CollectionIndexCache.getIndex()` to throw on unrecoverable errors so they can surface sanitized failures to the user.

---

## 7. Testing

- Unit tests live in `tests/unit/collection/CollectionIndexCache.test.ts`.  
- Integration tests should simulate offline mode by pre-populating the disk cache and verifying fallback logic.

---

## 8. Future Enhancements

- Support delta updates (apply small patches rather than re-downloading full index).  
- Expose metrics (hit rate, fetch latency) via `PerformanceMonitor`.  
- Allow manual refresh triggers (CLI command or MCP tool).
