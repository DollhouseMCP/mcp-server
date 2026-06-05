import { and, eq, isNull } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { authAccounts, userAdminRoles, users } from '../../database/schema/index.js';
import type {
  ConsolePrincipalSecurityState,
  IConsoleIdentityResolver,
} from './IConsoleIdentityResolver.js';

export class PostgresConsoleIdentityResolver implements IConsoleIdentityResolver {
  constructor(private readonly db: DatabaseInstance) {}

  async resolveEnabledPrincipal(sub: string): Promise<ConsolePrincipalSecurityState | null> {
    return withSystemContext(this.db, async (tx) => {
      const rows = await tx.select({
        sub: authAccounts.sub,
        userId: users.id,
        disabledAt: users.disabledAt,
        authzVersion: users.authzVersion,
      })
        .from(authAccounts)
        .innerJoin(users, eq(authAccounts.userId, users.id))
        .where(and(eq(authAccounts.sub, sub), isNull(users.disabledAt)))
        .limit(1);
      if (rows.length === 0) return null;
      const principal = rows[0];
      // Roles come from the per-user `user_admin_roles` table (active grants) —
      // the single authoritative role store — NOT the legacy per-identity
      // `auth_accounts.roles` column. Admin is a console concept resolved live
      // here (every request), so a revoke takes effect immediately.
      const roleRows = await tx.select({ role: userAdminRoles.role })
        .from(userAdminRoles)
        .where(and(eq(userAdminRoles.userId, principal.userId), isNull(userAdminRoles.revokedAt)))
        .orderBy(userAdminRoles.role);
      return {
        sub: principal.sub,
        userId: principal.userId,
        disabledAt: principal.disabledAt,
        authzVersion: principal.authzVersion,
        roles: roleRows.map(row => row.role),
      };
    });
  }

  async linkAccount(sub: string, displayName?: string): Promise<void> {
    await withSystemContext(this.db, async (tx) => {
      const account = await tx
        .select({ userId: authAccounts.userId })
        .from(authAccounts)
        .where(eq(authAccounts.sub, sub))
        .limit(1);
      // No account row yet (or already linked) → nothing to do.
      if (account.length === 0 || account[0].userId) return;

      // Find-or-create the users row (a CLI-provisioned admin already has one,
      // keyed by sub), then link the account to it. `username` defaults to the
      // stable sub; display name is the human label.
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
      if (!userId) return;

      await tx
        .update(authAccounts)
        .set({ userId, updatedAt: new Date() })
        .where(and(eq(authAccounts.sub, sub), isNull(authAccounts.userId)));
    });
  }
}
