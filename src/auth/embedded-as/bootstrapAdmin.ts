/**
 * bootstrapAdmin — single source of truth for the must-fix #22
 * "is this sub the pre-claimed bootstrap admin for this method?"
 * predicate.
 *
 * Three IAuthMethod implementations (LocalAccountMethod, MagicLinkMethod,
 * GithubSocialMethod) used to inline the same `bootstrap.completed &&
 * bootstrap.adminSub === sub && bootstrap.adminMethod === '<id>'` check.
 * A fix in one wouldn't propagate to the others — Round 5 caught this
 * during the 4-reviewer pass (M3). Also the `...(isBootstrapAdmin ?
 * { roles: ['admin'] } : {})` upsertAccount spread quietly clobbered
 * existing roles on every non-admin login (H5). The new pattern:
 *
 *   1. Method calls `upsertAccount(...)` with the rest of the row, no
 *      `roles` key. upsertAccount is full-row replacement; it doesn't
 *      touch roles when the field is absent because the field is also
 *      absent on the input shape, so the storage layer's mapper preserves
 *      whatever was there.
 *
 *   2. Method calls `if (await isBootstrapAdminFor(...)) await
 *      storage.setAccountRoles(sub, ['admin'])`. setAccountRoles is the
 *      role-only write that does NOT depend on the rest of the row.
 *      Only the bootstrap admin path triggers it; everyone else's roles
 *      stay untouched.
 *
 * `methodId` matches `IAuthMethod.id` (e.g. `'local-password'`,
 * `'magic-link'`, `'github'`), NOT the class name.
 */

import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';

export type BootstrapAdminMethod = 'local-password' | 'magic-link' | 'github';

/**
 * Return true when the bootstrap state names `sub` as the pre-claimed
 * admin AND the operator pre-claimed it under `methodId`. Both conditions
 * must hold so e.g. a magic-link admin can't be accidentally promoted by
 * a github login that happens to land on the same sub.
 */
export async function isBootstrapAdminFor(
  storage: IAuthStorageLayer,
  sub: string,
  methodId: BootstrapAdminMethod,
): Promise<boolean> {
  const bootstrap = await storage.getBootstrapState();
  return (
    bootstrap.completed === true
    && bootstrap.adminSub === sub
    && bootstrap.adminMethod === methodId
  );
}
