/**
 * Provision a console admin up front (operator-driven, at setup) — the
 * `dollhousemcp admin bootstrap` path.
 *
 * Industry-standard SSO model (cf. Keycloak/Grafana/Django createsuperuser):
 * the operator designates a SPECIFIC admin by identity; the role is written to
 * the authoritative per-user store (`user_admin_roles`) at setup, and the
 * credential is established by the user/IdP on first login. No defaults, no
 * "first login wins" — nothing happens for an identity the operator didn't name.
 *
 * The auth account itself need not exist yet: we create the `users` row keyed by
 * the OAuth `sub` and grant admin. On the admin's first login, the AS account
 * upsert links the new `auth_accounts` row to this `users` row by `sub`
 * (see PostgresAuthStorageLayer.upsertAccount), so the console recognizes them
 * immediately.
 */

import { and, eq, isNull } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { userAdminRoles, users } from '../../database/schema/index.js';

export interface ProvisionConsoleAdminResult {
  readonly userId: string;
  readonly created: boolean;
  readonly roleGranted: boolean;
}

/**
 * Find-or-create the `users` row for `sub` and ensure it holds an active
 * `admin` role in `user_admin_roles`. Idempotent: re-running is a no-op once the
 * row + active role exist. Uses the system (admin) context — RBAC writes are an
 * operator action, not a per-user request.
 */
export async function provisionConsoleAdmin(
  db: DatabaseInstance,
  sub: string,
  displayName?: string,
): Promise<ProvisionConsoleAdminResult> {
  return withSystemContext(db, async (tx) => {
    const inserted = await tx
      .insert(users)
      .values({ username: sub, displayName: displayName || sub })
      .onConflictDoNothing()
      .returning({ id: users.id });
    let userId = inserted[0]?.id;
    const created = Boolean(inserted[0]);
    if (!userId) {
      const existing = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, sub))
        .limit(1);
      userId = existing[0]?.id;
    }
    if (!userId) throw new Error(`Failed to provision console admin user for sub '${sub}'`);

    // Grant admin only if there isn't already an active grant (the partial
    // unique index permits one active row per (user, role); check-then-insert
    // keeps this idempotent without relying on partial-index ON CONFLICT).
    const activeAdmin = await tx
      .select({ id: userAdminRoles.id })
      .from(userAdminRoles)
      .where(and(
        eq(userAdminRoles.userId, userId),
        eq(userAdminRoles.role, 'admin'),
        isNull(userAdminRoles.revokedAt),
      ))
      .limit(1);
    let roleGranted = false;
    if (!activeAdmin[0]) {
      await tx.insert(userAdminRoles).values({ userId, role: 'admin', grantedByUserId: userId });
      roleGranted = true;
    }
    return { userId, created, roleGranted };
  });
}
