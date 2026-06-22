/**
 * createSigningKeyStore — backend-selection factory for `ISigningKeyStore`.
 *
 * Backend selection pairs with **auth storage**, not element storage,
 * because signing keys are AS-internal (alongside `auth_kv` and
 * `auth_accounts`). Resolution:
 *   1. Explicit `backend` option (test injection).
 *   2. `NODE_ENV === 'test'` → 'memory'.
 *   3. `DOLLHOUSE_AUTH_STORAGE_BACKEND === 'postgres'` → 'postgres'.
 *   4. Default → 'filesystem'.
 *
 * @module storage/signingKeys/createSigningKeyStore
 */

import * as path from 'node:path';

import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { resolveDataDirectory } from '../../paths/resolveDataDirectory.js';
import type { DatabaseInstance } from '../../database/connection.js';
import type { ISigningKeyStore } from './ISigningKeyStore.js';
import { InMemorySigningKeyStore } from './InMemorySigningKeyStore.js';
import { FilesystemSigningKeyStore } from './FilesystemSigningKeyStore.js';

export type SigningKeyBackend = 'memory' | 'filesystem' | 'postgres';

export interface CreateSigningKeyStoreOptions {
  backend?: SigningKeyBackend;
  /** Override storage root for the filesystem backend; defaults to the auth state dir. */
  rootDir?: string;
  legacyRoot?: string;
  /**
   * Drizzle DB instance, required when backend='postgres'. Resolved from
   * the DI container ('DatabaseInstance') in production wiring.
   */
  database?: DatabaseInstance;
}

export async function createSigningKeyStore(
  options: CreateSigningKeyStoreOptions = {},
): Promise<ISigningKeyStore> {
  const backend = pickBackend(options);

  switch (backend) {
    case 'memory':
      logger.info('[SigningKeyStore] backend=memory (in-process state, lost on restart)');
      return new InMemorySigningKeyStore();

    case 'filesystem': {
      // Co-locate with the auth state dir — signing keys + bootstrap +
      // accounts are all AS infrastructure. Operators backing up auth
      // state get the keys for free.
      const rootDir = options.rootDir
        ?? path.join(resolveDataDirectory('state', { legacyRoot: options.legacyRoot }), 'auth');
      logger.info('[SigningKeyStore] backend=filesystem', { rootDir });
      return new FilesystemSigningKeyStore({ rootDir });
    }

    case 'postgres': {
      if (!options.database) {
        throw new Error(
          'DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres requires a DatabaseInstance for the signing ' +
          'key store. The DI container should resolve "DatabaseInstance" before constructing ' +
          'the store. Same constraint as the auth storage layer — see createAuthStorage error.',
        );
      }
      const { PostgresSigningKeyStore } = await import('./PostgresSigningKeyStore.js');
      logger.info('[SigningKeyStore] backend=postgres');
      return new PostgresSigningKeyStore({ db: options.database });
    }
  }
}

function pickBackend(options: CreateSigningKeyStoreOptions): SigningKeyBackend {
  if (options.backend) return options.backend;
  if (env.NODE_ENV === 'test') return 'memory';
  if (env.DOLLHOUSE_AUTH_STORAGE_BACKEND === 'postgres') return 'postgres';
  return 'filesystem';
}
