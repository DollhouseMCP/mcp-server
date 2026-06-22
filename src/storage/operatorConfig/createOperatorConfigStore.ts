/**
 * createOperatorConfigStore — backend-selection factory for `IOperatorConfigStore`.
 *
 * Mirrors `createAuthStorage`: explicit option > env var > NODE_ENV=test
 * > filesystem default. Backend names match auth's nomenclature even
 * though the user-facing env var (`DOLLHOUSE_STORAGE_BACKEND`) uses
 * 'file' / 'database' as values.
 *
 * Resolution:
 *   1. Explicit `backend` option (test injection).
 *   2. `NODE_ENV === 'test'` → 'memory' (no disk artifacts).
 *   3. `DOLLHOUSE_STORAGE_BACKEND === 'database'` → 'postgres'.
 *   4. Default → 'filesystem'.
 *
 * Note the env var maps `'file'` → `'filesystem'` and `'database'` →
 * `'postgres'` internally. The internal names match the storage-domain
 * convention (also used in `createAuthStorage`'s
 * `AuthStorageBackend = 'memory' | 'filesystem' | 'postgres'`).
 *
 * Postgres backend requires a `DatabaseInstance` — the caller resolves
 * it from the DI container ('DatabaseInstance' key) and forwards.
 *
 * @module storage/operatorConfig/createOperatorConfigStore
 */

import * as path from 'node:path';

import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { resolveDataDirectory } from '../../paths/resolveDataDirectory.js';
import type { DatabaseInstance } from '../../database/connection.js';
import type { IOperatorConfigStore } from './IOperatorConfigStore.js';
import { InMemoryOperatorConfigStore } from './InMemoryOperatorConfigStore.js';
import { FilesystemOperatorConfigStore } from './FilesystemOperatorConfigStore.js';

export type OperatorConfigBackend = 'memory' | 'filesystem' | 'postgres';

export interface CreateOperatorConfigStoreOptions {
  /** Force a specific backend; bypasses env-var detection. */
  backend?: OperatorConfigBackend;
  /** Override storage root for the filesystem backend (tests pass a tmpdir). */
  rootDir?: string;
  /** Forwarded to `resolveDataDirectory` for legacy `~/.dollhouse/` layout detection. */
  legacyRoot?: string;
  /**
   * Drizzle DB instance, required when backend='postgres'. Resolved from
   * the DI container ('DatabaseInstance') in production wiring.
   */
  database?: DatabaseInstance;
}

export async function createOperatorConfigStore(
  options: CreateOperatorConfigStoreOptions = {},
): Promise<IOperatorConfigStore> {
  const backend = pickBackend(options);

  switch (backend) {
    case 'memory':
      logger.info('[OperatorConfigStore] backend=memory (in-process state, lost on restart)');
      return new InMemoryOperatorConfigStore();

    case 'filesystem': {
      const rootDir = options.rootDir
        ?? path.join(resolveDataDirectory('state', { legacyRoot: options.legacyRoot }), 'operator');
      logger.info('[OperatorConfigStore] backend=filesystem', { rootDir });
      return new FilesystemOperatorConfigStore({ rootDir });
    }

    case 'postgres': {
      if (!options.database) {
        throw new Error(
          'DOLLHOUSE_STORAGE_BACKEND=database requires a DatabaseInstance for the operator ' +
          'config store. The DI container should resolve "DatabaseInstance" before constructing ' +
          'the store. If you are running a memory/filesystem deployment, do not select the ' +
          'database backend.',
        );
      }
      // Lazy import so memory/filesystem deployments don't pay the Drizzle cost.
      const { PostgresOperatorConfigStore } = await import('./PostgresOperatorConfigStore.js');
      logger.info('[OperatorConfigStore] backend=postgres');
      return new PostgresOperatorConfigStore({ db: options.database });
    }
  }
}

function pickBackend(options: CreateOperatorConfigStoreOptions): OperatorConfigBackend {
  if (options.backend) return options.backend;
  if (env.NODE_ENV === 'test') return 'memory';
  if (env.DOLLHOUSE_STORAGE_BACKEND === 'database') return 'postgres';
  return 'filesystem';
}
