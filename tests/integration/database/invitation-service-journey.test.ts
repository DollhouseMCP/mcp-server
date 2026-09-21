import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { eq, sql } from 'drizzle-orm';
import { GitHubAuthenticatedUserClient } from '../../../src/auth/github/GitHubAuthenticatedUserClient.js';
import type { TransactionalEmail } from '../../../src/auth/embedded-as/methods/TransactionalEmailSender.js';
import { authAccounts, authKv } from '../../../src/database/schema/auth.js';
import { users } from '../../../src/database/schema/users.js';
import { userAdminRoles } from '../../../src/database/schema/webConsole.js';
import { InvitationManagementService } from '../../../src/invitations/InvitationManagementService.js';
import { InvitationDeliveryService } from '../../../src/invitations/InvitationDeliveryService.js';
import { PostgresInvitationManagementStore } from '../../../src/invitations/PostgresInvitationManagementStore.js';
import { PostgresInvitationDeliveryStore } from '../../../src/invitations/PostgresInvitationDeliveryStore.js';
import { PostgresInvitationClaimStore } from '../../../src/invitations/PostgresInvitationClaimStore.js';
import { PostgresInvitationActivationStore } from '../../../src/invitations/PostgresInvitationActivationStore.js';
import { parseInvitationToken } from '../../../src/invitations/InvitationToken.js';
import { OnboardingCredentials } from '../../../src/invitations/onboarding/OnboardingCredentials.js';
import { PostgresOnboardingStore } from '../../../src/invitations/onboarding/PostgresOnboardingStore.js';
import { appendSecurityAuditEventWithTx } from '../../../src/security/auditSink.js';
import { PostgresConsoleIdentityResolver } from '../../../src/web-console/identity/PostgresConsoleIdentityResolver.js';
import { ROLE_DESCRIPTIONS } from '../../../src/web-console/modules/account-admin/AccountAdminRoleDescriptions.js';
import { HmacConsoleOpaqueValueService } from '../../../src/web-console/security/ConsoleOpaqueValues.js';
import { PostgresConsoleAccountAllowlistStore } from '../../../src/web-console/stores/PostgresConsoleAccountAllowlistStore.js';
import { closeTestDb, getTestAdminDb, isDatabaseAvailable } from './test-db-helpers.js';

let available = false;
beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('Required PostgreSQL unavailable');
});
afterAll(closeTestDb);

