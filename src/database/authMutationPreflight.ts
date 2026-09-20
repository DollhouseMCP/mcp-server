import { sql } from 'drizzle-orm';
import type { DrizzleTx } from './db-utils.js';

/**
 * Internal activation prerequisite, before any advisory locks or mutation writes.
 * Acquire users first; never wait for downstream writers while holding users,
 * because they may already own a row/unique entry and be waiting on a users FK.
 * NOWAIT contention raises 55P03 and aborts the caller's entire transaction.
 * This deliberately coarse beta protocol leaves ordinary readers unblocked.
 * Resolve audit HMAC material before opening this transaction; no network calls,
 * separate-connection reads, normal sessions or provider operations belong here.
 * A caller must still acquire the complete principal/allowlist advisory set with
 * the nonblocking identity helper and revalidate policy/expiry before writing.
 */
export async function lockAuthMutationResourcesWithTx(tx: DrizzleTx): Promise<void> {
  await tx.execute(sql`LOCK TABLE users IN EXCLUSIVE MODE`);
  await tx.execute(sql`
    LOCK TABLE auth_accounts, user_admin_roles, account_allowlist_entries,
      admin_audit_chain_heads, admin_audit_events, security_invalidation_events
    IN EXCLUSIVE MODE NOWAIT
  `);
}
