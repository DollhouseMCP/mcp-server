import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Sql } from 'postgres';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import type { MemoryMaintenanceInvocation } from '../../../src/storage/DatabaseMemoryAtomicInvalidator.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const inspection = { status: 'equivalent', canApply: false, owner: { userId: USER, memoryId: OWNER }, name: 'Memory',
  revision: '7', dirty: true, rawUnits: 20, counts: { rawEntries: 0, childEntries: 0, volumes: 0 }, diagnostics: [], diagnosticsTruncated: false };
let current = { inspection, projectionSha256: 'a'.repeat(64) };
let commitFailure: Error | null = null;
let activeUser = USER;
let archive = false;
let roleSafe = true;
let releaseCommit: (() => void) | null = null;
let gateCommit: Promise<void> | null = null;
const statements: string[] = [];
class FakeRefusal extends Error { constructor(readonly reason: string) { super(reason); } }
const observe = jest.fn(async () => undefined);
const capture = jest.fn(async () => current);
const fresh = jest.fn(async () => current.inspection);
const refreshInspection = jest.fn(async (_tx: unknown, owner: { userId: string; memoryId: string }) => ({ ...await fresh(), owner }));
await jest.unstable_mockModule('../../../src/storage/DatabaseMemoryReconciliationInspector.js', () => ({
  DatabaseMemoryReconciliationInspector: class { captureEquivalentProjection = capture; inspect = fresh; inspectInTransaction = refreshInspection; },
}));
await jest.unstable_mockModule('../../../src/storage/DatabaseMemoryAtomicInvalidator.js', () => ({
  Refusal: FakeRefusal,
  captureRequest: (value: unknown) => value,
  observeCurrentMemoryMaintenance: observe,
  transaction: async (_connection: unknown, state: MemoryMaintenanceInvocation, body: (tx: unknown) => Promise<unknown>) => {
    state.callbackStarted = true;
    try {
      const result = await body(tx);
      if (gateCommit) await gateCommit;
      if (commitFailure) throw commitFailure;
      return result;
    } catch (cause) {
      if (cause instanceof FakeRefusal) state.acknowledgedAbort = true;
      throw cause;
    } finally { state.drained = true; state.settled = true; }
  },
}));
const { DatabaseMemoryEquivalentReconciler } = await import('../../../src/storage/DatabaseMemoryEquivalentReconciler.js');
const tx = { execute: async (statement: SQL) => {
  const text = new PgDialect().sqlToQuery(statement).sql;
  statements.push(text);
  if (text.includes('AS safe')) return [{ safe: true }];
  if (text.includes('FROM public.elements') && text.includes('AS present')) return [{ present: true }];
  if (text.includes('AS present')) return [{ present: archive }];
  if (text.includes('AS actor')) return [{ actor: 'ordinary', ordinary: roleSafe, tenant: true, origin: true, rls: true, rights: true }];
  if (text.includes('SELECT id::text')) return [{ id: OWNER }];
  if (text.includes('UPDATE public.elements')) return [{ revision: '8', dirty: false, name: 'Memory' }];
  return [];
} };
const db = { transaction: async (body: (value: typeof tx) => Promise<unknown>) => body(tx) } as unknown as DatabaseInstance;
const connection = { begin: () => undefined } as unknown as Sql;
const maintenance = { runId: RUN, candidateCommit: 'b'.repeat(40), expectedCatalogSha256: 'c'.repeat(64),
  maintenanceEvidenceSha256: 'd'.repeat(64), maintenanceEvidenceId: 'unit', declaredContextId: 'unit', databaseName: 'isolated', databaseOid: '42' };
