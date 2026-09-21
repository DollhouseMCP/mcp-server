import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { withSystemContext } from '../../../src/database/admin.js';
import { deleteConsolePrincipalWithTx } from '../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js';
import { closeTestDb, getTestAdminDb, isDatabaseAvailable } from './test-db-helpers.js';

const TERMINAL_AT = new Date('2026-09-01T10:00:00.000Z');
const TERMINAL_AT_SQL = TERMINAL_AT.toISOString();
const EXPIRES_1H_SQL = new Date(TERMINAL_AT.getTime() + 3_600_000).toISOString();
const EXPIRES_2H_SQL = new Date(TERMINAL_AT.getTime() + 7_200_000).toISOString();
const DELETED_AT = new Date('2026-09-20T10:00:00.000Z');
let databaseAvailable = false;

beforeAll(async () => {
  databaseAvailable = await isDatabaseAvailable();
  if (!databaseAvailable && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') {
    throw new Error('PostgreSQL invitation account-deletion proof is required but the test database is unavailable.');
  }
});

afterAll(async () => {
  if (databaseAvailable) await closeTestDb();
});

describe('invitation recipient account deletion', () => {
  it('redacts recipient PII, revokes pending/open state, and preserves terminal history', async () => {
    if (!databaseAvailable) return;
    const db = getTestAdminDb();
    const adminId = randomUUID();
    const inviterId = randomUUID();
    const recipientId = randomUUID();
    const pendingInvitationId = randomUUID();
    const acceptedInvitationId = randomUUID();
    const inFlightDeliveryId = randomUUID();
    const pendingCorrelationId = randomUUID();
    const acceptedCorrelationId = randomUUID();

    await db.execute(sql`
      INSERT INTO users (id, username, activation_state) VALUES
        (${adminId}::uuid, ${`admin-${adminId}`}, 'active'),
        (${inviterId}::uuid, ${`inviter-${inviterId}`}, 'active'),
        (${recipientId}::uuid, ${`recipient-${recipientId}`}, 'pending_activation')
    `);
    await db.execute(sql`
      INSERT INTO account_invitations (
        id, user_id, email_original, email_normalized, inviter_user_id,
        intended_display_name, intended_username, state, current_generation,
        accepted_at, correlation_id, created_at, updated_at
      ) VALUES
        (
          ${pendingInvitationId}::uuid, ${recipientId}::uuid,
          'Pending Recipient <pending@example.test>', 'pending@example.test', ${inviterId}::uuid,
          'Pending Recipient', 'pending-recipient', 'pending', 2,
          NULL, ${pendingCorrelationId}::uuid, ${TERMINAL_AT_SQL}::timestamptz, ${TERMINAL_AT_SQL}::timestamptz
        ),
        (
          ${acceptedInvitationId}::uuid, ${recipientId}::uuid,
          'Accepted Recipient <accepted@example.test>', 'accepted@example.test', ${inviterId}::uuid,
          'Accepted Recipient', 'accepted-recipient', 'accepted', 1,
          ${TERMINAL_AT_SQL}::timestamptz, ${acceptedCorrelationId}::uuid,
          ${TERMINAL_AT_SQL}::timestamptz, ${TERMINAL_AT_SQL}::timestamptz
        )
    `);
    await db.execute(sql`
      INSERT INTO account_invitation_generations (
        invitation_id, generation, state, credential_hash, issued_at, expires_at,
        credential_consumed_at, accepted_at, superseded_at
      ) VALUES
        (
          ${pendingInvitationId}::uuid, 1, 'superseded', ${randomBytes(32)},
          ${TERMINAL_AT_SQL}::timestamptz, ${EXPIRES_1H_SQL}::timestamptz,
          NULL, NULL, ${TERMINAL_AT_SQL}::timestamptz
        ),
        (
          ${pendingInvitationId}::uuid, 2, 'pending', ${randomBytes(32)},
          ${TERMINAL_AT_SQL}::timestamptz, ${EXPIRES_2H_SQL}::timestamptz, NULL, NULL, NULL
        ),
        (
          ${acceptedInvitationId}::uuid, 1, 'accepted', ${randomBytes(32)},
          ${TERMINAL_AT_SQL}::timestamptz, ${EXPIRES_1H_SQL}::timestamptz,
          ${TERMINAL_AT_SQL}::timestamptz, ${TERMINAL_AT_SQL}::timestamptz, NULL
        )
    `);
    await db.execute(sql`
      INSERT INTO account_invitation_claim_assertions (
        invitation_id, generation, user_id, claim_owner_hash, state,
        email_verified_at, created_at, expires_at, last_exchanged_at, completed_at
      ) VALUES
        (
          ${pendingInvitationId}::uuid, 1, ${recipientId}::uuid, ${randomBytes(32)}, 'completed',
          ${TERMINAL_AT_SQL}::timestamptz, ${TERMINAL_AT_SQL}::timestamptz, ${EXPIRES_1H_SQL}::timestamptz,
          ${TERMINAL_AT_SQL}::timestamptz, ${TERMINAL_AT_SQL}::timestamptz
        ),
        (
          ${pendingInvitationId}::uuid, 2, ${recipientId}::uuid, ${randomBytes(32)}, 'open',
          ${TERMINAL_AT_SQL}::timestamptz, ${TERMINAL_AT_SQL}::timestamptz, ${EXPIRES_2H_SQL}::timestamptz,
          ${TERMINAL_AT_SQL}::timestamptz, NULL
        ),
        (
          ${acceptedInvitationId}::uuid, 1, ${recipientId}::uuid, ${randomBytes(32)}, 'completed',
          ${TERMINAL_AT_SQL}::timestamptz, ${TERMINAL_AT_SQL}::timestamptz, ${EXPIRES_1H_SQL}::timestamptz,
          ${TERMINAL_AT_SQL}::timestamptz, ${TERMINAL_AT_SQL}::timestamptz
        )
    `);
    await db.execute(sql`
      INSERT INTO account_invitation_delivery_attempts (
        id, invitation_id, generation, attempt_number, state, provider,
        provider_message_id, failure_class, sanitized_detail, correlation_id,
        requested_at, started_at, completed_at
      ) VALUES (
        ${inFlightDeliveryId}::uuid, ${pendingInvitationId}::uuid, 2, 2, 'submitting', 'test-mail',
        NULL, NULL, NULL, ${randomUUID()}::uuid,
        ${TERMINAL_AT_SQL}::timestamptz, ${TERMINAL_AT_SQL}::timestamptz, NULL
      )
    `);
    await db.execute(sql`
      INSERT INTO account_invitation_delivery_attempts (
        invitation_id, generation, attempt_number, state, provider,
        provider_message_id, failure_class, sanitized_detail, correlation_id,
        requested_at, started_at, completed_at
      ) VALUES
        (
          ${pendingInvitationId}::uuid, 1, 1, 'submitted', 'test-mail',
          'provider-pending-1', NULL, ${JSON.stringify({ recipient: 'pending@example.test' })}::jsonb,
          ${randomUUID()}::uuid, ${TERMINAL_AT_SQL}::timestamptz,
          ${TERMINAL_AT_SQL}::timestamptz, ${TERMINAL_AT_SQL}::timestamptz
        ),
        (
          ${pendingInvitationId}::uuid, 2, 1, 'failed', 'test-mail',
          'provider-pending-2', 'mailbox_pending@example.test',
          ${JSON.stringify({ detail: 'pending@example.test rejected' })}::jsonb,
          ${randomUUID()}::uuid, ${TERMINAL_AT_SQL}::timestamptz,
          ${TERMINAL_AT_SQL}::timestamptz, ${TERMINAL_AT_SQL}::timestamptz
        ),
        (
          ${acceptedInvitationId}::uuid, 1, 1, 'submitted', 'test-mail',
          'provider-accepted-1', NULL, ${JSON.stringify({ recipient: 'accepted@example.test' })}::jsonb,
          ${randomUUID()}::uuid, ${TERMINAL_AT_SQL}::timestamptz,
          ${TERMINAL_AT_SQL}::timestamptz, ${TERMINAL_AT_SQL}::timestamptz
        )
    `);

    const beforeDelete = Date.now();
    const outcome = await withSystemContext(db, tx => deleteConsolePrincipalWithTx(tx, {
      userId: recipientId,
      deletedByUserId: adminId,
      deletedAt: DELETED_AT,
    }));
    const afterDelete = Date.now();

    expect(outcome).toMatchObject({ userId: recipientId, outcome: 'anonymized' });
    const invitations = await db.execute(sql`
      SELECT id, email_original, email_normalized, intended_display_name, intended_username,
             state, accepted_at, revoked_at, expired_at, correlation_id, updated_at, version
      FROM account_invitations
      WHERE user_id = ${recipientId}::uuid
      ORDER BY id
    `) as unknown as Array<Record<string, unknown>>;
    expect(invitations).toHaveLength(2);
    for (const invitation of invitations) {
      expect(invitation.email_original).toBe(`deleted-${invitation.id}@deleted.invalid`);
      expect(invitation.email_normalized).toBe(`deleted-${invitation.id}@deleted.invalid`);
      expect(invitation.intended_display_name).toBeNull();
      expect(invitation.intended_username).toBe(`deleted-${invitation.id}`);
      expect(Number(invitation.version)).toBe(2);
    }
    const pending = invitations.find(row => row.id === pendingInvitationId)!;
    const accepted = invitations.find(row => row.id === acceptedInvitationId)!;
    expect(pending.state).toBe('revoked');
    expect(pending.accepted_at).toBeNull();
    expect(pending.expired_at).toBeNull();
    expect(pending.correlation_id).toBe(pendingCorrelationId);
    const redactedAt = new Date(pending.revoked_at as string | Date);
    // The database container clock can differ slightly from the test process.
    expect(redactedAt.getTime()).toBeGreaterThanOrEqual(beforeDelete - 2_000);
    expect(redactedAt.getTime()).toBeLessThanOrEqual(afterDelete + 2_000);
    expect(redactedAt).not.toEqual(DELETED_AT);
    expect(new Date(pending.updated_at as string | Date)).toEqual(redactedAt);
    expect(accepted.state).toBe('accepted');
    expect(new Date(accepted.accepted_at as string | Date)).toEqual(TERMINAL_AT);
    expect(accepted.revoked_at).toBeNull();
    expect(accepted.correlation_id).toBe(acceptedCorrelationId);

    const generations = await db.execute(sql`
      SELECT invitation_id, generation, state, accepted_at, revoked_at, superseded_at, version
      FROM account_invitation_generations
      WHERE invitation_id IN (${pendingInvitationId}::uuid, ${acceptedInvitationId}::uuid)
      ORDER BY invitation_id, generation
    `) as unknown as Array<Record<string, unknown>>;
    const superseded = generations.find(row => row.invitation_id === pendingInvitationId && row.generation === 1)!;
    const revoked = generations.find(row => row.invitation_id === pendingInvitationId && row.generation === 2)!;
    const acceptedGeneration = generations.find(row => row.invitation_id === acceptedInvitationId)!;
    expect(superseded.state).toBe('superseded');
    expect(new Date(superseded.superseded_at as string | Date)).toEqual(TERMINAL_AT);
    expect(Number(superseded.version)).toBe(1);
    expect(revoked.state).toBe('revoked');
    expect(new Date(revoked.revoked_at as string | Date)).toEqual(redactedAt);
    expect(Number(revoked.version)).toBe(2);
    expect(acceptedGeneration.state).toBe('accepted');
    expect(new Date(acceptedGeneration.accepted_at as string | Date)).toEqual(TERMINAL_AT);
    expect(Number(acceptedGeneration.version)).toBe(1);

    const claims = await db.execute(sql`
      SELECT invitation_id, generation, state, completed_at, revoked_at, version
      FROM account_invitation_claim_assertions
      WHERE user_id = ${recipientId}::uuid
      ORDER BY invitation_id, generation
    `) as unknown as Array<Record<string, unknown>>;
    const openClaim = claims.find(row => row.invitation_id === pendingInvitationId && row.generation === 2)!;
    expect(openClaim.state).toBe('revoked');
    expect(new Date(openClaim.revoked_at as string | Date)).toEqual(redactedAt);
    expect(Number(openClaim.version)).toBe(2);
    for (const claim of claims.filter(row => row !== openClaim)) {
      expect(claim.state).toBe('completed');
      expect(new Date(claim.completed_at as string | Date)).toEqual(TERMINAL_AT);
      expect(claim.revoked_at).toBeNull();
      expect(Number(claim.version)).toBe(1);
    }

    const deliveries = await db.execute(sql`
      SELECT state, provider, provider_message_id, failure_class, sanitized_detail,
             requested_at, started_at, completed_at, version
      FROM account_invitation_delivery_attempts
      WHERE invitation_id IN (${pendingInvitationId}::uuid, ${acceptedInvitationId}::uuid)
      ORDER BY invitation_id, generation, attempt_number
    `) as unknown as Array<Record<string, unknown>>;
    expect(deliveries.map(row => row.state).sort()).toEqual(['failed', 'submitted', 'submitted', 'submitting']);
    for (const delivery of deliveries) {
      expect(delivery.provider).toBe('test-mail');
      expect(delivery.provider_message_id).toBeNull();
      expect(delivery.failure_class).toBeNull();
      expect(delivery.sanitized_detail).toBeNull();
      expect(new Date(delivery.requested_at as string | Date)).toEqual(TERMINAL_AT);
      expect(new Date(delivery.started_at as string | Date)).toEqual(TERMINAL_AT);
      if (delivery.state === 'submitting') expect(delivery.completed_at).toBeNull();
      else expect(new Date(delivery.completed_at as string | Date)).toEqual(TERMINAL_AT);
      expect(Number(delivery.version)).toBe(2);
    }
    const staleProviderResult = await db.execute(sql`
      UPDATE account_invitation_delivery_attempts
      SET provider_message_id = 'late-provider-result', version = version + 1
      WHERE id = ${inFlightDeliveryId}::uuid AND version = 1
      RETURNING id
    `);
    expect(staleProviderResult).toHaveLength(0);
  });

  it('does not redact another recipient when the deleted user is only the inviter', async () => {
    if (!databaseAvailable) return;
    const db = getTestAdminDb();
    const adminId = randomUUID();
    const issuerId = randomUUID();
    const recipientId = randomUUID();
    const invitationId = randomUUID();
    await db.execute(sql`
      INSERT INTO users (id, username, activation_state) VALUES
        (${adminId}::uuid, ${`admin-${adminId}`}, 'active'),
        (${issuerId}::uuid, ${`issuer-${issuerId}`}, 'active'),
        (${recipientId}::uuid, ${`recipient-${recipientId}`}, 'pending_activation')
    `);
    await db.execute(sql`
      INSERT INTO account_invitations (
        id, user_id, email_original, email_normalized, inviter_user_id,
        intended_display_name, intended_username, correlation_id
      ) VALUES (
        ${invitationId}::uuid, ${recipientId}::uuid, 'Other Recipient', 'other@example.test',
        ${issuerId}::uuid, 'Other Recipient', 'other-recipient', ${randomUUID()}::uuid
      )
    `);
    await db.execute(sql`
      INSERT INTO account_invitation_generations (
        invitation_id, generation, credential_hash, issued_at, expires_at
      ) VALUES (
        ${invitationId}::uuid, 1, ${randomBytes(32)}, ${TERMINAL_AT_SQL}::timestamptz,
        ${EXPIRES_1H_SQL}::timestamptz
      )
    `);

    await expect(withSystemContext(db, tx => deleteConsolePrincipalWithTx(tx, {
      userId: issuerId,
      deletedByUserId: adminId,
      deletedAt: DELETED_AT,
    }))).resolves.toMatchObject({ outcome: 'anonymized' });

    const rows = await db.execute(sql`
      SELECT email_original, email_normalized, intended_display_name, intended_username, state, version
      FROM account_invitations WHERE id = ${invitationId}::uuid
    `) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      email_original: 'Other Recipient',
      email_normalized: 'other@example.test',
      intended_display_name: 'Other Recipient',
      intended_username: 'other-recipient',
      state: 'pending',
    });
    expect(Number(rows[0]?.version)).toBe(1);
  });

  it('makes invitation management wait outside the users-before-invitations lock sequence', async () => {
    if (!databaseAvailable) return;
    const db = getTestAdminDb();
    const adminId = randomUUID();
    const inviterId = randomUUID();
    const recipientId = randomUUID();
    const invitationId = randomUUID();
    await db.execute(sql`
      INSERT INTO users (id, username, activation_state) VALUES
        (${adminId}::uuid, ${`admin-${adminId}`}, 'active'),
        (${inviterId}::uuid, ${`inviter-${inviterId}`}, 'active'),
        (${recipientId}::uuid, ${`recipient-${recipientId}`}, 'pending_activation')
    `);
    await db.execute(sql`
      INSERT INTO account_invitations (
        id, user_id, email_original, email_normalized, inviter_user_id,
        intended_display_name, intended_username, correlation_id
      ) VALUES (
        ${invitationId}::uuid, ${recipientId}::uuid, 'Race Recipient', 'race@example.test',
        ${inviterId}::uuid, 'Race Recipient', 'race-recipient', ${randomUUID()}::uuid
      )
    `);
    await db.execute(sql`
      INSERT INTO account_invitation_generations (
        invitation_id, generation, credential_hash, issued_at, expires_at
      ) VALUES (
        ${invitationId}::uuid, 1, ${randomBytes(32)}, ${TERMINAL_AT_SQL}::timestamptz,
        ${EXPIRES_1H_SQL}::timestamptz
      )
    `);

    let deletionLockedResolve!: () => void;
    let releaseDeletion!: () => void;
    const deletionLocked = new Promise<void>(resolve => { deletionLockedResolve = resolve; });
    const deletionMayProceed = new Promise<void>(resolve => { releaseDeletion = resolve; });
    const deletion = withSystemContext(db, async tx => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${recipientId}::uuid FOR UPDATE`);
      deletionLockedResolve();
      await deletionMayProceed;
      return deleteConsolePrincipalWithTx(tx, {
        userId: recipientId,
        deletedByUserId: adminId,
        deletedAt: DELETED_AT,
      });
    });
    await deletionLocked;

    let managementStartedResolve!: () => void;
    const managementStarted = new Promise<void>(resolve => { managementStartedResolve = resolve; });
    let managementSettled = false;
    const management = db.transaction(async tx => {
      managementStartedResolve();
      await tx.execute(sql`LOCK TABLE users IN EXCLUSIVE MODE`);
      const rows = await tx.execute(sql`SELECT deleted_at FROM users WHERE id = ${recipientId}::uuid`);
      return rows as unknown as Array<{ deleted_at: Date | string | null }>;
    });
    void management.then(
      () => { managementSettled = true; },
      () => { managementSettled = true; },
    );
    await managementStarted;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(managementSettled).toBe(false);

    releaseDeletion();
    await expect(deletion).resolves.toMatchObject({ outcome: 'anonymized' });
    const observedAfterDeletion = await management;
    expect(observedAfterDeletion[0]?.deleted_at).not.toBeNull();
    const invitation = await db.execute(sql`
      SELECT email_normalized, state
      FROM account_invitations WHERE id = ${invitationId}::uuid
    `) as unknown as Array<Record<string, unknown>>;
    expect(invitation[0]).toMatchObject({
      email_normalized: `deleted-${invitationId}@deleted.invalid`,
      state: 'revoked',
    });
  });

  it('rolls back invitation redaction and account tombstoning when the outer transaction fails', async () => {
    if (!databaseAvailable) return;
    const db = getTestAdminDb();
    const adminId = randomUUID();
    const inviterId = randomUUID();
    const recipientId = randomUUID();
    const invitationId = randomUUID();
    await db.execute(sql`
      INSERT INTO users (id, username, activation_state) VALUES
        (${adminId}::uuid, ${`admin-${adminId}`}, 'active'),
        (${inviterId}::uuid, ${`inviter-${inviterId}`}, 'active'),
        (${recipientId}::uuid, ${`recipient-${recipientId}`}, 'pending_activation')
    `);
    await db.execute(sql`
      INSERT INTO account_invitations (
        id, user_id, email_original, email_normalized, inviter_user_id,
        intended_display_name, intended_username, correlation_id
      ) VALUES (
        ${invitationId}::uuid, ${recipientId}::uuid, 'Rollback Recipient', 'rollback@example.test',
        ${inviterId}::uuid, 'Rollback Recipient', 'rollback-recipient', ${randomUUID()}::uuid
      )
    `);
    await db.execute(sql`
      INSERT INTO account_invitation_generations (
        invitation_id, generation, credential_hash, issued_at, expires_at
      ) VALUES (
        ${invitationId}::uuid, 1, ${randomBytes(32)}, ${TERMINAL_AT_SQL}::timestamptz,
        ${EXPIRES_1H_SQL}::timestamptz
      )
    `);

    await expect(withSystemContext(db, async tx => {
      await deleteConsolePrincipalWithTx(tx, {
        userId: recipientId,
        deletedByUserId: adminId,
        deletedAt: DELETED_AT,
      });
      throw new Error('force rollback after invitation purge');
    })).rejects.toThrow('force rollback after invitation purge');

    const users = await db.execute(sql`
      SELECT username, deleted_at FROM users WHERE id = ${recipientId}::uuid
    `) as unknown as Array<Record<string, unknown>>;
    expect(users[0]).toMatchObject({ username: `recipient-${recipientId}`, deleted_at: null });
    const invitations = await db.execute(sql`
      SELECT email_original, email_normalized, intended_display_name, intended_username,
             state, revoked_at, version
      FROM account_invitations WHERE id = ${invitationId}::uuid
    `) as unknown as Array<Record<string, unknown>>;
    expect(invitations[0]).toMatchObject({
      email_original: 'Rollback Recipient',
      email_normalized: 'rollback@example.test',
      intended_display_name: 'Rollback Recipient',
      intended_username: 'rollback-recipient',
      state: 'pending',
      revoked_at: null,
    });
    expect(Number(invitations[0]?.version)).toBe(1);
    const generations = await db.execute(sql`
      SELECT state, revoked_at, version
      FROM account_invitation_generations
      WHERE invitation_id = ${invitationId}::uuid AND generation = 1
    `) as unknown as Array<Record<string, unknown>>;
    expect(generations[0]).toMatchObject({ state: 'pending', revoked_at: null });
    expect(Number(generations[0]?.version)).toBe(1);
  });
});
