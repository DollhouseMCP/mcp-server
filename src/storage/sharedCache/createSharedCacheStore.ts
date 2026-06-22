/**
 * createSharedCacheStore — backend-selection factory for `ISharedCacheStore`.
 *
 * Same selection logic as `createOperatorConfigStore`:
 *   1. Explicit `backend` option (test injection).
 *   2. `NODE_ENV === 'test'` → 'memory'.
 *   3. `DOLLHOUSE_STORAGE_BACKEND === 'database'` → 'postgres'.
 *   4. Default → 'filesystem'.
 *
 * Postgres backend requires a `DatabaseInstance` from the DI container.
 *
 * @module storage/sharedCache/createSharedCacheStore
 */

import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { resolveDataDirectory } from '../../paths/resolveDataDirectory.js';
import type { DatabaseInstance } from '../../database/connection.js';
import type { ISharedCacheStore } from './ISharedCacheStore.js';
import { InMemorySharedCacheStore } from './InMemorySharedCacheStore.js';
import { FilesystemSharedCacheStore } from './FilesystemSharedCacheStore.js';

export type SharedCacheBackend = 'memory' | 'filesystem' | 'postgres';

export interface CreateSharedCacheStoreOptions {
  /** Force a specific backend; bypasses env-var detection. */
  backend?: SharedCacheBackend;
  /** Override storage root for the filesystem backend (tests pass a tmpdir). */
  rootDir?: string;
  /** Forwarded to `resolveDataDirectory` for legacy `~/.dollhouse/cache/` layout. */
  legacyRoot?: string;
  /**
   * Drizzle DB instance, required when backend='postgres'. Resolved from
   * the DI container ('DatabaseInstance') in production wiring.
   */
  database?: DatabaseInstance;
}

export async function createSharedCacheStore(
  options: CreateSharedCacheStoreOptions = {},
): Promise<ISharedCacheStore> {
  const backend = pickBackend(options);

  switch (backend) {
    case 'memory':
      logger.info('[SharedCacheStore] backend=memory (in-process state, lost on restart)');
      return new InMemorySharedCacheStore();

    case 'filesystem': {
      // Use the existing 'cache' subdir so legacy `~/.dollhouse/cache/`
      // layouts continue to work. Distinct from 'state' (auth, config)
      // because cache is operationally different — wipeable, regeneratable
      // from the network — and operators may want it on a different mount.
      const rootDir = options.rootDir
        ?? resolveDataDirectory('cache', { legacyRoot: options.legacyRoot });
      logger.info('[SharedCacheStore] backend=filesystem', { rootDir });
      return new FilesystemSharedCacheStore({ rootDir });
    }

    case 'postgres': {
      if (!options.database) {
        throw new Error(
          'DOLLHOUSE_STORAGE_BACKEND=database requires a DatabaseInstance for the shared ' +
          'cache store. The DI container should resolve "DatabaseInstance" before constructing ' +
          'the store.',
        );
      }
      const { PostgresSharedCacheStore } = await import('./PostgresSharedCacheStore.js');
      logger.info('[SharedCacheStore] backend=postgres');
      return new PostgresSharedCacheStore({ db: options.database });
    }
  }
}

function pickBackend(options: CreateSharedCacheStoreOptions): SharedCacheBackend {
  if (options.backend) return options.backend;
  if (env.NODE_ENV === 'test') return 'memory';
  if (env.DOLLHOUSE_STORAGE_BACKEND === 'database') return 'postgres';
  return 'filesystem';
}
