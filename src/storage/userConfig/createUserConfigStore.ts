/**
 * createUserConfigStore — backend-selection factory for `IUserConfigStore`.
 *
 * Mirrors `createOperatorConfigStore`: explicit option > NODE_ENV=test
 * > DOLLHOUSE_STORAGE_BACKEND env var > filesystem default.
 *
 * Backend names match the storage-domain convention:
 *   - 'memory'     — InMemoryUserConfigStore (tests, dev opt-in)
 *   - 'filesystem' — FilesystemUserConfigStore (default)
 *   - 'postgres'   — PostgresUserConfigStore (when DOLLHOUSE_STORAGE_BACKEND=database)
 *
 * Postgres backend requires a `DatabaseInstance` — the caller resolves
 * it from the DI container ('DatabaseInstance' key) and forwards.
 *
 * @module storage/userConfig/createUserConfigStore
 */

import * as path from 'node:path';

import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { resolveDataDirectory } from '../../paths/resolveDataDirectory.js';
import type { DatabaseInstance } from '../../database/connection.js';
import type { IFileOperationsService } from '../../services/FileOperationsService.js';
import type { IUserConfigStore } from './IUserConfigStore.js';
import { InMemoryUserConfigStore } from './InMemoryUserConfigStore.js';
import { FilesystemUserConfigStore } from './FilesystemUserConfigStore.js';

export type UserConfigBackend = 'memory' | 'filesystem' | 'postgres';

export interface CreateUserConfigStoreOptions {
  /** Force a specific backend; bypasses env-var detection. */
  backend?: UserConfigBackend;
  /** Override storage root for the filesystem backend (tests pass a tmpdir). */
  rootDir?: string;
  /** Forwarded to `resolveDataDirectory` for legacy `~/.dollhouse/` layout detection. */
  legacyRoot?: string;
  /**
   * Drizzle DB instance, required when backend='postgres'. Resolved from
   * the DI container ('DatabaseInstance') in production wiring.
   */
  database?: DatabaseInstance;
  fileOperations?: IFileOperationsService;
}

export async function createUserConfigStore(
  options: CreateUserConfigStoreOptions = {},
): Promise<IUserConfigStore> {
  const backend = pickBackend(options);

  switch (backend) {
    case 'memory':
      logger.info('[UserConfigStore] backend=memory (in-process state, lost on restart)');
      return new InMemoryUserConfigStore();

    case 'filesystem': {
      const rootDir = options.rootDir
        ?? path.join(resolveDataDirectory('state', { legacyRoot: options.legacyRoot }), 'user');
      logger.info('[UserConfigStore] backend=filesystem', { rootDir });
      return new FilesystemUserConfigStore({ rootDir, fileOperations: options.fileOperations });
    }

    case 'postgres': {
      if (!options.database) {
        throw new Error(
          'DOLLHOUSE_STORAGE_BACKEND=database requires a DatabaseInstance for the user ' +
          'config store. The DI container should resolve "DatabaseInstance" before constructing ' +
          'the store. If you are running a memory/filesystem deployment, do not select the ' +
          'database backend.',
        );
      }
      // Lazy import so memory/filesystem deployments don't pay the Drizzle cost.
      const { PostgresUserConfigStore } = await import('./PostgresUserConfigStore.js');
      logger.info('[UserConfigStore] backend=postgres');
      return new PostgresUserConfigStore({ db: options.database });
    }
  }
}

function pickBackend(options: CreateUserConfigStoreOptions): UserConfigBackend {
  if (options.backend) return options.backend;
  if (env.NODE_ENV === 'test') return 'memory';
  if (env.DOLLHOUSE_STORAGE_BACKEND === 'database') return 'postgres';
  return 'filesystem';
}
