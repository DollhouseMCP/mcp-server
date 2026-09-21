import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { withSystemContext } from '../../../src/database/admin.js';
import { authAccounts, authKv } from '../../../src/database/schema/auth.js';
import { accountInvitationGenerations as generations, accountInvitationClaimAssertions as claims } from '../../../src/database/schema/invitations.js';
import { users } from '../../../src/database/schema/users.js';
import { userAdminRoles } from '../../../src/database/schema/webConsole.js';
import type { InvitationManagementAudit } from '../../../src/invitations/IInvitationManagementStore.js';
import { PostgresInvitationManagementStore } from '../../../src/invitations/PostgresInvitationManagementStore.js';
import { PostgresInvitationClaimStore } from '../../../src/invitations/PostgresInvitationClaimStore.js';
import { PostgresInvitationActivationStore, type InvitationActivationInput } from '../../../src/invitations/PostgresInvitationActivationStore.js';
import { PostgresOnboardingStore, ONBOARDING_SESSION_MODEL, ONBOARDING_OWNER_MODEL } from '../../../src/invitations/onboarding/PostgresOnboardingStore.js';
import { appendSecurityAuditEventWithTx } from '../../../src/security/auditSink.js';
import { appendConsoleAdminAuditEventWithTx } from '../../../src/web-console/audit/PostgresAdminAuditWriter.js';
import { PostgresConsoleAccountAllowlistStore, addAccountAllowlistEntryWithTx, removeAccountAllowlistEntryWithTx } from '../../../src/web-console/stores/PostgresConsoleAccountAllowlistStore.js';
import { closeTestDb, getTestAdminDb, isDatabaseAvailable } from './test-db-helpers.js';

