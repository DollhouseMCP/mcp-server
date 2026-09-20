import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import { PostgresInvitationDeliveryStore } from '../../../src/invitations/PostgresInvitationDeliveryStore.js';
import { PostgresInvitationManagementStore } from '../../../src/invitations/PostgresInvitationManagementStore.js';
import type { InvitationManagementAudit } from '../../../src/invitations/IInvitationManagementStore.js';
import type { InvitationDeliveryResultUpdate } from '../../../src/invitations/InvitationTypes.js';
import { accountInvitations, accountInvitationGenerations, accountInvitationDeliveryAttempts } from '../../../src/database/schema/invitations.js';
import { users } from '../../../src/database/schema/users.js';
import { getErrorCode } from '../../../src/database/db-utils.js';
import { withSystemContext } from '../../../src/database/admin.js';
import { deleteConsolePrincipalWithTx } from '../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js';
import { appendSecurityAuditEventWithTx } from '../../../src/security/auditSink.js';
import { appendConsoleAdminAuditEventWithTx } from '../../../src/web-console/audit/PostgresAdminAuditWriter.js';
import { closeTestDb, getTestAdminDb, getTestDb, isDatabaseAvailable } from './test-db-helpers.js';

const inviterId = randomUUID();
const key = randomBytes(32);
const audit: InvitationManagementAudit = { kind: 'system', appendSecurityEvent: appendSecurityAuditEventWithTx };
const adminAudit: InvitationManagementAudit = {
  kind: 'admin', appendSecurityEvent: appendSecurityAuditEventWithTx,
  appendAdminEvent: (tx, event) => appendConsoleAdminAuditEventWithTx(tx, event, { resolve: async () => ({ keyId: 'delivery-test', key }) }),
  adminContext: {
    actorUserId: inviterId, actorSub: `test:${inviterId}`, actorRole: 'admin', actorCapabilityRole: 'admin',
    actorConsoleSessionHash: Buffer.alloc(32, 7), capability: 'console:admin:accounts',
    elevationAcr: null, elevationAmr: [], elevationAuthTime: null,
    endpoint: '/internal/invitation-delivery', clientIp: null, userAgent: null,
  },
};
const db = () => getTestAdminDb();
const deliveries = () => new PostgresInvitationDeliveryStore(db());
const management = () => new PostgresInvitationManagementStore(db());
const reserve = (id: string, correlation = randomUUID(), generation = 1, writer = audit) =>
  deliveries().runMutation(writer, mutation => mutation.reserveDeliveryAttempt(id, generation, 'smtp', correlation));
const recordResult = (id: string, result: InvitationDeliveryResultUpdate, writer = audit) =>
  deliveries().runMutation(writer, mutation => mutation.recordDeliveryResult(id, result));
