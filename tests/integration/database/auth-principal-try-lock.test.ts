import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createDatabaseConnection } from '../../../src/database/connection.js';
import { getErrorCode } from '../../../src/database/db-utils.js';
import { lockAuthAllowlistIdentitiesWithTx, lockAuthPrincipalsWithTx, tryLockAuthMutationIdentitiesWithTx } from '../../../src/database/authPrincipalLock.js';
import { users } from '../../../src/database/schema/users.js';
import { authAccounts } from '../../../src/database/schema/auth.js';
import { accountAllowlistEntries } from '../../../src/database/schema/webConsole.js';
import { PostgresConsoleAccountAllowlistStore } from '../../../src/web-console/stores/PostgresConsoleAccountAllowlistStore.js';
import { deleteConsolePrincipalWithTx } from '../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js';
import { TEST_DB_ADMIN_URL } from './test-db-helpers.js';

const connection = createDatabaseConnection({ connectionUrl: TEST_DB_ADMIN_URL, poolSize: 5, ssl: 'disable' });
const db = connection.db;
const actorId = randomUUID();
beforeAll(async () => { await db.insert(users).values({ id: actorId, username: `lock-admin-${actorId}` }); });
afterAll(() => connection.close());
const identity = (id: string) => ({ kind: 'github_id', normalizedValue: id });
const account = (id: string) => ({ provider: 'github', externalSub: id, sub: `github_${id}`, emailVerified: false, createdAt: Date.now(), updatedAt: Date.now() });
const provision = (id: string) => new PostgresConsoleAccountAllowlistStore(db).provisionAccountIfAllowed({
  identity: { sub: `github_${id}`, method: 'github', provider: 'github', externalSub: id, githubId: id },
  account: account(id), required: true,
});
async function waitForPrincipalLock(subject: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await db.execute(sql`
      SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted
        AND classid = ((hashtextextended(${'dollhouse:auth-principal:' + subject}, 0) >> 32) & 4294967295)::oid
        AND objid = (hashtextextended(${'dollhouse:auth-principal:' + subject}, 0) & 4294967295)::oid
      ) AS held
    `);
    if (rows[0].held) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('principal lock was not acquired');
}

describe('nonblocking auth identity transaction locks', () => {
  it('reuses existing namespaces, de-duplicates keys and permits same-transaction reentry', async () => {
    const id = randomUUID();
    await db.transaction(async tx => {
      await lockAuthPrincipalsWithTx(tx, [`github_${id}`]);
      await lockAuthAllowlistIdentitiesWithTx(tx, [identity(id)]);
      await tryLockAuthMutationIdentitiesWithTx(tx, [`github_${id}`, '', `github_${id}`], [identity(id), identity(id)]);
    });
  });

  it('aborts on contention even if the callback catches the rejection; prior writes and partial locks roll back', async () => {
    const id = randomUUID();
    const temporaryUser = randomUUID();
    await db.transaction(async owner => {
      await lockAuthAllowlistIdentitiesWithTx(owner, [identity(id)]);
      let transactionFailure: unknown;
      try { await db.transaction(async contender => {
        await contender.insert(users).values({ id: temporaryUser, username: `rollback-${temporaryUser}` });
        let failure: unknown;
        try { await tryLockAuthMutationIdentitiesWithTx(contender, [`github_${id}`], [identity(id)]); } catch (error) { failure = error; }
        expect(getErrorCode(failure)).toBe('40001');
        await expect(contender.execute(sql`SELECT 1`)).rejects.toMatchObject({ cause: { code: '25P02' } });
        // The driver must reject the outer transaction even when application
        // code swallows both failed statements. Nothing can commit.
      }); } catch (error) { transactionFailure = error; }
      expect(getErrorCode(transactionFailure)).toBe('40001');
      expect(await db.select().from(users).where(eq(users.id, temporaryUser))).toHaveLength(0);
      await db.transaction(tx => tryLockAuthMutationIdentitiesWithTx(tx, [`github_${id}`], []));
    });
  });

  it('fails without waiting behind the actual sign-in provisioner holding a principal lock', async () => {
    const id = randomUUID();
    await db.insert(accountAllowlistEntries).values({ kind: 'github_id', normalizedValue: id, displayValue: id, createdByUserId: actorId });
    let pending: ReturnType<typeof provision> | undefined;
    await db.transaction(async blocker => {
      await lockAuthAllowlistIdentitiesWithTx(blocker, [identity(id)]);
      pending = provision(id);
      await waitForPrincipalLock(`github_${id}`);
      let failure: unknown;
      try {
        await db.transaction(async contender => {
          await contender.execute(sql`LOCK TABLE users IN EXCLUSIVE MODE`);
          await tryLockAuthMutationIdentitiesWithTx(contender, [`github_${id}`], [identity(id)]);
        });
      } catch (error) { failure = error; }
      expect(getErrorCode(failure)).toBe('40001');
    });
    expect(await pending).toEqual({ allowed: true });
  });

  it('releases users on contention so actual deletion completes and its deny tombstone still blocks fresh sign-in', async () => {
    const id = randomUUID();
    const userId = randomUUID();
    await db.insert(users).values({ id: userId, username: `delete-${userId}` });
    await db.insert(authAccounts).values({ provider: 'github', externalSub: id, sub: `github_${id}`, userId });
    await db.insert(accountAllowlistEntries).values({ kind: 'github_id', normalizedValue: id, displayValue: id, createdByUserId: actorId });
    let deletion: Promise<unknown> | undefined;
    await db.transaction(async blocker => {
      await lockAuthPrincipalsWithTx(blocker, [`github_${id}`]);
      let failure: unknown;
      try {
        await db.transaction(async contender => {
          await contender.execute(sql`LOCK TABLE users IN EXCLUSIVE MODE`);
          deletion = db.transaction(tx => deleteConsolePrincipalWithTx(tx, { userId, deletedByUserId: actorId, deletedAt: new Date() }));
          await tryLockAuthMutationIdentitiesWithTx(contender, [`github_${id}`], [identity(id)]);
        });
      } catch (error) { failure = error; }
      expect(getErrorCode(failure)).toBe('40001');
    });
    expect(await deletion).toMatchObject({ userId });
    expect(await provision(id)).toMatchObject({ allowed: false });
    expect(await db.select().from(authAccounts).where(eq(authAccounts.sub, `github_${id}`))).toHaveLength(0);
  });
});