const audit: InvitationManagementAudit = { kind: 'system', appendSecurityEvent: appendSecurityAuditEventWithTx };
const management = () => new PostgresInvitationManagementStore(getTestAdminDb());
const sessionStore = () => new PostgresOnboardingStore(getTestAdminDb(), new PostgresInvitationClaimStore(getTestAdminDb()));
const activate = (input: InvitationActivationInput, writer = audit) => new PostgresInvitationActivationStore(getTestAdminDb(), sessionStore()).activate(input, writer);
let databaseAvailable = false;
beforeAll(async () => {
  databaseAvailable = await isDatabaseAvailable();
  if (!databaseAvailable && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('PostgreSQL is required for activation tests');
});
afterAll(closeTestDb);

async function fixture() {
  const inviterId = randomUUID();
  await getTestAdminDb().insert(users).values({ id: inviterId, username: `issuer-${inviterId}` });
  await getTestAdminDb().insert(userAdminRoles).values({ userId: inviterId, role: 'admin', grantedByUserId: inviterId });
  const id = randomUUID();
  const secret = randomBytes(32);
  const invitation = await management().runMutation(audit, mutation => mutation.issue({
    invitationId: id, userId: randomUUID(), username: `activation-${id}`, displayName: null,
    emailOriginal: `${id}@example.com`, emailNormalized: `${id}@example.com`, inviterUserId: inviterId,
    intendedRoles: ['operator', 'auditor'], generation: 1, credentialSecret: secret, ttlHours: 1, correlationId: randomUUID(),
  }));
  const owner = randomBytes(32);
  const claim = await new PostgresInvitationClaimStore(getTestAdminDb()).runMutation(audit, mutation => mutation.beginClaim({
    invitationId: id, generation: 1, credentialSecret: secret, claimOwnerHash: owner, correlationId: randomUUID(),
  }));
  const sessionHash = randomBytes(32);
  await sessionStore().createOwner(owner, randomBytes(32));
  await sessionStore().replaceSession({ ownerHash: owner, sessionHash, csrfTokenHash: randomBytes(32),
    invitationId: id, generation: 1, claimAssertionId: claim.id });
  const input: InvitationActivationInput = {
    invitationId: id, generation: 1, claimAssertionId: claim.id, claimOwnerHash: owner, sessionHash,
    githubId: `9${BigInt(`0x${randomBytes(8).toString('hex')}`)}`, githubLogin: 'renamed-provider-user',
    providerEmail: null, providerEmailVerified: false, correlationId: randomUUID(),
  };
  return { invitation, claim, input, inviterId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function state(f: Fixture) {
  const rows = await getTestAdminDb().execute(sql`
    SELECT activation_state,
      (SELECT state FROM account_invitations WHERE id = ${f.invitation.id}::uuid) AS invitation_state,
      (SELECT state FROM account_invitation_claim_assertions WHERE id = ${f.claim.id}::uuid) AS claim_state,
      (SELECT count(*) FROM auth_accounts WHERE user_id = ${f.invitation.userId}::uuid)::int AS identities,
      (SELECT count(*) FROM user_admin_roles WHERE user_id = ${f.invitation.userId}::uuid AND revoked_at IS NULL)::int AS roles,
      (SELECT count(*) FROM account_allowlist_entries WHERE kind = 'github_id' AND normalized_value = ${f.input.githubId} AND revoked_at IS NULL)::int AS grants,
      (SELECT count(*) FROM security_invalidation_events WHERE user_id = ${f.invitation.userId}::uuid)::int AS invalidations,
      (SELECT count(*) FROM security_audit_events WHERE target_id = ${f.invitation.id} AND event_type = 'invitation.activated')::int AS audits,
      (SELECT count(*) FROM console_sessions WHERE user_id = ${f.invitation.userId}::uuid)::int AS sessions
    FROM users WHERE id = ${f.invitation.userId}::uuid
  `);
  return rows[0];
}
async function restrictedRecords(f: Fixture) {
  return getTestAdminDb().select().from(authKv).where(sql`${authKv.id} = ${f.input.claimOwnerHash.toString('hex')}
    AND ${authKv.model} IN (${ONBOARDING_OWNER_MODEL}, ${ONBOARDING_SESSION_MODEL})`).orderBy(authKv.model);
}
async function expectPending(f: Fixture) {
  expect(await state(f)).toEqual({ activation_state: 'pending_activation', invitation_state: 'pending', claim_state: 'open', identities: 0, roles: 0, grants: 0, invalidations: 0, audits: 0, sessions: 0 });
}

describe('atomic invitation GitHub activation', () => {
  it.each([null, 'different-address@example.org'])('activates by immutable GitHub ID with optional unrelated metadata email %s', async email => {
    if (!databaseAvailable) return;
    const f = await fixture();
    expect(await activate({ ...f.input, providerEmail: email, providerEmailVerified: true })).toEqual({ status: 'activated', userId: f.invitation.userId, invitationId: f.invitation.id });
    expect(await state(f)).toEqual({ activation_state: 'active', invitation_state: 'accepted', claim_state: 'completed', identities: 1, roles: 2, grants: 1, invalidations: 1, audits: 1, sessions: 0 });
    const [identity] = await getTestAdminDb().select().from(authAccounts).where(eq(authAccounts.userId, f.invitation.userId));
    expect(identity).toMatchObject({ provider: 'github', externalSub: f.input.githubId, sub: `github_${f.input.githubId}`, email, emailVerified: email !== null });
    const [generation] = await getTestAdminDb().select().from(generations).where(eq(generations.invitationId, f.invitation.id));
    expect(generation.state).toBe('accepted');
    expect(generation.credentialConsumedAt).not.toBeNull();
    expect(await restrictedRecords(f)).toHaveLength(0);
    const events = await getTestAdminDb().execute(sql`SELECT * FROM security_audit_events WHERE event_type IN ('invitation.activated', 'invitation.github_identity_linked') AND (target_id = ${f.invitation.id} OR target_id = ${f.invitation.userId})`);
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain(f.input.claimOwnerHash.toString('hex'));
    expect(await getTestAdminDb().execute(sql`SELECT sequence_id FROM admin_audit_events WHERE resource_id = ${f.invitation.id}`)).toHaveLength(0);
  });

  it('admits a later ordinary provision through the actual authority using only stable GitHub ID', async () => {
    if (!databaseAvailable) return;
    const f = await fixture();
    await activate(f.input);
    const before = await state(f);
    const sub = `github_${f.input.githubId}`;
    const result = await new PostgresConsoleAccountAllowlistStore(getTestAdminDb()).provisionAccountIfAllowed({
      identity: { sub, method: 'github', provider: 'github', externalSub: f.input.githubId, githubId: f.input.githubId, githubUsername: 'another-renamed-login' },
      account: { provider: 'github', externalSub: f.input.githubId, sub, emailVerified: false, createdAt: Date.now(), updatedAt: Date.now() }, required: true,
    });
    expect(result).toEqual({ allowed: true });
    expect(await state(f)).toEqual(before);
    const [identity] = await getTestAdminDb().select().from(authAccounts).where(eq(authAccounts.sub, sub));
    expect(identity.userId).toBe(f.invitation.userId);
  });

  it.each(['email', 'github_username'] as const)('honors current matching %s deny tombstones', async kind => {
    if (!databaseAvailable) return;
    const f = await fixture();
    const email = `${randomUUID()}@example.org`;
    const login = `u-${randomUUID()}`;
    await withSystemContext(getTestAdminDb(), async tx => {
      const grant = await addAccountAllowlistEntryWithTx(tx, { kind, value: kind === 'email' ? email : login, createdByUserId: f.inviterId, createdAt: new Date() });
      await removeAccountAllowlistEntryWithTx(tx, { id: grant.id, revokedByUserId: f.inviterId, revokedAt: new Date() });
    });
    await expect(activate({ ...f.input, githubLogin: login, providerEmail: email, providerEmailVerified: true })).rejects.toMatchObject({ code: 'invitation_invalid' });
    await expectPending(f);
  });

  it.each(['disabledAt', 'deletedAt'] as const)('rejects a completed retry when the account is now %s', async field => {
    if (!databaseAvailable) return;
    const f = await fixture();
    await activate(f.input);
    await getTestAdminDb().update(users).set({ [field]: new Date() }).where(eq(users.id, f.invitation.userId));
    await expect(activate(f.input)).rejects.toMatchObject({ code: 'invitation_invalid' });
  });

  it.each(['session', 'owner'] as const)('rejects a restricted %s that ended before activation', async kind => {
    if (!databaseAvailable) return;
    const f = await fixture();
    if (kind === 'session') await sessionStore().endSession(f.input.claimOwnerHash, f.input.sessionHash);
    else await sessionStore().endOwner(f.input.claimOwnerHash);
    await expect(activate(f.input)).rejects.toMatchObject({ code: 'invitation_invalid' });
    await expectPending(f);
  });

  it('rejects a replaced restricted session even though its owner and claim remain valid', async () => {
    if (!databaseAvailable) return;
    const f = await fixture();
    await sessionStore().replaceSession({ ownerHash: f.input.claimOwnerHash, sessionHash: randomBytes(32), csrfTokenHash: randomBytes(32),
      invitationId: f.invitation.id, generation: 1, claimAssertionId: f.claim.id });
    await expect(activate(f.input)).rejects.toMatchObject({ code: 'invitation_invalid' });
    await expectPending(f);
  });

  it('rejects a live session whose persisted invitation differs from the activation request', async () => {
    if (!databaseAvailable) return;
    const first = await fixture();
    const second = await fixture();
    await expect(activate({ ...second.input, claimOwnerHash: first.input.claimOwnerHash, sessionHash: first.input.sessionHash }))
      .rejects.toMatchObject({ code: 'invitation_invalid' });
    await expectPending(first);
    await expectPending(second);
  });

  it('retains live restricted-session locks through activation commit while an actual endSession waits', async () => {
    if (!databaseAvailable) return;
    const f = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const reachedAudit = new Promise<void>(resolve => { entered = resolve; });
    const releaseAudit = new Promise<void>(resolve => { release = resolve; });
    const pending = activate(f.input, { kind: 'system', appendSecurityEvent: async (tx, event) => {
      await appendSecurityAuditEventWithTx(tx, event);
      if (event.eventType === 'invitation.github_identity_linked') { entered(); await releaseAudit; }
    } });
    await reachedAudit;
    let ended = false;
    const ending = sessionStore().endSession(f.input.claimOwnerHash, f.input.sessionHash).then(result => { ended = true; return result; });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(ended).toBe(false);
    } finally { release(); }
    expect((await pending).status).toBe('activated');
    expect(await ending).toBe(false); // Activation already removed the exact session and owner.
    expect(await restrictedRecords(f)).toHaveLength(0);
    expect((await state(f)).audits).toBe(1);
  });

  it('rejects restricted-session expiry that occurs while waiting for its owner row lock', async () => {
    if (!databaseAvailable) return;
    const f = await fixture();
    let pending: Promise<unknown> | undefined;
    await getTestAdminDb().transaction(async tx => {
      const owner = f.input.claimOwnerHash.toString('hex');
      await tx.select().from(authKv).where(sql`${authKv.model} = ${ONBOARDING_OWNER_MODEL} AND ${authKv.id} = ${owner}`).for('update');
      await tx.execute(sql`WITH expiry AS (SELECT date_trunc('milliseconds', clock_timestamp()) + INTERVAL '150 milliseconds' AS at)
        UPDATE auth_kv SET expires_at = expiry.at, payload = jsonb_set(payload, '{expiresAt}', to_jsonb(expiry.at))
        FROM expiry WHERE model = ${ONBOARDING_SESSION_MODEL} AND id = ${owner}`);
      pending = activate(f.input);
      void pending.catch(() => undefined);
      await tx.execute(sql`SELECT pg_sleep(0.25)`);
    });
    await expect(pending).rejects.toMatchObject({ code: 'invitation_invalid' });
    await expectPending(f);
  });

  it('copies mutable caller context before waiting and only links its original GitHub subject', async () => {
    if (!databaseAvailable) return;
    const f = await fixture();
    const pending = activate(f.input);
    const originalId = f.input.githubId;
    f.input.claimOwnerHash.fill(0);
    f.input.sessionHash.fill(0);
    (f.input as { githubId: string }).githubId = '123';
    expect((await pending).status).toBe('activated');
    const [identity] = await getTestAdminDb().select().from(authAccounts).where(eq(authAccounts.userId, f.invitation.userId));
    expect(identity.externalSub).toBe(originalId);
  });

  it('acknowledges same-owner same-ID retries after expiry without restoring subsequently revoked roles or authority', async () => {
    if (!databaseAvailable) return;
    const f = await fixture();
    await activate(f.input);
    await getTestAdminDb().update(userAdminRoles).set({ revokedAt: new Date(), revokedByUserId: f.inviterId }).where(eq(userAdminRoles.userId, f.invitation.userId));
    await getTestAdminDb().execute(sql`UPDATE account_allowlist_entries SET revoked_at = clock_timestamp(), revoked_by_user_id = ${f.inviterId}::uuid WHERE normalized_value = ${f.input.githubId}`);
    await getTestAdminDb().update(claims).set({ createdAt: new Date(0), expiresAt: new Date(3600000) }).where(eq(claims.id, f.claim.id));
    const before = await state(f);
    expect((await activate({ ...f.input, githubLogin: 'new-login', providerEmail: 'changed@example.org' })).status).toBe('already_activated');
    expect(await state(f)).toEqual(before);
    expect(await restrictedRecords(f)).toHaveLength(0);
    await expect(activate({ ...f.input, claimOwnerHash: randomBytes(32) })).rejects.toMatchObject({ code: 'claim_owner_mismatch' });
    await expect(activate({ ...f.input, githubId: '111' })).rejects.toMatchObject({ code: 'invitation_invalid' });
  });

  it('serializes simultaneous completion as one activation and one historical acknowledgement', async () => {
    if (!databaseAvailable) return;
    const f = await fixture();
    const results = await Promise.all([activate(f.input), activate(f.input)]);
    expect(results.map(r => r.status).sort()).toEqual(['activated', 'already_activated']);
    expect((await state(f)).audits).toBe(1);
  });

  it('rolls back every activation effect if mandatory security audit fails after its insert', async () => {
    if (!databaseAvailable) return;
    const f = await fixture();
    const recordsBefore = await restrictedRecords(f);
    await expect(activate(f.input, { kind: 'system', appendSecurityEvent: async (tx, event) => {
      await appendSecurityAuditEventWithTx(tx, event);
      if (event.eventType === 'invitation.activated') throw new Error('security audit failed');
    } })).rejects.toThrow('security audit failed');
    await expectPending(f);
    expect(await restrictedRecords(f)).toEqual(recordsBefore);
    expect((await activate(f.input)).status).toBe('activated');
  });

  it('rolls back activation and deleted restricted records when completion reports failure', async () => {
    if (!databaseAvailable) return;
    const f = await fixture();
    const sessions = sessionStore();
    const recordsBefore = await restrictedRecords(f);
    const store = new PostgresInvitationActivationStore(getTestAdminDb(), {
      lockSessionWithTx: (tx, owner, session) => sessions.lockSessionWithTx(tx, owner, session),
      completeEnrollmentWithTx: async (tx, owner, session) => {
        expect(await sessions.completeEnrollmentWithTx(tx, owner, session)).toBe(true);
        return false;
      },
    });
    await expect(store.activate(f.input, audit)).rejects.toMatchObject({ code: 'invitation_invalid' });
    await expectPending(f);
    expect(await restrictedRecords(f)).toEqual(recordsBefore);
  });

  it('cannot delete mismatched restricted records and snapshots cleanup hashes before awaiting', async () => {
    if (!databaseAvailable) return;
    const f = await fixture();
    const before = await restrictedRecords(f);
    await withSystemContext(getTestAdminDb(), async tx => {
      await expect(sessionStore().completeEnrollmentWithTx(tx, f.input.claimOwnerHash, randomBytes(32))).resolves.toBe(false);
      await expect(sessionStore().completeEnrollmentWithTx(tx, randomBytes(32), f.input.sessionHash)).resolves.toBe(false);
    });
    expect(await restrictedRecords(f)).toEqual(before);
    await withSystemContext(getTestAdminDb(), async tx => {
      const owner = Buffer.from(f.input.claimOwnerHash);
      const session = Buffer.from(f.input.sessionHash);
      const pending = sessionStore().completeEnrollmentWithTx(tx, owner, session);
      owner.fill(0); session.fill(0);
      await expect(pending).resolves.toBe(true);
    });
    expect(await restrictedRecords(f)).toHaveLength(0);
  });

  it('rolls back all activation writes when the restricted session expires before final cleanup', async () => {
    if (!databaseAvailable) return;
    const f = await fixture();
    const recordsBefore = await restrictedRecords(f);
    await expect(activate(f.input, { kind: 'system', appendSecurityEvent: async (tx, event) => {
      await appendSecurityAuditEventWithTx(tx, event);
      if (event.eventType === 'invitation.activated') {
        await tx.execute(sql`WITH expiry AS (SELECT date_trunc('milliseconds', clock_timestamp()) + INTERVAL '50 milliseconds' AS at)
          UPDATE auth_kv SET expires_at = expiry.at, payload = jsonb_set(payload, '{expiresAt}', to_jsonb(expiry.at))
          FROM expiry WHERE model = ${ONBOARDING_SESSION_MODEL} AND id = ${f.input.claimOwnerHash.toString('hex')}`);
        await tx.execute(sql`SELECT pg_sleep(0.1)`);
      }
    } })).rejects.toMatchObject({ code: 'invitation_invalid' });
    await expectPending(f);
    expect(await restrictedRecords(f)).toEqual(recordsBefore);
  });

  it('appends real admin audit only for supplied admin context and rolls back its writer failure', async () => {
    if (!databaseAvailable) return;
    const f = await fixture();
    const material = { keyId: 'activation-test', key: randomBytes(32) };
    let fail = true;
    const admin: InvitationManagementAudit = { kind: 'admin', appendSecurityEvent: appendSecurityAuditEventWithTx,
      appendAdminEvent: async (tx, event) => { await appendConsoleAdminAuditEventWithTx(tx, event, { resolve: async () => material }); if (fail) throw new Error('admin audit failed'); },
      adminContext: { actorUserId: f.inviterId, actorSub: `github_issuer-${f.inviterId}`, actorRole: 'admin', actorCapabilityRole: 'admin', actorConsoleSessionHash: randomBytes(32), capability: 'console:admin:accounts', elevationAcr: null, elevationAmr: [], elevationAuthTime: null, endpoint: '/internal/activation', clientIp: null, userAgent: null },
    };
    const recordsBefore = await restrictedRecords(f);
    await expect(activate(f.input, admin)).rejects.toThrow('admin audit failed');
    await expectPending(f);
    expect(await restrictedRecords(f)).toEqual(recordsBefore);
    fail = false;
    await activate(f.input, admin);
    expect(await getTestAdminDb().execute(sql`SELECT sequence_id FROM admin_audit_events WHERE resource_id = ${f.invitation.id}`)).toHaveLength(1);
  });

  it.each(['roles', 'disabled', 'deleted'] as const)('rechecks current inviter %s before granting intended roles', async change => {
    if (!databaseAvailable) return;
    const f = await fixture();
    if (change === 'roles') await getTestAdminDb().update(userAdminRoles).set({ role: 'account_admin' }).where(eq(userAdminRoles.userId, f.inviterId));
    else await getTestAdminDb().update(users).set(change === 'disabled' ? { disabledAt: new Date() } : { deletedAt: new Date() }).where(eq(users.id, f.inviterId));
    await expect(activate(f.input)).rejects.toMatchObject({ code: 'invitation_invalid' });
    await expectPending(f);
  });

  it('rejects a GitHub identity owned by another account without email matching', async () => {
    if (!databaseAvailable) return;
    const f = await fixture();
    await getTestAdminDb().insert(authAccounts).values({ provider: 'github', externalSub: f.input.githubId, sub: `github_${f.input.githubId}`, userId: f.inviterId, email: f.invitation.emailOriginal });
    await expect(activate(f.input)).rejects.toMatchObject({ code: 'invitation_conflict' });
    await expectPending(f);
  });

  it.each(['absent', 'unlinked', 'disabled', 'deleted'] as const)('preserves legacy username-sub ownership when identity is %s', async mode => {
    if (!databaseAvailable) return;
    const f = await fixture();
    const sub = `github_${f.input.githubId}`;
    const legacyId = randomUUID();
    await getTestAdminDb().insert(users).values({ id: legacyId, username: sub,
      ...(mode === 'disabled' ? { disabledAt: new Date() } : {}), ...(mode === 'deleted' ? { deletedAt: new Date() } : {}),
    });
    if (mode !== 'absent') await getTestAdminDb().insert(authAccounts).values({ provider: 'github', externalSub: f.input.githubId, sub, userId: null });
    await expect(activate(f.input)).rejects.toMatchObject({ code: 'invitation_conflict' });
    await expectPending(f);
    const [identity] = await getTestAdminDb().select().from(authAccounts).where(eq(authAccounts.sub, sub));
    expect(identity?.userId ?? null).toBeNull();
    const [legacy] = await getTestAdminDb().select().from(users).where(eq(users.username, sub));
    expect(legacy.id).toBe(legacyId);
  });

  it('permits only one invitation to bind the same GitHub ID under concurrent completion', async () => {
    if (!databaseAvailable) return;
    const first = await fixture();
    const second = await fixture();
    const results = await Promise.allSettled([activate(first.input), activate({ ...second.input, githubId: first.input.githubId })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'invitation_conflict' } });
    const rows = await getTestAdminDb().select().from(authAccounts).where(eq(authAccounts.externalSub, first.input.githubId));
    expect(rows).toHaveLength(1);
    expect([first.invitation.userId, second.invitation.userId]).toContain(rows[0].userId);
  });

  it('binds an existing unlinked identity by immutable ID despite a renamed login and removed provider email', async () => {
    if (!databaseAvailable) return;
    const f = await fixture();
    await getTestAdminDb().insert(authAccounts).values({ provider: 'github', externalSub: f.input.githubId, sub: `github_${f.input.githubId}`, displayName: 'old-login', email: 'old@example.org' });
    expect((await activate(f.input)).status).toBe('activated');
    const [identity] = await getTestAdminDb().select().from(authAccounts).where(eq(authAccounts.userId, f.invitation.userId));
    expect(identity).toMatchObject({ displayName: f.input.githubLogin, email: null });
  });

  it('preserves stable GitHub deny tombstones even when a newer email grant would allow ordinary matching', async () => {
    if (!databaseAvailable) return;
    const f = await fixture();
    await withSystemContext(getTestAdminDb(), async tx => {
      const grant = await addAccountAllowlistEntryWithTx(tx, { kind: 'github_id', value: f.input.githubId, createdByUserId: f.inviterId, createdAt: new Date() });
      await removeAccountAllowlistEntryWithTx(tx, { id: grant.id, revokedByUserId: f.inviterId, revokedAt: new Date() });
      await addAccountAllowlistEntryWithTx(tx, { kind: 'email', value: f.invitation.emailOriginal, createdByUserId: f.inviterId, createdAt: new Date() });
    });
    await expect(activate({ ...f.input, providerEmail: f.invitation.emailOriginal, providerEmailVerified: true })).rejects.toMatchObject({ code: 'invitation_invalid' });
    await expectPending(f);
  });

  it.each(['revoke', 'regenerate', 'owner'] as const)('rejects %s before activation', async change => {
    if (!databaseAvailable) return;
    const f = await fixture();
    if (change === 'revoke') await management().runMutation(audit, mutation => mutation.revoke(f.invitation.id, randomUUID()));
    if (change === 'regenerate') await management().runMutation(audit, mutation => mutation.regenerate({ invitationId: f.invitation.id, credentialSecret: randomBytes(32), ttlHours: 1, correlationId: randomUUID() }));
    await expect(activate(change === 'owner' ? { ...f.input, claimOwnerHash: randomBytes(32) } : f.input)).rejects.toMatchObject({ code: change === 'revoke' ? 'invitation_revoked' : change === 'regenerate' ? 'invitation_superseded' : 'invitation_invalid' });
    expect((await state(f)).activation_state).toBe('pending_activation');
    expect((await state(f)).identities).toBe(0);
  });

  it('reads expiry from database time after waiting for the account lock', async () => {
    if (!databaseAvailable) return;
    const f = await fixture();
    let pending: Promise<unknown> | undefined;
    await getTestAdminDb().transaction(async tx => {
      await tx.execute(sql`LOCK TABLE users IN EXCLUSIVE MODE`);
      const times = await tx.execute(sql`SELECT date_trunc('milliseconds', clock_timestamp()) + INTERVAL '150 milliseconds' AS expires`);
      await tx.update(claims).set({ expiresAt: new Date(times[0].expires as string | Date) }).where(eq(claims.id, f.claim.id));
      pending = activate(f.input);
      void pending.catch(() => undefined);
      await tx.execute(sql`SELECT pg_sleep(0.25)`);
    });
    await expect(pending).rejects.toMatchObject({ code: 'invitation_expired' });
    await expectPending(f);
  });

  it.each(['disabledAt', 'deletedAt'] as const)('never overrides pending account %s', async field => {
    if (!databaseAvailable) return;
    const f = await fixture();
    await getTestAdminDb().update(users).set({ [field]: new Date() }).where(eq(users.id, f.invitation.userId));
    await expect(activate(f.input)).rejects.toMatchObject({ code: 'invitation_invalid' });
    await expectPending(f);
  });
});
