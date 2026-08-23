import { sql } from 'drizzle-orm';

import type { DrizzleTx } from './db-utils.js';

const AUTH_PRINCIPAL_LOCK_NAMESPACE = 'dollhouse:auth-principal:';
const AUTH_ALLOWLIST_LOCK_NAMESPACE = 'dollhouse:auth-allowlist:';

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
