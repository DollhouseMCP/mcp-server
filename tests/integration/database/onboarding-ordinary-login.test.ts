import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { users } from '../../../src/database/schema/users.js';
import { userAdminRoles } from '../../../src/database/schema/webConsole.js';
import { authAccounts } from '../../../src/database/schema/auth.js';
import { InvitationManagementService } from '../../../src/invitations/InvitationManagementService.js';
import { PostgresInvitationManagementStore } from '../../../src/invitations/PostgresInvitationManagementStore.js';
import { PostgresInvitationClaimStore } from '../../../src/invitations/PostgresInvitationClaimStore.js';
import { PostgresInvitationActivationStore } from '../../../src/invitations/PostgresInvitationActivationStore.js';
import { PostgresOnboardingStore } from '../../../src/invitations/onboarding/PostgresOnboardingStore.js';
import { OnboardingCredentials } from '../../../src/invitations/onboarding/OnboardingCredentials.js';
import { parseInvitationToken } from '../../../src/invitations/InvitationToken.js';
import { HmacConsoleOpaqueValueService } from '../../../src/web-console/security/ConsoleOpaqueValues.js';
import { appendSecurityAuditEventWithTx } from '../../../src/security/auditSink.js';
import { ordinaryGithubConsole } from '../../helpers/web-console/ordinaryGithubLogin.js';
import { closeTestDb, getTestAdminDb, isDatabaseAvailable } from './test-db-helpers.js';
let available = false;
beforeAll(async () => { available = await isDatabaseAvailable();
  if (!available && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('Required PostgreSQL unavailable'); });
afterAll(closeTestDb);

it('fresh ordinary GitHub HTTP login creates a normal invited-user session without email merging or unearned elevation', async () => {
  if (!available) return;
  const db = getTestAdminDb(), inviterId = randomUUID(), otherId = randomUUID(), githubId = randomInt(1, 2 ** 48 - 1);
  const providerEmail = `${randomUUID()}@provider.test`, otherSub = `local_${randomUUID()}`;
  await db.insert(users).values([{ id: inviterId, username: `ordinary-admin-${inviterId}` },
    { id: otherId, username: `ordinary-other-${otherId}`, email: providerEmail }]);
  await db.insert(userAdminRoles).values({ userId: inviterId, role: 'admin', grantedByUserId: inviterId });
  await db.insert(authAccounts).values({ userId: otherId, sub: otherSub, provider: 'local', externalSub: otherSub, email: providerEmail, emailVerified: true });
  const audit = { kind: 'system' as const, appendSecurityEvent: appendSecurityAuditEventWithTx };
  const management = new InvitationManagementService(new PostgresInvitationManagementStore(db), audit);
  const issued = await management.issue({ username: `ordinary-${randomUUID()}`, displayName: 'Renée 李', email: `${randomUUID()}@invite.test`,
    intendedRoles: ['operator'], inviterUserId: inviterId, correlationId: randomUUID() });
  const credentials = new OnboardingCredentials(new HmacConsoleOpaqueValueService(randomBytes(32)));
  const owner = credentials.issue('owner'), session = credentials.issue('session'), csrf = credentials.issue('csrf');
  const onboarding = new PostgresOnboardingStore(db, new PostgresInvitationClaimStore(db));
  await onboarding.createOwner(owner.hash, csrf.hash);
  const parsed = parseInvitationToken(issued.credential);
  const restricted = await onboarding.exchangeClaim({ invitationId: parsed.invitationId, generation: parsed.generation,
    credentialSecret: parsed.secret, ownerHash: owner.hash, sessionHash: session.hash, csrfTokenHash: csrf.hash, correlationId: randomUUID() }, audit);
  parsed.secret.fill(0);
  expect(await new PostgresInvitationActivationStore(db, onboarding).activate({ invitationId: restricted.invitationId,
    generation: restricted.generation, claimAssertionId: restricted.claimAssertionId, claimOwnerHash: owner.hash, sessionHash: session.hash,
    githubId: String(githubId), githubLogin: 'ordinary-invited-user', providerEmail, providerEmailVerified: false, correlationId: randomUUID() }, audit))
    .toMatchObject({ status: 'activated', userId: issued.invitation.userId });
  expect(await onboarding.findSession(owner.hash, session.hash)).toBeNull();

  const ordinary = await ordinaryGithubConsole(db, githubId, providerEmail);
  try {
    // Current ordinary GitHub policy still requires a verified primary email,
    // independently of invitation inbox proof. This test does not relax it.
    const denied = await ordinary.login(false);
    expect(denied.callback.status).toBe(400); expect(denied.me.status).toBe(401);
    expect(await ordinary.sessions.listActiveForUser(issued.invitation.userId)).toHaveLength(0);
    const login = await ordinary.login(true);
    expect(login.me.status).toBe(200); expect(login.session).toBeTruthy();
    expect(await login.me.json()).toMatchObject({ user_id: issued.invitation.userId, auth_sub: `github_${githubId}`,
      granted_capabilities: ['console:self'], available_admin_capabilities: ['console:admin:operate'], elevation: { active: false } });
    expect(await ordinary.sessions.findActiveByIdHash(ordinary.opaque.hashOpaqueValue(login.session!)))
      .toMatchObject({ userId: issued.invitation.userId, authSub: `github_${githubId}`, grantedCapabilities: ['console:self'], elevation: null });
    expect(login.replay!.status).toBe(302); expect(login.replay!.headers.get('location')).toBe('/api/v1/auth/login');
    expect(login.replay!.headers.getSetCookie().some(cookie => cookie.startsWith('dh_session='))).toBe(false);
    expect(await ordinary.sessions.listActiveForUser(issued.invitation.userId)).toHaveLength(1);
    expect(ordinary.providerCalls.filter(url => url === 'https://api.github.com/user/emails')).toHaveLength(2);
    expect((await db.select().from(authAccounts).where(eq(authAccounts.sub, `github_${githubId}`)))[0].userId).toBe(issued.invitation.userId);
    expect((await db.select().from(authAccounts).where(eq(authAccounts.sub, otherSub)))[0].userId).toBe(otherId);
  } finally { await ordinary.close(); }
}, 30000);
