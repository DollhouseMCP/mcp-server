import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { withSystemContext } from '../../../src/database/admin.js';
import { accountInvitationClaimAssertions as claims, accountInvitationGenerations as generations, accountInvitations } from '../../../src/database/schema/invitations.js';
import { users } from '../../../src/database/schema/users.js';
import type { InvitationIssueRecord } from '../../../src/invitations/IInvitationStore.js';
import type { InvitationManagementAudit } from '../../../src/invitations/IInvitationManagementStore.js';
import { PostgresInvitationManagementStore } from '../../../src/invitations/PostgresInvitationManagementStore.js';
import { PostgresInvitationClaimStore } from '../../../src/invitations/PostgresInvitationClaimStore.js';
import { hashInvitationCredential } from '../../../src/invitations/InvitationToken.js';
import { appendSecurityAuditEventWithTx } from '../../../src/security/auditSink.js';
import { closeTestDb, getTestAdminDb } from './test-db-helpers.js';

const inviterId = randomUUID();
const audit: InvitationManagementAudit = { kind: 'system', appendSecurityEvent: appendSecurityAuditEventWithTx };
const management = () => new PostgresInvitationManagementStore(getTestAdminDb());
const store = () => new PostgresInvitationClaimStore(getTestAdminDb());
async function issue() {
  const invitationId = randomUUID();
  const input: InvitationIssueRecord = {
    invitationId, userId: randomUUID(), username: `claim-${invitationId}`, displayName: null,
    emailOriginal: `${invitationId}@example.com`, emailNormalized: `${invitationId}@example.com`,
    inviterUserId: inviterId, intendedRoles: ['admin'], generation: 1,
    credentialSecret: randomBytes(32), ttlHours: 24, correlationId: randomUUID(),
  };
  const invitation = await management().runMutation(audit, mutation => mutation.issue(input));
  return { input, invitation, ownerHash: randomBytes(32) };
}
type Fixture = Awaited<ReturnType<typeof issue>>;
const claimInput = (fixture: Fixture) => ({
  invitationId: fixture.invitation.id, generation: 1, credentialSecret: fixture.input.credentialSecret,
  claimOwnerHash: fixture.ownerHash, correlationId: randomUUID(),
});
const claim = (fixture: Fixture) => store().runMutation(audit, mutation => mutation.beginClaim(claimInput(fixture)));
const regenerate = (fixture: Fixture) => management().runMutation(audit, mutation => mutation.regenerate({ invitationId: fixture.invitation.id, credentialSecret: randomBytes(32), ttlHours: 1, correlationId: randomUUID() }));
const revoke = (fixture: Fixture) => management().runMutation(audit, mutation => mutation.revoke(fixture.invitation.id, randomUUID()));
const candidateInput = (fixture: Fixture, claimAssertionId: string) => ({ invitationId: fixture.invitation.id, generation: 1, claimAssertionId, claimOwnerHash: fixture.ownerHash });
const generationRow = async (fixture: Fixture) => (await getTestAdminDb().select().from(generations).where(and(eq(generations.invitationId, fixture.invitation.id), eq(generations.generation, 1))))[0];

beforeAll(async () => { await getTestAdminDb().insert(users).values({ id: inviterId, username: `claim-admin-${inviterId}` }); });
afterAll(closeTestDb);

