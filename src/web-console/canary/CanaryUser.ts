import { and, eq, isNull } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { CANARY_DISPLAY_NAME, CANARY_USER_UUID, CANARY_USERNAME } from '../../database/internalUsers.js';
import { authAccounts } from '../../database/schema/auth.js';
import { userAdminRoles, users } from '../../database/schema/index.js';

export interface CanaryUser {
  readonly userId: string;
  readonly accountCorrelationId: string;
  /** True when this call created the row. */
  readonly created: boolean;
}

/** The reserved canary identity is not in the state the canary needs. Nothing is run against it. */
export class CanaryUserStateError extends Error {}

/**
 * Finds or creates the canary user, and refuses to hand it out unless it is
 * still what it must be: disabled, with no sign-in identity and no role.
 *
 * It is created disabled, so that even a sign-in identity attached to it by
 * mistake would be refused. It is never given one here, and nothing in the
 * console can give it one, because account administration does not see it.
 *
 * The checks matter because the row is long-lived and its ID is public. If
 * someone has changed it by hand, the canary stops rather than run as a user
 * that can sign in or holds a role. The row is locked while it is checked.
 */
export async function ensureCanaryUser(db: DatabaseInstance, now: () => Date = () => new Date()): Promise<CanaryUser> {
  return withSystemContext(db, async tx => {
    const inserted = await tx.insert(users)
      .values({
        id: CANARY_USER_UUID,
        username: CANARY_USERNAME,
        displayName: CANARY_DISPLAY_NAME,
        disabledAt: now(),
      })
      .onConflictDoNothing()
      .returning({ id: users.id });

    const rows = await tx.select({
      username: users.username,
      disabledAt: users.disabledAt,
      deletedAt: users.deletedAt,
      accountCorrelationId: users.accountCorrelationId,
    }).from(users).where(eq(users.id, CANARY_USER_UUID)).limit(1).for('update');
    const row = rows[0];
    if (!row) {
      // The insert did nothing and there is no row with the reserved ID, so
      // another row already holds the reserved username.
      throw new CanaryUserStateError('The reserved canary username belongs to another user.');
    }
    if (row.username !== CANARY_USERNAME) throw new CanaryUserStateError('The reserved canary ID belongs to another user.');
    if (row.deletedAt !== null) throw new CanaryUserStateError('The canary user has been deleted.');
    if (row.disabledAt === null) throw new CanaryUserStateError('The canary user has been enabled. It must stay disabled.');

    const identities = await tx.select({ sub: authAccounts.sub }).from(authAccounts)
      .where(eq(authAccounts.userId, CANARY_USER_UUID)).limit(1);
    if (identities.length > 0) throw new CanaryUserStateError('The canary user has a sign-in identity attached. It must have none.');

    const roles = await tx.select({ role: userAdminRoles.role }).from(userAdminRoles)
      .where(and(eq(userAdminRoles.userId, CANARY_USER_UUID), isNull(userAdminRoles.revokedAt))).limit(1);
    if (roles.length > 0) throw new CanaryUserStateError('The canary user holds a role. It must hold none.');

    return { userId: CANARY_USER_UUID, accountCorrelationId: row.accountCorrelationId, created: inserted.length > 0 };
  });
}
