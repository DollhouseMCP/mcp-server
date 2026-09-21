import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createDatabaseConnection } from '../../../src/database/connection.js';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import { getErrorCode } from '../../../src/database/db-utils.js';
import { lockAuthMutationResourcesWithTx } from '../../../src/database/authMutationPreflight.js';
import { users } from '../../../src/database/schema/users.js';
import { authAccounts } from '../../../src/database/schema/auth.js';
import { accountAllowlistEntries } from '../../../src/database/schema/webConsole.js';
import { grantConsoleAdminRoleWithTx, linkConsoleIdentityWithTx, deleteConsolePrincipalWithTx } from '../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js';
import { addAccountAllowlistEntryWithTx, removeAccountAllowlistEntryWithTx, PostgresConsoleAccountAllowlistStore } from '../../../src/web-console/stores/PostgresConsoleAccountAllowlistStore.js';
import { appendConsoleAdminAuditEventWithTx } from '../../../src/web-console/audit/PostgresAdminAuditWriter.js';
import { appendSecurityInvalidationEventWithTx } from '../../../src/web-console/services/invalidation/PostgresConsoleSecurityInvalidationStore.js';
import { closeTestDb, isDatabaseAvailable, TEST_DB_ADMIN_URL } from './test-db-helpers.js';

const connection = createDatabaseConnection({ connectionUrl: TEST_DB_ADMIN_URL, poolSize: 5, ssl: 'disable' });
const db = connection.db;
const actorId = randomUUID();
let databaseAvailable = false;
beforeAll(async () => {
  databaseAvailable = await isDatabaseAvailable();
  if (!databaseAvailable && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('PostgreSQL is required for mutation preflight tests');
  if (!databaseAvailable) return;
  await db.insert(users).values({ id: actorId, username: `preflight-admin-${actorId}` });
});
afterAll(async () => { await Promise.all([connection.close(), closeTestDb()]); });
async function user() {
  const id = randomUUID();
  await db.insert(users).values({ id, username: `preflight-${id}` });
  return id;
}
async function waitForWriter(table: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await db.execute(sql`
      SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation = ${table}::regclass
        AND mode = 'RowExclusiveLock' AND granted) AS held
    `);
    if (rows[0].held) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`writer never reached ${table}`);
}
async function contendWith(table: string, writer: (tx: DrizzleTx) => Promise<unknown>): Promise<void> {
  let writing: Promise<unknown> | undefined;
  let failure: unknown;
  try {
    await db.transaction(async contender => {
      await contender.execute(sql`LOCK TABLE users IN EXCLUSIVE MODE`);
      writing = db.transaction(writer).then(value => ({ value }), error => ({ writerFailure: error }));
      await waitForWriter(table);
      await lockAuthMutationResourcesWithTx(contender);
      throw new Error('preflight must not succeed while another writer owns a downstream table');
    });
  } catch (error) { failure = error; }
  expect(getErrorCode(failure)).toBe('55P03');
  expect(await writing).not.toHaveProperty('writerFailure');
  // All partial table locks released; the same complete preflight now succeeds.
  await db.transaction(tx => lockAuthMutationResourcesWithTx(tx));
}

