/**
 * The canary user on PostgreSQL: created once, kept inert, and invisible to
 * account administration.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import { and, eq } from 'drizzle-orm';

import { SYSTEM_USER_UUID } from '../../../src/collection/shared-pool/SharedPoolConfig.js';
import { CANARY_USER_UUID, CANARY_USERNAME } from '../../../src/database/internalUsers.js';
import { authAccounts } from '../../../src/database/schema/auth.js';
import { users } from '../../../src/database/schema/users.js';
import { userAdminRoles } from '../../../src/database/schema/webConsole.js';
import { CanaryUserStateError, ensureCanaryUser } from '../../../src/web-console/canary/CanaryUser.js';
import { PostgresConsoleAccountAdminStore } from '../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js';
import { closeTestDb, getTestAdminDb } from './test-db-helpers.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;

required('the canary user on PostgreSQL', () => {
  const db = () => getTestAdminDb();
  const accounts = () => new PostgresConsoleAccountAdminStore(db());

  afterAll(async () => {
    await closeTestDb();
  });

  it('is created on first use and found, unchanged, on every later one', async () => {
    const first = await ensureCanaryUser(db());
    const second = await ensureCanaryUser(db());

    expect(first.userId).toBe(CANARY_USER_UUID);
    expect(second).toEqual({ ...first, created: false });
    expect(first.accountCorrelationId).toMatch(/^[0-9a-f-]{36}$/);

    const [row] = await db().select().from(users).where(eq(users.id, CANARY_USER_UUID));
    expect(row).toMatchObject({ username: CANARY_USERNAME, email: null, deletedAt: null });
    expect(row.disabledAt).toBeInstanceOf(Date);
  });

  it('has no sign-in identity and no role', async () => {
    await ensureCanaryUser(db());
    expect(await db().select().from(authAccounts).where(eq(authAccounts.userId, CANARY_USER_UUID))).toEqual([]);
    expect(await db().select().from(userAdminRoles).where(eq(userAdminRoles.userId, CANARY_USER_UUID))).toEqual([]);
  });

  it('is left out of the account list, as is the shared-pool system user', async () => {
    const canary = await ensureCanaryUser(db());
    await db().insert(users).values({ id: SYSTEM_USER_UUID, username: 'dollhousemcp-system' }).onConflictDoNothing();

    // Disabled accounts are listed, so being disabled is not what hides it.
    for (const query of [{ search: 'dollhousemcp' }, { search: 'dollhousemcp', enabled: false }, { enabled: false, limit: 200 }]) {
      const page = await accounts().listPrincipals(query);
      expect(page.items.map(item => item.userId)).not.toContain(CANARY_USER_UUID);
      expect(page.items.map(item => item.userId)).not.toContain(SYSTEM_USER_UUID);
    }
    expect(await accounts().findPrincipal(CANARY_USER_UUID)).toBeNull();
    expect(await accounts().findPrincipal(SYSTEM_USER_UUID)).toBeNull();
    expect(await accounts().findPrincipalByAccountCorrelationId(canary.accountCorrelationId)).toBeNull();
  });

  describe('refuses to be used once it is no longer inert', () => {
    it('when it has been enabled', async () => {
      await ensureCanaryUser(db());
      await db().update(users).set({ disabledAt: null }).where(eq(users.id, CANARY_USER_UUID));
      try {
        await expect(ensureCanaryUser(db())).rejects.toThrow(CanaryUserStateError);
        await expect(ensureCanaryUser(db())).rejects.toThrow('must stay disabled');
      } finally {
        await db().update(users).set({ disabledAt: new Date() }).where(eq(users.id, CANARY_USER_UUID));
      }
      await expect(ensureCanaryUser(db())).resolves.toMatchObject({ created: false });
    });

    it('when a sign-in identity has been attached', async () => {
      await ensureCanaryUser(db());
      const identity = { provider: 'local', externalSub: 'canary-test-identity', sub: 'local_canary-test-identity' };
      await db().insert(authAccounts).values({ ...identity, userId: CANARY_USER_UUID });
      try {
        await expect(ensureCanaryUser(db())).rejects.toThrow('has a sign-in identity attached');
      } finally {
        await db().delete(authAccounts).where(and(
          eq(authAccounts.provider, identity.provider), eq(authAccounts.externalSub, identity.externalSub),
        ));
      }
      await expect(ensureCanaryUser(db())).resolves.toMatchObject({ created: false });
    });

    it('when it has been given a role', async () => {
      await ensureCanaryUser(db());
      await db().insert(userAdminRoles).values({ userId: CANARY_USER_UUID, role: 'auditor', grantedByUserId: CANARY_USER_UUID });
      try {
        await expect(ensureCanaryUser(db())).rejects.toThrow('holds a role');
      } finally {
        await db().delete(userAdminRoles).where(eq(userAdminRoles.userId, CANARY_USER_UUID));
      }
      await expect(ensureCanaryUser(db())).resolves.toMatchObject({ created: false });
    });
  });
});
