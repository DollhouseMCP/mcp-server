import { sql } from 'drizzle-orm';

import type { DrizzleTx } from './db-utils.js';

const AUTH_PRINCIPAL_LOCK_NAMESPACE = 'dollhouse:auth-principal:';

/** Serialize account provisioning and deletion even when no identity row exists yet. */
export async function lockAuthPrincipalsWithTx(
  tx: DrizzleTx,
  subjects: readonly string[],
): Promise<void> {
  const uniqueSubjects = [...new Set(subjects.filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'en'));
  for (const subject of uniqueSubjects) {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${AUTH_PRINCIPAL_LOCK_NAMESPACE + subject}, 0)
      )
    `);
  }
}
