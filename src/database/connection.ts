/**
 * Database Connection
 *
 * PostgreSQL connection pool via postgres.js + Drizzle ORM.
 * Configured via DOLLHOUSE_DATABASE_URL environment variable.
 * Registered as a singleton in the DI container.
 *
 * @since v2.2.0 — Phase 4, Step 4.1
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { logger } from '../utils/logger.js';
import * as schema from './schema/index.js';

export interface DatabaseConfig {
  /** PostgreSQL connection string */
  connectionUrl: string;
  /** Maximum number of connections in pool (default: 10) */
  poolSize?: number;
  /** SSL mode (default: 'prefer') */
  ssl?: 'disable' | 'prefer' | 'require';
}

export type DatabaseInstance = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Create a database connection pool and Drizzle instance.
 *
 * The returned object includes a `close()` method for graceful shutdown
 * (drain pool, close connections). Integrate with LifecycleService.
 */
/**
 * Known dev credentials shipped in docker/init-db.sql and docker-compose.db.yml.
 * A production process must never connect with these — treat as a hard fail
 * rather than silently running with known-weak passwords.
 */
const DEV_PASSWORDS = new Set(['dollhouse', 'dollhouse_app']);

/**
 * Production safeguard: refuses to start if the connection URL embeds a known
 * development password OR the `PGPASSWORD` env var is set to one.
 *
 * Known limitations (NOT handled):
 *   - `~/.pgpass` file entries. postgres.js honors them and this guard does
 *     not read the file. Operators deploying to production should not rely
 *     on .pgpass for the production database password.
 *   - Custom passwords that happen to collide with dev ones (very unlikely
 *     given the specific strings). If that happens, change the prod password.
 *
 * The guard runs only when `NODE_ENV === 'production'` so dev/test flows are
 * unaffected.
 */
function assertNotDevCredentialsInProduction(connectionUrl: string): void {
  if (process.env.NODE_ENV !== 'production') return;

  // PGPASSWORD is the second most-common way the password reaches postgres.js.
  const pgPassword = process.env.PGPASSWORD;
  if (pgPassword && DEV_PASSWORDS.has(pgPassword)) {
    throw new Error(
      '[Database] Refusing to start: PGPASSWORD env var is set to a known development password. ' +
      'Set a unique PostgreSQL password before deploying to production.',
    );
  }

  try {
    const parsed = new URL(connectionUrl);
    if (parsed.password && DEV_PASSWORDS.has(parsed.password)) {
      throw new Error(
        '[Database] Refusing to start: connection URL uses a known development password. ' +
        'Set a unique PostgreSQL password via DOLLHOUSE_DATABASE_URL before deploying to production.',
      );
    }
  } catch (err) {
    // Re-throw our assertion but let URL parse errors fall through to postgres.js
    if (err instanceof Error && err.message.includes('Refusing to start')) throw err;
  }
}

export function createDatabaseConnection(config: DatabaseConfig) {
  assertNotDevCredentialsInProduction(config.connectionUrl);
  const poolSize = config.poolSize ?? 10;

  const client = postgres(config.connectionUrl, {
    max: poolSize,
    ssl: config.ssl === 'disable' ? false : config.ssl ?? 'prefer',
    connect_timeout: 10,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    onnotice: (notice) => {
      logger.debug('[Database] PostgreSQL notice', { message: notice.message });
    },
  });

  const db = drizzle(client, { schema });

  logger.info('[Database] Connection pool created', {
    poolSize,
    ssl: config.ssl ?? 'prefer',
  });

  return {
    db,
    client,
    async close(): Promise<void> {
      logger.info('[Database] Draining connection pool');
      await client.end();
      logger.info('[Database] Connection pool closed');
    },
  };
}
