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
export function createDatabaseConnection(config: DatabaseConfig) {
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
