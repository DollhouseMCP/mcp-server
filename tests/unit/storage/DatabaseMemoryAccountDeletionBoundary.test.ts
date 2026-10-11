import { describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import { DatabaseMemoryAccountDeletionBoundary } from '../../../src/storage/DatabaseMemoryAccountDeletionBoundary.js';
import { DATABASE_MEMORY_LEGACY_PROFILE } from '../../../src/storage/DatabaseMemoryLegacyMutationGuard.js';
import { PostgresConsoleAccountAdminStore, deleteConsolePrincipalWithTx } from '../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js';
import { PostgresAccountAdminMutationTransactionRunner } from '../../../src/web-console/modules/account-admin/AccountAdminMutationTransaction.js';
import { AccountAdminDeletionService } from '../../../src/web-console/modules/account-admin/AccountAdminDeletionService.js';
import {
  createAccountAdminModule, InMemoryAccountAdminMutationTransactionRunner, InMemoryConsoleAccountAdminStore,
  InMemoryConsoleAccountAllowlistStore, InMemoryConsoleSessionStore, InMemoryConsoleSecurityInvalidationStore,
  InMemoryAdminAuditWriter, InMemoryUserIntegrationStore, InMemoryRuntimeSessionControlStore,
  type ConsoleRequest,
} from '../../../src/web-console/index.js';
const USER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-08T00:00:00Z');
const legacy = { protocol_version: 1, profile: DATABASE_MEMORY_LEGACY_PROFILE, mode: 'legacy', generation: '1' };
function database(rows: unknown[] = [legacy]) {
  let active = false;
  const calls: string[] = [];
  const execute = jest.fn(async (query: SQL) => {
    const text = new PgDialect().sqlToQuery(query).sql; calls.push(text);
    if (text.includes('AS "canBypassRls"')) return [{ currentUser: 'system', canBypassRls: true }];
    if (text.includes('memory_backend_modes')) return rows;
    return [];
  });
  const tx = { execute } as unknown as DrizzleTx;
  const transaction = jest.fn(async (body: (tx: DrizzleTx) => Promise<unknown>) => {
    if (active) throw new Error('Unexpected nested acquisition with pool size one');
    active = true; try { return await body(tx); } finally { active = false; }
  });
  const db = { transaction } as unknown as DatabaseInstance;
  return { db, tx, execute, transaction, calls, isActive: () => active };
}
function fixture(rows?: unknown[]) {
  const d = database(rows); const boundary = new DatabaseMemoryAccountDeletionBoundary(d.db);
  const store = Object.assign(new InMemoryConsoleAccountAdminStore([{
    userId: USER, primarySub: 'local_target', username: 'target', displayName: 'Target', email: null,
    emailVerified: false, authMethods: ['local-password'], roles: ['operator'], disabledAt: null,
    createdAt: NOW, lastLoginAt: null, adminFactorEnrolled: false, accountCorrelationId: USER, authzVersion: 1,
  }]), { requireMemoryDeletionBoundary: (value: DatabaseMemoryAccountDeletionBoundary) => {
    if (value !== boundary) throw new Error('Wrong store boundary');
  } });
  const allowlist = new InMemoryConsoleAccountAllowlistStore(); const audit = new InMemoryAdminAuditWriter();
  const runner = Object.assign(new InMemoryAccountAdminMutationTransactionRunner({ accountAdminStore: store,
    accountAllowlistStore: allowlist, securityInvalidationStore: new InMemoryConsoleSecurityInvalidationStore(), adminAuditWriter: audit }),
  { requireMemoryDeletionBoundary: (value: DatabaseMemoryAccountDeletionBoundary) => {
    if (value !== boundary) throw new Error('Wrong runner boundary');
  } });
  const sessions = new InMemoryConsoleSessionStore(); const revoke = jest.spyOn(sessions, 'revokeForUser');
  const integration = new InMemoryUserIntegrationStore(); const blocking = jest.spyOn(integration, 'hasBlockingCredentialMaterial');
  const abandon = jest.spyOn(integration, 'abandonCredentialCleanupForUser');
  const runtime = new InMemoryRuntimeSessionControlStore(); const presence = jest.spyOn(runtime, 'listPresenceByUser');
  const oauth = { revokePrincipalGrants: jest.fn(async (input: { userId: string; revokedAt: Date }) => {
    expect(d.isActive()).toBe(false);
    return { userId: input.userId, revokedAt: input.revokedAt, linkedSubjectsProcessed: 0,
      oauthGrantFamiliesDiscovered: 0, oauthGrantFamiliesRevoked: 0, subjects: [] };
  }) };
  const remove = jest.spyOn(store, 'deletePrincipal');
  const module = createAccountAdminModule({ memoryDeletionBoundary: boundary, accountAdminStore: store,
    accountAllowlistStore: allowlist, sessionStore: sessions, oauthGrantRevocationService: oauth,
    runtimeSessionControlStore: runtime, integrationStore: integration, accountAdminMutationTransactionRunner: runner, now: () => NOW });
  const route = module.routes.find(route => route.method === 'DELETE' && route.path.endsWith('/users/:user_id'))!;
  const req = { params: { user_id: USER }, query: {}, body: { integration_credential_cleanup_override: 'abandon_unrevoked_provider_credentials' },
    get: () => undefined, ip: '127.0.0.1', consoleContext: { correlationId: ADMIN, receivedAt: NOW }, consoleAuthentication: {
      userId: ADMIN, authSub: 'local_admin', authzVersion: 1, sessionIdHash: Buffer.alloc(32),
      grantedCapabilities: ['console:admin:accounts'], elevation: null,
    } } as unknown as ConsoleRequest;
  return { ...d, boundary, store, runner, audit, sessions, integration, oauth, revoke, blocking, abandon, presence, remove, route, req };
}
describe('dormant account cascade refusal', () => {
  it.each([
    ['missing', []], ['guarded', [{ ...legacy, mode: 'guarded' }]], ['read-only', [{ ...legacy, mode: 'read_only' }]],
    ['unsupported', [{ ...legacy, protocol_version: 2 }]], ['wrong-profile', [{ ...legacy, profile: 'other' }]],
    ['malformed-generation', [{ ...legacy, generation: 'NaN' }]],
  ])('refuses %s before integration or authentication mutation', async (_name, rows) => {
    const f = fixture(rows); f.blocking.mockResolvedValue(true);
    await expect(f.route.handler(f.req)).resolves.toMatchObject({ status: 409, body: { code: 'memory_deletion_unavailable' } });
    expect(f.blocking).not.toHaveBeenCalled(); expect(f.abandon).not.toHaveBeenCalled(); expect(f.revoke).not.toHaveBeenCalled();
    expect(f.oauth.revokePrincipalGrants).not.toHaveBeenCalled(); expect(f.presence).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
    expect(await f.store.findPrincipal(USER)).not.toBeNull();
    expect(f.audit.getEvents()).toEqual([expect.objectContaining({ result: 'rejected', errorCode: 'memory_deletion_unavailable' })]);
  });
  it('finishes released legacy inspection before ordinary revocations and preserves deletion order', async () => {
    const f = fixture();
    await expect(f.route.handler(f.req)).resolves.toMatchObject({ status: 200, body: { outcome: 'deleted' } });
    expect(f.revoke).toHaveBeenCalledTimes(1); expect(f.oauth.revokePrincipalGrants).toHaveBeenCalledTimes(1);
    expect(f.presence).toHaveBeenCalledTimes(1); expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.revoke.mock.invocationCallOrder[0]).toBeLessThan(f.oauth.revokePrincipalGrants.mock.invocationCallOrder[0]);
    expect(f.oauth.revokePrincipalGrants.mock.invocationCallOrder[0]).toBeLessThan(f.presence.mock.invocationCallOrder[0]);
    expect(f.presence.mock.invocationCallOrder[0]).toBeLessThan(f.remove.mock.invocationCallOrder[0]);
    expect(f.isActive()).toBe(false);
  });
  it.each([null, undefined, new Error('private query failure')])('preserves original check cause even when denial audit fails: %p', async cause => {
    const f = fixture(); f.transaction.mockRejectedValueOnce(cause);
    jest.spyOn(f.runner, 'run').mockRejectedValueOnce(new Error('audit unavailable'));
    const outcome = await Promise.resolve(f.route.handler(f.req)).then(() => ({ resolved: true }), error => ({ error }));
    expect(outcome).toEqual({ error: cause }); expect(f.revoke).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });
  it('guards the internal direct helper before user locks or either purge branch', async () => {
    const d = database([]); const boundary = new DatabaseMemoryAccountDeletionBoundary(d.db);
    await expect(deleteConsolePrincipalWithTx(d.tx, { userId: USER, deletedByUserId: ADMIN, deletedAt: NOW }, boundary))
      .rejects.toMatchObject({ code: 'EMEMORYLEGACYDENIED' });
    expect(d.execute).toHaveBeenCalledTimes(1); expect(d.calls[0]).toContain('FOR SHARE');
  });
  it('rejects different DB objects and different/missing protected component boundaries', () => {
    const f = fixture(); const other = new DatabaseMemoryAccountDeletionBoundary(database().db);
    expect(() => new PostgresConsoleAccountAdminStore(f.db, other)).toThrow('original database');
    expect(() => new PostgresAccountAdminMutationTransactionRunner({ db: f.db, memoryDeletionBoundary: other,
      hmacKeyResolver: { resolve: async () => ({ keyId: 'test', key: Buffer.alloc(32) }) } })).toThrow('original database');
    const options = { accountAdminStore: f.store, transactionRunner: f.runner, sessionStore: f.sessions,
      oauthGrantRevocationService: f.oauth, memoryDeletionBoundary: other };
    expect(() => new AccountAdminDeletionService(options)).toThrow('Wrong store boundary');
    expect(() => new AccountAdminDeletionService({ ...options, memoryDeletionBoundary: f.boundary,
      transactionRunner: { run: f.runner.run.bind(f.runner) } })).toThrow('matching store and transaction runner');
    const pgStore = new PostgresConsoleAccountAdminStore(f.db, f.boundary);
    const pgRunner = new PostgresAccountAdminMutationTransactionRunner({ db: f.db, memoryDeletionBoundary: f.boundary,
      hmacKeyResolver: { resolve: async () => ({ keyId: 'test', key: Buffer.alloc(32) }) } });
    expect(() => pgStore.requireMemoryDeletionBoundary(other)).toThrow('same memory deletion boundary');
    expect(() => pgRunner.requireMemoryDeletionBoundary(other)).toThrow('same memory deletion boundary');
  });
});
