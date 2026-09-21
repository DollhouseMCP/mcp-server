import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { isSubjectAccountAllowed } from '../../../src/auth/AccountAccess.js';
import { createUnifiedAuthMiddleware } from '../../../src/auth/authMiddleware.js';
import { PostgresAuthStorageLayer } from '../../../src/auth/embedded-as/storage/PostgresAuthStorageLayer.js';
import { InMemoryRateLimitStore } from '../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import { InviteTokenStore } from '../../../src/auth/embedded-as/inviteTokens.js';
import { LocalLoginRateLimiter } from '../../../src/auth/embedded-as/rateLimit.js';
import { LocalAccountMethod } from '../../../src/auth/embedded-as/methods/LocalAccountMethod.js';
import { MagicLinkMethod, hashEmail } from '../../../src/auth/embedded-as/methods/MagicLinkMethod.js';
import { UserIdentityService } from '../../../src/services/UserIdentityService.js';
import { PostgresConsoleIdentityResolver } from '../../../src/web-console/identity/PostgresConsoleIdentityResolver.js';
import { linkConsoleIdentityWithTx, PostgresConsoleAccountAdminStore } from '../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js';
import { PostgresInvitationManagementStore } from '../../../src/invitations/PostgresInvitationManagementStore.js';
import { appendSecurityAuditEventWithTx } from '../../../src/security/auditSink.js';
import { getErrorCode } from '../../../src/database/db-utils.js';
import { withSystemContext } from '../../../src/database/admin.js';
import { authAccounts } from '../../../src/database/schema/auth.js';
import { accountInvitations } from '../../../src/database/schema/invitations.js';
import { users } from '../../../src/database/schema/users.js';
import { closeTestDb, getTestAdminDb, getTestDb, isDatabaseAvailable, TEST_DB_ADMIN_URL } from './test-db-helpers.js';

const db = getTestAdminDb();
const storage = new PostgresAuthStorageLayer({ db });
const consoleIdentity = new PostgresConsoleIdentityResolver(db);
const identity = new UserIdentityService({ db, appConnectionUrl: TEST_DB_ADMIN_URL, ssl: 'disable' });
const inviterId = randomUUID();
let available = false;
let githubSequence = BigInt(Date.now());
beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('PostgreSQL is required');
  if (available) await db.insert(users).values({ id: inviterId, username: `admin-${inviterId}` });
});
afterAll(closeTestDb);

async function fixture(cohort = true, active = true, username = `policy-${randomUUID()}`) {
  const id = randomUUID();
  const email = `${id}@example.com`;
  if (cohort) {
    await new PostgresInvitationManagementStore(db).runMutation({ kind: 'system', appendSecurityEvent: appendSecurityAuditEventWithTx },
      tx => tx.issue({ invitationId: id, userId: id, username, displayName: null, emailOriginal: email, emailNormalized: email,
        inviterUserId: inviterId, intendedRoles: ['operator'], generation: 1, credentialSecret: randomBytes(32),
        ttlHours: 24, correlationId: randomUUID() }));
    if (active) await db.update(users).set({ activationState: 'active' }).where(eq(users.id, id));
  } else await db.insert(users).values({ id, username });
  return { id, email };
}
async function account(userId: string | null, provider = 'local', externalSub = randomUUID(), sub = `${provider}_${externalSub}`) {
  // Simulate credentials linked before this policy, including malformed legacy rows.
  await db.insert(authAccounts).values({ userId, provider, externalSub, sub, passwordHash: 'unchanged', emailVerified: true });
  return { sub, provider, externalSub, emailVerified: true, createdAt: 1, updatedAt: 1 };
}
const githubId = () => String(++githubSequence);

