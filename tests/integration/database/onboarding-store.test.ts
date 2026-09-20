import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { withSystemContext } from '../../../src/database/admin.js';
import { authKv } from '../../../src/database/schema/auth.js';
import { users } from '../../../src/database/schema/users.js';
import { accountInvitationClaimAssertions as claims } from '../../../src/database/schema/invitations.js';
import { PostgresInvitationManagementStore } from '../../../src/invitations/PostgresInvitationManagementStore.js';
import { PostgresInvitationClaimStore } from '../../../src/invitations/PostgresInvitationClaimStore.js';
import { PostgresOnboardingStore, ONBOARDING_OWNER_MODEL, ONBOARDING_SESSION_MODEL } from '../../../src/invitations/onboarding/PostgresOnboardingStore.js';
import { OnboardingCredentials } from '../../../src/invitations/onboarding/OnboardingCredentials.js';
import { HmacConsoleOpaqueValueService } from '../../../src/web-console/security/ConsoleOpaqueValues.js';
import { appendSecurityAuditEventWithTx } from '../../../src/security/auditSink.js';
import { closeTestDb, getTestAdminDb, isDatabaseAvailable } from './test-db-helpers.js';

const db = () => getTestAdminDb();
const authority = () => new PostgresInvitationClaimStore(db());
const store = () => new PostgresOnboardingStore(db(), authority());
const management = () => new PostgresInvitationManagementStore(db());
const credentials = new OnboardingCredentials(new HmacConsoleOpaqueValueService(randomBytes(32)));
const hash = (purpose: 'owner' | 'session' | 'csrf') => credentials.issue(purpose).hash;
const audit = { kind: 'system' as const, appendSecurityEvent: appendSecurityAuditEventWithTx };
const inviterId = randomUUID();
let available = false;
beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('Required test database unavailable');
  if (available) await db().insert(users).values({ id: inviterId, username: `onboarding-admin-${inviterId}` });
});
afterAll(closeTestDb);

async function fixture(existingOwner?: Buffer) {
  const ownerHash = existingOwner ?? hash('owner');
  if (!existingOwner) await store().createOwner(ownerHash, hash('csrf'));
  const invitationId = randomUUID();
  const secret = randomBytes(32);
  const invitation = await management().runMutation(audit, mutation => mutation.issue({
    invitationId, userId: randomUUID(), username: `onboarding-${invitationId}`, displayName: null,
    emailOriginal: `${invitationId}@example.test`, emailNormalized: `${invitationId}@example.test`,
    intendedRoles: [], inviterUserId: inviterId, generation: 1, ttlHours: 24,
    credentialSecret: secret, correlationId: randomUUID(),
  }));
  const claimInput = { invitationId, generation: 1, credentialSecret: secret, claimOwnerHash: ownerHash, correlationId: randomUUID() };
  const claim = await authority().runMutation(audit, mutation => mutation.beginClaim(claimInput));
  const input = { ownerHash, invitationId, generation: 1, claimAssertionId: claim.id, sessionHash: hash('session'), csrfTokenHash: hash('csrf') };
  return { ownerHash, invitation, claim, claimInput, input };
}
const slot = (model: string, owner: Buffer) => and(eq(authKv.model, model), eq(authKv.id, owner.toString('hex')));
async function patchSlot(model: string, owner: Buffer, patch: Record<string, unknown>) {
  const [row] = await db().select().from(authKv).where(slot(model, owner));
  await db().update(authKv).set({ payload: { ...(row.payload as object), ...patch }, ...(typeof patch.expiresAt === 'string' ? { expiresAt: new Date(patch.expiresAt) } : {}) }).where(slot(model, owner));
}

