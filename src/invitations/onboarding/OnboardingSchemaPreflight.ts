import { sql } from 'drizzle-orm';
import type { DatabaseInstance } from '../../database/connection.js';

/**
 * Unregistered startup probe for the same privileged database used by onboarding.
 * Fixed projections resolve required relations/columns without returning records.
 * This verifies readable schema shape, not migration provenance or write grants.
 */
export async function assertOnboardingSchemaReady(database: Pick<DatabaseInstance, 'execute'>): Promise<void> {
  try {
    await database.execute(sql`
      SELECT u.activation_state,
        i.id, i.user_id, i.email_original, i.email_normalized, i.inviter_user_id,
        i.intended_display_name, i.intended_username, i.state, i.current_generation,
        i.accepted_at, i.revoked_at, i.expired_at, i.correlation_id, i.version, i.created_at, i.updated_at,
        g.invitation_id, g.generation, g.state, g.credential_hash, g.issued_at, g.expires_at,
        g.credential_consumed_at, g.accepted_at, g.revoked_at, g.expired_at, g.superseded_at, g.version,
        r.invitation_id, r.role,
        c.id, c.invitation_id, c.generation, c.user_id, c.claim_owner_hash, c.state,
        c.email_verified_at, c.created_at, c.expires_at, c.last_exchanged_at,
        c.completed_at, c.revoked_at, c.expired_at, c.version,
        d.id, d.invitation_id, d.generation, d.attempt_number, d.state, d.provider,
        d.provider_message_id, d.failure_class, d.sanitized_detail, d.correlation_id,
        d.requested_at, d.started_at, d.completed_at, d.version,
        kv.model, kv.id, kv.payload, kv.expires_at, kv.created_at,
        a.event_type, a.actor_id, a.target_id, a.metadata, a.occurred_at
      FROM users u, account_invitations i, account_invitation_generations g,
        account_invitation_intended_roles r, account_invitation_claim_assertions c,
        account_invitation_delivery_attempts d, auth_kv kv, security_audit_events a
      WHERE FALSE
    `);
  } catch {
    throw new Error('Private beta onboarding database schema is unavailable.');
  }
}