describe('durable invitation authentication policy', () => {
  it.each(['local', 'magic-link', 'api-key'])('blocks existing %s credentials at AS, console and MCP identity boundaries', async provider => {
    if (!available) return;
    const user = await fixture();
    const linked = await account(user.id, provider);
    expect(await storage.isAccountAllowed(linked.sub)).toBe(false);
    expect(await consoleIdentity.resolveEnabledPrincipal(linked.sub)).toBeNull();
    await expect(identity.resolveUserForSub(linked.sub)).rejects.toThrow('Account is not available');
    const app = express();
    app.use(createUnifiedAuthMiddleware({ provider: { name: 'test', validate: async () => ({ ok: true, claims: { sub: linked.sub } }) },
      isAccountAllowed: sub => isSubjectAccountAllowed(db, sub) }));
    app.post('/mcp', (_req, res) => res.json({ ok: true }));
    expect((await request(app).post('/mcp').set('Authorization', 'Bearer unchanged').set('Mcp-Session-Id', 'existing')).status).toBe(401);
  });

  it('allows coherent GitHub only after activation and fails closed for a restricted database role', async () => {
    if (!available) return;
    const user = await fixture(true, false);
    const linked = await account(user.id, 'github', githubId());
    expect(await storage.isAccountAllowed(linked.sub)).toBe(false);
    await db.update(users).set({ activationState: 'active' }).where(eq(users.id, user.id));
    expect(await isSubjectAccountAllowed(db, linked.sub)).toBe(true);
    await expect(isSubjectAccountAllowed(getTestDb(), linked.sub)).rejects.toThrow('requires a PostgreSQL role');
    expect(await identity.resolveUserForSub(linked.sub)).toBe(user.id);
    expect(await consoleIdentity.resolveEnabledPrincipal(linked.sub)).toMatchObject({ userId: user.id });
    await storage.upsertAccount({ ...linked, displayName: 'Renamed GitHub profile' });
    expect((await storage.getAccount(linked.sub))?.displayName).toBe('Renamed GitHub profile');
  });

  it.each(['local', 'magic-link', 'service'])('leaves legacy active %s accounts unchanged', async provider => {
    if (!available) return;
    const user = await fixture(false);
    const linked = await account(user.id, provider);
    expect(await storage.isAccountAllowed(linked.sub)).toBe(true);
    expect(await identity.resolveUserForSub(linked.sub)).toBe(user.id);
    await storage.upsertAccount({ ...linked, displayName: 'Legacy update' });
    expect((await storage.getAccount(linked.sub))?.displayName).toBe('Legacy update');
  });

  it('retains the cohort policy after terminal invitation state changes', async () => {
    if (!available) return;
    const user = await fixture();
    const linked = await account(user.id);
    await db.update(accountInvitations).set({ state: 'revoked', revokedAt: new Date() }).where(eq(accountInvitations.id, user.id));
    expect(await storage.isAccountAllowed(linked.sub)).toBe(false);
  });

  it('rejects attaching alternatives but permits a coherent GitHub identity', async () => {
    if (!available) return;
    const user = await fixture();
    const local = await account(null);
    const github = await account(null, 'github', githubId());
    const link = (sub: string) => withSystemContext(db, tx => linkConsoleIdentityWithTx(tx, { userId: user.id, sub, linkedAt: new Date() }));
    expect(await link(local.sub)).toBeNull();
    expect(await link(github.sub)).toMatchObject({ linkedUserId: user.id });
    expect((await db.select().from(authAccounts).where(eq(authAccounts.sub, local.sub)))[0].userId).toBeNull();
  });

  it('rejects legacy username fallback attachment and credential replacement', async () => {
    if (!available) return;
    const sub = `local_${randomUUID()}`;
    await fixture(true, true, sub);
    const local = await account(null, 'local', sub.slice(6), sub);
    expect(await storage.isAccountAllowed(sub)).toBe(false);
    await consoleIdentity.linkAccount(sub);
    expect((await db.select().from(authAccounts).where(eq(authAccounts.sub, sub)))[0].userId).toBeNull();
    await expect(storage.upsertAccount(local)).rejects.toThrow('Authentication method is not available');
  });

  it('does not upgrade an incoherent stored GitHub subject through a caller-provided rename', async () => {
    if (!available) return;
    const user = await fixture();
    const id = githubId();
    const malformed = await account(user.id, 'github', id, `local_${randomUUID()}`);
    expect(await storage.isAccountAllowed(malformed.sub)).toBe(false);
    await expect(storage.upsertAccount({ ...malformed, sub: `github_${id}` })).rejects.toThrow('Authentication method is not available');
    expect(await storage.getAccount(malformed.sub)).not.toBeNull();
    const local = await account(user.id, 'local', githubId());
    await expect(storage.upsertAccount({ ...local, provider: 'github' })).rejects.toThrow('Authentication method is not available');
  });

  it('preserves an unlinked legacy fallback owner when an upsert attempts to rename its subject', async () => {
    if (!available) return;
    const sub = `local_${randomUUID()}`;
    await fixture(true, true, sub);
    const id = githubId();
    const malformed = await account(null, 'github', id, sub);
    await expect(storage.upsertAccount({ ...malformed, sub: `github_${id}` })).rejects.toThrow('Authentication method is not available');
    expect(await storage.getAccount(sub)).not.toBeNull();
  });

  it.each([
    ['local', '123', 'github_123'],
    ['github', '0', 'github_0'],
    ['github', '321', 'github_123'],
  ])('rejects incoherent persisted identity %s/%s/%s at both read and attachment boundaries', async (provider, externalSub, sub) => {
    if (!available) return;
    const user = await fixture();
    const linked = await account(null, provider, externalSub, sub);
    expect(await withSystemContext(db, tx => linkConsoleIdentityWithTx(tx, {
      userId: user.id, sub, linkedAt: new Date(),
    }))).toBeNull();
    await db.update(authAccounts).set({ userId: user.id }).where(eq(authAccounts.sub, sub));
    expect(await storage.isAccountAllowed(linked.sub)).toBe(false);
    await db.delete(authAccounts).where(eq(authAccounts.sub, sub));
  });

  it('preserves an existing unlinked legacy credential when issuance loses the creation order', async () => {
    if (!available) return;
    const id = randomUUID();
    const sub = `local_${id}`;
    await storage.upsertAccount({ sub, provider: 'local', externalSub: id, emailVerified: true, createdAt: 1, updatedAt: 1 });
    await expect(fixture(true, true, sub)).rejects.toMatchObject({ code: 'invitation_conflict' });
    expect(await storage.isAccountAllowed(sub)).toBe(true);
    expect(await db.select().from(users).where(eq(users.username, sub))).toHaveLength(0);
  });

  it('aborts credential insertion while issuance owns the cohort creation gate', async () => {
    if (!available) return;
    const id = randomUUID();
    const sub = `local_${id}`;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const issuing = new PostgresInvitationManagementStore(db).runMutation({
      kind: 'system', appendSecurityEvent: appendSecurityAuditEventWithTx,
    }, async tx => {
      const invitation = await tx.issue({ invitationId: id, userId: id, username: sub, displayName: null,
        emailOriginal: `${id}@example.com`, emailNormalized: `${id}@example.com`, inviterUserId: inviterId,
        intendedRoles: ['operator'], generation: 1, credentialSecret: randomBytes(32), ttlHours: 24, correlationId: randomUUID() });
      entered();
      await gate;
      return invitation;
    });
    const input = { sub, provider: 'local', externalSub: id, emailVerified: true, createdAt: 1, updatedAt: 1 };
    try {
      await Promise.race([ready, issuing]);
      const result = await storage.upsertAccount(input).then(() => null, error => error);
      expect(getErrorCode(result)).toBe('55P03');
      expect(result.message).toBe('Authentication method is temporarily unavailable');
      expect(result).not.toHaveProperty('query');
      expect(await storage.getAccount(sub)).toBeNull();
    } finally { release(); await issuing; }
    await expect(storage.upsertAccount(input)).rejects.toThrow('Authentication method is not available');
    expect(await storage.getAccount(sub)).toBeNull();
  });

  it('owns mutable credential and link inputs before opening a transaction or waiting for user locks', async () => {
    if (!available) return;
    const cohort = await fixture();
    const github = await account(cohort.id, 'github', githubId());
    const input = { ...github, rawProfile: { login: 'original' } };
    const pending = storage.upsertAccount(input);
    input.provider = 'local';
    input.rawProfile.login = 'mutated';
    await pending;
    expect((await storage.getAccount(github.sub))?.rawProfile).toEqual({ login: 'original' });

    const legacy = await fixture(false);
    const local = await account(null);
    const linkInput = { userId: legacy.id, sub: local.sub, linkedAt: new Date() };
    const linking = new PostgresConsoleAccountAdminStore(db).linkIdentity(linkInput);
    linkInput.userId = cohort.id;
    expect(await linking).toMatchObject({ linkedUserId: legacy.id });

    const other = await account(null);
    await withSystemContext(db, async tx => {
      const owned = { userId: legacy.id, sub: other.sub, linkedAt: new Date() };
      const operation = linkConsoleIdentityWithTx(tx, owned);
      owned.userId = cohort.id;
      expect(await operation).toMatchObject({ linkedUserId: legacy.id });
    });
  });

  it('rejects local invite redemption without changing the existing password', async () => {
    if (!available) return;
    const user = await fixture();
    const linked = await account(user.id);
    const invites = new InviteTokenStore(randomBytes(32), storage);
    const method = new LocalAccountMethod({ storage, invites,
      rateLimiter: new LocalLoginRateLimiter({ storage, store: new InMemoryRateLimitStore(), storeBackend: 'memory' }) });
    const token = invites.issue({ sub: linked.sub, email: user.email, purpose: 'invite' });
    await expect(method.consumeInvite(token, 'a-valid-long-password')).rejects.toThrow('Authentication method is not available');
    expect((await storage.getAccount(linked.sub))?.credentials?.passwordHash).toBe('unchanged');
  });

  it('rejects magic-link redemption for an already linked cohort identity', async () => {
    if (!available) return;
    const user = await fixture();
    const linked = await account(user.id, 'magic-link', hashEmail(user.email));
    const invites = new InviteTokenStore(randomBytes(32), storage);
    const method = new MagicLinkMethod({ storage, invites, verifyUrl: 'https://example.com/verify',
      emailSender: { sendMagicLink: async () => { throw new Error('must not send'); } }, rateLimitStore: new InMemoryRateLimitStore() });
    const token = invites.issue({ sub: linked.sub, email: user.email, purpose: 'magic-link' });
    await expect(method.consumeMagicLink(token)).rejects.toThrow('Authentication method is not available');
    expect((await storage.getAccount(linked.sub))?.credentials?.passwordHash).toBe('unchanged');
  });
});
