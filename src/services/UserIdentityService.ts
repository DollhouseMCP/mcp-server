/**
 * UserIdentityService
 *
 * Resolves DollhouseMCP usernames to database user UUIDs, creating
 * user rows on demand. Used when set_user_identity is called in
 * HTTP+database mode to bind the session to a real DB identity.
 *
 * User creation requires the admin connection (the app role can only
 * SELECT on the users table). A short-lived admin connection is opened
 * per create operation, keeping admin credentials out of the runtime
 * connection pool.
 *
 * Resolved UUIDs are cached in memory — user rows are immutable once
 * created, so the cache never goes stale within a process lifetime.
 */

import { eq } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { createDatabaseConnection, type DatabaseInstance } from '../database/connection.js';
import { users } from '../database/schema/users.js';

export interface UserIdentityServiceOptions {
  /** App-role Drizzle instance (for SELECT lookups via admin bypass). */
  db: DatabaseInstance;
  /** Admin connection URL for user row creation. */
  adminConnectionUrl?: string;
  /** App connection URL — fallback if no admin URL (pre-RLS setups). */
  appConnectionUrl: string;
  ssl?: 'disable' | 'prefer' | 'require';
}

export class UserIdentityService {
  private readonly db: DatabaseInstance;
  private readonly adminConnectionUrl: string;
  private readonly ssl: 'disable' | 'prefer' | 'require';

  /** username → UUID cache. User rows don't change, so this never goes stale. */
  private readonly cache = new Map<string, string>();

  constructor(options: UserIdentityServiceOptions) {
    this.db = options.db;
    this.adminConnectionUrl = options.adminConnectionUrl || options.appConnectionUrl;
    this.ssl = options.ssl ?? 'prefer';
  }

  /**
   * Resolve a username to a database UUID, creating the user row if needed.
   * Returns the UUID. Cached after first resolution.
   */
  async resolveOrCreateUser(username: string, displayName?: string): Promise<string> {
    const cached = this.cache.get(username);
    if (cached) return cached;

    const adminConn = createDatabaseConnection({
      connectionUrl: this.adminConnectionUrl,
      poolSize: 2,
      ssl: this.ssl,
    });

    try {
      const adminDb = adminConn.db;

      const inserted = await adminDb
        .insert(users)
        .values({
          username,
          displayName: displayName || username,
        })
        .onConflictDoNothing()
        .returning({ id: users.id });

      if (inserted[0]) {
        const userId = inserted[0].id;
        this.cache.set(username, userId);

        logger.info(`[UserIdentityService] Created user row for '${username}'`, { userId });
        SecurityMonitor.logSecurityEvent({
          type: 'IDENTITY_CHANGED',
          severity: 'LOW',
          source: 'UserIdentityService.resolveOrCreateUser',
          details: `Created database user row for '${username}'`,
          additionalData: { username, userId },
        });

        return userId;
      }

      // Row already existed — fetch it
      const existing = await adminDb
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username))
        .limit(1);

      if (!existing[0]) {
        throw new Error(`Failed to resolve user row for '${username}'`);
      }

      const userId = existing[0].id;
      this.cache.set(username, userId);
      return userId;
    } finally {
      await adminConn.close();
    }
  }
}
