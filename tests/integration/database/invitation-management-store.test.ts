import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { PostgresInvitationManagementStore } from '../../../src/invitations/PostgresInvitationManagementStore.js';
import type { InvitationIssueRecord } from '../../../src/invitations/IInvitationStore.js';
import type { InvitationManagementAudit } from '../../../src/invitations/IInvitationManagementStore.js';
import { hashInvitationCredential } from '../../../src/invitations/InvitationToken.js';
import { normalizeInvitationEmail } from '../../../src/invitations/InvitationEmail.js';
import { appendSecurityAuditEventWithTx } from '../../../src/security/auditSink.js';
import { appendConsoleAdminAuditEventWithTx } from '../../../src/web-console/audit/PostgresAdminAuditWriter.js';
import { accountInvitations, accountInvitationGenerations, accountInvitationClaimAssertions } from '../../../src/database/schema/invitations.js';
import { users } from '../../../src/database/schema/users.js';
import { withSystemContext } from '../../../src/database/admin.js';
import { deleteConsolePrincipalWithTx } from '../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js';
import { closeTestDb, getTestAdminDb, isDatabaseAvailable } from './test-db-helpers.js';

const inviterId = randomUUID();
const key = randomBytes(32);
const systemAudit: InvitationManagementAudit = { kind: 'system', appendSecurityEvent: appendSecurityAuditEventWithTx };
const adminAudit: InvitationManagementAudit = {
  kind: 'admin', appendSecurityEvent: appendSecurityAuditEventWithTx,
  appendAdminEvent: (tx, event) => appendConsoleAdminAuditEventWithTx(tx, event, {
    resolve: async () => ({ keyId: 'invitation-test', key }),
  }),
  adminContext: {
    actorUserId: inviterId, actorSub: `test:${inviterId}`, actorRole: 'admin', actorCapabilityRole: 'admin',
    actorConsoleSessionHash: Buffer.alloc(32, 5), capability: 'console:admin:accounts',
    elevationAcr: null, elevationAmr: [], elevationAuthTime: null,
    endpoint: '/internal/invitations', clientIp: null, userAgent: null,
  },
};
const store = () => new PostgresInvitationManagementStore(getTestAdminDb());
const record = (overrides: Partial<InvitationIssueRecord> = {}): InvitationIssueRecord => {
  const id = randomUUID();
  return {
    invitationId: id, userId: randomUUID(), username: `invite-${id}`, displayName: 'Pending User',
    emailOriginal: `User-${id}@Example.com`, emailNormalized: `user-${id}@example.com`,
    inviterUserId: inviterId, intendedRoles: ['operator'], generation: 1,
    credentialSecret: randomBytes(32), ttlHours: 24, correlationId: randomUUID(), ...overrides,
  };
};
const issue = (input = record(), audit = systemAudit) => store().runMutation(audit, mutation => mutation.issue(input));
const regenerate = (invitationId: string, audit = systemAudit) => store().runMutation(audit, mutation => mutation.regenerate({
  invitationId, credentialSecret: randomBytes(32), ttlHours: 1, correlationId: randomUUID(),
}));
const revoke = (invitationId: string, audit = systemAudit) => store().runMutation(audit, mutation => mutation.revoke(invitationId, randomUUID()));

let databaseAvailable = false;
beforeAll(async () => {
  databaseAvailable = await isDatabaseAvailable();
  if (!databaseAvailable && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') {
    throw new Error('PostgreSQL is required for invitation integration tests');
  }
  if (!databaseAvailable) return;
  await getTestAdminDb().insert(users).values({ id: inviterId, username: `admin-${inviterId}` }); });
afterAll(closeTestDb);

