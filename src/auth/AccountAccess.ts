import { eq } from 'drizzle-orm';

import { withSystemContext } from '../database/admin.js';
import type { DatabaseInstance } from '../database/connection.js';
import type { DrizzleTx } from '../database/db-utils.js';
import { authAccounts } from '../database/schema/auth.js';
import { users } from '../database/schema/users.js';

/** Read account eligibility from the authoritative user row; never cache it. */
export async function isSubjectAccountAllowed(db: DatabaseInstance, sub: string): Promise<boolean> {
  return withSystemContext(db, async (tx) => {
    const accounts = await tx.select({ userId: authAccounts.userId }).from(authAccounts)
      .where(eq(authAccounts.sub, sub)).limit(1);
    const userId = accounts[0]?.userId;
    const rows = await tx.select({
      activationState: users.activationState,
      disabledAt: users.disabledAt,
      deletedAt: users.deletedAt,
    }).from(users).where(userId ? eq(users.id, userId) : eq(users.username, sub)).limit(1);
    // Existing provisioning may create the user on first console/MCP access.
    // A dangling canonical link must never be treated as a new identity.
    if (!rows[0]) return !userId;
    return rows[0].activationState === 'active' && !rows[0].disabledAt && !rows[0].deletedAt;
  });
}

/** Gate resolved UUIDs too: a cached identity is not cached authorization. */
export async function assertUserAccountAllowed(db: DatabaseInstance | DrizzleTx, userId: string): Promise<void> {
  const rows = await db.select({
    activationState: users.activationState,
    disabledAt: users.disabledAt,
    deletedAt: users.deletedAt,
  }).from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user || user.activationState !== 'active' || user.disabledAt || user.deletedAt) {
    throw new Error('Account is not available for authentication');
  }
}
