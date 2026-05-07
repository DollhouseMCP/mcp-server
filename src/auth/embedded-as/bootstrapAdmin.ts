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
 * existing roles on every non-admin login (H5). The pattern below
 * separates upsert (full-row write) from setAccountRoles (role-only
 * write), but each method must explicitly preserve any pre-existing
 * roles into the upsert payload — see below.
 *
 * Required call shape for every method that issues the upsert:
 *
 *   const isBootstrapAdmin = await isBootstrapAdminFor(storage, sub, methodId);
 *   const existing = await storage.getAccount(sub);
 *   await storage.upsertAccount({
 *     ...rest,
 *     // Preserve any roles already on the row. upsertAccount IS full-row
 *     // replacement — every backend's mapper writes whatever roles
 *     // value is on the input. Postgres's onConflictDoUpdate set clause
 *     // explicitly writes `roles: row.roles`, so omitting `roles` from
 *     // the input shape resolves to `row.roles = []` and clobbers the
 *     // pre-existing list. The read-then-spread pattern is what makes
 *     // the upsert safe; the helper does NOT do this for you.
 *     ...(existing?.roles ? { roles: existing.roles } : {}),
 *   });
 *   if (isBootstrapAdmin) {
 *     await storage.setAccountRoles(sub, ['admin']);
 *   }
 *
 * The setAccountRoles call is a separate role-only write whose purpose
 * is to PROMOTE the pre-claimed admin without re-issuing the rest of
 * the row. It is not a substitute for the read-then-spread; both are
 * required.
 *
 * Known limitation (R5 / multi-node): the upsert + setAccountRoles
 * sequence runs in two transactions. On Postgres, a concurrent login
 * for the same sub on a different replica between the two writes can
 * overwrite the role grant. Tracked as `L-R5-12` in the dashboard.
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
