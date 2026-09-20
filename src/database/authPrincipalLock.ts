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

/**
 * Acquire the COMPLETE principal/allowlist set without waiting behind another
 * identity writer. Call before identity/role/allowlist/audit writes. On contention
 * PostgreSQL raises 40001 and aborts the transaction, including previously held
 * locks/writes; catching the JS error cannot safely continue that transaction.
 * The owner may retry the entire DB operation after revalidating its inputs, never
 * an OAuth exchange or external side effect. This does not guard other row locks.
 */
export async function tryLockAuthMutationIdentitiesWithTx(
  tx: DrizzleTx,
  subjects: readonly string[],
  identities: readonly AuthAllowlistLockIdentity[],
): Promise<void> {
  const ownedSubjects = [...subjects];
  const ownedIdentities = identities.map(identity => `${identity.kind}:${identity.normalizedValue}`);
  await lockNamespacedValuesWithTx(tx, AUTH_PRINCIPAL_LOCK_NAMESPACE, ownedSubjects, false);
  await lockNamespacedValuesWithTx(tx, AUTH_ALLOWLIST_LOCK_NAMESPACE, ownedIdentities, false);
}

async function lockNamespacedValuesWithTx(
  tx: DrizzleTx,
  namespace: string,
  values: readonly string[],
  wait = true,
): Promise<void> {
  const uniqueValues = [...new Set(values.filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'en'));
  for (const value of uniqueValues) {
    if (!wait) {
      const rows = await tx.execute(sql`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${namespace + value}, 0)) AS acquired
      `);
      if (rows[0]?.acquired !== true) {
        // Raising in PostgreSQL poisons the transaction itself, unlike throwing
        // only a JS exception that a callback could catch before committing.
        await tx.execute(sql`DO $$ BEGIN
          RAISE EXCEPTION 'auth identity lock contention' USING ERRCODE = '40001';
        END $$`);
      }
      continue;
    }
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${namespace + value}, 0)
      )
    `);
  }
}