describe('transactional invitation management', () => {
  it('atomically creates a pending user and hashed generation without identities, roles or sessions', async () => {
    if (!databaseAvailable) return;
    const input = record();
    const view = await issue(input, adminAudit);
    expect(await store().inspect(view.id)).toEqual(view);
    expect(view.currentGeneration.expiresAt.getTime() - view.currentGeneration.issuedAt.getTime()).toBe(24 * 3_600_000);
    expect(view.currentGeneration).not.toHaveProperty('credentialHash');
    const [user] = await getTestAdminDb().select().from(users).where(eq(users.id, input.userId));
    expect(user.activationState).toBe('pending_activation');
    expect(user.disabledAt).toBeNull();
    expect(user.deletedAt).toBeNull();
    const [generation] = await getTestAdminDb().select().from(accountInvitationGenerations)
      .where(eq(accountInvitationGenerations.invitationId, view.id));
    expect(generation.credentialHash).toEqual(hashInvitationCredential({ invitationId: view.id, generation: 1, secret: input.credentialSecret }, input.emailNormalized, generation.expiresAt));
    const linked = await getTestAdminDb().execute(sql`
      SELECT (SELECT count(*) FROM auth_accounts WHERE user_id = ${input.userId}::uuid)::int AS identities,
      (SELECT count(*) FROM user_admin_roles WHERE user_id = ${input.userId}::uuid)::int AS roles,
      (SELECT count(*) FROM console_sessions WHERE user_id = ${input.userId}::uuid)::int AS sessions
    `);
    expect(linked[0]).toEqual({ identities: 0, roles: 0, sessions: 0 });
    const security = await getTestAdminDb().execute(sql`SELECT * FROM security_audit_events WHERE target_id = ${view.id}`);
    const admin = await getTestAdminDb().execute(sql`SELECT * FROM admin_audit_events WHERE resource_id = ${view.id}`);
    expect(security).toHaveLength(1);
    expect(admin).toHaveLength(1);
    const auditJson = JSON.stringify([security, admin]);
    expect(auditJson).not.toContain(input.emailOriginal);
    expect(auditJson).not.toContain(input.credentialSecret.toString('hex'));
    expect(auditJson).not.toContain(input.credentialSecret.toString('base64url'));
    expect(await store().inspect(randomUUID())).toBeNull();
  });

  it('rolls back user, invitation and both audits when administrator audit fails', async () => {
    if (!databaseAvailable) return;
    const input = record();
    const failAudit: InvitationManagementAudit = { ...adminAudit, appendAdminEvent: async (tx, event) => {
      if (adminAudit.kind === 'admin') await adminAudit.appendAdminEvent(tx, event);
      throw new Error('audit unavailable');
    } } as InvitationManagementAudit;
    await expect(issue(input, failAudit)).rejects.toThrow('audit unavailable');
    expect(await store().inspect(input.invitationId)).toBeNull();
    expect(await getTestAdminDb().select().from(users).where(eq(users.id, input.userId))).toHaveLength(0);
    expect(await getTestAdminDb().execute(sql`SELECT id FROM security_audit_events WHERE target_id = ${input.invitationId}`)).toHaveLength(0);
    expect(await getTestAdminDb().execute(sql`SELECT sequence_id FROM admin_audit_events WHERE resource_id = ${input.invitationId}`)).toHaveLength(0);
  });

  it('copies caller-owned secret and intended roles before awaiting the mutation', async () => {
    if (!databaseAvailable) return;
    const input = record();
    const saved = Buffer.from(input.credentialSecret);
    const view = await store().runMutation(systemAudit, async mutation => {
      const pending = mutation.issue(input);
      input.credentialSecret.fill(7);
      (input.intendedRoles as string[]).push('admin');
      return pending;
    });
    expect(view.intendedRoles).toEqual(['operator']);
    const [generation] = await getTestAdminDb().select().from(accountInvitationGenerations).where(eq(accountInvitationGenerations.invitationId, view.id));
    expect(generation.credentialHash).toEqual(hashInvitationCredential({ invitationId: view.id, generation: 1, secret: saved }, view.emailNormalized, generation.expiresAt));
  });

  it('serializes competing replica issuance for the same normalized email', async () => {
    if (!databaseAvailable) return;
    const first = record();
    const second = record({ emailOriginal: first.emailOriginal.toUpperCase(), emailNormalized: first.emailNormalized });
    const results = await Promise.allSettled([issue(first), issue(second)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'invitation_conflict' } });
    const found = await getTestAdminDb().select().from(users).where(eq(users.email, first.emailNormalized));
    expect(found).toHaveLength(1);
  });

  it('rejects existing active accounts using the same NFC/case/whitespace email normalization', async () => {
    if (!databaseAvailable) return;
    const email = `Usér-${randomUUID()}@Example.com`;
    await getTestAdminDb().insert(users).values({ username: `existing-${randomUUID()}`, email: `\u00a0${email.normalize('NFD')}\u00a0` });
    await expect(issue(record({ emailOriginal: email, emailNormalized: normalizeInvitationEmail(email) }))).rejects.toMatchObject({ code: 'invitation_conflict' });
  });

  it('rejects a canonical username collision with a legacy padded, cased and decomposed value', async () => {
    if (!databaseAvailable) return;
    const canonicalUsername = `café-${randomUUID()}`;
    const legacyUsername = `\u00a0${canonicalUsername.normalize('NFD').toUpperCase()}\u00a0`;
    await getTestAdminDb().insert(users).values({ username: legacyUsername });
    await expect(issue(record({ username: canonicalUsername }))).rejects.toMatchObject({ code: 'invitation_conflict' });
  });

  it.each([
    { username: ' MixedCase ', displayName: 'Pending User' },
    { username: `valid-${randomUUID()}`, displayName: ' Padded Name ' },
    { username: '\u0301detached-mark', displayName: 'Pending User' },
  ])('rejects noncanonical or invalid direct-store account names', async account => {
    if (!databaseAvailable) return;
    const input = record(account);
    await expect(issue(input)).rejects.toMatchObject({ code: 'invitation_invalid' });
    expect(await store().inspect(input.invitationId)).toBeNull();
  });

  it.each([0, 169, 1.5])('rejects invalid TTL %s without creating records', async ttlHours => {
    if (!databaseAvailable) return;
    const input = record({ ttlHours });
    await expect(issue(input)).rejects.toMatchObject({ code: 'configuration_invalid' });
    expect(await store().inspect(input.invitationId)).toBeNull();
  });

  it('rejects mismatched normalized email and administrator issuer', async () => {
    if (!databaseAvailable) return;
    await expect(issue(record({ emailNormalized: 'other@example.com' }))).rejects.toMatchObject({ code: 'invitation_invalid' });
    await expect(issue(record({ inviterUserId: randomUUID() }), adminAudit)).rejects.toMatchObject({ code: 'invitation_invalid' });
  });

  it('supersedes an expired generation and revokes its open claim in the replacement transaction', async () => {
    if (!databaseAvailable) return;
    const view = await issue();
    const db = getTestAdminDb();
    await db.update(accountInvitationGenerations).set({ state: 'expired', expiredAt: new Date(), issuedAt: new Date(0), expiresAt: new Date(3_600_000) }).where(eq(accountInvitationGenerations.invitationId, view.id));
    await db.update(accountInvitations).set({ state: 'expired', expiredAt: new Date() }).where(eq(accountInvitations.id, view.id));
    await db.insert(accountInvitationClaimAssertions).values({ invitationId: view.id, generation: 1, userId: view.userId, claimOwnerHash: randomBytes(32), emailVerifiedAt: new Date(), lastExchangedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) });
    const regenerated = await regenerate(view.id);
    expect(regenerated.state).toBe('pending');
    expect(regenerated.currentGeneration.generation).toBe(2);
    expect(regenerated.currentGeneration.expiresAt.getTime() - regenerated.currentGeneration.issuedAt.getTime()).toBe(3_600_000);
    const [old] = await db.select().from(accountInvitationGenerations).where(and(eq(accountInvitationGenerations.invitationId, view.id), eq(accountInvitationGenerations.generation, 1)));
    expect(old.state).toBe('superseded');
    expect(old.expiredAt).toBeNull();
    const [claim] = await db.select().from(accountInvitationClaimAssertions).where(eq(accountInvitationClaimAssertions.invitationId, view.id));
    expect(claim.state).toBe('revoked');
  });

  it('serializes simultaneous regeneration into successive valid generations', async () => {
    if (!databaseAvailable) return;
    const view = await issue();
    const results = await Promise.all([regenerate(view.id), regenerate(view.id)]);
    expect(results.map(result => result.currentGeneration.generation).sort()).toEqual([2, 3]);
    const all = await getTestAdminDb().select().from(accountInvitationGenerations).where(eq(accountInvitationGenerations.invitationId, view.id));
    expect(all.filter(row => row.state === 'pending')).toHaveLength(1);
    expect(all.filter(row => row.state === 'superseded')).toHaveLength(2);
  });

  it('makes revoke idempotent and a regeneration race cannot resurrect a revoked invitation', async () => {
    if (!databaseAvailable) return;
    const view = await issue();
    await Promise.allSettled([regenerate(view.id), revoke(view.id)]);
    const final = await store().inspect(view.id);
    expect(final?.state).toBe('revoked');
    expect(await revoke(view.id)).toEqual(final);
    await expect(regenerate(view.id)).rejects.toMatchObject({ code: 'invitation_revoked' });
  });

  it('rolls back generation replacement and revocation when security audit fails', async () => {
    if (!databaseAvailable) return;
    const view = await issue();
    const fail: InvitationManagementAudit = { kind: 'system', appendSecurityEvent: async () => { throw new Error('security audit failed'); } };
    await expect(regenerate(view.id, fail)).rejects.toThrow('security audit failed');
    expect(await store().inspect(view.id)).toEqual(view);
    await expect(revoke(view.id, fail)).rejects.toThrow('security audit failed');
    expect(await store().inspect(view.id)).toEqual(view);
  });

  it.each(['disabled', 'deleted'] as const)('acknowledges a revoked invitation after its recipient is %s without further writes', async state => {
    if (!databaseAvailable) return;
    const view = await issue(record(), adminAudit);
    await revoke(view.id, adminAudit);
    if (state === 'disabled') {
      await getTestAdminDb().update(users).set({ disabledAt: new Date() }).where(eq(users.id, view.userId));
    } else {
      const deleted = await withSystemContext(getTestAdminDb(), tx => deleteConsolePrincipalWithTx(tx, {
        userId: view.userId, deletedByUserId: inviterId, deletedAt: new Date(),
      }));
      expect(deleted?.outcome).toBe('anonymized');
    }
    const terminal = await store().inspect(view.id);
    const [before] = await getTestAdminDb().select().from(users).where(eq(users.id, view.userId));
    const securityBefore = await getTestAdminDb().execute(sql`SELECT * FROM security_audit_events WHERE target_id = ${view.id} ORDER BY id`);
    const adminBefore = await getTestAdminDb().execute(sql`SELECT * FROM admin_audit_events WHERE resource_id = ${view.id} ORDER BY sequence_id`);
    expect(await revoke(view.id, adminAudit)).toEqual(terminal);
    expect((await getTestAdminDb().select().from(users).where(eq(users.id, view.userId)))[0]).toEqual(before);
    expect(await store().inspect(view.id)).toEqual(terminal);
    expect(await getTestAdminDb().execute(sql`SELECT * FROM security_audit_events WHERE target_id = ${view.id} ORDER BY id`)).toEqual(securityBefore);
    expect(await getTestAdminDb().execute(sql`SELECT * FROM admin_audit_events WHERE resource_id = ${view.id} ORDER BY sequence_id`)).toEqual(adminBefore);
    if (state === 'deleted') expect(before).toMatchObject({ username: `deleted-${view.userId}`, email: null, displayName: null });
  });

  it.each(['disabledAt', 'deletedAt'] as const)('preserves and denies the independent %s account state', async field => {
    if (!databaseAvailable) return;
    const view = await issue();
    await getTestAdminDb().update(users).set({ [field]: new Date() }).where(eq(users.id, view.userId));
    await expect(regenerate(view.id)).rejects.toMatchObject({ code: 'invitation_invalid' });
    await expect(revoke(view.id)).rejects.toMatchObject({ code: 'invitation_invalid' });
    const [user] = await getTestAdminDb().select().from(users).where(eq(users.id, view.userId));
    expect(user[field]).not.toBeNull();
    expect(user.activationState).toBe('pending_activation');
  });

  it('rejects accepted invitations and accounts already activated', async () => {
    if (!databaseAvailable) return;
    const view = await issue();
    await getTestAdminDb().update(accountInvitations).set({ state: 'accepted', acceptedAt: new Date() }).where(eq(accountInvitations.id, view.id));
    await getTestAdminDb().update(accountInvitationGenerations).set({ state: 'accepted', acceptedAt: new Date() }).where(eq(accountInvitationGenerations.invitationId, view.id));
    await expect(regenerate(view.id)).rejects.toMatchObject({ code: 'invitation_invalid' });
    await expect(revoke(view.id)).rejects.toMatchObject({ code: 'invitation_invalid' });
    await getTestAdminDb().update(users).set({ activationState: 'active' }).where(eq(users.id, view.userId));
    await expect(regenerate(view.id)).rejects.toMatchObject({ code: 'account_not_pending' });
  });

  it('copies regeneration secrets and audit actor buffers at their async boundaries', async () => {
    if (!databaseAvailable) return;
    const view = await issue();
    const secret = randomBytes(32);
    const saved = Buffer.from(secret);
    const mutableAudit = { ...adminAudit, adminContext: {
      ...(adminAudit.kind === 'admin' ? adminAudit.adminContext : (() => { throw new Error('admin required'); })()),
      actorConsoleSessionHash: Buffer.alloc(32, 17), elevationAmr: ['original'],
    } } as Extract<InvitationManagementAudit, { kind: 'admin' }>;
    const pending = store().runMutation(mutableAudit, async mutation => {
      const result = mutation.regenerate({ invitationId: view.id, credentialSecret: secret, ttlHours: 1, correlationId: randomUUID() });
      secret.fill(1);
      return result;
    });
    mutableAudit.adminContext.actorConsoleSessionHash.fill(3);
    (mutableAudit.adminContext.elevationAmr as string[]).push('changed');
    const regenerated = await pending;
    const [generation] = await getTestAdminDb().select().from(accountInvitationGenerations).where(and(eq(accountInvitationGenerations.invitationId, view.id), eq(accountInvitationGenerations.generation, 2)));
    expect(generation.credentialHash).toEqual(hashInvitationCredential({ invitationId: view.id, generation: 2, secret: saved }, view.emailNormalized, regenerated.currentGeneration.expiresAt));
    const events = await getTestAdminDb().execute(sql`SELECT actor_console_session_hash, elevation_amr FROM admin_audit_events WHERE resource_id = ${view.id}`);
    expect(events[0].actor_console_session_hash).toEqual(Buffer.alloc(32, 17));
    expect(events[0].elevation_amr).toEqual(['original']);
  });

  it('waits for an existing account writer and rejects its committed duplicate', async () => {
    if (!databaseAvailable) return;
    const input = record();
    let pending: Promise<unknown> | undefined;
    await getTestAdminDb().transaction(async tx => {
      await tx.insert(users).values({ username: `competing-${randomUUID()}`, email: input.emailOriginal });
      pending = issue(input);
      // The row-exclusive lock is held until this transaction commits. Issuance
      // must inspect the committed account, even if its transaction began earlier.
    });
    await expect(pending).rejects.toMatchObject({ code: 'invitation_conflict' });
    expect(await store().inspect(input.invitationId)).toBeNull();
  });

  it('rejects inconsistent generation state and missing invitations without writes', async () => {
    if (!databaseAvailable) return;
    await expect(regenerate(randomUUID())).rejects.toMatchObject({ code: 'invitation_not_found' });
    const view = await issue();
    await getTestAdminDb().update(accountInvitationGenerations).set({ state: 'expired', expiredAt: new Date() }).where(eq(accountInvitationGenerations.invitationId, view.id));
    await expect(regenerate(view.id)).rejects.toMatchObject({ code: 'invitation_invalid' });
    await expect(revoke(view.id)).rejects.toMatchObject({ code: 'invitation_invalid' });
  });


  it.each(['update', 'soft-delete'] as const)('does not deadlock with an existing row-lock-first account %s writer', async operation => {
    if (!databaseAvailable) return;
    const view = await issue();
    let pending: Promise<unknown> | undefined;
    await getTestAdminDb().transaction(async tx => {
      // Existing account administration locks rows before its UPDATE/DELETE.
      await tx.select().from(users).where(eq(users.id, view.userId)).for('update');
      pending = regenerate(view.id).catch(error => error);
      // Let regeneration attempt its table lock while this transaction owns ROW SHARE.
      await tx.execute(sql`SELECT pg_sleep(0.1)`);
      if (operation === 'update') {
        await tx.update(users).set({ displayName: 'Changed by existing writer' }).where(eq(users.id, view.userId));
      } else {
        await tx.update(users).set({ deletedAt: new Date() }).where(eq(users.id, view.userId));
      }
    });
    const result = await pending;
    if (operation === 'update') {
      expect(result).toMatchObject({ currentGeneration: { generation: 2 } });
    } else {
      expect(result).toMatchObject({ code: 'invitation_invalid' });
      expect((await store().inspect(view.id))?.currentGeneration.generation).toBe(1);
    }
  });

  it('aborts before mutation callbacks when an ordinary audit owns the head before its users FK check', async () => {
    if (!databaseAvailable) return;
    const input = record();
    let managementResult: Promise<unknown> | undefined;
    let mutationAuditCalls = 0;
    const contenderAudit = { ...adminAudit, appendAdminEvent: async (tx, event) => {
      mutationAuditCalls += 1;
      if (adminAudit.kind === 'admin') await adminAudit.appendAdminEvent(tx, event);
    } } as InvitationManagementAudit;
    await getTestAdminDb().transaction(async writer => {
      // Match the ordinary writer's actual INSERT then FOR UPDATE order. It has
      // not touched users yet; its later audit INSERT performs those FK checks.
      await writer.execute(sql`INSERT INTO admin_audit_chain_heads (stream_id) VALUES ('admin') ON CONFLICT DO NOTHING`);
      await writer.execute(sql`SELECT * FROM admin_audit_chain_heads WHERE stream_id = 'admin' FOR UPDATE`);
      managementResult = issue(input, contenderAudit).catch(error => error);
      await writer.execute(sql`SELECT pg_sleep(0.1)`);
      if (adminAudit.kind !== 'admin') throw new Error('admin audit required');
      await adminAudit.appendAdminEvent(writer, {
        ...adminAudit.adminContext, occurredAt: new Date(), correlationId: randomUUID(),
        operation: 'test.concurrent_audit', resourceKind: null, resourceId: null, targetUserId: inviterId,
        argsRedacted: {}, result: 'approved', errorCode: null, resultDetailRedacted: null,
      });
    });
    expect(await managementResult).toMatchObject({ code: 'concurrent_update' });
    expect(mutationAuditCalls).toBe(0);
    expect(await store().inspect(input.invitationId)).toBeNull();
    expect(await getTestAdminDb().select().from(users).where(eq(users.id, input.userId))).toHaveLength(0);
    expect((await issue(input, adminAudit)).state).toBe('pending');
  });
});
