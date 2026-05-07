/**
 * cliAuthStorage — bootstrap-CLI helper that resolves the same
 * IAuthStorageLayer the running AS uses, INCLUDING the Postgres
 * backend.
 *
 * The previous shape called `createAuthStorage({ methods: [...] })`
 * directly, which works for filesystem + memory backends but throws
 * on postgres because the postgres branch requires an injected
 * `DatabaseInstance` from the DI container. The AS gets that
 * instance via `AuthServiceRegistrar` resolving `'DatabaseInstance'`,
 * but the CLIs don't run inside the DI container — they're standalone
 * `bin/` entry points. Result before this fix: a hosted-Postgres
 * deployment could close the bootstrap gate but couldn't open it via
 * the documented `dollhouse-admin-bootstrap` CLI (Round 5 review
 * fixup, post-triage HIGH-1).
 *
 * This helper opens a short-lived Drizzle connection from
 * `DOLLHOUSE_DATABASE_URL` when the auth storage backend is postgres,
 * passes it through to `createAuthStorage`, and exposes a `close()`
 * to drain the pool when the CLI exits. Filesystem and memory
 * backends skip the database wiring entirely.
 *
 * @module cli/cliAuthStorage
 */

import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import {
  createAuthStorage,
  type AuthStorageBackend,
  type CreateAuthStorageOptions,
} from '../auth/embedded-as/storage/createAuthStorage.js';
import type { IAuthStorageLayer } from '../auth/embedded-as/storage/IAuthStorageLayer.js';
import type { DatabaseInstance } from '../database/connection.js';

export interface CliAuthStorageHandle {
  storage: IAuthStorageLayer;
  /** Drain the database pool if one was opened. No-op for non-Postgres backends. */
  close: () => Promise<void>;
}

function detectBackend(): AuthStorageBackend {
  // Mirror the resolution order in `createAuthStorage.pickBackend` —
  // explicit env wins, otherwise filesystem default. We do this
  // up-front so we know whether to open a database connection.
  const envBackend = process.env.DOLLHOUSE_AUTH_STORAGE_BACKEND;
  if (envBackend === 'memory' || envBackend === 'filesystem' || envBackend === 'postgres') {
    return envBackend;
  }
  // Leave NODE_ENV=test → memory to createAuthStorage's own logic;
  // CLI processes typically don't run with NODE_ENV=test.
  return 'filesystem';
}

/**
 * Build the storage handle for a CLI. Pass the same `methods` you'd
 * pass to `createAuthStorage` directly so the durable-method safety
 * guard applies. The returned object holds an open Postgres pool when
 * backend=postgres; the caller MUST `await handle.close()` before
 * exiting.
 */
export async function openCliAuthStorage(
  baseOptions: Omit<CreateAuthStorageOptions, 'database'>,
): Promise<CliAuthStorageHandle> {
  const backend = baseOptions.backend ?? detectBackend();

  if (backend !== 'postgres') {
    const storage = await createAuthStorage(baseOptions);
    return { storage, close: async () => undefined };
  }

  // Postgres backend — open a connection from the same env the AS
  // uses. The CLI shares the storage backend with the running AS;
  // a separate connection pool is fine because (a) auth ops are
  // low-volume, (b) the CLI is short-lived.
  const url = env.DOLLHOUSE_DATABASE_URL;
  if (!url) {
    throw new Error(
      'DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres requires DOLLHOUSE_DATABASE_URL ' +
      'to be set so the bootstrap CLI can open a connection. Either set the URL ' +
      'or use DOLLHOUSE_AUTH_STORAGE_BACKEND=filesystem for non-DB deployments.',
    );
  }

  // Lazy import: only callers on the postgres branch pull in the
  // database / drizzle dependencies.
  const { createDatabaseConnection } = await import('../database/connection.js');
  const connection = createDatabaseConnection({
    connectionUrl: url,
    poolSize: 2, // bootstrap CLIs do at most 2-3 queries
  });

  let storage: IAuthStorageLayer;
  try {
    storage = await createAuthStorage({
      ...baseOptions,
      backend,
      database: connection.db as unknown as DatabaseInstance,
    });
  } catch (err) {
    // Don't leak the pool if createAuthStorage itself failed.
    await connection.close().catch((closeErr) => {
      logger.warn('[cliAuthStorage] failed to close pool after createAuthStorage error', {
        error: closeErr instanceof Error ? closeErr.message : String(closeErr),
      });
    });
    throw err;
  }

  return {
    storage,
    close: async () => {
      try {
        await connection.close();
      } catch (err) {
        // CLI is exiting anyway — log and swallow rather than crash
        // the process before the operator-facing success message
        // reaches stdout.
        logger.warn('[cliAuthStorage] failed to drain pool on close', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