describe('durable invitation claims', () => {
  it('consumes a credential for one owner without activation, identity, role or session grants', async () => {
    const fixture = await issue();
    const claimed = await claim(fixture);
    expect(claimed).not.toHaveProperty('claimOwnerHash');
    expect(claimed).toMatchObject({ invitationId: fixture.invitation.id, generation: 1, userId: fixture.invitation.userId, state: 'open', version: 1 });
    expect(claimed.expiresAt).toEqual(fixture.invitation.currentGeneration.expiresAt);
    const generation = await generationRow(fixture);
    expect(generation.credentialConsumedAt).toEqual(claimed.emailVerifiedAt);
    expect(generation.state).toBe('pending');
    const rows = await getTestAdminDb().execute(sql`
      SELECT activation_state,
      (SELECT count(*) FROM auth_accounts WHERE user_id = ${fixture.invitation.userId}::uuid)::int AS identities,
      (SELECT count(*) FROM user_admin_roles WHERE user_id = ${fixture.invitation.userId}::uuid)::int AS roles,
      (SELECT count(*) FROM console_sessions WHERE user_id = ${fixture.invitation.userId}::uuid)::int AS sessions
      FROM users WHERE id = ${fixture.invitation.userId}::uuid
    `);
    expect(rows[0]).toEqual({ activation_state: 'pending_activation', identities: 0, roles: 0, sessions: 0 });
    const events = await getTestAdminDb().execute(sql`SELECT metadata FROM security_audit_events WHERE target_id = ${fixture.invitation.id} AND event_type = 'invitation.claimed'`);
    expect(events).toHaveLength(1);
    const json = JSON.stringify(events);
    expect(json).not.toContain(fixture.ownerHash.toString('hex'));
    expect(json).not.toContain(fixture.input.credentialSecret.toString('base64url'));
    expect(json).not.toContain(fixture.invitation.emailOriginal);
  });

  it('resumes the same durable claim across replicas and rejects a different owner', async () => {
    const fixture = await issue();
    const first = await claim(fixture);
    const resumed = await claim(fixture);
    expect(resumed.id).toBe(first.id);
    expect(resumed.version).toBe(2);
    expect(resumed.emailVerifiedAt).toEqual(first.emailVerifiedAt);
    expect(resumed.expiresAt).toEqual(first.expiresAt);
    await expect(claim({ ...fixture, ownerHash: randomBytes(32) })).rejects.toMatchObject({ code: 'invitation_replayed' });
    const rows = await getTestAdminDb().select().from(claims).where(eq(claims.invitationId, fixture.invitation.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].claimOwnerHash).toEqual(fixture.ownerHash);
  });

  it('allows only one browser in a concurrent first-claim race', async () => {
    const fixture = await issue();
    const results = await Promise.allSettled([claim(fixture), claim({ ...fixture, ownerHash: randomBytes(32) })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'invitation_replayed' } });
  });

  it('serializes simultaneous same-owner claims as creation and resume', async () => {
    const fixture = await issue();
    const results = await Promise.all([claim(fixture), claim(fixture)]);
    expect(new Set(results.map(result => result.id)).size).toBe(1);
    expect(results.map(result => result.version).sort()).toEqual([1, 2]);
  });

  it('rejects wrong credentials before binding an owner', async () => {
    const fixture = await issue();
    await expect(store().runMutation(audit, mutation => mutation.beginClaim({ ...claimInput(fixture), credentialSecret: randomBytes(32) }))).rejects.toMatchObject({ code: 'invitation_invalid' });
    expect((await generationRow(fixture)).credentialConsumedAt).toBeNull();
    expect(await getTestAdminDb().select().from(claims).where(eq(claims.invitationId, fixture.invitation.id))).toHaveLength(0);
  });

  it.each(['claimOwnerHash', 'credentialSecret'] as const)('copies mutable %s before waiting', async field => {
    const fixture = await issue();
    const input = claimInput(fixture);
    const savedOwner = Buffer.from(input.claimOwnerHash);
    const first = await store().runMutation(audit, async mutation => {
      const pending = mutation.beginClaim(input);
      input[field].fill(0);
      return pending;
    });
    const [row] = await getTestAdminDb().select().from(claims).where(eq(claims.id, first.id));
    expect(row.claimOwnerHash).toEqual(savedOwner);
  });

  it('rolls back consumed credential, claim and audit when the audit writer fails', async () => {
    const fixture = await issue();
    const failing: InvitationManagementAudit = { kind: 'system', appendSecurityEvent: async (tx, event) => {
      await appendSecurityAuditEventWithTx(tx, event);
      throw new Error('audit failed');
    } };
    await expect(store().runMutation(failing, mutation => mutation.beginClaim(claimInput(fixture)))).rejects.toThrow('audit failed');
    expect((await generationRow(fixture)).credentialConsumedAt).toBeNull();
    expect(await getTestAdminDb().select().from(claims).where(eq(claims.invitationId, fixture.invitation.id))).toHaveLength(0);
    expect(await getTestAdminDb().execute(sql`SELECT id FROM security_audit_events WHERE target_id = ${fixture.invitation.id} AND event_type = 'invitation.claimed'`)).toHaveLength(0);
    expect((await claim(fixture)).state).toBe('open');
  });

  it.each(['regenerate', 'revoke'] as const)('a concurrent %s cannot leave a usable old claim', async operation => {
    const fixture = await issue();
    await Promise.allSettled([claim(fixture), operation === 'regenerate' ? regenerate(fixture) : revoke(fixture)]);
    await expect(claim(fixture)).rejects.toMatchObject({ code: operation === 'regenerate' ? 'invitation_superseded' : 'invitation_revoked' });
    const rows = await getTestAdminDb().select().from(claims).where(eq(claims.invitationId, fixture.invitation.id));
    expect(rows.every(row => row.state === 'revoked')).toBe(true);
  });

  it('uses database time to reject expired credentials and an expired same-owner claim', async () => {
    const fixture = await issue();
    const first = await claim(fixture);
    await getTestAdminDb().update(claims).set({ createdAt: new Date(0), expiresAt: new Date(3_600_000) }).where(eq(claims.id, first.id));
    await expect(claim(fixture)).rejects.toMatchObject({ code: 'invitation_expired' });
    const unclaimed = await issue();
    const expiresAt = new Date(3_600_000);
    await getTestAdminDb().update(generations).set({
      issuedAt: new Date(0), expiresAt,
      credentialHash: hashInvitationCredential({ invitationId: unclaimed.invitation.id, generation: 1, secret: unclaimed.input.credentialSecret }, unclaimed.invitation.emailNormalized, expiresAt),
    }).where(eq(generations.invitationId, unclaimed.invitation.id));
    await expect(claim(unclaimed)).rejects.toMatchObject({ code: 'invitation_expired' });
    expect((await generationRow(unclaimed)).credentialConsumedAt).toBeNull();
  });

  it('checks server expiry after waiting for an account lock', async () => {
    const fixture = await issue();
    let pending: Promise<unknown> | undefined;
    await getTestAdminDb().transaction(async tx => {
      await tx.execute(sql`LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`);
      const times = await tx.execute(sql`SELECT date_trunc('milliseconds', clock_timestamp()) + INTERVAL '150 milliseconds' AS expires`);
      const expiresAt = new Date(times[0].expires as string | Date);
      await tx.update(generations).set({
        expiresAt,
        credentialHash: hashInvitationCredential({ invitationId: fixture.invitation.id, generation: 1, secret: fixture.input.credentialSecret }, fixture.invitation.emailNormalized, expiresAt),
      }).where(eq(generations.invitationId, fixture.invitation.id));
      // Convert rejection to a value immediately so Jest never sees an unhandled rejection.
      pending = claim(fixture).catch(error => error);
      await tx.execute(sql`SELECT pg_sleep(0.2)`);
    });
    expect(await pending).toMatchObject({ code: 'invitation_expired' });
    expect((await generationRow(fixture)).credentialConsumedAt).toBeNull();
  });

  it.each(['disabledAt', 'deletedAt', 'activationState', 'email', 'username'] as const)('rejects changed account %s', async field => {
    const fixture = await issue();
    const changes = { disabledAt: new Date(), deletedAt: new Date(), activationState: 'active' as const, email: 'changed@example.com', username: `changed-${randomUUID()}` };
    await getTestAdminDb().update(users).set({ [field]: changes[field] }).where(eq(users.id, fixture.invitation.userId));
    await expect(claim(fixture)).rejects.toMatchObject({ code: field === 'activationState' ? 'account_not_pending' : 'invitation_invalid' });
    expect((await generationRow(fixture)).credentialConsumedAt).toBeNull();
  });

  it('fails closed for inconsistent consumption/claim records and accepted invitations', async () => {
    const fixture = await issue();
    await getTestAdminDb().update(generations).set({ credentialConsumedAt: new Date() }).where(eq(generations.invitationId, fixture.invitation.id));
    await expect(claim(fixture)).rejects.toMatchObject({ code: 'invitation_invalid' });
    await getTestAdminDb().update(accountInvitations).set({ state: 'accepted', acceptedAt: new Date() }).where(eq(accountInvitations.id, fixture.invitation.id));
    await getTestAdminDb().update(generations).set({ state: 'accepted', acceptedAt: new Date() }).where(eq(generations.invitationId, fixture.invitation.id));
    await expect(claim(fixture)).rejects.toMatchObject({ code: 'invitation_invalid' });
  });
});

