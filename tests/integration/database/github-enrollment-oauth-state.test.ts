import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { authKv } from '../../../src/database/schema/auth.js';
import { users } from '../../../src/database/schema/users.js';
import { PostgresInvitationClaimStore } from '../../../src/invitations/PostgresInvitationClaimStore.js';
import { PostgresInvitationManagementStore } from '../../../src/invitations/PostgresInvitationManagementStore.js';
import { appendSecurityAuditEventWithTx } from '../../../src/security/auditSink.js';
import { HmacConsoleOpaqueValueService } from '../../../src/web-console/security/ConsoleOpaqueValues.js';
import { GitHubEnrollmentOAuthStateService } from '../../../src/invitations/onboarding/GitHubEnrollmentOAuthState.js';
import { OnboardingCredentials } from '../../../src/invitations/onboarding/OnboardingCredentials.js';
import { PostgresOnboardingStore } from '../../../src/invitations/onboarding/PostgresOnboardingStore.js';
import {
  GITHUB_ENROLLMENT_STATE_MODEL, PostgresGitHubEnrollmentOAuthStateStore,
} from '../../../src/invitations/onboarding/PostgresGitHubEnrollmentOAuthStateStore.js';
import { closeTestDb, getTestAdminDb, isDatabaseAvailable } from './test-db-helpers.js';

const CALLBACK = 'https://console.example.test/auth/onboarding/github/callback';
const db = () => getTestAdminDb();
const claimStore = () => new PostgresInvitationClaimStore(db());
const onboardingStore = () => new PostgresOnboardingStore(db(), claimStore());
const managementStore = () => new PostgresInvitationManagementStore(db());
const stateStore = () => new PostgresGitHubEnrollmentOAuthStateStore(db(), onboardingStore());
const opaque = new HmacConsoleOpaqueValueService(randomBytes(32));
const credentials = new OnboardingCredentials(opaque);
const audit = { kind: 'system' as const, appendSecurityEvent: appendSecurityAuditEventWithTx };
const inviterId = randomUUID();
let available = false;

beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('Required test database unavailable');
  if (available) await db().insert(users).values({ id: inviterId, username: `github-state-admin-${inviterId}` });
});
afterAll(closeTestDb);

async function fixture() {
  const owner = credentials.issue('owner');
  await onboardingStore().createOwner(owner.hash, credentials.issue('csrf').hash);
  const invitationId = randomUUID();
  const secret = randomBytes(32);
  const invitation = await managementStore().runMutation(audit, mutation => mutation.issue({
    invitationId, userId: randomUUID(), username: `github-state-${invitationId}`, displayName: null,
    emailOriginal: `${invitationId}@example.test`, emailNormalized: `${invitationId}@example.test`,
    intendedRoles: [], inviterUserId: inviterId, generation: 1, ttlHours: 24,
    credentialSecret: secret, correlationId: randomUUID(),
  }));
  const claim = await claimStore().runMutation(audit, mutation => mutation.beginClaim({
    invitationId, generation: 1, credentialSecret: secret, claimOwnerHash: owner.hash, correlationId: randomUUID(),
  }));
  const session = credentials.issue('session');
  const record = await onboardingStore().replaceSession({ ownerHash: owner.hash, sessionHash: session.hash,
    csrfTokenHash: credentials.issue('csrf').hash, invitationId, generation: 1, claimAssertionId: claim.id });
  const service = new GitHubEnrollmentOAuthStateService(stateStore(), opaque,
    { clientId: 'Iv1_test-client', callbackUri: CALLBACK });
  return { owner, session, record, service, invitation };
}

const slot = (ownerHash: Buffer) => and(eq(authKv.model, GITHUB_ENROLLMENT_STATE_MODEL), eq(authKv.id, ownerHash.toString('hex')));
async function stored(ownerHash: Buffer) {
  return (await db().select().from(authKv).where(slot(ownerHash)))[0];
}

