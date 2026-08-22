import { and, eq, isNull, sql } from 'drizzle-orm';

import type { DrizzleTx } from './db-utils.js';
import { users } from './schema/users.js';

const AUTH_PRINCIPAL_LOCK_NAMESPACE = 'dollhouse:auth-principal:';
const AUTH_ALLOWLIST_LOCK_NAMESPACE = 'dollhouse:auth-allowlist:';
const AUTH_AUTHORITY_MUTATION_LOCK = 'dollhouse:account-admin-mutation';
const USER_LIFECYCLE_LOCK_NAMESPACE = 'dollhouse:user-lifecycle:';

export interface AuthAllowlistLockIdentity {
  readonly kind: string;
  readonly normalizedValue: string;
}

/** Serialize account provisioning and deletion even when no identity row exists yet. */
export async function lockAuthPrincipalsWithTx(
  tx: DrizzleTx,
  subjects: readonly string[],
): Promise<void> {
  await lockNamespacedValuesWithTx(tx, AUTH_PRINCIPAL_LOCK_NAMESPACE, subjects);
}

/** Serialize user-scoped writes with account disable and deletion. */
export async function lockUserLifecycleWithTx(tx: DrizzleTx, userId: string): Promise<void> {
  await lockNamespacedValuesWithTx(tx, USER_LIFECYCLE_LOCK_NAMESPACE, [userId]);
}

export class InactiveUserLifecycleError extends Error {
  constructor() {
    super('database user is disabled, deleted, or missing');
    this.name = 'InactiveUserLifecycleError';
  }
}

/** Serialize a user-owned write with lifecycle mutations and reject tombstoned principals. */
export async function lockActiveUserLifecycleWithTx(tx: DrizzleTx, userId: string): Promise<void> {
  await lockUserLifecycleWithTx(tx, userId);
  const active = await tx.select({ id: users.id }).from(users).where(and(
    eq(users.id, userId),
    isNull(users.disabledAt),
    isNull(users.deletedAt),
  )).limit(1);
  if (!active[0]) throw new InactiveUserLifecycleError();
}

/**
 * Serialize changes to the identity-to-user authority graph. Automatic
 * provisioning and administrative mutations share this lock; ordinary reads
 * of an already-linked subject use only that subject's principal lock.
 */
export async function lockAuthAuthorityMutationsWithTx(tx: DrizzleTx): Promise<void> {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${AUTH_AUTHORITY_MUTATION_LOCK}, 0))
  `);
}

/**
 * Serialize grant, revocation, sign-in, and deletion decisions for allowlist identities.
 * Authority writers must hold this transaction lock before allocating `authority_order`,
 * so sequence allocation for one identity cannot outrun an earlier uncommitted decision.
 */
export async function lockAuthAllowlistIdentitiesWithTx(
  tx: DrizzleTx,
  identities: readonly AuthAllowlistLockIdentity[],
): Promise<void> {
  await lockNamespacedValuesWithTx(
    tx,
    AUTH_ALLOWLIST_LOCK_NAMESPACE,
    identities.map(identity => `${identity.kind}:${identity.normalizedValue}`),
  );
}

async function lockNamespacedValuesWithTx(
  tx: DrizzleTx,
  namespace: string,
  values: readonly string[],
): Promise<void> {
  const uniqueValues = [...new Set(values.filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'en'));
  for (const value of uniqueValues) {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${namespace + value}, 0)
      )
    `);
  }
}