function reconciler() { return new DatabaseMemoryEquivalentReconciler(db, () => activeUser, connection, 'ordinary'); }
beforeEach(() => {
  statements.length = 0; current = { inspection: { ...inspection }, projectionSha256: 'a'.repeat(64) };
  commitFailure = null; activeUser = USER; archive = false; roleSafe = true; releaseCommit = null; gateCommit = null;
  observe.mockClear(); capture.mockClear(); fresh.mockClear(); refreshInspection.mockClear();
});
describe('dormant equivalent reconciliation transaction boundaries (synthetic transaction adapter)', () => {
  it('prepares diagnostic exact-owner input without maintenance proof or writes', async () => {
    const result = await reconciler().prepareEquivalent({ userId: USER, memoryId: OWNER });
    expect(result.proposal).toMatchObject({ formatVersion: 1, locator: OWNER, revision: '7', dirty: true });
    expect(Object.isFrozen(result.proposal)).toBe(true); expect(observe).not.toHaveBeenCalled();
    expect(statements.some(value => value.includes('UPDATE'))).toBe(false);
  });
  it('publishes the final token only after known outer commit, while refusing concurrent apply', async () => {
    const owner = reconciler(), { proposal } = await owner.prepareEquivalent({ userId: USER, memoryId: OWNER });
    gateCommit = new Promise<void>(resolve => { releaseCommit = resolve; });
    const pending = owner.qualifyEquivalent(proposal!, maintenance);
    let settled = false; void pending.then(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(await owner.qualifyEquivalent(proposal!, maintenance)).toEqual({ status: 'unknown', attemptId: RUN });
    releaseCommit!();
    expect(await pending).toMatchObject({ status: 'qualified', token: { backend: 'database', ownerId: OWNER, revision: '8' } });
    const update = statements.find(value => value.includes('UPDATE public.elements'))!;
    expect(update).toContain('SET memory_entries_out_of_sync=false'); expect(update).not.toContain('updated_at');
  });
  it('preserves clean equivalent rows without UPDATE', async () => {
    current.inspection = { ...inspection, dirty: false };
    const owner = reconciler(), { proposal } = await owner.prepareEquivalent({ userId: USER, memoryId: OWNER });
    expect(await owner.qualifyEquivalent(proposal!, maintenance)).toMatchObject({ status: 'already-qualified', token: { revision: '7' } });
    expect(statements.some(value => value.includes('UPDATE public.elements'))).toBe(false);
  });
  it('uses acknowledged rollback for stale projection and emits no update/token', async () => {
    const owner = reconciler(), { proposal } = await owner.prepareEquivalent({ userId: USER, memoryId: OWNER });
    current = { ...current, projectionSha256: 'e'.repeat(64) };
    expect(await owner.qualifyEquivalent(proposal!, maintenance)).toEqual({ status: 'refused', reason: 'stale' });
    expect(statements.some(value => value.includes('UPDATE public.elements'))).toBe(false);
  });
  it.each(['archive', 'role'] as const)('refuses current %s before mutation', async condition => {
    const owner = reconciler(), { proposal } = await owner.prepareEquivalent({ userId: USER, memoryId: OWNER });
    if (condition === 'archive') archive = true; else roleSafe = false;
    expect(await owner.qualifyEquivalent(proposal!, maintenance)).toMatchObject({ status: 'refused', reason: condition === 'archive' ? 'archive-bearing' : 'application-context' });
    expect(statements.some(value => value.includes('UPDATE public.elements'))).toBe(false);
  });
  it('poisons apply after unknown commit until an explicit drained fresh diagnostic refresh', async () => {
    const owner = reconciler(), { proposal } = await owner.prepareEquivalent({ userId: USER, memoryId: OWNER });
    commitFailure = new Error('COMMIT transport uncertainty');
    expect(await owner.qualifyEquivalent(proposal!, maintenance)).toEqual({ status: 'unknown', attemptId: RUN });
    const count = observe.mock.calls.length;
    expect(await owner.qualifyEquivalent(proposal!, { ...maintenance, runId: OWNER })).toEqual({ status: 'unknown', attemptId: RUN });
    expect(observe.mock.calls).toHaveLength(count);
    commitFailure = null;
    current = { ...current, inspection: { ...current.inspection, dirty: false, revision: '8' } };
    const refresh = await owner.refreshUnknown({ begin: () => undefined } as unknown as Sql);
    expect(refresh).toEqual(current.inspection);
    expect(refresh.owner).toEqual({ userId: USER, memoryId: OWNER });
    expect(Object.keys(refresh.owner).sort()).toEqual(['memoryId', 'userId']);
    expect(Object.isFrozen(refreshInspection.mock.calls.at(-1)?.[1])).toBe(true);
    expect(refresh).toMatchObject({ dirty: false, revision: '8' });
    expect(fresh).toHaveBeenCalledTimes(1);
    commitFailure = null;
    expect(await owner.qualifyEquivalent(proposal!, maintenance)).toEqual({ status: 'refused', reason: 'stale' });
    const prepared = await owner.prepareEquivalent({ userId: USER, memoryId: OWNER });
    expect(await owner.qualifyEquivalent(prepared.proposal!, maintenance)).toMatchObject({ status: 'already-qualified' });
  });
  it('refuses a changed active user before unknown refresh queries and retains poison', async () => {
    const owner = reconciler(), { proposal } = await owner.prepareEquivalent({ userId: USER, memoryId: OWNER });
    commitFailure = new Error('unknown commit');
    expect(await owner.qualifyEquivalent(proposal!, maintenance)).toMatchObject({ status: 'unknown' });
    activeUser = OWNER;
    const count = observe.mock.calls.length;
    await expect(owner.refreshUnknown({ begin: () => undefined } as unknown as Sql)).rejects.toThrow();
    expect(observe.mock.calls).toHaveLength(count);
    expect(await owner.qualifyEquivalent(proposal!, maintenance)).toMatchObject({ status: 'unknown' });
  });
  it('refuses forged additional proposal fields before maintenance proof', async () => {
    const owner = reconciler(), { proposal } = await owner.prepareEquivalent({ userId: USER, memoryId: OWNER });
    expect(await owner.qualifyEquivalent({ ...proposal!, authorization: true } as typeof proposal & { authorization: boolean }, maintenance)).toMatchObject({ status: 'refused' });
    expect(observe).not.toHaveBeenCalled();
  });
});
