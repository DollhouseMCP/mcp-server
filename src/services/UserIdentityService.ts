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
 * OAuth subjects are deliberately resolved live because account links,
 * disablement, deletion, and authorization fences are mutable admin state.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { createDatabaseConnection, type DatabaseInstance } from '../database/connection.js';
import type { DrizzleTx } from '../database/db-utils.js';
import {
  lockAuthAuthorityMutationsWithTx,
  lockAuthPrincipalsWithTx,
} from '../database/authPrincipalLock.js';
import { users } from '../database/schema/users.js';
import { authAccounts, authSubjectRevocationFences } from '../database/schema/auth.js';
import {
  OIDC_AUTH_TOKEN_CLOCK_SKEW_SECONDS,
  type AuthClaims,
} from '../auth/IAuthProvider.js';
import { hashAuthSubject } from '../security/authSubjectRevocation.js';

export interface UserIdentityServiceOptions {
  /** App-role Drizzle instance (for SELECT lookups via admin bypass). */
  db: DatabaseInstance;
  /** Lifecycle-managed system-role instance for live identity authority checks. */
  systemDb?: DatabaseInstance;
  /** Admin connection URL for user row creation. */
  adminConnectionUrl?: string;
  /** App connection URL — fallback if no admin URL (pre-RLS setups). */
  appConnectionUrl: string;
  ssl?: 'disable' | 'prefer' | 'require';
  authProvider?: 'embedded' | 'oidc' | 'local';
}

export class UserIdentityService {
  private readonly db: DatabaseInstance;
  private readonly systemDb?: DatabaseInstance;
  private readonly adminConnectionUrl: string;
  private readonly ssl: 'disable' | 'prefer' | 'require';
  private readonly authProvider: 'embedded' | 'oidc' | 'local';

  /** Stdio-only username cache; OAuth subjects never use this cache. */
  private readonly cache = new Map<string, string>();

  constructor(options: UserIdentityServiceOptions) {
    this.db = options.db;
    this.systemDb = options.systemDb;
    this.adminConnectionUrl = options.adminConnectionUrl || options.appConnectionUrl;
    this.ssl = options.ssl ?? 'prefer';
    this.authProvider = options.authProvider ?? 'embedded';
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
    const adminConn = this.systemDb ? null : createDatabaseConnection({
        connectionUrl: this.adminConnectionUrl,
        poolSize: 2,
        ssl: this.ssl,
      });
    try {
      const adminDb = this.systemDb ?? adminConn?.db;
      if (!adminDb) throw new Error('System database connection is unavailable');

      const linkedUserId = await adminDb.transaction(async tx => {
        await lockAuthPrincipalsWithTx(tx, [sub]);
        return this.resolveLinkedUserForSubWithTx(tx, sub);
      });
      if (linkedUserId) return linkedUserId;

      // Provisioning is the uncommon path. Match the account-admin lock order
      // (authority graph, then subject), and re-read everything after acquiring
      // both locks so a concurrent unlink/delete cannot be overwritten.
      const resolved = await adminDb.transaction(async tx => {
        await lockAuthAuthorityMutationsWithTx(tx);
        await lockAuthPrincipalsWithTx(tx, [sub]);
        return this.resolveUserForSubWithTx(tx, sub, displayName);
      });
      if (resolved.linked) {
        SecurityMonitor.logSecurityEvent({
          type: 'IDENTITY_CHANGED',
          severity: 'LOW',
          source: 'UserIdentityService.resolveUserForSub',
          details: `Linked auth identity '${sub}' to its database user row`,
          additionalData: { sub, userId: resolved.userId },
        });
      }
      return resolved.userId;
    } finally {
      await adminConn?.close();
    }
  }

  /** Return an already-linked, live user while holding the subject lock. */
  private async resolveLinkedUserForSubWithTx(
    tx: DrizzleTx,
    sub: string,
  ): Promise<string | null> {
    const fence = await tx.select({ subjectHash: authSubjectRevocationFences.subjectHash })
      .from(authSubjectRevocationFences)
      .where(eq(authSubjectRevocationFences.subjectHash, hashAuthSubject(sub)))
      .limit(1);
    if (fence[0]) {
      throw new Error('OAuth subject is administratively revoked');
    }

    const account = await tx.select({ userId: authAccounts.userId })
      .from(authAccounts)
      .where(eq(authAccounts.sub, sub))
      .limit(1);
    if (!account[0]?.userId) return null;

    const liveUser = await tx.select({
      id: users.id,
      disabledAt: users.disabledAt,
      deletedAt: users.deletedAt,
    }).from(users).where(eq(users.id, account[0].userId)).limit(1);
    if (!liveUser[0] || liveUser[0].disabledAt || liveUser[0].deletedAt) {
      throw new Error('OAuth subject is linked to an unavailable account');
    }
    return liveUser[0].id;
  }

