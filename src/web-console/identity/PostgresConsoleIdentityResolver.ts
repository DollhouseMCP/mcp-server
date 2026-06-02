import { and, eq, isNull } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { authAccounts, users } from '../../database/schema/index.js';
import type {
  ConsolePrincipalSecurityState,
  IConsoleIdentityResolver,
} from './IConsoleIdentityResolver.js';

export class PostgresConsoleIdentityResolver implements IConsoleIdentityResolver {
  constructor(private readonly db: DatabaseInstance) {}

  async resolveEnabledPrincipal(sub: string): Promise<ConsolePrincipalSecurityState | null> {
    const rows = await withSystemContext(this.db, tx =>
      tx.select({
        sub: authAccounts.sub,
        userId: users.id,
        disabledAt: users.disabledAt,
        authzVersion: users.authzVersion,
        roles: authAccounts.roles,
      })
        .from(authAccounts)
        .innerJoin(users, eq(authAccounts.userId, users.id))
        .where(and(eq(authAccounts.sub, sub), isNull(users.disabledAt)))
        .limit(1),
    );
    if (rows.length === 0) return null;
    const principal = rows[0];
    return {
      sub: principal.sub,
      userId: principal.userId,
      disabledAt: principal.disabledAt,
      authzVersion: principal.authzVersion,
      roles: Array.isArray(principal.roles)
        ? principal.roles.filter((role): role is string => typeof role === 'string')
        : [],
    };
  }
}