describe('PostgreSQL GitHub enrollment OAuth state', () => {
  it('persists hashes and server-held authority only, then consumes exactly once', async () => {
    if (!available) return;
    const f = await fixture();
    const correlationId = randomUUID();
    const started = await f.service.begin(f.owner.hash, f.session.hash, correlationId);
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    const row = await stored(f.owner.hash);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(state);
    expect(serialized).not.toContain('codeVerifier');
    expect(row.payload).toMatchObject({ userId: f.record.userId, invitationId: f.invitation.id,
      generation: 1, claimAssertionId: f.record.claimAssertionId, correlationId,
      purpose: 'link_login_identity', callbackUri: CALLBACK });
    const payload = row.payload as { createdAt: string; expiresAt: string };
    expect(new Date(payload.expiresAt).getTime() - new Date(payload.createdAt).getTime()).toBe(300_000);
    expect(started.expiresAt.toISOString()).toBe(payload.expiresAt);
    expect(started.context).toEqual({ userId: f.record.userId, invitationId: f.invitation.id,
      generation: 1, claimAssertionId: f.record.claimAssertionId, correlationId });
    const consumed = await f.service.consume(state, f.owner.hash, f.session.hash);
    expect(consumed).toMatchObject({ userId: f.record.userId, invitationId: f.invitation.id,
      correlationId, codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(Object.keys(consumed).sort()).toEqual([
      'callbackUri', 'claimAssertionId', 'codeVerifier', 'correlationId', 'generation',
      'invitationId', 'purpose', 'userId',
    ]);
    expect(await stored(f.owner.hash)).toBeUndefined();
    await expect(f.service.consume(state, f.owner.hash, f.session.hash)).rejects.toMatchObject({ name: 'GitHubEnrollmentStateError' });
  });

  it('replaces the owner slot and does not consume it for state, owner, or session swaps', async () => {
    if (!available) return;
    const f = await fixture();
    const first = new URL((await f.service.begin(f.owner.hash, f.session.hash, randomUUID())).authorizationUrl).searchParams.get('state')!;
    const second = new URL((await f.service.begin(f.owner.hash, f.session.hash, randomUUID())).authorizationUrl).searchParams.get('state')!;
    await expect(f.service.consume(first, f.owner.hash, f.session.hash)).rejects.toMatchObject({ name: 'GitHubEnrollmentStateError' });
    await expect(f.service.consume(second, randomBytes(32), f.session.hash)).rejects.toMatchObject({ name: 'GitHubEnrollmentStateError' });
    await expect(f.service.consume(second, f.owner.hash, randomBytes(32))).rejects.toMatchObject({ name: 'GitHubEnrollmentStateError' });
    expect(await stored(f.owner.hash)).toBeDefined();
    await expect(f.service.consume(second, f.owner.hash, f.session.hash)).resolves.toMatchObject({ purpose: 'link_login_identity' });
  });

  it('rejects expired state using database time without deleting a different future retry', async () => {
    if (!available) return;
    const f = await fixture();
    const state = new URL((await f.service.begin(f.owner.hash, f.session.hash, randomUUID())).authorizationUrl).searchParams.get('state')!;
    const row = await stored(f.owner.hash);
    await db().update(authKv).set({ payload: { ...(row.payload as object), expiresAt: new Date(0).toISOString() }, expiresAt: new Date(0) })
      .where(slot(f.owner.hash));
    await expect(f.service.consume(state, f.owner.hash, f.session.hash)).rejects.toMatchObject({ name: 'GitHubEnrollmentStateError' });
    expect(await stored(f.owner.hash)).toBeDefined();
    const replacement = new URL((await f.service.begin(f.owner.hash, f.session.hash, randomUUID())).authorizationUrl).searchParams.get('state')!;
    await expect(f.service.consume(replacement, f.owner.hash, f.session.hash)).resolves.toMatchObject({ userId: f.record.userId });
  });

  it('revalidates the live restricted session and rejects a superseded binding', async () => {
    if (!available) return;
    const f = await fixture();
    const state = new URL((await f.service.begin(f.owner.hash, f.session.hash, randomUUID())).authorizationUrl).searchParams.get('state')!;
    const replacementSession = credentials.issue('session');
    await onboardingStore().replaceSession({ ownerHash: f.owner.hash, sessionHash: replacementSession.hash,
      csrfTokenHash: credentials.issue('csrf').hash, invitationId: f.record.invitationId,
      generation: f.record.generation, claimAssertionId: f.record.claimAssertionId });
    await expect(f.service.consume(state, f.owner.hash, f.session.hash)).rejects.toMatchObject({ name: 'GitHubEnrollmentStateError' });
    await expect(f.service.consume(state, f.owner.hash, replacementSession.hash)).rejects.toMatchObject({ name: 'GitHubEnrollmentStateError' });
    expect(await stored(f.owner.hash)).toBeDefined();
    const next = new URL((await f.service.begin(f.owner.hash, replacementSession.hash, randomUUID())).authorizationUrl).searchParams.get('state')!;
    await expect(f.service.consume(next, f.owner.hash, replacementSession.hash)).resolves.toMatchObject({
      userId: f.record.userId,
      invitationId: f.invitation.id,
    });
  });

  it('rolls back consumption when the state delete fails and permits one later retry', async () => {
    if (!available) return;
    const f = await fixture();
    const state = new URL((await f.service.begin(f.owner.hash, f.session.hash, randomUUID())).authorizationUrl).searchParams.get('state')!;
    await db().execute(sql.raw(`CREATE OR REPLACE FUNCTION test_github_state_delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.model = '${GITHUB_ENROLLMENT_STATE_MODEL}' AND OLD.id = '${f.owner.hash.toString('hex')}' THEN RAISE EXCEPTION 'test delete failure'; END IF; RETURN OLD; END $$`));
    try {
      await db().execute(sql`CREATE TRIGGER test_github_state_delete_failure BEFORE DELETE ON auth_kv FOR EACH ROW EXECUTE FUNCTION test_github_state_delete_failure()`);
      await expect(f.service.consume(state, f.owner.hash, f.session.hash)).rejects.toMatchObject({ name: 'GitHubEnrollmentStateError' });
      expect(await stored(f.owner.hash)).toBeDefined();
    } finally {
      await db().execute(sql`DROP TRIGGER IF EXISTS test_github_state_delete_failure ON auth_kv`);
      await db().execute(sql`DROP FUNCTION IF EXISTS test_github_state_delete_failure()`);
    }
    await expect(f.service.consume(state, f.owner.hash, f.session.hash)).resolves.toMatchObject({ purpose: 'link_login_identity' });
  });
});
