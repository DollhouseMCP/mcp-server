/** Required disposable PostgreSQL proof; not live activation or hot promotion. */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../../src/database/schema/index.js';
import { withSystemContext } from '../../../src/database/admin.js';
import { DatabaseMemoryAccountDeletionBoundary } from '../../../src/storage/DatabaseMemoryAccountDeletionBoundary.js';
import { DATABASE_MEMORY_LEGACY_PROFILE as legacyProfile } from '../../../src/storage/DatabaseMemoryLegacyMutationGuard.js';
import { DATABASE_MEMORY_ADMISSION_PROFILE as protectedProfile } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import { PostgresConsoleAccountAdminStore, deleteConsolePrincipalWithTx } from '../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js';
import { PostgresAccountAdminMutationTransactionRunner } from '../../../src/web-console/modules/account-admin/AccountAdminMutationTransaction.js';
import { PostgresConsoleSessionStore } from '../../../src/web-console/stores/PostgresConsoleSessionStore.js';
import { ConsoleOAuthGrantRevocationService } from '../../../src/web-console/services/oauth/ConsoleOAuthGrantRevocationService.js';
import { PostgresConsoleOAuthSubjectResolver } from '../../../src/web-console/services/oauth/PostgresConsoleOAuthSubjectResolver.js';
import { PostgresAuthStorageLayer } from '../../../src/auth/embedded-as/storage/PostgresAuthStorageLayer.js';
import { PostgresRuntimeSessionControlStore } from '../../../src/web-console/services/runtime/PostgresRuntimeSessionControlStore.js';
import { createAccountAdminModule, InMemoryConsoleAccountAllowlistStore, type ConsoleRequest } from '../../../src/web-console/index.js';
import { makeEquivalentFixture, type EquivalentFixture } from './fixtures/2905-equivalent-reconciliation-fixture.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
const owned: { fixture: EquivalentFixture; name: string }[] = [];
const now = new Date('2026-10-08T00:00:00Z');
function phase(name: string, value: string) { console.info(`[db-account-refusal:${name}] ${value}`); }
afterEach(async () => {
  jest.restoreAllMocks();
  for (const { fixture: f, name } of owned.splice(0)) {
    phase(name, 'cleanup-start'); await f.cleanup(); phase(name, 'cleanup-end');
  }
});
async function fixture(name: string) {
  phase(name, 'fixture-start'); const f = await makeEquivalentFixture(); owned.push({ fixture: f, name });
  // The fixture maintenance connection has max:1. No held early transaction may nest a revocation transaction.
  const db = drizzle(f.maintenance, { schema });
  const boundary = new DatabaseMemoryAccountDeletionBoundary(db);
  const store = new PostgresConsoleAccountAdminStore(db, boundary);
  const runner = new PostgresAccountAdminMutationTransactionRunner({ db, memoryDeletionBoundary: boundary,
    hmacKeyResolver: { resolve: async () => ({ keyId: 'fixture', key: Buffer.alloc(32, 1) }) } });
  const sessions = new PostgresConsoleSessionStore(db);
  const auth = new PostgresAuthStorageLayer({ db });
  const oauth = new ConsoleOAuthGrantRevocationService(new PostgresConsoleOAuthSubjectResolver(db), auth);
  const runtime = new PostgresRuntimeSessionControlStore(db);
  const module = createAccountAdminModule({ memoryDeletionBoundary: boundary, accountAdminStore: store,
    accountAllowlistStore: new InMemoryConsoleAccountAllowlistStore(), sessionStore: sessions,
    oauthGrantRevocationService: oauth, runtimeSessionControlStore: runtime,
    accountAdminMutationTransactionRunner: runner, now: () => now });
  const route = module.routes.find(value => value.method === 'DELETE' && value.path.endsWith('/users/:user_id'))!;
  const req = { params: { user_id: f.userId }, query: {}, body: {}, get: () => undefined, ip: '127.0.0.1',
    consoleContext: { correlationId: f.foreignUserId, receivedAt: now }, consoleAuthentication: {
      userId: f.foreignUserId, authSub: 'local_fixture_admin', authzVersion: 1, sessionIdHash: Buffer.alloc(32),
      grantedCapabilities: ['console:admin:accounts'], elevation: null,
    } } as unknown as ConsoleRequest;
  const input = { userId: f.userId, deletedByUserId: f.foreignUserId, deletedAt: now };
  const sub = `local_${f.userId}`;
  await f.maintenance`INSERT INTO public.auth_accounts(provider,external_sub,sub,user_id)
    VALUES ('local',${f.userId},${sub},${f.userId}::uuid)`;
  await sessions.create({ idHash: Buffer.alloc(32, 2), csrfTokenHash: Buffer.alloc(32, 3), userId: f.userId,
    authSub: sub, grantedCapabilities: ['console:self'], elevation: null, createdAt: now, lastUsedAt: now,
    idleExpiresAt: new Date(now.getTime()+60000), absoluteExpiresAt: new Date(now.getTime()+120000),
    revokedAt: null, lastIp: null, userAgent: null });
  await auth.genericSet('Grant', 'fixture-grant', { accountId: sub });
  await f.maintenance`INSERT INTO public.memory_volumes(user_id,memory_id,volume,raw_content,sha256,entry_count,sealed_at)
    VALUES (${f.userId}::uuid,${f.memoryId}::uuid,1,'fixture archive',${'a'.repeat(64)},0,${now.toISOString()}::timestamptz)`;
  const seed = (mode = 'legacy', profile = legacyProfile) => f.maintenance`INSERT INTO public.memory_backend_modes
    (user_id,backend,protocol_version,profile,mode,generation) VALUES (${f.userId}::uuid,'database',1,${profile},${mode},1)`;
  const accountSnapshot = async () => {
    const [row] = await f.maintenance<{ principal: string | null; identities: string | null; sessions: string | null; credentials: string | null }[]>`SELECT
      (SELECT to_jsonb(u)::text FROM public.users u WHERE id=${f.userId}::uuid) AS principal,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY sub)::text FROM public.auth_accounts a WHERE user_id=${f.userId}::uuid) AS identities,
      (SELECT jsonb_agg(to_jsonb(s) ORDER BY id_hash)::text FROM public.console_sessions s WHERE user_id=${f.userId}::uuid) AS sessions,
      (SELECT jsonb_agg(to_jsonb(k) ORDER BY model,id)::text FROM public.auth_kv k) AS credentials`;
    return { ...row, memory: await f.snapshot() };
  };
  phase(name, 'fixture-end'); return { ...f, db, boundary, store, runner, sessions, auth, oauth, runtime, route, req, input, seed, accountSnapshot };
}
required('required PostgreSQL account-cascade refusal', () => {
  it('refuses missing and protected modes before real revocations and preserves all account and memory state', async () => {
    const f = await fixture('protected-service'); const before = await f.accountSnapshot();
    const revoke = jest.spyOn(f.sessions, 'revokeForUser');
    const grants = jest.spyOn(f.oauth, 'revokePrincipalGrants');
    const runtime = jest.spyOn(f.runtime, 'listPresenceByUser');
    for (const mode of ['missing', 'guarded', 'read_only']) {
      if (mode === 'guarded') await f.seed(mode, protectedProfile);
      if (mode === 'read_only') await f.maintenance`UPDATE public.memory_backend_modes SET mode='read_only' WHERE user_id=${f.userId}::uuid`;
      expect(await f.route.handler(f.req)).toMatchObject({ status: 409, body: { code: 'memory_deletion_unavailable' } });
      expect(await f.accountSnapshot()).toEqual(before);
    }
    expect(revoke).not.toHaveBeenCalled(); expect(grants).not.toHaveBeenCalled(); expect(runtime).not.toHaveBeenCalled();
    const [counts] = await f.maintenance`SELECT count(*)::int AS rejected,
      count(*) FILTER (WHERE result='approved')::int AS approved FROM public.admin_audit_events`;
    expect(counts).toEqual({ rejected: 3, approved: 0 });
    phase('protected-service', 'assertions-complete');
  });
  it.each(['deleted', 'anonymized'] as const)('preserves real legacy %s and independent revocations with pool size one', async outcome => {
    const name = `legacy-${outcome}`; const f = await fixture(name); await f.seed();
    if (outcome === 'anonymized') await f.maintenance`INSERT INTO public.user_admin_roles(user_id,role,granted_by_user_id)
      VALUES (${f.foreignUserId}::uuid,'operator',${f.userId}::uuid)`;
    const revoke = jest.spyOn(f.sessions, 'revokeForUser');
    const grants = jest.spyOn(f.oauth, 'revokePrincipalGrants');
    const runtime = jest.spyOn(f.runtime, 'listPresenceByUser');
    expect(await f.route.handler(f.req)).toMatchObject({ status: 200, body: { outcome } });
    expect(revoke).toHaveBeenCalledTimes(1); expect(grants).toHaveBeenCalledTimes(1); expect(runtime).toHaveBeenCalledTimes(1);
    expect(revoke.mock.invocationCallOrder[0]).toBeLessThan(grants.mock.invocationCallOrder[0]);
    expect(grants.mock.invocationCallOrder[0]).toBeLessThan(runtime.mock.invocationCallOrder[0]);
    const after = await f.accountSnapshot();
    expect(after.identities).toBeNull(); expect(after.credentials).toBeNull();
    expect(after.memory.parent).toBeNull(); expect(JSON.parse(after.memory.entries)).toEqual([]);
    expect(JSON.parse(after.memory.tags)).toEqual([]); expect(JSON.parse(after.memory.volumes)).toEqual([]);
    if (outcome === 'deleted') expect(after.principal).toBeNull();
    else expect(JSON.parse(after.principal!)).toMatchObject({ username: `deleted-${f.userId}`, email: null, deleted_at: expect.any(String) });
    phase(name, 'assertions-complete');
  });
  it('protects actual store and transaction-runner deletion paths before either branch', async () => {
    const f = await fixture('direct-denial'); await f.seed('guarded', protectedProfile); const before = await f.accountSnapshot();
    await expect(f.store.deletePrincipal(f.input)).rejects.toMatchObject({ code: 'EMEMORYLEGACYDENIED' });
    await expect(f.runner.run(tx => tx.deletePrincipal(f.input))).rejects.toMatchObject({ code: 'EMEMORYLEGACYDENIED' });
    await f.maintenance`INSERT INTO public.user_admin_roles(user_id,role,granted_by_user_id)
      VALUES (${f.foreignUserId}::uuid,'operator',${f.userId}::uuid)`;
    await expect(f.store.deletePrincipal(f.input)).rejects.toMatchObject({ code: 'EMEMORYLEGACYDENIED' });
    await expect(f.runner.run(tx => tx.deletePrincipal(f.input))).rejects.toMatchObject({ code: 'EMEMORYLEGACYDENIED' });
    expect(await f.accountSnapshot()).toEqual(before);
    phase('direct-denial', 'assertions-complete');
  });
  it('holds the direct deletion transaction against promotion, without claiming a workflow hot barrier', async () => {
    const f = await fixture('direct-mode-lock'); await f.seed();
    let entered!: () => void; const entry = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const check = f.boundary.requireLegacyBeforeDelete.bind(f.boundary);
    jest.spyOn(f.boundary, 'requireLegacyBeforeDelete').mockImplementation(async (tx, target) => {
      await check(tx, target); entered(); await held;
    });
    const operation = f.store.deletePrincipal(f.input);
    let transition: PromiseLike<unknown> | undefined; let settled: PromiseSettledResult<unknown>[] = [];
    try {
      await Promise.race([entry, operation.then(() => { throw new Error('Deletion completed before held barrier'); })]);
      const [{ pid }] = await f.competitor`SELECT pg_backend_pid() AS pid`;
      transition = f.competitor`UPDATE public.memory_backend_modes SET mode='guarded',profile=${protectedProfile}
        WHERE user_id=${f.userId}::uuid`.execute();
      let blocked = false;
      // Query competitor itself would wait behind UPDATE; use the independent ordinary connection for observation.
      for (let attempt = 0; attempt < 1000; attempt++) {
        const [row] = await f.ordinary`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=${pid} AND NOT granted) AS blocked`;
        if (row.blocked) { blocked = true; break; }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(blocked).toBe(true);
    } finally { release(); settled = await Promise.allSettled([operation, ...(transition ? [transition] : [])]); }
    expect(settled.every(value => value.status === 'fulfilled')).toBe(true);
    expect((settled[0] as PromiseFulfilledResult<unknown>).value).toMatchObject({ outcome: 'deleted' });
    jest.restoreAllMocks();
    await expect(f.boundary.checkBeforeAuthMutation(f.userId)).rejects.toMatchObject({ code: 'EMEMORYLEGACYDENIED' });
    phase('direct-mode-lock', 'assertions-complete');
  });
  it('rolls back completed direct deletion on a known callback refusal', async () => {
    const f = await fixture('known-rollback'); await f.seed(); const before = await f.accountSnapshot(); const cause = new Error('Controlled rollback');
    await expect(withSystemContext(f.db, async tx => {
      expect(await deleteConsolePrincipalWithTx(tx, f.input, f.boundary)).toMatchObject({ outcome: 'deleted' });
      throw cause;
    })).rejects.toBe(cause);
    expect(await f.accountSnapshot()).toEqual(before);
    phase('known-rollback', 'assertions-complete');
  });
});