describe('transaction-owned activation candidate', () => {
  it('locks the matching pending candidate without activating and allows the caller to roll back later writes', async () => {
    const fixture = await issue();
    const claimed = await claim(fixture);
    await expect(withSystemContext(getTestAdminDb(), async tx => {
      const candidate = await store().lockActivationCandidateWithTx(tx, candidateInput(fixture, claimed.id));
      expect(candidate.claim).toEqual(claimed);
      expect(candidate.invitation.userId).toBe(fixture.invitation.userId);
      await tx.update(users).set({ activationState: 'active' }).where(eq(users.id, candidate.invitation.userId));
      throw new Error('activation failed');
    })).rejects.toThrow('activation failed');
    const [user] = await getTestAdminDb().select().from(users).where(eq(users.id, fixture.invitation.userId));
    expect(user.activationState).toBe('pending_activation');
    const [row] = await getTestAdminDb().select().from(claims).where(eq(claims.id, claimed.id));
    expect(row.state).toBe('open');
  });

  it('rejects another owner or another invitation claim and snapshots the owner buffer', async () => {
    const fixture = await issue();
    const claimed = await claim(fixture);
    const other = await issue();
    const otherClaim = await claim(other);
    await expect(withSystemContext(getTestAdminDb(), tx => store().lockActivationCandidateWithTx(tx, { ...candidateInput(fixture, claimed.id), claimOwnerHash: other.ownerHash }))).rejects.toMatchObject({ code: 'claim_owner_mismatch' });
    await expect(withSystemContext(getTestAdminDb(), tx => store().lockActivationCandidateWithTx(tx, candidateInput(fixture, otherClaim.id)))).rejects.toMatchObject({ code: 'invitation_invalid' });
    await withSystemContext(getTestAdminDb(), async tx => {
      const input = candidateInput(fixture, claimed.id);
      const pending = store().lockActivationCandidateWithTx(tx, input);
      input.claimOwnerHash.fill(0);
      expect((await pending).claim.id).toBe(claimed.id);
    });
  });

  it.each(['regenerate', 'revoke', 'expire', 'complete'] as const)('rejects a candidate after %s', async operation => {
    const fixture = await issue();
    const claimed = await claim(fixture);
    if (operation === 'regenerate') await regenerate(fixture);
    if (operation === 'revoke') await revoke(fixture);
    if (operation === 'expire') await getTestAdminDb().update(claims).set({ createdAt: new Date(0), expiresAt: new Date(3_600_000) }).where(eq(claims.id, claimed.id));
    if (operation === 'complete') await getTestAdminDb().update(claims).set({ state: 'completed', completedAt: new Date() }).where(eq(claims.id, claimed.id));
    await expect(withSystemContext(getTestAdminDb(), tx => store().lockActivationCandidateWithTx(tx, candidateInput(fixture, claimed.id)))).rejects.toHaveProperty('code');
  });
});
