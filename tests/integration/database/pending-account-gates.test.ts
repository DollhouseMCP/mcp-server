import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';

import { isSubjectAccountAllowed } from '../../../src/auth/AccountAccess.js';
import { createUnifiedAuthMiddleware } from '../../../src/auth/authMiddleware.js';
import { createAuthStorage } from '../../../src/auth/embedded-as/storage/createAuthStorage.js';
import { PostgresAuthStorageLayer } from '../../../src/auth/embedded-as/storage/PostgresAuthStorageLayer.js';
import { UserIdentityService } from '../../../src/services/UserIdentityService.js';
import { PostgresConsoleIdentityResolver } from '../../../src/web-console/identity/PostgresConsoleIdentityResolver.js';
import { authAccounts } from '../../../src/database/schema/auth.js';
import { users } from '../../../src/database/schema/users.js';
import { closeTestDb, getTestAdminDb, TEST_DB_ADMIN_URL } from './test-db-helpers.js';

const db = getTestAdminDb();
const storage = new PostgresAuthStorageLayer({ db });
const consoleIdentity = new PostgresConsoleIdentityResolver(db);
const identity = new UserIdentityService({ db, appConnectionUrl: TEST_DB_ADMIN_URL, ssl: 'disable' });
const prefix = `pending-gates-${randomUUID()}`;
let sequence = 0;

async function fixture(linked = true) {
  const sub = `${prefix}-${sequence++}`;
  const [user] = await db.insert(users).values({ username: sub }).returning();
  await storage.upsertAccount({ sub, provider: 'local', externalSub: sub, emailVerified: true, createdAt: 1, updatedAt: 1 });
  if (linked) await db.update(authAccounts).set({ userId: user.id }).where(eq(authAccounts.sub, sub));
  return { sub, userId: user.id };
}

afterAll(closeTestDb);

describe('pending account authorization boundaries', () => {
  it.each([
    ['pending', { activationState: 'pending_activation' as const }],
    ['disabled', { disabledAt: new Date() }],
    ['deleted', { deletedAt: new Date() }],
  ])('rechecks %s state after successful console and MCP identity resolution', async (_label, patch) => {
    const { sub, userId } = await fixture();
    expect(await identity.resolveUserForSub(sub)).toBe(userId);
    expect(await consoleIdentity.resolveEnabledPrincipal(sub)).toMatchObject({ userId });
    expect(await storage.isAccountAllowed(sub)).toBe(true);
    await db.update(users).set(patch).where(eq(users.id, userId));
    await expect(identity.resolveUserForSub(sub)).rejects.toThrow('Account is not available');
    expect(await consoleIdentity.resolveEnabledPrincipal(sub)).toBeNull();
    expect(await storage.isAccountAllowed(sub)).toBe(false);
  });

  it('honors the canonical link rather than a different active username match', async () => {
    const { sub, userId } = await fixture();
    const [pending] = await db.insert(users).values({
      username: `${sub}-canonical`, activationState: 'pending_activation',
    }).returning();
    expect(await identity.resolveUserForSub(sub)).toBe(userId);
    await db.update(authAccounts).set({ userId: pending.id }).where(eq(authAccounts.sub, sub));
    await expect(identity.resolveUserForSub(sub)).rejects.toThrow('Account is not available');
    expect(await storage.isAccountAllowed(sub)).toBe(false);
  });

  it('denies an unlinked pending username before creating a canonical identity link', async () => {
    const { sub, userId } = await fixture(false);
    await db.update(users).set({ activationState: 'pending_activation' }).where(eq(users.id, userId));
    expect(await storage.isAccountAllowed(sub)).toBe(false);
    await expect(identity.resolveUserForSub(sub)).rejects.toThrow('Account is not available');
    const [account] = await db.select().from(authAccounts).where(eq(authAccounts.sub, sub));
    expect(account.userId).toBeNull();
  });

  it('preserves first-login provisioning and active legacy unlinked accounts', async () => {
    const freshSub = `${prefix}-new`;
    expect(await storage.isAccountAllowed(freshSub)).toBe(true);
    const freshUserId = await identity.resolveUserForSub(freshSub);
    expect(await identity.resolveUserForSub(freshSub)).toBe(freshUserId);
    const { sub, userId } = await fixture(false);
    expect(await storage.isAccountAllowed(sub)).toBe(true);
    await consoleIdentity.linkAccount(sub);
    expect(await consoleIdentity.resolveEnabledPrincipal(sub)).toMatchObject({ userId });
    expect(await identity.resolveUserForSub(sub)).toBe(userId);
  });

  it('gates database users even when OAuth state is stored in memory', async () => {
    const { sub, userId } = await fixture();
    const mixedStorage = await createAuthStorage({ backend: 'memory', database: db });
    expect(await mixedStorage.isAccountAllowed(sub)).toBe(true);
    await db.update(users).set({ activationState: 'pending_activation' }).where(eq(users.id, userId));
    expect(await mixedStorage.isAccountAllowed(sub)).toBe(false);
  });

  it('denies existing MCP session requests with the same valid token after a state change', async () => {
    const { sub, userId } = await fixture();
    const app = express();
    app.use(createUnifiedAuthMiddleware({
      provider: { name: 'test', validate: async () => ({ ok: true, claims: { sub } }) },
      isAccountAllowed: subject => isSubjectAccountAllowed(db, subject),
    }));
    app.post('/mcp', (_req, res) => res.json({ ok: true }));
    const call = () => request(app).post('/mcp').set('Authorization', 'Bearer unchanged')
      .set('Mcp-Session-Id', 'existing-session');
    expect((await call()).status).toBe(200);
    await db.update(users).set({ activationState: 'pending_activation' }).where(eq(users.id, userId));
    expect((await call()).status).toBe(401);
  });
});
