/**
 * createAuthStorage — backend-selection factory for IAuthStorageLayer.
 *
 * Resolution order:
 *   1. Explicit `backend` option (test injection point).
 *   2. `DOLLHOUSE_AUTH_STORAGE_BACKEND` env var (`memory|filesystem|postgres`).
 *   3. `NODE_ENV === 'test'` → memory (no disk artifacts during tests).
 *   4. Default: `filesystem`.
 *
 * Three backends ship in §8.1:
 *   - InMemoryAuthStorageLayer — solo dev / tests; non-durable.
 *   - FilesystemAuthStorageLayer — atomic-write + lock under
 *     `resolveDataDirectory('state')` (XDG / Library / LOCALAPPDATA, with
 *     legacy `~/.dollhouse/state/auth/` honored when `legacyRoot` is
 *     supplied). The default for solo / small-team deployments.
 *   - PostgresAuthStorageLayer — Drizzle-backed; the recommended choice
 *     for hosted / multi-instance deployments. Reuses the Phase 4
 *     database connection injected by the caller; this factory imports
 *     it lazily so memory/filesystem callers don't pay the Drizzle cost.
 *
 * Safety guard: methods that require durable storage (local-account,
 * magic-link) refuse to start with the in-memory backend in non-test
 * environments unless `DOLLHOUSE_ALLOW_MEMORY_AUTH_STORAGE=true` is
 * explicitly set. The intent is to prevent operators from silently
 * losing user credentials on restart.
 *
 * @module auth/embedded-as/storage/createAuthStorage
 */

import * as path from 'node:path';
import { logger } from '../../../utils/logger.js';
import { resolveDataDirectory } from '../../../paths/resolveDataDirectory.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import type { IAuthStorageLayer } from './IAuthStorageLayer.js';
import { InMemoryAuthStorageLayer } from './InMemoryAuthStorageLayer.js';
import { FilesystemAuthStorageLayer } from './FilesystemAuthStorageLayer.js';

export type AuthStorageBackend = 'memory' | 'filesystem' | 'postgres';

export interface CreateAuthStorageOptions {
  /** Force a specific backend; bypasses env-var detection. */
  backend?: AuthStorageBackend;
  /** Override storage root for the filesystem backend (tests pass a tmpdir). */
  rootDir?: string;
  /**
   * Forwarded to `resolveDataDirectory` for the filesystem backend.
   * Set when an existing `~/.dollhouse/` install is detected so paths
   * resolve to the legacy layout instead of the platform default.
   */
  legacyRoot?: string;
  /**
   * Active method ids that drive the safety guard. When this list
   * contains a durable-data method (local-password, magic-link) and
   * the chosen backend is `memory` (in a non-test environment), the
   * factory throws unless `allowMemoryWithDurableMethods` is set.
   */
  methods?: readonly string[];
  /** Test/operator escape for the safety guard. Logged at warn. */
  allowMemoryWithDurableMethods?: boolean;
  /**
   * Drizzle DB instance, required when backend='postgres'. Resolved from
   * the DI container ('Database') in production wiring; tests pass a
   * scratch instance.
   */
  database?: DatabaseInstance;
}

/** Methods whose data must survive a restart for the deployment to be sane. */
export const DURABLE_AUTH_METHODS: ReadonlySet<string> = new Set([
  'local-password',
  'magic-link',
]);

export async function createAuthStorage(
  options: CreateAuthStorageOptions = {},
): Promise<IAuthStorageLayer> {
  const backend = pickBackend(options);

  const requiresDurable = (options.methods ?? []).some(m => DURABLE_AUTH_METHODS.has(m));
  if (backend === 'memory' && requiresDurable) {
    const allowed = options.allowMemoryWithDurableMethods
      ?? (process.env.DOLLHOUSE_ALLOW_MEMORY_AUTH_STORAGE === 'true');
    if (!allowed) {
      throw new Error(
        `Auth storage backend 'memory' refused for methods that require durable state: ` +
        `${(options.methods ?? []).filter(m => DURABLE_AUTH_METHODS.has(m)).join(', ')}. ` +
        `Set DOLLHOUSE_AUTH_STORAGE_BACKEND=filesystem (or postgres when available), ` +
        `or DOLLHOUSE_ALLOW_MEMORY_AUTH_STORAGE=true to override (not recommended; ` +
        `accounts and refresh tokens are lost on restart).`,
      );
    }
    logger.warn(
      '[AuthStorage] memory backend is allowing durable-data methods — accounts and ' +
      'refresh tokens will be lost on restart. Set DOLLHOUSE_AUTH_STORAGE_BACKEND=filesystem to fix.',
    );
  }

  switch (backend) {
    case 'memory':
      logger.info('[AuthStorage] backend=memory (in-process state, lost on restart)');
      return new InMemoryAuthStorageLayer();

    case 'filesystem': {
      const rootDir = options.rootDir
        ?? path.join(resolveDataDirectory('state', { legacyRoot: options.legacyRoot }), 'auth');
      logger.info('[AuthStorage] backend=filesystem', { rootDir });
      return new FilesystemAuthStorageLayer({ rootDir });
    }

    case 'postgres': {
      if (!options.database) {
        throw new Error(
          'PostgresAuthStorageLayer requires a Drizzle database instance. ' +
          'Set DOLLHOUSE_DATABASE_URL and ensure DatabaseServiceRegistrar runs ' +
          'before AuthServiceRegistrar, or pass `database` explicitly in tests.',
        );
      }
      // Lazy import so the postgres dependency isn't pulled into bundles
      // for filesystem/memory deployments.
      const { PostgresAuthStorageLayer } = await import('./PostgresAuthStorageLayer.js');
      logger.info('[AuthStorage] backend=postgres');
      return new PostgresAuthStorageLayer({ db: options.database });
    }
  }
}

function pickBackend(options: CreateAuthStorageOptions): AuthStorageBackend {
  if (options.backend) return options.backend;
  const env = process.env.DOLLHOUSE_AUTH_STORAGE_BACKEND?.trim().toLowerCase();
  if (env === 'memory' || env === 'filesystem' || env === 'postgres') return env;
  if (env && env.length > 0) {
    throw new Error(
      `DOLLHOUSE_AUTH_STORAGE_BACKEND must be one of memory|filesystem|postgres, got: ${env}`,
    );
  }
  if (process.env.NODE_ENV === 'test') return 'memory';
  return 'filesystem';
}
