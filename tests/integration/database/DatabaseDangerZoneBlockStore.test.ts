import { admissionPhases, pauseQueryResult, verifyAdmission, verifyBlockDrain, verifyResetStage } from '../../helpers/blockDrain.js';
import { conflictCases, verifyDeclinedWrite } from '../../helpers/blockConflicts.js';
import { firstUseCases, verifyConcurrentFirstUse, verifyFirstUse } from '../../helpers/blockFirstUse.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseDangerZoneBlockStore } from '../../../src/state/DatabaseDangerZoneBlockStore.js';
import { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';
import { dangerZoneBlocks, dangerZoneBlockEvidence } from '../../../src/database/schema/dangerZoneBlocks.js';
import { users } from '../../../src/database/schema/users.js';
import { adminAuditEvents } from '../../../src/database/schema/webConsole.js';
import { withSystemContext } from '../../../src/database/admin.js';
import { purgeUserScopedData } from '../../../src/database/userDataPurge.js';
import { withUserContext, withUserRead } from '../../../src/database/rls.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { getTestDb, getTestAdminDb, ensureTestUser, ensureTestUserB, closeTestDb } from './test-db-helpers.js';
import { PostgresRateLimitStore } from '../../../src/auth/embedded-as/storage/PostgresRateLimitStore.js';
import { PostgresAdminAuditWriter } from '../../../src/web-console/audit/PostgresAdminAuditWriter.js';
import { createSecurityAdminBlockRecoveryRoutes } from '../../../src/web-console/modules/security-admin/SecurityAdminBlockRecovery.js';
import { CONSOLE_ADMIN_STEPUP_ACR, type ConsoleRequest } from '../../../src/web-console/platform/ConsolePlatformTypes.js';
import { HmacConsoleOpaqueValueService } from '../../../src/web-console/security/ConsoleOpaqueValues.js';

let user: string;
let other: string;
const record = { reason: 'Review required', blockedAt: 'invalid date', verificationId: 'challenge' };
beforeAll(async () => { user = await ensureTestUser(); other = await ensureTestUserB(); });
afterEach(async () => {
  jest.restoreAllMocks();
  await getTestAdminDb().delete(dangerZoneBlocks);
  await getTestAdminDb().delete(dangerZoneBlockEvidence);
});
afterAll(closeTestDb);
function store(userId = user) { return new DatabaseDangerZoneBlockStore(getTestDb(), userId); }
it.each(firstUseCases)('loads database state on first %s', async operation => { await verifyFirstUse(store(), operation); });
it('joins concurrent first uses of database state', async () => { await verifyConcurrentFirstUse(store()); });
it.each(conflictCases)('reconciles a declined database write: %s', async scenario => {
  await verifyDeclinedWrite(store(), store(), scenario);
});
describe.each(['select', 'insert', 'delete'] as const)('database reset after %s', method => {
  it.each([1, 3])('persists %s arrivals', async count => {
    await verifyResetStage(store(), count, pause => {
      const db = getTestDb();
      const transaction = db.transaction.bind(db);
      jest.spyOn(db, 'transaction').mockImplementationOnce(callback => transaction(async tx => {
        const wrapped = new Proxy(tx, {
          get(target, key) {
            if (key !== method) return Reflect.get(target, key);
            return (...args: unknown[]) => pauseQueryResult(Reflect.apply(target[method], target, args), pause);
          },
        });
        return callback(wrapped);
      }));
    });
  });
});
describe.each(admissionPhases)('database admission during %s', phase => {
  it.each([[1, false], [3, false], [1, true], [3, true]] as const)('settles %s arrivals (failure: %s)', async (count, fail) => {
    await verifyAdmission(store(), phase, count, fail);
  });
});
async function seed(name: string, block: unknown = record, version = 1) {
  await withUserContext(getTestDb(), user, tx => tx.insert(dangerZoneBlocks).values({
    userId: user, agentName: name, block: sql`${JSON.stringify(block)}::jsonb`, version, blockedAt: new Date(0),
  }));
}
describe('database block state', () => {
  it('reports an unsupported row version and denies agents while unavailable', async () => {
    await withSystemContext(getTestAdminDb(), tx => tx.insert(dangerZoneBlocks).values({
      userId: user, agentName: 'future-version', block: record, version: 2, blockedAt: new Date(0),
    }));
    const backing = store();
    expect(await backing.load()).toEqual({ status: 'unsupportedVersion' });
    const enforcer = new DangerZoneEnforcer(backing);
    await enforcer.initialize();
    expect(await enforcer.check('unlisted')).toMatchObject({
      blocked: true, reason: 'Blocked-agent state is unavailable.',
    });
  });
  it('keeps replicas closed on rejected state and replays queued blocks after a database reset', async () => {
    await seed('future-version', record, 2);
    const first = new DangerZoneEnforcer(store());
    const second = new DangerZoneEnforcer(store());
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect((await first.check('other')).blocked).toBe(true);
      expect((await second.check('other')).blocked).toBe(true);
      expect(await first.block('first-queued', 'Queued review', [])).toBe(false);
      expect(await second.block('second-queued', 'Queued review', [])).toBe(false);

      clock.mockReturnValue(now + 1001);
      expect((await first.check('other')).blocked).toBe(true);
      expect((await second.check('other')).blocked).toBe(true);
      await store().reset();

      clock.mockReturnValue(now + 2002);
      expect((await first.check('other')).blocked).toBe(false);
      expect((await second.check('other')).blocked).toBe(false);
      expect((await second.check('first-queued')).blocked).toBe(true);
      expect((await first.check('second-queued')).blocked).toBe(true);
    } finally {
      await Promise.all([first.shutdown(), second.shutdown()]);
    }
  });
  it('resets only the selected rejected snapshot and rolls back if mandatory audit fails', async () => {
    await seed('invalid-version', record, 2);
    expect(await store(other).apply({ kind: 'put', name: 'bystander', block: record })).toBe(true);
    const recovery = new DatabaseDangerZoneBlockStore(getTestAdminDb(), user);
    const digest = await recovery.rejectedSnapshotDigest();
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    await seed('additional-block');
    const audit = jest.fn(async () => {});
    expect(await recovery.resetRejected(digest!, audit)).toBe(false);
    expect(audit).not.toHaveBeenCalled();

    const currentDigest = (await recovery.rejectedSnapshotDigest())!;
    await expect(recovery.resetRejected(currentDigest, async () => {
      throw new Error('Audit unavailable');
    })).rejects.toThrow('Audit unavailable');
    expect(await recovery.rejectedSnapshotDigest()).toBe(currentDigest);
    expect(await getTestAdminDb().select().from(dangerZoneBlockEvidence)).toEqual([]);

    const outcomes = await Promise.all([recovery.resetRejected(currentDigest, audit), recovery.resetRejected(currentDigest, audit)]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(await recovery.rejectedSnapshotDigest()).toBeNull();
    expect(await store(other).load()).toEqual({ status: 'loaded', value: { bystander: record } });
    const [evidence] = await getTestAdminDb().select().from(dangerZoneBlockEvidence);
    expect(evidence.userId).toBe(user);
    expect(evidence.snapshot).toEqual([
      expect.objectContaining({ agentName: 'additional-block', version: 1 }),
      expect.objectContaining({ agentName: 'invalid-version', version: 2 }),
    ]);
  });
  it('writes the confirmed hosted reset and its redacted audit event for the selected account', async () => {
    const database = getTestAdminDb();
    const adminId = randomUUID();
    const targetId = randomUUID();
    await database.insert(users).values([
      { id: adminId, username: `block-reset-admin-${adminId}` }, { id: targetId, username: `block-reset-target-${targetId}` },
    ]);
    await database.insert(dangerZoneBlocks).values({
      userId: targetId, agentName: 'invalid-version', version: 2, block: record, blockedAt: new Date(0),
    });
    await store(other).apply({ kind: 'put', name: 'bystander', block: record });
    const auditKeys = { resolve: async () => ({ keyId: 'block-recovery-test', key: Buffer.alloc(32, 1) }) };
    const now = new Date();
    const correlationId = randomUUID();
    const proof = '817341';
    const prove = jest.fn(async () => ({ ok: true as const, method: 'totp' as const, authTime: now }));
    const rateLimitStore = new PostgresRateLimitStore(database);
    const [preview, reset] = createSecurityAdminBlockRecoveryRoutes({
      database, auditKeys, auditWriter: new PostgresAdminAuditWriter(database, auditKeys), rateLimitStore,
      opaqueValues: new HmacConsoleOpaqueValueService(Buffer.alloc(32, 2)), totp: { prove }, now: () => now,
    });
    const req = {
      params: { user_id: targetId }, headers: {}, get: () => undefined,
      consoleContext: { correlationId, receivedAt: now },
      consoleAuthentication: {
        userId: adminId, authSub: 'admin-block-recovery', sessionIdHash: Buffer.alloc(32, 3),
        grantedCapabilities: ['console:admin:security'], authzVersion: 1,
        elevation: { acr: CONSOLE_ADMIN_STEPUP_ACR, amr: ['otp'], authTime: now,
          expiresAt: new Date(now.getTime() + 120_000), capabilities: ['console:admin:security'] },
      },
    } as unknown as ConsoleRequest;
    try {
      const reviewed = await preview.handler(req);
      expect(reviewed.status).toBe(200);
      const { approval_id, ...binding } = reviewed.body as { approval_id: string };
      req.headers['idempotency-key'] = approval_id;
      req.body = { ...binding, proof };
      expect(await reset.handler(req)).toEqual({ status: 204 });
      expect(prove).toHaveBeenCalledWith(adminId, proof);
      expect(await store(targetId).load()).toEqual({ status: 'loaded', value: {} });
      expect(await store(other).load()).toEqual({ status: 'loaded', value: { bystander: record } });
      const [event] = await database.select().from(adminAuditEvents).where(and(
        eq(adminAuditEvents.correlationId, correlationId), eq(adminAuditEvents.result, 'approved'),
      ));
      expect(event).toMatchObject({ actorUserId: adminId, targetUserId: targetId, argsRedacted: {} });
      expect(JSON.stringify(event)).not.toContain(proof);
    } finally {
      await rateLimitStore.reset('security.users.blocked_agents.reset', adminId);
    }
  });
  it('reports a declined block receipt and retains the stored challenge', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 1000);
    const enforcer = new DangerZoneEnforcer(store());
    await enforcer.block('agent', 'Current review', [], 'current-code');
    clock.mockReturnValue(now);
    const events = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    expect(await enforcer.block('agent', 'Earlier review', [], 'earlier-code')).toBe(false);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'HIGH', details: 'Agent block was not confirmed',
      additionalData: { agentName: 'agent', verificationId: 'earlier-code', reason: 'declined' },
    }));
    expect(await enforcer.check('agent')).toMatchObject({ blocked: true, verificationId: 'current-code' });
  });
  it('shares blocks across independent owners and releases only the matching event', async () => {
    const first = new DangerZoneEnforcer(store()), second = new DangerZoneEnforcer(store());
    await Promise.all([first.initialize(), second.initialize()]);
    await Promise.all([
      first.block('a', 'Review required', [], 'a-code', undefined, 'session-a'),
      second.block('b', 'Review required', [], 'b-code', undefined, 'session-b'),
    ]);
    expect((await second.check('a')).verificationId).toBe('a-code');
    expect((await first.check('b')).verificationId).toBe('b-code');
    expect(await second.unblock('a', 'a-code', 'session-b')).toBe(false);
    expect(await first.unblock('a', 'a-code', 'session-a')).toBe(true);
    expect((await second.check('b')).blocked).toBe(true);
    const restored = new DangerZoneEnforcer(store());
    await restored.initialize();
    expect((await restored.check('b')).verificationId).toBe('b-code');
    expect((await restored.check('a')).blocked).toBe(false);
  });
  it('reconciles a healthy database refresh before releasing a block', async () => {
    const backing = store();
    const enforcer = new DangerZoneEnforcer(backing);
    await enforcer.initialize();
    await enforcer.block('agent', 'Review required', [], 'code');
    const originalLoad = backing.load.bind(backing);
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    jest.spyOn(backing, 'load').mockImplementationOnce(async () => { await held; return originalLoad(); });
    const checking = enforcer.check('other');
    const releasing = enforcer.unblock('agent', 'code');
    finish();
    await checking;
    expect(await releasing).toBe(true);
    expect((await enforcer.check('agent')).blocked).toBe(false);
  });
  it('recovers a transient database read without resetting stored blocks', async () => {
    await seed('agent');
    const backing = store();
    const enforcer = new DangerZoneEnforcer(backing);
    await enforcer.initialize();
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    jest.spyOn(getTestDb(), 'transaction').mockRejectedValueOnce(new Error('temporary storage failure'));
    expect((await enforcer.check('other')).blocked).toBe(true);
    clock.mockReturnValue(now + 1001);
    expect((await enforcer.check('other')).blocked).toBe(false);
    expect((await enforcer.check('agent')).verificationId).toBe('challenge');
  });
  it('preserves an invalid row when another block is saved', async () => {
    const raw = { reason: 42, diagnostic: ['retained'] };
    await seed('damaged', raw);
    const enforcer = new DangerZoneEnforcer(store());
    await enforcer.initialize();
    await enforcer.block('healthy', 'Review required', []);
    const loaded = await store().load();
    expect(loaded.status === 'loaded' && loaded.value.damaged).toEqual(raw);
    expect(await enforcer.unblock('damaged')).toBe(false);
  });
  it('enforces user-scoped rows and evidence with the application role', async () => {
    const role = await getTestDb().execute(sql`select current_user as role`);
    expect(role[0].role).toBe('dollhouse_app');
    await seed('agent');
    expect(await store(other).load()).toEqual({ status: 'loaded', value: {} });
    expect(await getTestDb().select().from(dangerZoneBlocks)).toEqual([]);
    await expect(withUserContext(getTestDb(), other, tx => tx.insert(dangerZoneBlocks).values({
      userId: user, agentName: 'wrong-owner', block: record, blockedAt: new Date(),
    }))).rejects.toThrow();
    await store().reset();
    expect(await withUserRead(getTestDb(), other, tx => tx.select().from(dangerZoneBlockEvidence))).toEqual([]);
    const evidence = await withUserRead(getTestDb(), user, tx => tx.select().from(dangerZoneBlockEvidence));
    expect(evidence).toHaveLength(1);
    await withUserContext(getTestDb(), user, tx => tx.delete(dangerZoneBlockEvidence));
    expect(await withUserRead(getTestDb(), user, tx => tx.select().from(dangerZoneBlockEvidence))).toHaveLength(1);
  });
  it('keeps state unavailable after query failures and suppresses writes', async () => {
    const backing = store();
    const failure = jest.spyOn(getTestDb(), 'transaction').mockRejectedValue(new Error('query unavailable'));
    const enforcer = new DangerZoneEnforcer(backing);
    await enforcer.initialize();
    expect((await enforcer.check('agent')).blocked).toBe(true);
    const apply = jest.spyOn(backing, 'apply');
    await enforcer.block('agent', 'Review required', [], 'challenge');
    expect(await enforcer.unblock('agent', 'challenge')).toBe(false);
    enforcer.setAdminToken('admin');
    expect(await enforcer.clearAll('admin')).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    failure.mockRestore();
    await enforcer.initialize();
    await enforcer.flush();
    expect((await enforcer.check('agent')).verificationId).toBe('challenge');
  });
  it.each(['bad/key', 'duplicate', 'version'])('requires a fully validated snapshot: %s', async kind => {
    await seed('a');
    await seed(kind === 'duplicate' ? ' a ' : kind, record, kind === 'version' ? 2 : 1);
    const events = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    const enforcer = new DangerZoneEnforcer(store());
    await enforcer.initialize();
    expect((await enforcer.check('unlisted')).blocked).toBe(true);
    expect((await enforcer.getBlockedAgents())).toEqual([]);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ severity: 'HIGH' }));
    expect(await getTestAdminDb().select().from(dangerZoneBlocks)).toHaveLength(2);
  });
  it('restores valid legacy rows and reserves invalid records', async () => {
    await seed('valid');
    await seed('placeholder', null);
    await seed('typed', { ...record, sessionId: 42 });
    const enforcer = new DangerZoneEnforcer(store());
    await enforcer.initialize();
    expect(await enforcer.check('valid')).toMatchObject({ eventId: 'challenge', blockedAt: new Date(0).toISOString() });
    expect((await enforcer.check('placeholder')).blocked).toBe(true);
    expect(await enforcer.unblock('placeholder')).toBe(false);
    expect(await enforcer.unblock('typed', 'challenge')).toBe(false);
  });
  it('holds calls during load and publishes newer local blocks afterward', async () => {
    await seed('agent');
    const backing = store();
    const original = backing.load.bind(backing);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    jest.spyOn(backing, 'load').mockImplementationOnce(async () => { await pending; return original(); });
    const enforcer = new DangerZoneEnforcer(backing);
    const loading = enforcer.initialize();
    const checking = enforcer.check('agent');
    const blocking = enforcer.block('agent', 'New review', [], 'new-code');
    release();
    await loading;
    expect(await checking).toMatchObject({ blocked: true, verificationId: 'new-code' });
    expect(await blocking).toBe(true);
    await enforcer.flush();
    expect((await enforcer.check('agent')).verificationId).toBe('new-code');
  });
  it('preserves reset evidence and reloads repaired state completely', async () => {
    await seed('agent', record, 2);
    const enforcer = new DangerZoneEnforcer(store());
    await enforcer.initialize();
    expect(await enforcer.unblock('agent', 'challenge')).toBe(false);
    enforcer.setAdminToken('admin');
    expect(await enforcer.clearAll('admin')).toBe(true);
    expect((await enforcer.check('agent')).blocked).toBe(false);
    const evidence = await withUserRead(getTestDb(), user, tx => tx.select().from(dangerZoneBlockEvidence));
    expect(evidence[0].snapshot).toEqual([expect.objectContaining({ agentName: 'agent', version: 2, block: record })]);
    await seed('agent', record, 2);
    await enforcer.initialize();
    await withUserContext(getTestDb(), user, tx => tx.update(dangerZoneBlocks).set({ version: 1 }).where(eq(dangerZoneBlocks.agentName, 'agent')));
    expect((await enforcer.check('agent')).verificationId).toBeUndefined();
    await enforcer.initialize();
    expect((await enforcer.check('agent')).verificationId).toBe('challenge');
  });
  it('keeps a replacement block when a release observes an older event', async () => {
    const backing = store();
    await backing.apply({ kind: 'put', name: 'agent', block: { ...record, eventId: 'new', blockedAt: new Date().toISOString() } });
    expect(await backing.apply({ kind: 'remove', name: 'agent', eventId: 'old' })).toBe(false);
    expect(await backing.load()).toMatchObject({ status: 'loaded', value: { agent: { eventId: 'new' } } });
  });
  it('erases block state and evidence with the owning account data', async () => {
    await seed('evidence');
    await store().reset();
    await seed('current');
    await store(other).apply({ kind: 'put', name: 'other', block: { ...record, blockedAt: new Date().toISOString() } });
    await withSystemContext(getTestAdminDb(), tx => purgeUserScopedData(tx, user));
    expect(await store().load()).toEqual({ status: 'loaded', value: {} });
    expect(await withUserRead(getTestDb(), user, tx => tx.select().from(dangerZoneBlockEvidence))).toEqual([]);
    expect(await store(other).load()).toMatchObject({ status: 'loaded', value: { other: { reason: 'Review required' } } });
  });

});

it.each([false, true])('settles successive pending block writes (failure: %s)', async fail => {
    await verifyBlockDrain(store(), fail);
});

it.each([false, true])('settles initial-load pending writes (failure: %s)', async fail => {
  await verifyBlockDrain(store(), fail, 'initial');
});
