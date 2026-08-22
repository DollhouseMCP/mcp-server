import { and, eq, sql } from 'drizzle-orm';

import { UserIdentityService } from '../../../src/services/UserIdentityService.js';
import { PostgresAuthStorageLayer } from '../../../src/auth/embedded-as/storage/PostgresAuthStorageLayer.js';
import {
  lockAuthAuthorityMutationsWithTx,
  lockAuthPrincipalsWithTx,
} from '../../../src/database/authPrincipalLock.js';
import {
  authAccounts,
  authIdentityEvents,
  authKv,
  authSubjectRevocationFences,
  users,
} from '../../../src/database/schema/index.js';
import { hashAuthSubject } from '../../../src/security/authSubjectRevocation.js';
import {
  closeTestDb,
  getTestAdminDb,
  getTestDb,
  isDatabaseAvailable,
} from './test-db-helpers.js';

const APP_URL = process.env.DOLLHOUSE_TEST_DATABASE_URL
  ?? 'postgres://dollhouse_app:dollhouse_app@localhost:5432/dollhousemcp_test';
const ADMIN_URL = process.env.DOLLHOUSE_TEST_DATABASE_ADMIN_URL
  ?? 'postgres://dollhouse:dollhouse@localhost:5432/dollhousemcp_test';
const SUBJECT = 'oidc_revocation-integration-user';

let dbAvailable = false;

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
});

afterEach(async () => {
  if (!dbAvailable) return;
  const db = getTestAdminDb();
  await db.delete(authKv).where(and(eq(authKv.model, 'Grant'), eq(authKv.id, 'late-grant')));
  await db.delete(authSubjectRevocationFences)
    .where(eq(authSubjectRevocationFences.subjectHash, hashAuthSubject(SUBJECT)));
  await db.delete(authIdentityEvents).where(eq(authIdentityEvents.sub, SUBJECT));
  await db.delete(authAccounts).where(eq(authAccounts.sub, SUBJECT));
  await db.delete(users).where(eq(users.username, SUBJECT));
});

afterAll(async () => {
  await closeTestDb();
});

