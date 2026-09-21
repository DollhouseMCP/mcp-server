import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { users } from '../../../src/database/schema/users.js';
import { authKv } from '../../../src/database/schema/auth.js';
import { appendSecurityAuditEventWithTx } from '../../../src/security/auditSink.js';
import { PostgresInvitationManagementStore } from '../../../src/invitations/PostgresInvitationManagementStore.js';
import { PostgresInvitationClaimStore } from '../../../src/invitations/PostgresInvitationClaimStore.js';
import { PostgresOnboardingStore } from '../../../src/invitations/onboarding/PostgresOnboardingStore.js';
import { PostgresOnboardingMetadataStore } from '../../../src/invitations/onboarding/PostgresOnboardingMetadataStore.js';
import { closeTestDb, getTestAdminDb, isDatabaseAvailable } from './test-db-helpers.js';

const db = () => getTestAdminDb();
const management = () => new PostgresInvitationManagementStore(db());
const sessions = () => new PostgresOnboardingStore(db(), new PostgresInvitationClaimStore(db()));
const metadata = () => new PostgresOnboardingMetadataStore(db(), sessions());
const audit = { kind: 'system' as const, appendSecurityEvent: appendSecurityAuditEventWithTx };
const inviterId = randomUUID();
let available = false;
beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('Required test database unavailable');
  if (available) await db().insert(users).values({ id: inviterId, username: `metadata-admin-${inviterId}` });
});
afterAll(closeTestDb);

async function fixture() {
  const invitationId = randomUUID();
  const owner = randomBytes(32), session = randomBytes(32), secret = randomBytes(32);
  const label = randomUUID();
  const email = `Tester-${label}@example.test`;
  const invitation = await management().runMutation(audit, mutation => mutation.issue({ invitationId,
    userId: randomUUID(), username: `tester-${label}`, displayName: 'Invited Tester',
    emailOriginal: email, emailNormalized: email.toLowerCase(), intendedRoles: ['auditor'],
    inviterUserId: inviterId, generation: 1, ttlHours: 24, credentialSecret: secret, correlationId: randomUUID() }));
  await sessions().createOwner(owner, randomBytes(32));
  const record = await sessions().exchangeClaim({ invitationId, generation: 1, credentialSecret: secret,
    ownerHash: owner, sessionHash: session, csrfTokenHash: randomBytes(32), correlationId: randomUUID() }, audit);
  return { invitation, owner, session, secret, record };
}

it('returns only proof-bound account/access/expiry metadata without changing records', async () => {
  if (!available) return;
  const f = await fixture();
  const before = await db().select().from(authKv).where(eq(authKv.id, f.owner.toString('hex')));
  const result = await metadata().read(f.owner, f.session);
  expect(result).toEqual({ state: 'claimed', account: { username: f.invitation.intendedUsername,
    displayName: 'Invited Tester', verifiedEmail: f.invitation.emailOriginal }, intendedRoles: ['auditor'],
    emailVerifiedAt: f.record.emailVerifiedAt.toISOString(), invitationExpiresAt: f.invitation.currentGeneration.expiresAt.toISOString(),
    sessionExpiresAt: f.record.expiresAt.toISOString(), serverTime: expect.any(String) });
  expect(new Date(result!.serverTime).getTime()).toBeGreaterThanOrEqual(f.record.createdAt.getTime());
  expect(new Date(result!.invitationExpiresAt).getTime()).toBeGreaterThan(new Date(result!.sessionExpiresAt).getTime());
  const json = JSON.stringify(result);
  for (const value of [f.invitation.id, f.invitation.userId, f.record.claimAssertionId, inviterId,
    ...[f.owner, f.session, f.secret, f.record.csrfTokenHash].flatMap(buffer => [buffer.toString('hex'), buffer.toString('base64url')])]) {
    expect(json).not.toContain(value);
  }
  expect(result).not.toHaveProperty('invitationId');
  expect(await db().select().from(authKv).where(eq(authKv.id, f.owner.toString('hex')))).toEqual(before);
});

it('rejects missing, unclaimed, swapped and stale browser bindings without account metadata', async () => {
  if (!available) return;
  const f = await fixture();
  const otherOwner = randomBytes(32);
  await sessions().createOwner(otherOwner, randomBytes(32));
  expect(await metadata().read(randomBytes(32), f.session)).toBeNull();
  expect(await metadata().read(otherOwner, f.session)).toBeNull();
  expect(await metadata().read(f.owner, randomBytes(32))).toBeNull();
  const next = await sessions().replaceSession({ ownerHash: f.owner, sessionHash: randomBytes(32), csrfTokenHash: randomBytes(32),
    invitationId: f.invitation.id, generation: 1, claimAssertionId: f.record.claimAssertionId });
  expect(await metadata().read(f.owner, f.session)).toBeNull();
  expect(await metadata().read(f.owner, next.idHash)).not.toBeNull();
});

it.each(['revoked', 'regenerated', 'disabled', 'active', 'ended'] as const)('denies metadata after the context becomes %s', async state => {
  if (!available) return;
  const f = await fixture();
  if (state === 'revoked') await management().runMutation(audit, mutation => mutation.revoke(f.invitation.id, randomUUID()));
  if (state === 'regenerated') await management().runMutation(audit, mutation => mutation.regenerate({
    invitationId: f.invitation.id, credentialSecret: randomBytes(32), ttlHours: 24, correlationId: randomUUID() }));
  if (state === 'disabled') await db().update(users).set({ disabledAt: new Date() }).where(eq(users.id, f.invitation.userId));
  if (state === 'active') await db().update(users).set({ activationState: 'active' }).where(eq(users.id, f.invitation.userId));
  if (state === 'ended') await sessions().endSession(f.owner, f.session);
  expect(await metadata().read(f.owner, f.session)).toBeNull();
});

it('does not mask authority outages or trust an authority result for a different browser', async () => {
  if (!available) return;
  const f = await fixture();
  const outage = new Error('synthetic authority outage');
  const failed = new PostgresOnboardingMetadataStore(db(), { lockSessionWithTx: async () => { throw outage; } });
  await expect(failed.read(f.owner, f.session)).rejects.toBe(outage);
  const swapped = new PostgresOnboardingMetadataStore(db(), { lockSessionWithTx: async () => ({ ...f.record, ownerHash: randomBytes(32) }) });
  expect(await swapped.read(f.owner, f.session)).toBeNull();
});