describe('PostgreSQL restricted onboarding owner/session persistence', () => {
  it('persists only hashes, keeps namespaces separate, and establishes owner before claim', async () => {
    if (!available) return;
    const owner = credentials.issue('owner');
    const csrf = credentials.issue('csrf');
    const created = await store().createOwner(owner.hash, csrf.hash);
    expect(created.expiresAt.getTime() - created.createdAt.getTime()).toBe(900000);
    const rows = await db().select().from(authKv).where(slot(ONBOARDING_OWNER_MODEL, owner.hash));
    expect(JSON.stringify(rows)).not.toContain(owner.value);
    expect(JSON.stringify(rows)).not.toContain(csrf.value);
    await db().insert(authKv).values({ model: 'Session', id: owner.hash.toString('hex'), payload: { normal: true } });
    expect(await store().findOwner(owner.hash)).toEqual(created);
    await expect(store().createOwner(owner.hash, hash('csrf'))).rejects.toMatchObject({ code: 'conflict' });
    await store().endOwner(owner.hash);
    expect(await db().select().from(authKv).where(slot('Session', owner.hash))).toHaveLength(1);
  });

  it('requires a managed unexpired owner and current claim before creating the restricted session', async () => {
    if (!available) return;
    const f = await fixture();
    await store().endOwner(f.ownerHash);
    await expect(store().replaceSession(f.input)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await db().select().from(authKv).where(slot(ONBOARDING_SESSION_MODEL, f.ownerHash))).toHaveLength(0);
  });

  it('rotates credentials and CSRF atomically while retaining the stable owner', async () => {
    if (!available) return;
    const f = await fixture();
    const first = await store().replaceSession(f.input);
    expect(first.scope).toBe('onboarding:github-enrollment');
    expect(first.emailVerifiedAt).toEqual(f.claim.emailVerifiedAt);
    expect(first.expiresAt.getTime() - first.createdAt.getTime()).toBe(900000);
    expect(await store().findSession(f.ownerHash, first.idHash)).toEqual(first);
    const next = await store().replaceSession({ ...f.input, sessionHash: hash('session'), csrfTokenHash: hash('csrf') });
    expect(await store().findSession(f.ownerHash, first.idHash)).toBeNull();
    expect(await store().findSession(f.ownerHash, next.idHash)).toEqual(next);
    expect(next.csrfTokenHash.equals(first.csrfTokenHash)).toBe(false);
    await expect(store().replaceSession({ ...f.input, sessionHash: next.idHash })).rejects.toMatchObject({ code: 'conflict' });
    expect((await store().findOwner(f.ownerHash))?.ownerHash).toEqual(f.ownerHash);
  });

  it('serializes concurrent rotations into one primary-key session slot', async () => {
    if (!available) return;
    const f = await fixture();
    const results = await Promise.all([store().replaceSession(f.input),
      store().replaceSession({ ...f.input, sessionHash: hash('session'), csrfTokenHash: hash('csrf') })]);
    expect(await db().select().from(authKv).where(slot(ONBOARDING_SESSION_MODEL, f.ownerHash))).toHaveLength(1);
    const active = await Promise.all(results.map(record => store().findSession(f.ownerHash, record.idHash)));
    expect(active.filter(Boolean)).toHaveLength(1);
  });

  it('rolls back owner refresh and preserves the previous session if replacement persistence fails', async () => {
    if (!available) return;
    const f = await fixture();
    const first = await store().replaceSession(f.input);
    const ownerBefore = await store().findOwner(f.ownerHash);
    await db().execute(sql.raw(`CREATE OR REPLACE FUNCTION test_onboarding_reject_session() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.model = 'DollhouseOnboardingSessionV1' AND NEW.id = TG_ARGV[0] THEN RAISE EXCEPTION 'test session write failure'; END IF; RETURN NEW; END $$`));
    try {
      await db().execute(sql.raw(`CREATE TRIGGER test_onboarding_session_failure BEFORE INSERT OR UPDATE ON auth_kv FOR EACH ROW EXECUTE FUNCTION test_onboarding_reject_session('${f.ownerHash.toString('hex')}')`));
      await expect(store().replaceSession({ ...f.input, sessionHash: hash('session'), csrfTokenHash: hash('csrf') })).rejects.toBeInstanceOf(Error);
      expect(await store().findOwner(f.ownerHash)).toEqual(ownerBefore);
      expect(await store().findSession(f.ownerHash, first.idHash)).toEqual(first);
    } finally {
      await db().execute(sql`DROP TRIGGER IF EXISTS test_onboarding_session_failure ON auth_kv`);
      await db().execute(sql`DROP FUNCTION IF EXISTS test_onboarding_reject_session()`);
    }
  });

  it('propagates authority outages without returning a previously valid session', async () => {
    if (!available) return;
    const f = await fixture();
    const first = await store().replaceSession(f.input);
    const unavailable = new PostgresOnboardingStore(db(), { lockActivationCandidateWithTx: async () => { throw new Error('authority unavailable'); } });
    await expect(unavailable.findSession(f.ownerHash, first.idHash)).rejects.toThrow('authority unavailable');
    await expect(unavailable.replaceSession({ ...f.input, sessionHash: hash('session'), csrfTokenHash: hash('csrf') })).rejects.toThrow('authority unavailable');
    expect(await store().findSession(f.ownerHash, first.idHash)).toEqual(first);
  });

  it('does not silently switch another live invitation context across tabs', async () => {
    if (!available) return;
    const first = await fixture();
    const session = await store().replaceSession(first.input);
    const other = await fixture(first.ownerHash);
    await expect(store().replaceSession(other.input)).rejects.toMatchObject({ code: 'conflict' });
    expect(await store().findSession(first.ownerHash, session.idHash)).toEqual(session);
    await store().endSession(first.ownerHash, session.idHash);
    expect((await store().replaceSession(other.input)).invitationId).toBe(other.invitation.id);
  });

  it('ends only the matching session, permits same-owner resume, and then explicitly ends the owner', async () => {
    if (!available) return;
    const f = await fixture();
    const first = await store().replaceSession(f.input);
    expect(await store().endSession(f.ownerHash, hash('session'))).toBe(false);
    expect(await store().endSession(f.ownerHash, first.idHash)).toBe(true);
    expect(await store().findOwner(f.ownerHash)).not.toBeNull();
    expect(await store().findSession(f.ownerHash, first.idHash)).toBeNull();
    const resumed = await authority().runMutation(audit, mutation => mutation.beginClaim(f.claimInput));
    expect(resumed.id).toBe(f.claim.id);
    const next = await store().replaceSession({ ...f.input, sessionHash: hash('session'), csrfTokenHash: hash('csrf') });
    await store().endOwner(f.ownerHash);
    expect(await store().findOwner(f.ownerHash)).toBeNull();
    expect(await store().findSession(f.ownerHash, next.idHash)).toBeNull();
  });

  it.each(['disabled', 'deleted', 'active', 'regenerated', 'revoked', 'claim-expired'] as const)('rechecks authoritative %s state on lookup and replacement', async action => {
    if (!available) return;
    const f = await fixture();
    const first = await store().replaceSession(f.input);
    if (action === 'disabled') await db().update(users).set({ disabledAt: new Date() }).where(eq(users.id, f.invitation.userId));
    if (action === 'deleted') await db().update(users).set({ deletedAt: new Date() }).where(eq(users.id, f.invitation.userId));
    if (action === 'active') await db().update(users).set({ activationState: 'active' }).where(eq(users.id, f.invitation.userId));
    if (action === 'regenerated') await management().runMutation(audit, mutation => mutation.regenerate({ invitationId: f.invitation.id, credentialSecret: randomBytes(32), ttlHours: 24, correlationId: randomUUID() }));
    if (action === 'revoked') await management().runMutation(audit, mutation => mutation.revoke(f.invitation.id, randomUUID()));
    if (action === 'claim-expired') await db().update(claims).set({ createdAt: new Date(0), expiresAt: new Date(1000) }).where(eq(claims.id, f.claim.id));
    expect(await store().findSession(f.ownerHash, first.idHash)).toBeNull();
    await expect(store().replaceSession({ ...f.input, sessionHash: hash('session'), csrfTokenHash: hash('csrf') })).rejects.toBeInstanceOf(Error);
  });

  it('denies another owner, malformed stored records, ordinary scopes, and any non-null revocation', async () => {
    if (!available) return;
    const f = await fixture();
    const first = await store().replaceSession(f.input);
    expect(await store().findSession(hash('owner'), first.idHash)).toBeNull();
    for (const patch of [{ scope: 'console' }, { csrfTokenHash: 'not-a-hash' }, { roles: ['admin'] }]) {
      await patchSlot(ONBOARDING_SESSION_MODEL, f.ownerHash, patch);
      expect(await store().findSession(f.ownerHash, first.idHash)).toBeNull();
    }
    await patchSlot(ONBOARDING_OWNER_MODEL, f.ownerHash, { revokedAt: new Date(Date.now() + 60000).toISOString() });
    expect(await store().findOwner(f.ownerHash)).toBeNull();
    await expect(store().replaceSession({ ...f.input, sessionHash: hash('session'), csrfTokenHash: hash('csrf') })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('denies inconsistent KV expiry metadata instead of bypassing its TTL', async () => {
    if (!available) return;
    const f = await fixture();
    const current = await store().replaceSession(f.input);
    await db().update(authKv).set({ expiresAt: new Date(0) }).where(slot(ONBOARDING_SESSION_MODEL, f.ownerHash));
    expect(await store().findSession(f.ownerHash, current.idHash)).toBeNull();
    await db().update(authKv).set({ expiresAt: null }).where(slot(ONBOARDING_OWNER_MODEL, f.ownerHash));
    expect(await store().findOwner(f.ownerHash)).toBeNull();
  });

  it('caps owner renewal at original creation plus168 hours and the session at that deadline', async () => {
    if (!available) return;
    const f = await fixture();
    const createdAt = new Date(Date.now() - 168 * 3600000 + 30000);
    await patchSlot(ONBOARDING_OWNER_MODEL, f.ownerHash, { createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + 168 * 3600000).toISOString() });
    const current = await store().replaceSession(f.input);
    expect(current.expiresAt.getTime()).toBe(createdAt.getTime() + 168 * 3600000);
    expect((await store().findOwner(f.ownerHash))?.expiresAt).toEqual(current.expiresAt);
  });

  it('keeps the owner after session expiry so a current claim can resume', async () => {
    if (!available) return;
    const f = await fixture();
    const first = await store().replaceSession(f.input);
    const past = new Date(Date.now() - 1000);
    await patchSlot(ONBOARDING_SESSION_MODEL, f.ownerHash, { createdAt: new Date(past.getTime() - 900000).toISOString(), emailVerifiedAt: new Date(past.getTime() - 900000).toISOString(), expiresAt: past.toISOString() });
    expect(await store().findSession(f.ownerHash, first.idHash)).toBeNull();
    expect(await store().findOwner(f.ownerHash)).not.toBeNull();
    const next = await store().replaceSession({ ...f.input, sessionHash: hash('session'), csrfTokenHash: hash('csrf') });
    expect(await store().findSession(f.ownerHash, next.idHash)).toEqual(next);
  });

  it('uses the database clock after owner lock waits before issuing', async () => {
    if (!available) return;
    const f = await fixture();
    const owner = await store().findOwner(f.ownerHash);
    const [clock] = await db().execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
    await patchSlot(ONBOARDING_OWNER_MODEL, f.ownerHash, { refreshedAt: owner!.createdAt.toISOString(), expiresAt: new Date(new Date(clock.now).getTime() + 150).toISOString() });
    let outcome: Promise<boolean> | undefined;
    await withSystemContext(db(), async tx => {
      await tx.select().from(authKv).where(slot(ONBOARDING_OWNER_MODEL, f.ownerHash)).for('update');
      const pending = store().replaceSession(f.input);
      // Capture rejection immediately, release the held owner lock after expiry.
      outcome = pending.then(() => false, () => true);
      await tx.execute(sql`SELECT pg_sleep(0.25)`);

    });
    expect(await outcome).toBe(true);
    expect(await store().findOwner(f.ownerHash)).toBeNull();
    // Synchronize with the waiting issuance by trying the same owner lock again.
    await withSystemContext(db(), tx => tx.select().from(authKv).where(slot(ONBOARDING_OWNER_MODEL, f.ownerHash)).for('update'));
    expect(await db().select().from(authKv).where(slot(ONBOARDING_SESSION_MODEL, f.ownerHash))).toHaveLength(0);
  });

  it('bootstraps fresh CSRF after reload without changing ownership or extending either lifetime', async () => {
    if (!available) return;
    const f = await fixture();
    const owner = await store().findOwner(f.ownerHash);
    const ownerCsrf = credentials.issue('csrf');
    const updatedOwner = await store().rotateOwnerCsrf(f.ownerHash, ownerCsrf.hash);
    expect(updatedOwner).toEqual({ ...owner, csrfTokenHash: ownerCsrf.hash });
    const current = await store().replaceSession(f.input);
    const csrf = credentials.issue('csrf');
    const updatedSession = await store().rotateSessionCsrf(f.ownerHash, current.idHash, csrf.hash);
    expect(updatedSession).toEqual({ ...current, csrfTokenHash: csrf.hash });
    expect(await store().findSession(f.ownerHash, current.idHash)).toEqual(updatedSession);
    expect(credentials.matches('csrf', csrf.value, updatedSession.csrfTokenHash)).toBe(true);
    expect(current.csrfTokenHash.equals(updatedSession.csrfTokenHash)).toBe(false);
    await expect(store().rotateSessionCsrf(f.ownerHash, hash('session'), hash('csrf'))).rejects.toMatchObject({ code: 'unavailable' });
    await management().runMutation(audit, mutation => mutation.revoke(f.invitation.id, randomUUID()));
    await expect(store().rotateSessionCsrf(f.ownerHash, current.idHash, hash('csrf'))).rejects.toBeInstanceOf(Error);
    await store().endOwner(f.ownerHash);
    await expect(store().rotateOwnerCsrf(f.ownerHash, hash('csrf'))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('serializes owner-ending against replacement without leaving an orphan session', async () => {
    if (!available) return;
    const f = await fixture();
    await store().replaceSession(f.input);
    await Promise.allSettled([store().endOwner(f.ownerHash),
      store().replaceSession({ ...f.input, sessionHash: hash('session'), csrfTokenHash: hash('csrf') })]);
    expect(await store().findOwner(f.ownerHash)).toBeNull();
    expect(await db().select().from(authKv).where(slot(ONBOARDING_SESSION_MODEL, f.ownerHash))).toHaveLength(0);
  });
});
