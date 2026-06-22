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

import { and, eq, isNull } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { createDatabaseConnection, type DatabaseInstance } from '../database/connection.js';
import { users } from '../database/schema/users.js';
import { authAccounts } from '../database/schema/auth.js';

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
   * Resolve an authenticated OAuth `sub` to its database user UUID, ensuring the
   * `auth_accounts` row for that sub is LINKED to exactly one `users` row.
   *
   * This is the single, fail-closed identity seam for authenticated (HTTP/MCP)
   * sessions. It guarantees the MCP runtime and the web console resolve the same
   * sub to the SAME user row (the console reads roles/identity via
   * `auth_accounts.user_id`), so connecting from any machine on one OAuth
   * identity converges on one account — and admin roles (per-user) line up.
   *
   * Identity key is strictly the `sub` → its own `auth_accounts` row → one user.
   * Distinct subs never collapse onto one user; an existing link is never
   * clobbered. `username` defaults to the stable `sub` (display name is the
   * human label); see resolveOrCreateUser for the stdio username-keyed path.
   */
  async resolveUserForSub(sub: string, displayName?: string): Promise<string> {
    const cached = this.cache.get(sub);
    if (cached) return cached;

    const adminConn = createDatabaseConnection({
      connectionUrl: this.adminConnectionUrl,
      poolSize: 2,
      ssl: this.ssl,
    });
    try {
      const adminDb = adminConn.db;

      // 1. Already linked? Return the person's row.
      const account = await adminDb
        .select({ userId: authAccounts.userId })
        .from(authAccounts)
        .where(eq(authAccounts.sub, sub))
        .limit(1);
      if (account[0]?.userId) {
        this.cache.set(sub, account[0].userId);
        return account[0].userId;
      }

      // 2. Find-or-create the users row (username defaults to the stable sub).
      const inserted = await adminDb
        .insert(users)
        .values({ username: sub, displayName: displayName || sub })
        .onConflictDoNothing()
        .returning({ id: users.id });
      let userId = inserted[0]?.id;
      if (!userId) {
        const existing = await adminDb
          .select({ id: users.id })
          .from(users)
          .where(eq(users.username, sub))
          .limit(1);
        userId = existing[0]?.id;
      }
      if (!userId) throw new Error(`Failed to resolve user row for sub '${sub}'`);

      // 3. Link the auth_account if it exists and is still unlinked. The
      //    `IS NULL` guard makes the link atomic — a concurrent linker can't be
      //    clobbered; re-read to honor whichever writer won.
      if (account.length > 0) {
        await adminDb
          .update(authAccounts)
          .set({ userId, updatedAt: new Date() })
          .where(and(eq(authAccounts.sub, sub), isNull(authAccounts.userId)));
        const relinked = await adminDb
          .select({ userId: authAccounts.userId })
          .from(authAccounts)
          .where(eq(authAccounts.sub, sub))
          .limit(1);
        if (relinked[0]?.userId) userId = relinked[0].userId;
      } else {
        logger.warn(`[UserIdentityService] No auth_accounts row for sub '${sub}'; resolved an unlinked user row`, { userId });
      }

      this.cache.set(sub, userId);
      SecurityMonitor.logSecurityEvent({
        type: 'IDENTITY_CHANGED',
        severity: 'LOW',
        source: 'UserIdentityService.resolveUserForSub',
        details: `Linked auth identity '${sub}' to its database user row`,
        additionalData: { sub, userId },
      });
      return userId;
    } finally {
      await adminConn.close();
    }
  }

  /**
   * Resolve a username to a database UUID, creating the user row if needed.
   * Returns the UUID. Cached after first resolution.
   *
   * Username-keyed path for stdio `set_user_identity` (no OAuth account). For
   * authenticated HTTP/MCP sessions use {@link resolveUserForSub}, which links
   * the auth_account so the console and MCP converge on one user row.
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
