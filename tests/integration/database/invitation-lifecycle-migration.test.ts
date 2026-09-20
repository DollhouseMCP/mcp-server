import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { getErrorCode } from '../../../src/database/db-utils.js';
import { closeTestDb, getTestAdminDb, getTestDb } from './test-db-helpers.js';

const inviterId = randomUUID();
const pendingUserId = randomUUID();
const competingUserId = randomUUID();
const invitationId = randomUUID();
const competingInvitationId = randomUUID();
const correlationId = randomUUID();
const email = `migration-${randomUUID()}@example.com`;

beforeAll(async () => {
  const db = getTestAdminDb();
  await db.execute(sql`
    INSERT INTO users (id, username) VALUES
      (${inviterId}::uuid, ${`inviter-${inviterId}`}),
      (${pendingUserId}::uuid, ${`pending-${pendingUserId}`}),
      (${competingUserId}::uuid, ${`competing-${competingUserId}`})
  `);
  await db.execute(sql`UPDATE users SET activation_state = 'pending_activation' WHERE id = ${pendingUserId}::uuid`);
  await db.execute(sql`
    INSERT INTO account_invitations (
      id, user_id, email_original, email_normalized, inviter_user_id,
      intended_username, correlation_id
    ) VALUES (
      ${invitationId}::uuid, ${pendingUserId}::uuid, ${email}, ${email.toLowerCase()}, ${inviterId}::uuid,
      ${`pending-${pendingUserId}`}, ${correlationId}::uuid
    )
  `);
  await db.execute(sql`
    INSERT INTO account_invitation_generations (
      invitation_id, generation, credential_hash, issued_at, expires_at
    ) VALUES (
      ${invitationId}::uuid, 1, ${Buffer.alloc(32, 1)}, NOW(), NOW() + INTERVAL '24 hours'
    )
  `);
});

afterAll(async () => {
  await closeTestDb();
});