  private async resolveUserForSubWithTx(
    tx: DrizzleTx,
    sub: string,
    displayName?: string,
  ): Promise<{ userId: string; linked: boolean }> {
      const fence = await tx.select({ subjectHash: authSubjectRevocationFences.subjectHash })
        .from(authSubjectRevocationFences)
        .where(eq(authSubjectRevocationFences.subjectHash, hashAuthSubject(sub)))
        .limit(1);
      if (fence[0]) {
        throw new Error('OAuth subject is administratively revoked');
      }

      // 1. Already linked? Return the person's row.
      const account = await tx
        .select({ userId: authAccounts.userId })
        .from(authAccounts)
        .where(eq(authAccounts.sub, sub))
        .limit(1);
      if (account[0]?.userId) {
        const liveUser = await tx.select({
          id: users.id,
          disabledAt: users.disabledAt,
          deletedAt: users.deletedAt,
        }).from(users).where(eq(users.id, account[0].userId)).limit(1);
        if (!liveUser[0] || liveUser[0].disabledAt || liveUser[0].deletedAt) {
          throw new Error('OAuth subject is linked to an unavailable account');
        }
        return { userId: liveUser[0].id, linked: false };
      }

      if (account.length === 0) {
        if (this.authProvider === 'embedded') {
          throw new Error('Embedded OAuth subject has no canonical auth account');
        }
        await tx.insert(authAccounts).values({
          provider: this.authProvider,
          externalSub: sub,
          sub,
          displayName: displayName || sub,
        }).onConflictDoNothing();
        const createdAccount = await tx.select({ userId: authAccounts.userId })
          .from(authAccounts).where(eq(authAccounts.sub, sub)).limit(1);
        if (createdAccount.length === 0) {
          throw new Error('Failed to create canonical auth account');
        }
        if (createdAccount[0]?.userId) return { userId: createdAccount[0].userId, linked: false };
      }

      // 2. Find-or-create the users row (username defaults to the stable sub).
      const inserted = await tx
        .insert(users)
        .values({ username: sub, displayName: displayName || sub })
        .onConflictDoNothing()
        .returning({ id: users.id });
      let userId = inserted[0]?.id;
      if (!userId) {
        const existing = await tx
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
      await tx
        .update(authAccounts)
        .set({ userId, updatedAt: new Date() })
        .where(and(eq(authAccounts.sub, sub), isNull(authAccounts.userId)));
      const relinked = await tx
        .select({ userId: authAccounts.userId })
        .from(authAccounts)
        .where(eq(authAccounts.sub, sub))
        .limit(1);
      if (!relinked[0]?.userId) throw new Error('Failed to link canonical auth account');
      userId = relinked[0].userId;

      return { userId, linked: true };
  }

  /**
   * Re-check mutable account authority after cryptographic token validation.
   * Tokens issued at or before an authorization mutation are rejected, and
   * the canonical user id is attached for MCP session ownership checks.
   */
  async validateCurrentClaims(claims: AuthClaims): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const userId = await this.resolveUserForSub(claims.sub, claims.displayName);
      const adminConn = this.systemDb ? null : createDatabaseConnection({
          connectionUrl: this.adminConnectionUrl,
          poolSize: 2,
          ssl: this.ssl,
        });
      try {
        const adminDb = this.systemDb ?? adminConn?.db;
        if (!adminDb) throw new Error('System database connection is unavailable');
        const rows = await adminDb.select({
          linkedUserId: authAccounts.userId,
          disabledAt: users.disabledAt,
          deletedAt: users.deletedAt,
          authzVersion: users.authzVersion,
          authzChangedAt: users.authzChangedAt,
        }).from(authAccounts)
          .innerJoin(users, eq(users.id, authAccounts.userId))
          .where(eq(authAccounts.sub, claims.sub))
          .limit(1);
        const current = rows[0];
        if (!current || current.linkedUserId !== userId || current.disabledAt || current.deletedAt) {
          return { ok: false, reason: 'account is unavailable' };
        }
        if (current.authzVersion > 1) {
          if (this.authProvider === 'embedded') {
            if (claims.authzVersion !== current.authzVersion) {
              return { ok: false, reason: 'token predates current account authorization' };
            }
          } else {
            const cutoffSeconds = Math.floor(current.authzChangedAt.getTime() / 1000);
            const providerClockSkewSeconds = this.authProvider === 'oidc'
              ? OIDC_AUTH_TOKEN_CLOCK_SKEW_SECONDS
              : 0;
            if (claims.iat === undefined || claims.iat <= cutoffSeconds + providerClockSkewSeconds) {
              return { ok: false, reason: 'token predates current account authorization' };
            }
          }
        } else if (claims.authzVersion !== undefined && claims.authzVersion !== current.authzVersion) {
          return { ok: false, reason: 'token has stale account authorization' };
        }
        claims.userId = userId;
        claims.authzVersion = current.authzVersion;
        return { ok: true };
      } finally {
        await adminConn?.close();
      }
    } catch (error) {
      logger.warn('[UserIdentityService] Live claims validation rejected an identity', {
        sub: claims.sub,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, reason: 'account identity is not authorized' };
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