const regenerate = (id: string) => management().runMutation(audit, mutation => mutation.regenerate({
  invitationId: id, ttlHours: 24, credentialSecret: randomBytes(32), correlationId: randomUUID(),
}));
async function issue() {
  const id = randomUUID();
  return management().runMutation(audit, mutation => mutation.issue({
    invitationId: id, userId: randomUUID(), username: `delivery-${id}`, displayName: 'Pending',
    emailOriginal: `delivery-${id}@example.test`, emailNormalized: `delivery-${id}@example.test`,
    inviterUserId: inviterId, intendedRoles: [], generation: 1,
    credentialSecret: randomBytes(32), ttlHours: 24, correlationId: randomUUID(),
  }));
}
async function waitForBlockedUsers(mode: 'RowShareLock' | 'ExclusiveLock'): Promise<void> {
  // Observe through the independent app pool: both admin connections are in
  // the actual competing production transactions, one owning and one waiting.
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await getTestDb().execute(sql`SELECT EXISTS(
      SELECT 1 FROM pg_locks WHERE relation = 'users'::regclass AND mode = ${mode} AND NOT granted
    ) AS waiting`);
    if (rows[0].waiting) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Expected competing production writer to wait for users ${mode}`);
}

let dbAvailable = false;
beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('Required test database is unavailable');
  if (!dbAvailable) return;
  await db().insert(users).values({ id: inviterId, username: `delivery-admin-${inviterId}` });
});
afterAll(closeTestDb);

describe('transactional invitation delivery state', () => {
  it('reserves explicitly submitting with timestamps and separate durable audit', async () => {
    if (!dbAvailable) return;
    const invitation = await issue();
    const attempt = await reserve(invitation.id, randomUUID(), 1, adminAudit);
    expect(attempt).toMatchObject({ generation: 1, attemptNumber: 1, state: 'submitting', completedAt: null, submissionAuthorized: true });
    expect(attempt.startedAt).toEqual(attempt.requestedAt);
    expect(await deliveries().list(invitation.id)).toEqual([expect.objectContaining({ id: attempt.id, state: 'submitting' })]);
    expect(await db().execute(sql`SELECT sequence_id FROM admin_audit_events WHERE resource_id = ${invitation.id}`)).toHaveLength(1);
    const events = await db().execute(sql`SELECT metadata FROM security_audit_events WHERE target_id = ${invitation.id} AND event_type LIKE 'invitation.delivery.%'`);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(invitation.emailOriginal);
  });

  it('allows only one submission authorization for concurrent same-correlation reservations', async () => {
    if (!dbAvailable) return;
    const invitation = await issue();
    const correlation = randomUUID();
    const result = await Promise.all([reserve(invitation.id, correlation), reserve(invitation.id, correlation)]);
    expect(new Set(result.map(row => row.id)).size).toBe(1);
    expect(result.filter(row => row.submissionAuthorized)).toHaveLength(1);
    await expect(reserve(invitation.id)).rejects.toMatchObject({ code: 'invitation_conflict' });
  });

  it.each([
    { state: 'submitted', providerMessageId: 'provider-message-123' },
    { state: 'unknown', failureClass: 'timeout' },
  ] as const)('makes $state result idempotent without authorizing a retry', async result => {
    if (!dbAvailable) return;
    const invitation = await issue();
    const first = await reserve(invitation.id);
    const recorded = await recordResult(first.id, result);
    expect(recorded.state).toBe(result.state);
    expect(recorded.completedAt).toBeInstanceOf(Date);
    expect(recorded.version).toBe(2);
    expect(await recordResult(first.id, result)).toEqual(recorded);
    await expect(reserve(invitation.id)).rejects.toMatchObject({ code: 'invitation_conflict' });
    await expect(recordResult(first.id, { state: 'failed', failureClass: 'not_sent' })).rejects.toMatchObject({ code: 'invitation_conflict' });
    const replay = await reserve(invitation.id, first.correlationId);
    expect(replay.submissionAuthorized).toBe(false);
    expect((await management().inspect(invitation.id))?.state).toBe('pending');
    const [user] = await db().select().from(users).where(eq(users.id, invitation.userId));
    expect(user.activationState).toBe('pending_activation');
  });

  it('allocates one next attempt after confirmed failure even with concurrent explicit retries', async () => {
    if (!dbAvailable) return;
    const invitation = await issue();
    const first = await reserve(invitation.id);
    await recordResult(first.id, { state: 'failed', failureClass: 'recipient_rejected', sanitizedDetail: { smtpStatus: 550 } });
    const result = await Promise.allSettled([reserve(invitation.id), reserve(invitation.id)]);
    expect(result.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(await deliveries().list(invitation.id)).toEqual([
      expect.objectContaining({ attemptNumber: 2, state: 'submitting' }),
      expect.objectContaining({ attemptNumber: 1, state: 'failed' }),
    ]);
  });

  it('serializes competing provider outcomes without overwriting the winning result', async () => {
    if (!dbAvailable) return;
    const invitation = await issue();
    const attempt = await reserve(invitation.id);
    const result = await Promise.allSettled([
      recordResult(attempt.id, { state: 'submitted' }),
      recordResult(attempt.id, { state: 'unknown', failureClass: 'connection_lost' }),
    ]);
    expect(result.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(result.find(row => row.status === 'rejected')).toMatchObject({ reason: { code: 'invitation_conflict' } });
  });

  it('binds reservations to current generations and records late results only on their original attempt', async () => {
    if (!dbAvailable) return;
    const invitation = await issue();
    const first = await reserve(invitation.id);
    const replacement = await regenerate(invitation.id);
    await expect(reserve(invitation.id)).rejects.toMatchObject({ code: 'invitation_superseded' });
    const next = await reserve(invitation.id, randomUUID(), 2);
    expect(next.attemptNumber).toBe(1);
    await recordResult(first.id, { state: 'submitted' });
    expect(await management().inspect(invitation.id)).toEqual(replacement);
    expect((await deliveries().list(invitation.id)).map(row => [row.generation, row.state])).toEqual([[2, 'submitting'], [1, 'submitted']]);
    const event = await db().execute(sql`SELECT metadata FROM security_audit_events WHERE target_id = ${invitation.id} AND event_type = 'invitation.delivery.submitted'`);
    expect(event[0].metadata).toMatchObject({ generation: 1, attemptId: first.id });
  });

  it('denies expired generations and unavailable accounts without inserting attempts', async () => {
    if (!dbAvailable) return;
    const expired = await issue();
    await db().update(accountInvitationGenerations).set({ issuedAt: new Date(0), expiresAt: new Date(1000) }).where(eq(accountInvitationGenerations.invitationId, expired.id));
    await expect(reserve(expired.id)).rejects.toMatchObject({ code: 'invitation_expired' });
    const disabled = await issue();
    await db().update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabled.userId));
    await expect(reserve(disabled.id)).rejects.toMatchObject({ code: 'invitation_invalid' });
    expect(await deliveries().list(expired.id)).toHaveLength(0);
    expect(await deliveries().list(disabled.id)).toHaveLength(0);
  });

  it.each([
    { activationState: 'active' as const },
    { deletedAt: new Date() },
  ])('denies accounts that are no longer available for pending onboarding', async patch => {
    if (!dbAvailable) return;
    const invitation = await issue();
    await db().update(users).set(patch).where(eq(users.id, invitation.userId));
    await expect(reserve(invitation.id)).rejects.toBeInstanceOf(Error);
    expect(await deliveries().list(invitation.id)).toHaveLength(0);
  });

  it('retains late outcome evidence after revocation without reopening the invitation', async () => {
    if (!dbAvailable) return;
    const invitation = await issue();
    const attempt = await reserve(invitation.id);
    const revoked = await management().runMutation(audit, mutation => mutation.revoke(invitation.id, randomUUID()));
    expect((await recordResult(attempt.id, { state: 'unknown', failureClass: 'timeout' })).state).toBe('unknown');
    expect(await management().inspect(invitation.id)).toEqual(revoked);
    await expect(reserve(invitation.id)).rejects.toMatchObject({ code: 'invitation_invalid' });
  });

  it('cannot repopulate provider metadata after the account is deleted', async () => {
    if (!dbAvailable) return;
    const invitation = await issue();
    const attempt = await reserve(invitation.id);
    await db().update(users).set({ deletedAt: new Date(), disabledAt: new Date() }).where(eq(users.id, invitation.userId));
    await expect(recordResult(attempt.id, {
      state: 'submitted', providerMessageId: 'provider-message-deleted-account', sanitizedDetail: { smtpStatus: 250 },
    })).rejects.toMatchObject({ code: 'invitation_invalid' });
    const [retained] = await deliveries().list(invitation.id);
    expect(retained).toMatchObject({ providerMessageId: null, sanitizedDetail: null, state: 'submitting' });
  });

  it.each(['result', 'deletion'] as const)('cannot rehydrate metadata when the real %s transaction commits first', async first => {
    if (!dbAvailable) return;
    const invitation = await issue();
    const attempt = await reserve(invitation.id);
    const update: InvitationDeliveryResultUpdate = { state: 'submitted', providerMessageId: 'provider-in-flight-123',
      sanitizedDetail: { smtpStatus: 250, providerAccepted: true } };
    const deletion = { userId: invitation.userId, deletedByUserId: inviterId, deletedAt: new Date() };
    let competing: Promise<{ value?: unknown; error?: unknown }> | undefined;
    if (first === 'result') {
      await deliveries().runMutation(audit, async mutation => {
        expect(await mutation.recordDeliveryResult(attempt.id, update)).toMatchObject(update);
        competing = withSystemContext(db(), tx => deleteConsolePrincipalWithTx(tx, deletion))
          .then(value => ({ value }), error => ({ error }));
        await waitForBlockedUsers('RowShareLock');
      });
      expect(await competing).toMatchObject({ value: { outcome: 'anonymized' } });
    } else {
      await withSystemContext(db(), async tx => {
        expect(await deleteConsolePrincipalWithTx(tx, deletion)).toMatchObject({ outcome: 'anonymized' });
        competing = recordResult(attempt.id, update).then(value => ({ value }), error => ({ error }));
        await waitForBlockedUsers('ExclusiveLock');
      });
      expect(await competing).toMatchObject({ error: { code: 'invitation_invalid' } });
    }
    const [retained] = await deliveries().list(invitation.id);
    expect(retained).toMatchObject({ id: attempt.id, providerMessageId: null, failureClass: null, sanitizedDetail: null,
      state: first === 'result' ? 'submitted' : 'submitting', version: first === 'result' ? 3 : 2 });
    expect(await management().inspect(invitation.id)).toMatchObject({ state: 'revoked',
      emailOriginal: `deleted-${invitation.id}@deleted.invalid`, emailNormalized: `deleted-${invitation.id}@deleted.invalid`,
      intendedUsername: `deleted-${invitation.id}`, intendedDisplayName: null });
    const [user] = await db().select().from(users).where(eq(users.id, invitation.userId));
    expect(user).toMatchObject({ username: `deleted-${invitation.userId}`, email: null, displayName: null });
    expect(user.deletedAt).not.toBeNull();
    expect(user.disabledAt).not.toBeNull();
    // Even replaying the formerly successful result must not repopulate scrubbed
    // fields or append a new result audit after the account has been deleted.
    const eventsBefore = await db().execute(sql`SELECT * FROM security_audit_events WHERE target_id = ${invitation.id} ORDER BY id`);
    await expect(recordResult(attempt.id, update)).rejects.toMatchObject({ code: 'invitation_invalid' });
    expect((await deliveries().list(invitation.id))[0]).toEqual(retained);
    expect(await db().execute(sql`SELECT * FROM security_audit_events WHERE target_id = ${invitation.id} ORDER BY id`)).toEqual(eventsBefore);
  });

  it('rolls back reservation and result mutations when transaction-scoped audit fails', async () => {
    if (!dbAvailable) return;
    const invitation = await issue();
    const failing: InvitationManagementAudit = { ...adminAudit, appendAdminEvent: async () => { throw new Error('audit unavailable'); } };
    await expect(reserve(invitation.id, randomUUID(), 1, failing)).rejects.toThrow('audit unavailable');
    expect(await deliveries().list(invitation.id)).toHaveLength(0);
    const attempt = await reserve(invitation.id);
    await expect(recordResult(attempt.id, { state: 'submitted' }, failing)).rejects.toThrow('audit unavailable');
    expect((await deliveries().list(invitation.id))[0]).toMatchObject({ state: 'submitting', version: 1, completedAt: null });
    expect(await db().execute(sql`SELECT id FROM security_audit_events WHERE target_id = ${invitation.id} AND event_type = 'invitation.delivery.submitted'`)).toHaveLength(0);
  });

  it.each([null, 'delivered', 'bogus'])('schema rejects omitted/invalid attempt state %s', async state => {
    if (!dbAvailable) return;
    const invitation = await issue();
    let error: unknown;
    try {
      if (state === null) await db().execute(sql`INSERT INTO account_invitation_delivery_attempts (invitation_id, generation, attempt_number, correlation_id) VALUES (${invitation.id}, 1, 1, ${randomUUID()})`);
      else await db().execute(sql`INSERT INTO account_invitation_delivery_attempts (invitation_id, generation, attempt_number, correlation_id, state) VALUES (${invitation.id}, 1, 1, ${randomUUID()}, ${state})`);
    } catch (caught) { error = caught; }
    expect(getErrorCode(error)).toBe(state === null ? '23502' : '23514');
  });

  it('leaves pending invitation and account untouched after unsafe result metadata is rejected', async () => {
    if (!dbAvailable) return;
    const invitation = await issue();
    const attempt = await reserve(invitation.id);
    await expect(recordResult(attempt.id, { state: 'failed', failureClass: 'not_sent', sanitizedDetail: { error: 'password=secret' } })).rejects.toMatchObject({ code: 'invitation_invalid' });
    expect((await deliveries().list(invitation.id))[0].state).toBe('submitting');
    const [row] = await db().select().from(accountInvitations).where(eq(accountInvitations.id, invitation.id));
    expect(row.state).toBe('pending');
    expect(await db().select().from(accountInvitationDeliveryAttempts).where(eq(accountInvitationDeliveryAttempts.id, attempt.id))).toHaveLength(1);
  });
});