it('carries a Unicode invitation through delivery, atomic claim, activation and ordinary identity resolution without email merging', async () => {
  if (!available) return;
  const db = getTestAdminDb();
  const audit = { kind: 'system' as const, appendSecurityEvent: appendSecurityAuditEventWithTx };
  const inviterId = randomUUID();
  const unrelatedId = randomUUID();
  const providerEmail = `${randomUUID()}@provider.example`;
  const unrelatedSub = `local_${randomUUID()}`;
  await db.insert(users).values([
    { id: inviterId, username: `journey-admin-${inviterId}` },
    { id: unrelatedId, username: `existing-${unrelatedId}`, email: providerEmail },
  ]);
  await db.insert(userAdminRoles).values({ userId: inviterId, role: 'admin', grantedByUserId: inviterId });
  await db.insert(authAccounts).values({ provider: 'local', externalSub: unrelatedSub, sub: unrelatedSub,
    userId: unrelatedId, email: providerEmail, emailVerified: true });

  const management = new InvitationManagementService(new PostgresInvitationManagementStore(db), audit, 24);
  const suffix = randomUUID();
  const inviteEmail = `Invitation-${suffix}@example.test`;
  const issued = await management.issue({ username: ` CAFÉ-${suffix} `, displayName: ' Rene\u0301e 李 ',
    email: inviteEmail, inviterUserId: inviterId, intendedRoles: ['operator', 'auditor'], correlationId: randomUUID() });
  const userId = issued.invitation.userId;
  expect(issued.invitation).toMatchObject({ intendedUsername: `café-${suffix}`, intendedDisplayName: 'Renée 李' });
  expect((await db.select().from(users).where(eq(users.id, userId)))[0].activationState).toBe('pending_activation');

  const ledger = new PostgresInvitationDeliveryStore(db);
  let reservedState: string | undefined;
  const sender = { sendTransactionalEmail: jest.fn(async (_message: TransactionalEmail) => {
    reservedState = (await ledger.list(issued.invitation.id))[0].state;
    return { state: 'submitted' as const, providerMessageId: null };
  }) };
  const delivery = new InvitationDeliveryService(ledger, sender, {
    publicBaseUrl: 'https://console.example.test', supportEmail: 'Support@example.test',
    describeRole: role => ({ name: ROLE_DESCRIPTIONS[role].name, description: ROLE_DESCRIPTIONS[role].summary }),
  });
  const delivered = await delivery.deliver(issued, randomUUID(), audit);
  expect(delivered).toMatchObject({ status: 'recorded', attempt: { state: 'submitted' } });
  expect(sender.sendTransactionalEmail).toHaveBeenCalledTimes(1);
  expect(reservedState).toBe('submitting');
  const [message] = sender.sendTransactionalEmail.mock.calls[0];
  expect(message.to).toBe(inviteEmail);
  expect(message.text).toContain('Renée 李');
  expect(message.text).toContain(`/auth/onboarding/invitation#token=${issued.credential}`);
  expect(message.html).toContain('No Dollhouse password');
  expect(message.subject).not.toContain(issued.credential);

  const opaque = new OnboardingCredentials(new HmacConsoleOpaqueValueService(randomBytes(32)));
  const owner = opaque.issue('owner');
  const session = opaque.issue('session');
  const csrf = opaque.issue('csrf');
  const bootstrapCsrf = opaque.issue('csrf');
  const onboarding = new PostgresOnboardingStore(db, new PostgresInvitationClaimStore(db));
  await onboarding.createOwner(owner.hash, bootstrapCsrf.hash);
  const parsed = parseInvitationToken(issued.credential);
  const restricted = await onboarding.exchangeClaim({ invitationId: parsed.invitationId, generation: parsed.generation,
    credentialSecret: parsed.secret, ownerHash: owner.hash, sessionHash: session.hash,
    csrfTokenHash: csrf.hash, correlationId: randomUUID() }, audit);
  parsed.secret.fill(0);
  expect(restricted.scope).toBe('onboarding:github-enrollment');
  expect(await onboarding.findSession(owner.hash, session.hash)).toEqual(restricted);

  const githubAccessToken = `transient-${randomUUID()}`;
  const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    id: randomInt(1, 2 ** 48 - 1), login: 'journey-github-user', email: providerEmail, name: 'Provider display name',
  })));
  const profile = await new GitHubAuthenticatedUserClient({ fetchImpl }).fetchAuthenticatedUser(githubAccessToken);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe('https://api.github.com/user');
  expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${githubAccessToken}`);
  const githubId = profile.externalSub;
  const sub = `github_${githubId}`;
  const resolver = new PostgresConsoleIdentityResolver(db);
  expect(await resolver.resolveEnabledPrincipal(sub)).toBeNull();
  expect(await new PostgresInvitationActivationStore(db, onboarding).activate({
    invitationId: restricted.invitationId, generation: restricted.generation, claimAssertionId: restricted.claimAssertionId,
    claimOwnerHash: owner.hash, sessionHash: session.hash, githubId, githubLogin: profile.login,
    providerEmail: profile.email, providerEmailVerified: false, correlationId: randomUUID(),
  }, audit)).toEqual({ status: 'activated', userId, invitationId: issued.invitation.id });
  expect(await onboarding.findSession(owner.hash, session.hash)).toBeNull();

  // The ordinary allowlist/provisioning path must keep the explicit stable-ID
  // link even when provider metadata matches a different existing principal.
  expect(await new PostgresConsoleAccountAllowlistStore(db).provisionAccountIfAllowed({ required: true,
    identity: { sub, method: 'github', provider: 'github', externalSub: githubId, githubId,
      githubUsername: 'renamed-after-activation', email: providerEmail },
    account: { provider: 'github', externalSub: githubId, sub, email: providerEmail,
      emailVerified: false, createdAt: Date.now(), updatedAt: Date.now() },
  })).toEqual({ allowed: true });
  await resolver.linkAccount(sub, 'Provider display name');
  expect(await resolver.resolveEnabledPrincipal(sub)).toMatchObject({ userId, roles: ['auditor', 'operator'] });
  expect((await db.select().from(authAccounts).where(eq(authAccounts.sub, sub)))[0]).toMatchObject({ userId, externalSub: githubId, email: providerEmail });
  expect((await db.select().from(authAccounts).where(eq(authAccounts.sub, unrelatedSub)))[0].userId).toBe(unrelatedId);
  expect((await db.select().from(users).where(eq(users.id, userId)))[0]).toMatchObject({
    activationState: 'active', username: `café-${suffix}`, displayName: 'Renée 李', email: inviteEmail.toLowerCase(),
  });
  expect((await management.inspect(issued.invitation.id))?.state).toBe('accepted');

  // Inspect complete persisted rows, including bytea JSON, plus all audit
  // families touched by this journey. Raw invitation/browser credentials belong
  // only to the transient caller and fake transport.
  const durable = await db.execute(sql`SELECT jsonb_build_object(
    'user', (SELECT to_jsonb(u) FROM users u WHERE id = ${userId}::uuid),
    'accounts', (SELECT jsonb_agg(a) FROM auth_accounts a WHERE user_id = ${userId}::uuid),
    'intended_roles', (SELECT jsonb_agg(r) FROM account_invitation_intended_roles r WHERE invitation_id = ${issued.invitation.id}::uuid),
    'granted_roles', (SELECT jsonb_agg(r) FROM user_admin_roles r WHERE user_id = ${userId}::uuid),
    'allowlist', (SELECT jsonb_agg(a) FROM account_allowlist_entries a WHERE created_by_user_id = ${inviterId}::uuid),
    'invalidations', (SELECT jsonb_agg(e) FROM security_invalidation_events e WHERE user_id = ${userId}::uuid),
    'invitations', (SELECT jsonb_agg(i) FROM account_invitations i WHERE id = ${issued.invitation.id}::uuid),
    'generations', (SELECT jsonb_agg(g) FROM account_invitation_generations g WHERE invitation_id = ${issued.invitation.id}::uuid),
    'claims', (SELECT jsonb_agg(c) FROM account_invitation_claim_assertions c WHERE invitation_id = ${issued.invitation.id}::uuid),
    'attempts', (SELECT jsonb_agg(d) FROM account_invitation_delivery_attempts d WHERE invitation_id = ${issued.invitation.id}::uuid),
    'security', (SELECT jsonb_agg(a) FROM security_audit_events a WHERE target_id IN (${issued.invitation.id}, ${userId})),
    'admin', (SELECT jsonb_agg(a) FROM admin_audit_events a WHERE resource_id IN (${issued.invitation.id}, ${userId})),
    'identity', (SELECT jsonb_agg(a) FROM auth_identity_events a WHERE sub = ${sub})
  ) AS records`);
  const kv = await db.select().from(authKv).where(eq(authKv.id, owner.hash.toString('hex')));
  expect(durable[0].records).toMatchObject({
    intended_roles: expect.arrayContaining([expect.objectContaining({ role: 'auditor' }), expect.objectContaining({ role: 'operator' })]),
    granted_roles: expect.arrayContaining([expect.objectContaining({ role: 'auditor' }), expect.objectContaining({ role: 'operator' })]),
    allowlist: [expect.objectContaining({ kind: 'github_id', normalized_value: githubId })],
    invalidations: expect.arrayContaining([expect.objectContaining({ reason: 'invitation_activated' })]),
    generations: [expect.objectContaining({ state: 'accepted' })],
    claims: [expect.objectContaining({ state: 'completed' })],
    security: expect.arrayContaining([
      expect.objectContaining({ event_type: 'invitation.claimed' }),
      expect.objectContaining({ event_type: 'invitation.activated' }),
    ]),
  });
  expect(kv).toHaveLength(0);
  expect(await onboarding.findOwner(owner.hash)).toBeNull();
  const serialized = JSON.stringify({ durable, kv, delivered });
  for (const secret of [issued.credential, issued.credential.split('.')[3], owner.value, session.value, csrf.value, bootstrapCsrf.value, githubAccessToken]) {
    expect(serialized).not.toContain(secret);
  }
  const secretBytes = Buffer.from(issued.credential.split('.')[3], 'base64url');
  expect(serialized).not.toContain(secretBytes.toString('hex'));
  expect(serialized).not.toContain(JSON.stringify([...secretBytes]));
});
