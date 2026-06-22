/**
 * Database Bootstrap
 *
 * Initializes the database connection and ensures a user row exists
 * for the current OS user. Called during DI container setup when
 * DOLLHOUSE_STORAGE_BACKEND=database.
 *
 * @since v2.2.0 — Phase 4, Step 4.3
 */

import os from 'node:os';
import { eq } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { createDatabaseConnection, type DatabaseConfig, type DatabaseInstance } from './connection.js';
import { users } from './schema/users.js';

export interface DatabaseBootstrapResult {
  /** The Drizzle database instance for runtime queries (app role, RLS-enforced). */
  db: DatabaseInstance;
  /** The full connection object (includes close() for disposal). */
  connection: ReturnType<typeof createDatabaseConnection>;
  /** The UUID of the bootstrapped user row. */
  userId: string;
}

export interface DatabaseBootstrapConfig extends DatabaseConfig {
  /**
   * Optional admin connection URL used for identity bootstrap. When set, user
   * creation runs against this URL (privileged role, bypasses RLS on `users`).
   * When omitted, bootstrap uses the app connection — this only works if the
   * `users` table is not RLS-protected against the app role.
   */
  adminConnectionUrl?: string;
}

/**
 * Bootstrap the database: create connection, ensure user row exists.
 *
 * For stdio mode, the user is identified by OS username. For HTTP mode,
 * the userId comes from the authentication layer (handled separately).
 *
 * Identity writes (creating the initial user row) run against the admin URL
 * when provided, because the `users` table is RLS-protected and the app role
 * only has self-read access to it. The admin connection is opened just for
 * bootstrap and closed before returning; runtime queries use the app pool.
 *
 * @throws If connection fails or the user row cannot be materialized.
 */
export async function bootstrapDatabase(
  config: DatabaseBootstrapConfig,
): Promise<DatabaseBootstrapResult> {
  const connection = createDatabaseConnection(config);

  // Identity bootstrap uses the admin role when DOLLHOUSE_DATABASE_ADMIN_URL is set.
  // This keeps `users`-writing privileges out of the app pool once RLS is applied.
  let userId: string;
  if (config.adminConnectionUrl && config.adminConnectionUrl !== config.connectionUrl) {
    const adminConnection = createDatabaseConnection({
      ...config,
      connectionUrl: config.adminConnectionUrl,
      // Small pool — bootstrap is a one-shot operation
      poolSize: 2,
    });
    try {
      userId = await ensureCurrentUser(adminConnection.db);
    } finally {
      await adminConnection.close();
    }
  } else {
    userId = await ensureCurrentUser(connection.db);
  }

  logger.info('[DatabaseBootstrap] Database connection established and user bootstrapped', {
    userId,
  });

  SecurityMonitor.logSecurityEvent({
    type: 'PORTFOLIO_INITIALIZATION',
    severity: 'LOW',
    source: 'DatabaseBootstrap',
    details: 'Database connection established and default user bootstrapped',
    additionalData: { userId },
  });

  return { db: connection.db, connection, userId };
}

/**
 * Ensure a user row exists for the current OS user.
 * Uses INSERT ... ON CONFLICT DO NOTHING + SELECT fallback for
 * atomic, race-safe user creation.
 *
 * For stdio mode, this creates a single "local" user. For HTTP mode,
 * user creation is handled by the authentication layer.
 */
async function ensureCurrentUser(db: DatabaseInstance): Promise<string> {
  // DOLLHOUSE_USER takes priority — it's the operator-chosen identity.
  // Falls back to OS username for local/stdio mode.
  let username: string;
  const envUser = process.env.DOLLHOUSE_USER?.trim();
  if (envUser) {
    username = envUser;
  } else {
    try {
      username = os.userInfo().username || 'local';
    } catch {
      username = 'local';
    }
  }

  // Atomic upsert: insert if not exists, otherwise no-op
  const inserted = await db
    .insert(users)
    .values({
      username,
      displayName: username,
    })
    .onConflictDoNothing()
    .returning({ id: users.id });

  if (inserted[0]) {
    logger.info(`[DatabaseBootstrap] Created user row for '${username}'`, { userId: inserted[0].id });
    return inserted[0].id;
  }

  // Row already existed — fetch it (deterministic: unique constraint guarantees one row)
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (!existing[0]) {
    throw new Error(`[DatabaseBootstrap] Failed to ensure user row for '${username}'`);
  }

  return existing[0].id;
}
