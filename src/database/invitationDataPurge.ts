import { sql } from 'drizzle-orm';

import type { DrizzleTx } from './db-utils.js';

interface InvitationLockRow {
  readonly id: string;
}

interface DatabaseTimeRow {
  readonly redacted_at: Date | string;
}

/**
 * Redact invitation data owned by an account that is becoming a deletion
 * tombstone. Invitation history is intentionally retained, so this is separate
 * from the cascade replay in `purgeUserScopedData`.
 *
 * The caller must already hold `FOR UPDATE` on the recipient's users row. Rows
 * are then locked in the shared users-before-invitations order used by invitation
 * lifecycle mutations. All updates remain in the caller's transaction.
 */
export async function purgeInvitationRecipientData(tx: DrizzleTx, userId: string): Promise<void> {
  const invitationRows = await tx.execute(sql`
    SELECT id
    FROM account_invitations
    WHERE user_id = ${userId}::uuid
    ORDER BY id
    FOR UPDATE
  `) as unknown as InvitationLockRow[];
  if (invitationRows.length === 0) return;

  // Read database time after waiting for all invitation locks. One value is
  // reused for every revocation performed by this deletion transaction.
  const timeRows = await tx.execute(sql`
    SELECT date_trunc('milliseconds', clock_timestamp()) AS redacted_at
  `) as unknown as DatabaseTimeRow[];
  const redactedAt = timeRows[0]?.redacted_at;
  if (!redactedAt) throw new Error('Database did not return invitation redaction time');

  // Provider result fields may contain addresses or provider-side identifiers.
  // Keep delivery state and timing history, but remove those payloads from every
  // attempt for this recipient. Bump even an already-empty attempt so a provider
  // result that was in flight before deletion loses its optimistic-version race.
  await tx.execute(sql`
    UPDATE account_invitation_delivery_attempts AS delivery
    SET provider_message_id = NULL,
        failure_class = NULL,
        sanitized_detail = NULL,
        version = delivery.version + 1
    WHERE delivery.invitation_id IN (
      SELECT invitation.id
      FROM account_invitations AS invitation
      WHERE invitation.user_id = ${userId}::uuid
    )
  `);

  await tx.execute(sql`
    UPDATE account_invitation_claim_assertions AS claim
    SET state = 'revoked',
        revoked_at = ${redactedAt}::timestamptz,
        version = claim.version + 1
    WHERE claim.user_id = ${userId}::uuid
      AND claim.state = 'open'
  `);

  await tx.execute(sql`
    UPDATE account_invitation_generations AS generation
    SET state = 'revoked',
        revoked_at = ${redactedAt}::timestamptz,
        version = generation.version + 1
    WHERE generation.invitation_id IN (
      SELECT invitation.id
      FROM account_invitations AS invitation
      WHERE invitation.user_id = ${userId}::uuid
    )
      AND generation.state = 'pending'
  `);

  // The invitation id makes both tombstones unique, including under the
  // partial pending-email index. CASE preserves every terminal state and its
  // state-specific timestamp; only a pending aggregate becomes revoked.
  await tx.execute(sql`
    UPDATE account_invitations AS invitation
    SET email_original = 'deleted-' || invitation.id::text || '@deleted.invalid',
        email_normalized = 'deleted-' || invitation.id::text || '@deleted.invalid',
        intended_display_name = NULL,
        intended_username = 'deleted-' || invitation.id::text,
        state = CASE WHEN invitation.state = 'pending' THEN 'revoked' ELSE invitation.state END,
        revoked_at = CASE
          WHEN invitation.state = 'pending' THEN ${redactedAt}::timestamptz
          ELSE invitation.revoked_at
        END,
        updated_at = ${redactedAt}::timestamptz,
        version = invitation.version + 1
    WHERE invitation.user_id = ${userId}::uuid
  `);
}