describe('UserIdentityService live authorization', () => {
  it('invalidates issued claims after an authz mutation', async () => {
    if (!dbAvailable) return;
    const service = new UserIdentityService({
      db: getTestDb(),
      appConnectionUrl: APP_URL,
      adminConnectionUrl: ADMIN_URL,
      ssl: 'disable',
      authProvider: 'oidc',
    });
    const userId = await service.resolveUserForSub(SUBJECT, 'Revocation Test');
    const initialClaims = { sub: SUBJECT, iat: 1 };
    await expect(service.validateCurrentClaims(initialClaims)).resolves.toEqual({ ok: true });
    expect(initialClaims).toMatchObject({ userId });

    const changedAt = new Date();
    await getTestAdminDb().update(users).set({
      authzVersion: 2,
      authzChangedAt: changedAt,
      updatedAt: changedAt,
    }).where(eq(users.id, userId));

    await expect(service.validateCurrentClaims({
      sub: SUBJECT,
      iat: Math.floor(changedAt.getTime() / 1000),
    })).resolves.toEqual({ ok: false, reason: 'token predates current account authorization' });
    await expect(service.validateCurrentClaims({
      sub: SUBJECT,
      iat: Math.floor(changedAt.getTime() / 1000) + 60,
    })).resolves.toEqual({ ok: false, reason: 'token predates current account authorization' });
    await expect(service.validateCurrentClaims({
      sub: SUBJECT,
      iat: Math.floor(changedAt.getTime() / 1000) + 61,
    })).resolves.toEqual({ ok: true });
  });

  it('uses embedded token authorization generations instead of replica clocks', async () => {
    if (!dbAvailable) return;
    await getTestAdminDb().insert(authAccounts).values({
      provider: 'embedded',
      externalSub: SUBJECT,
      sub: SUBJECT,
      displayName: 'Revocation Test',
    });
    const service = new UserIdentityService({
      db: getTestDb(),
      appConnectionUrl: APP_URL,
      adminConnectionUrl: ADMIN_URL,
      ssl: 'disable',
      authProvider: 'embedded',
    });
    const userId = await service.resolveUserForSub(SUBJECT, 'Revocation Test');
    const changedAt = new Date();
    await getTestAdminDb().update(users).set({
      authzVersion: 2,
      authzChangedAt: changedAt,
      updatedAt: changedAt,
    }).where(eq(users.id, userId));

    await expect(service.validateCurrentClaims({
      sub: SUBJECT,
      authzVersion: 1,
      iat: Math.floor(changedAt.getTime() / 1000) + 86_400,
    })).resolves.toEqual({ ok: false, reason: 'token predates current account authorization' });
    await expect(service.validateCurrentClaims({
      sub: SUBJECT,
      authzVersion: 2,
      iat: 1,
    })).resolves.toEqual({ ok: true });
    await expect(service.validateCurrentClaims({ sub: SUBJECT, iat: Number.MAX_SAFE_INTEGER }))
      .resolves.toEqual({ ok: false, reason: 'token predates current account authorization' });
  });

  it('does not silently recreate an administratively unlinked subject', async () => {
    if (!dbAvailable) return;
    const service = new UserIdentityService({
      db: getTestDb(),
      appConnectionUrl: APP_URL,
      adminConnectionUrl: ADMIN_URL,
      ssl: 'disable',
      authProvider: 'oidc',
    });
    await service.resolveUserForSub(SUBJECT, 'Revocation Test');
    const revokedAt = new Date();
    await getTestAdminDb().update(authAccounts).set({ userId: null, updatedAt: revokedAt })
      .where(eq(authAccounts.sub, SUBJECT));
    await getTestAdminDb().insert(authSubjectRevocationFences).values({
      subjectHash: hashAuthSubject(SUBJECT),
      revokedAt,
      reason: 'identity_unlinked',
    });

    await expect(service.resolveUserForSub(SUBJECT)).rejects.toThrow('administratively revoked');
    await expect(service.validateCurrentClaims({ sub: SUBJECT, iat: Math.floor(Date.now() / 1000) }))
      .resolves.toEqual({ ok: false, reason: 'account identity is not authorized' });
  });

  it('blocks a late grant writer until disable commits and then rejects the write', async () => {
    if (!dbAvailable) return;
    const service = identityService();
    const userId = await service.resolveUserForSub(SUBJECT, 'Revocation Test');
    const storage = new PostgresAuthStorageLayer({ db: getTestAdminDb() });
    let releaseMutation!: () => void;
    let signalLocked!: () => void;
    const mutationLocked = new Promise<void>(resolve => { signalLocked = resolve; });
    const release = new Promise<void>(resolve => { releaseMutation = resolve; });

    const disable = getTestAdminDb().transaction(async tx => {
      await lockAuthAuthorityMutationsWithTx(tx);
      await lockAuthPrincipalsWithTx(tx, [SUBJECT]);
      await tx.update(users).set({
        disabledAt: new Date(),
        authzVersion: sql`${users.authzVersion} + 1`,
        authzChangedAt: new Date(),
      }).where(eq(users.id, userId));
      signalLocked();
      await release;
    });
    await mutationLocked;

    let writerSettled = false;
    const lateWriter = storage.genericSet('Grant', 'late-grant', { accountId: SUBJECT }, 60)
      .finally(() => { writerSettled = true; });
    await waitForAdvisoryLockWaiter();
    expect(writerSettled).toBe(false);

    releaseMutation();
    await disable;
    await expect(lateWriter).rejects.toThrow('auth principal is no longer active');
    await expect(getTestAdminDb().select({ id: authKv.id }).from(authKv).where(and(
      eq(authKv.model, 'Grant'),
      eq(authKv.id, 'late-grant'),
    ))).resolves.toEqual([]);
  });

  it('blocks late account and identity-event writes after account deletion', async () => {
    if (!dbAvailable) return;
    const storage = new PostgresAuthStorageLayer({ db: getTestAdminDb() });
    let releaseDeletion!: () => void;
    let signalLocked!: () => void;
    const deletionLocked = new Promise<void>(resolve => { signalLocked = resolve; });
    const release = new Promise<void>(resolve => { releaseDeletion = resolve; });

    const deletion = getTestAdminDb().transaction(async tx => {
      await lockAuthPrincipalsWithTx(tx, [SUBJECT]);
      await tx.insert(authSubjectRevocationFences).values({
        subjectHash: hashAuthSubject(SUBJECT),
        revokedAt: new Date(),
        reason: 'account_deleted',
      });
      signalLocked();
      await release;
    });
    await deletionLocked;

    let upsertSettled = false;
    const lateUpsert = storage.upsertAccount({
      sub: SUBJECT,
      provider: 'oidc',
      externalSub: SUBJECT,
      email: 'deleted@example.test',
      emailVerified: true,
      createdAt: 1,
      updatedAt: 2,
    }).finally(() => { upsertSettled = true; });
    await waitForAdvisoryLockWaiter();
    expect(upsertSettled).toBe(false);

    releaseDeletion();
    await deletion;
    await expect(lateUpsert).rejects.toThrow('auth subject belongs to a deleted account');
    await expect(storage.recordIdentityEvent({
      type: 'auth.oauth.token_issued',
      sub: SUBJECT,
      timestamp: Date.now(),
      details: { email: 'deleted@example.test' },
    })).rejects.toThrow('auth subject belongs to a deleted account');
    await expect(getTestAdminDb().select({ sub: authAccounts.sub }).from(authAccounts)
      .where(eq(authAccounts.sub, SUBJECT))).resolves.toEqual([]);
    await expect(getTestAdminDb().select({ sub: authIdentityEvents.sub }).from(authIdentityEvents)
      .where(eq(authIdentityEvents.sub, SUBJECT))).resolves.toEqual([]);
  });

  it('blocks identity resolution behind unlink and honors the committed subject fence', async () => {
    if (!dbAvailable) return;
    const service = identityService();
    await service.resolveUserForSub(SUBJECT, 'Revocation Test');
    let releaseMutation!: () => void;
    let signalLocked!: () => void;
    const mutationLocked = new Promise<void>(resolve => { signalLocked = resolve; });
    const release = new Promise<void>(resolve => { releaseMutation = resolve; });
    const revokedAt = new Date();

    const unlink = getTestAdminDb().transaction(async tx => {
      await lockAuthAuthorityMutationsWithTx(tx);
      await lockAuthPrincipalsWithTx(tx, [SUBJECT]);
      await tx.update(authAccounts).set({ userId: null, updatedAt: revokedAt })
        .where(eq(authAccounts.sub, SUBJECT));
      await tx.insert(authSubjectRevocationFences).values({
        subjectHash: hashAuthSubject(SUBJECT),
        revokedAt,
        reason: 'identity_unlinked',
      });
      signalLocked();
      await release;
    });
    await mutationLocked;

    let resolutionSettled = false;
    const resolution = service.resolveUserForSub(SUBJECT)
      .finally(() => { resolutionSettled = true; });
    await waitForAdvisoryLockWaiter();
    expect(resolutionSettled).toBe(false);

    releaseMutation();
    await unlink;
    await expect(resolution).rejects.toThrow('administratively revoked');
    await expect(getTestAdminDb().select({ userId: authAccounts.userId }).from(authAccounts)
      .where(eq(authAccounts.sub, SUBJECT))).resolves.toEqual([{ userId: null }]);
  });

  it('does not serialize an already-linked identity behind unrelated authority mutations', async () => {
    if (!dbAvailable) return;
    const service = identityService();
    const expectedUserId = await service.resolveUserForSub(SUBJECT, 'Revocation Test');
    let releaseMutation!: () => void;
    let signalLocked!: () => void;
    const mutationLocked = new Promise<void>(resolve => { signalLocked = resolve; });
    const release = new Promise<void>(resolve => { releaseMutation = resolve; });

    const unrelatedMutation = getTestAdminDb().transaction(async tx => {
      await lockAuthAuthorityMutationsWithTx(tx);
      signalLocked();
      await release;
    });
    await mutationLocked;

    try {
      await expect(Promise.race([
        service.resolveUserForSub(SUBJECT, 'Revocation Test'),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('linked identity waited on global authority lock')), 500);
        }),
      ])).resolves.toBe(expectedUserId);
    } finally {
      releaseMutation();
      await unrelatedMutation;
    }
  });
});

function identityService(): UserIdentityService {
  return new UserIdentityService({
    db: getTestDb(),
    appConnectionUrl: APP_URL,
    adminConnectionUrl: ADMIN_URL,
    ssl: 'disable',
    authProvider: 'oidc',
  });
}

async function waitForAdvisoryLockWaiter(): Promise<void> {
  const deadline = Date.now() + 2_000;
  do {
    const rows = await getTestDb().execute(sql`
      SELECT COUNT(*)::integer AS count
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND granted = false
    `) as unknown as Array<{ readonly count: number }>;
    if (Number(rows[0]?.count ?? 0) > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error('timed out waiting for a blocked PostgreSQL advisory-lock contender');
}