describe('0054 invitation lifecycle migration', () => {
  it('keeps preexisting-style rows active and protects every lifecycle table with forced RLS', async () => {
    const db = getTestAdminDb();
    const rows = await db.execute(sql`
      SELECT id, activation_state
      FROM users
      WHERE id IN (${inviterId}::uuid, ${pendingUserId}::uuid)
      ORDER BY id
    `) as unknown as Array<{ id: string; activation_state: string }>;
    expect(rows.find(row => row.id === inviterId)?.activation_state).toBe('active');
    expect(rows.find(row => row.id === pendingUserId)?.activation_state).toBe('pending_activation');

    const rlsRows = await db.execute(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN (
        'account_invitations',
        'account_invitation_generations',
        'account_invitation_intended_roles',
        'account_invitation_claim_assertions',
        'account_invitation_delivery_attempts'
      )
    `) as unknown as Array<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>;
    expect(rlsRows).toHaveLength(5);
    expect(rlsRows.every(row => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });

  it('accepts separate lifecycle rows and rejects a competing normalized pending email', async () => {
    const db = getTestAdminDb();
    await db.execute(sql`
      INSERT INTO account_invitation_intended_roles (invitation_id, role)
      VALUES (${invitationId}::uuid, 'operator')
    `);
    await db.execute(sql`
      INSERT INTO account_invitation_claim_assertions (
        invitation_id, generation, user_id, claim_owner_hash,
        email_verified_at, expires_at, last_exchanged_at
      ) VALUES (
        ${invitationId}::uuid, 1, ${pendingUserId}::uuid, ${Buffer.alloc(32, 2)},
        NOW(), NOW() + INTERVAL '1 hour', NOW()
      )
    `);
    await db.execute(sql`
      INSERT INTO account_invitation_delivery_attempts (
        invitation_id, generation, attempt_number, state, correlation_id
      ) VALUES (${invitationId}::uuid, 1, 1, 'not_attempted', ${correlationId}::uuid)
    `);

    await db.execute(sql`UPDATE users SET activation_state = 'pending_activation' WHERE id = ${competingUserId}::uuid`);
    let conflict: unknown;
    try {
      await db.execute(sql`
        INSERT INTO account_invitations (
          id, user_id, email_original, email_normalized, inviter_user_id,
          intended_username, correlation_id
        ) VALUES (
          ${competingInvitationId}::uuid, ${competingUserId}::uuid, ${email.toUpperCase()}, ${email.toLowerCase()},
          ${inviterId}::uuid, ${`competing-${competingUserId}`}, ${randomUUID()}::uuid
        )
      `);
    } catch (error) {
      conflict = error;
    }
    expect(getErrorCode(conflict)).toBe('23505');
  });

  it('rejects malformed credential hashes and inconsistent terminal timestamps', async () => {
    const db = getTestAdminDb();
    let invalidDigest: unknown;
    try {
      await db.execute(sql`
        INSERT INTO account_invitation_generations (
          invitation_id, generation, credential_hash, issued_at, expires_at
        ) VALUES (
          ${invitationId}::uuid, 2, ${Buffer.alloc(31, 3)}, NOW(), NOW() + INTERVAL '24 hours'
        )
      `);
    } catch (error) {
      invalidDigest = error;
    }
    expect(getErrorCode(invalidDigest)).toBe('23514');

    let invalidState: unknown;
    try {
      await db.execute(sql`
        UPDATE account_invitation_generations
        SET state = 'superseded'
        WHERE invitation_id = ${invitationId}::uuid AND generation = 1
      `);
    } catch (error) {
      invalidState = error;
    }
    expect(getErrorCode(invalidState)).toBe('23514');
  });

  it('rejects claims and delivery attempts for a missing generation', async () => {
    const db = getTestAdminDb();
    let missingGeneration: unknown;
    try {
      await db.execute(sql`
        INSERT INTO account_invitation_claim_assertions (
          invitation_id, generation, user_id, claim_owner_hash,
          email_verified_at, expires_at, last_exchanged_at
        ) VALUES (
          ${invitationId}::uuid, 99, ${pendingUserId}::uuid, ${Buffer.alloc(32, 4)},
          NOW(), NOW() + INTERVAL '1 hour', NOW()
        )
      `);
    } catch (error) {
      missingGeneration = error;
    }
    expect(getErrorCode(missingGeneration)).toBe('23503');

    let missingDeliveryGeneration: unknown;
    try {
      await db.execute(sql`
        INSERT INTO account_invitation_delivery_attempts (
          invitation_id, generation, attempt_number, state, correlation_id
        ) VALUES (${invitationId}::uuid, 99, 2, 'not_attempted', ${randomUUID()}::uuid)
      `);
    } catch (error) {
      missingDeliveryGeneration = error;
    }
    expect(getErrorCode(missingDeliveryGeneration)).toBe('23503');
  });

  it('requires a claim user to own the referenced invitation', async () => {
    const db = getTestAdminDb();
    await db.execute(sql`
      INSERT INTO account_invitation_generations (
        invitation_id, generation, credential_hash, issued_at, expires_at
      ) VALUES (
        ${invitationId}::uuid, 3, ${Buffer.alloc(32, 5)}, NOW(), NOW() + INTERVAL '24 hours'
      )
    `);

    let wrongUser: unknown;
    try {
      await db.execute(sql`
        INSERT INTO account_invitation_claim_assertions (
          invitation_id, generation, user_id, claim_owner_hash,
          email_verified_at, expires_at, last_exchanged_at
        ) VALUES (
          ${invitationId}::uuid, 3, ${competingUserId}::uuid, ${Buffer.alloc(32, 6)},
          NOW(), NOW() + INTERVAL '1 hour', NOW()
        )
      `);
    } catch (error) {
      wrongUser = error;
    }
    expect(getErrorCode(wrongUser)).toBe('23503');
  });

  it('denies lifecycle table access to the non-bypass application role', async () => {
    const appDb = getTestDb();
    const rows = await appDb.execute(sql`SELECT id FROM account_invitations`);
    expect(rows).toHaveLength(0);

    let denied: unknown;
    try {
      await appDb.execute(sql`
        INSERT INTO account_invitation_delivery_attempts (
          invitation_id, generation, attempt_number, state, correlation_id
        ) VALUES (${invitationId}::uuid, 1, 2, 'not_attempted', ${randomUUID()}::uuid)
      `);
    } catch (error) {
      denied = error;
    }
    expect(getErrorCode(denied)).toBe('42501');
  });
});