describe('activation resource preflight', () => {
  it('permits ordinary reads and same-transaction reentry', async () => {
    if (!databaseAvailable) return;
    await db.transaction(async tx => {
      await lockAuthMutationResourcesWithTx(tx);
      await lockAuthMutationResourcesWithTx(tx);
      expect(await db.select().from(users).where(eq(users.id, actorId))).toHaveLength(1);
    });
  });

  it('fails without a FK upgrade cycle against the actual role grant writer', async () => {
    if (!databaseAvailable) return;
    const userId = await user();
    await contendWith('user_admin_roles', tx => grantConsoleAdminRoleWithTx(tx, { userId, role: 'operator', grantedByUserId: actorId, grantedAt: new Date() }));
  });

  it('completes preflight while the actual identity linker waits at users before touching auth rows', async () => {
    if (!databaseAvailable) return;
    const userId = await user();
    const externalSub = randomUUID();
    const sub = `github_${externalSub}`;
    await db.insert(authAccounts).values({ provider: 'github', externalSub, sub });
    let linking: Promise<unknown> | undefined;
    await db.transaction(async contender => {
      await contender.execute(sql`LOCK TABLE users IN EXCLUSIVE MODE`);
      linking = db.transaction(tx => linkConsoleIdentityWithTx(tx, { userId, sub, linkedAt: new Date() }));
      let waiting = false;
      for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
        const rows = await db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks
          WHERE relation = 'users'::regclass AND mode = 'RowShareLock' AND NOT granted) AS waiting`);
        waiting = rows[0].waiting === true;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true);
      await lockAuthMutationResourcesWithTx(contender);
    });
    expect(await linking).toMatchObject({ linkedUserId: userId });
    const [linked] = await db.select().from(authAccounts).where(eq(authAccounts.sub, sub));
    expect(linked.userId).toBe(userId);
  });

  it.each(['add', 'remove'] as const)('fails without a FK upgrade cycle against actual authority %s', async operation => {
    if (!databaseAvailable) return;
    const value = `identity-${randomUUID()}@example.com`;
    if (operation === 'add') {
      await contendWith('account_allowlist_entries', tx => addAccountAllowlistEntryWithTx(tx, { kind: 'email', value, createdByUserId: actorId, createdAt: new Date() }));
    } else {
      const [entry] = await db.insert(accountAllowlistEntries).values({ kind: 'email', normalizedValue: value, displayValue: value, createdByUserId: actorId }).returning();
      await contendWith('account_allowlist_entries', tx => removeAccountAllowlistEntryWithTx(tx, { id: entry.id, revokedByUserId: actorId, revokedAt: new Date() }));
    }
  });

  it('fails without the global chain-head/users cycle against the actual administrator audit writer', async () => {
    if (!databaseAvailable) return;
    await contendWith('admin_audit_events', tx => appendConsoleAdminAuditEventWithTx(tx, {
      occurredAt: new Date(), actorUserId: actorId, actorSub: `test:${actorId}`, actorRole: 'admin', actorCapabilityRole: 'admin',
      actorConsoleSessionHash: randomBytes(32), capability: 'console:admin:accounts', elevationAcr: null, elevationAmr: [], elevationAuthTime: null,
      correlationId: randomUUID(), endpoint: '/test/preflight', operation: 'test.preflight', resourceKind: null, resourceId: null, targetUserId: null,
      argsRedacted: {}, result: 'approved', errorCode: null, resultDetailRedacted: null, clientIp: null, userAgent: null,
    }, { resolve: async () => ({ keyId: 'preflight-test', key: Buffer.alloc(32, 9) }) }));
  });

  it('preflights the actual durable security invalidation outbox writer', async () => {
    if (!databaseAvailable) return;
    const userId = await user();
    await contendWith('security_invalidation_events', tx => appendSecurityInvalidationEventWithTx(tx, {
      kind: 'principal_authz_changed', urgency: 'eventual', userId, authzVersion: 2, reason: 'test',
      payload: { previousAuthzVersion: 1, newAuthzVersion: 2 }, createdAt: new Date(), createdByUserId: actorId,
    }));
  });

  it('aborts actual sign-in provisioning before a users/resource lock inversion', async () => {
    if (!databaseAvailable) return;
    const externalSub = randomUUID();
    const sub = `github_${externalSub}`;
    await db.insert(authAccounts).values({ provider: 'github', externalSub, sub });
    await db.insert(accountAllowlistEntries).values({ kind: 'github_id', normalizedValue: externalSub, displayValue: externalSub, createdByUserId: actorId });
    const provision = () => new PostgresConsoleAccountAllowlistStore(db).provisionAccountIfAllowed({
      identity: { sub, method: 'github', provider: 'github', externalSub, githubId: externalSub },
      account: { sub, provider: 'github', externalSub, emailVerified: false, createdAt: Date.now(), updatedAt: Date.now() }, required: true,
    });
    await db.transaction(async contender => {
      await contender.execute(sql`LOCK TABLE users IN EXCLUSIVE MODE`);
      await contender.select().from(authAccounts).where(eq(authAccounts.sub, sub)).for('update');
      const failure = await provision().then(() => null, error => error);
      expect(getErrorCode(failure)).toBe('55P03');
      // Failed provisioning released its principal/allowlist locks on rollback.
      await lockAuthMutationResourcesWithTx(contender);
    });
    expect(await provision()).toEqual({ allowed: true });
  });

  it('serializes the real deletion writer before preflight and observes its committed account removal', async () => {
    if (!databaseAvailable) return;
    const userId = await user();
    let pending: Promise<unknown> | undefined;
    await db.transaction(async writer => {
      await deleteConsolePrincipalWithTx(writer, { userId, deletedByUserId: actorId, deletedAt: new Date() });
      pending = db.transaction(async contender => {
        await lockAuthMutationResourcesWithTx(contender);
        return contender.select().from(users).where(eq(users.id, userId));
      });
    });
    expect(await pending).toEqual([]);
  });
});
