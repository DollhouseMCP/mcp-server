/**
 * Shared Cache Storage — barrel export.
 *
 * @module storage/sharedCache
 */

export {
  type ISharedCacheStore,
  type SharedCacheEntry,
  type SharedCacheWriteEntry,
} from './ISharedCacheStore.js';
export { InMemorySharedCacheStore } from './InMemorySharedCacheStore.js';
export { FilesystemSharedCacheStore } from './FilesystemSharedCacheStore.js';
export {
  type SharedCacheBackend,
  type CreateSharedCacheStoreOptions,
  createSharedCacheStore,
} from './createSharedCacheStore.js';
