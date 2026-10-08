import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { MemoryHeadUpdateAdapter } from '../../../src/storage/MemoryHeadUpdateAdapter.js';
import { DatabaseMemoryAdmissionGate, DATABASE_MEMORY_ADMISSION_PROFILE as profile } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import { DatabaseMemoryBootQualification } from '../../../src/storage/DatabaseMemoryBootQualification.js';
import { DatabaseMemoryCandidateHandoff } from '../../../src/storage/DatabaseMemoryCandidateHandoff.js';
import { encodeMemoryCandidate } from '../../../src/storage/DatabaseMemoryCandidateEnvelope.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { logger } from '../../../src/utils/logger.js';

function fixture() {
  let tenant: string = randomUUID(); const originalTenant = tenant; const dialect = new PgDialect();
  const statements: string[] = [];
  let onStatement: ((statement: string) => Promise<void>) | undefined;
  let inspectionRows: Record<string, unknown>[] = [];
  const execute = jest.fn(async (query: SQL) => {
    const statement = dialect.sqlToQuery(query).sql; statements.push(statement); await onStatement?.(statement);
    if (statement.includes('pg_roles')) return [{ rolsuper: false, rolbypassrls: false }];
    if (statement.includes('pg_class')) return [{ owned: false, relforcerowsecurity: true }, { owned: false, relforcerowsecurity: true }];
    if (statement.includes('memory_backend_modes')) return [{ protocol_version: 1, profile, mode: 'guarded', generation: '1' }];
    if (statement.includes('SELECT id,status,envelope,digest')) return inspectionRows;
    if (statement.includes('RETURNING id') || statement.includes('SELECT id FROM')) return [{ id: 'private-receipt-row' }];
    return [];
  });
  const tx = { execute };
  let afterTransaction: (() => void) | undefined;
  const transaction = jest.fn(async (body: (transaction: typeof tx) => Promise<unknown>) => {
    const result = await body(tx); afterTransaction?.(); return result;
  });
  const db = { transaction } as unknown as DatabaseInstance;
  const store = new DatabaseMemoryStorageLayer(db, () => tenant);
  let gate!: DatabaseMemoryAdmissionGate;
  let handoff!: DatabaseMemoryCandidateHandoff;
  const adapter = new MemoryHeadUpdateAdapter({ backend: 'database', store }, () => tenant, () => gate, () => handoff);
  const boot = new DatabaseMemoryBootQualification();
  const identity = () => ({ tenant, store, backend: 'database' as const });
  gate = new DatabaseMemoryAdmissionGate(db, store, () => ({ tenant, backend: 'database', db, store, adapter,
    enabled: boot.isQualified(identity()), profile }));
  handoff = new DatabaseMemoryCandidateHandoff(db, store, gate, boot, () => tenant,
    () => ({ contextRoot: 'actual-owned-root', sessionId: 'actual-session', transport: 'http' }));
  const candidate = { content: 'Exact validated candidate', name: 'owned', metadata: {
    author: 'author', version: '1', description: '', tags: ['tag'], visibility: undefined,
  } };
  const original = { backend: 'database' as const, userId: tenant, ownerId: randomUUID(), locator: randomUUID(), name: 'owned', revision: '1' };
  return { gate, adapter, handoff, boot, identity, candidate, original, db, store, execute, statements, tx, originalTenant,
    setTenant: (value: string) => { tenant = value; },
    statement: (hook: typeof onStatement) => { onStatement = hook; },
    completion: (hook: typeof afterTransaction) => { afterTransaction = hook; },
    rows: (rows: typeof inspectionRows) => { inspectionRows = rows; } };
}
async function retained(f: ReturnType<typeof fixture>) {
  await f.boot.qualify(f.identity(), async () => {}); const capture = await f.gate.capture();
  const outcome = await f.handoff.handoff(capture, f.candidate, f.original);
  if (outcome.status !== 'committed') throw outcome.cause;
  return { capture, receipt: outcome.value };
}
afterEach(() => { jest.restoreAllMocks(); });

describe('candidate handoff driver/authority boundaries (SQL behavior requires actual PostgreSQL)', () => {
  it('does not derive a sibling update until its owning publication tail completes', async () => {
    const f = fixture(); await f.boot.qualify(f.identity(), async () => {});
    jest.spyOn(f.store, 'readHeadSnapshot').mockResolvedValue({ content: f.candidate.content, token: f.original });
    const token = { ...f.original, revision: '2' };
    jest.spyOn(f.store, 'prepareHeadWriteInAdmission').mockResolvedValue({ token, publish: () => {} });
    const snapshot = await f.adapter.readBoundSnapshot(f.original.locator, f.original.userId, 'owned-root');
    const memory = {}; f.adapter.bindLoaded(memory, snapshot, f.original.name, 'owned-root');
    f.adapter.beginUpdate(memory, f.original.userId, f.original.locator, f.original.name, 'owned-root');
    expect(await f.adapter.write(memory, f.original.userId, { ...f.candidate, name: f.original.name }))
      .toEqual({ status: 'committed', token });
    f.adapter.finishUpdate(memory); const publication = {}; f.adapter.bindPublication(publication, memory);
    expect(() => f.adapter.deriveBinding(publication, {}, f.original.userId, f.original.locator, f.original.name, 'owned-root')).toThrow('Cannot derive');
    await f.adapter.completePublication(memory, async () => 'actual owning tail');
    const candidate = {}; f.adapter.deriveBinding(publication, candidate, f.original.userId, f.original.locator, f.original.name, 'owned-root');
    expect(f.adapter.beginUpdate(candidate, f.original.userId, f.original.locator, f.original.name, 'owned-root')).toEqual(token);
    f.adapter.finishUpdate(candidate);
  });
  it('refuses unsupported caller data before invoking getters or dispatching handoff', async () => {
    const f = fixture(); await f.boot.qualify(f.identity(), async () => {});
    jest.spyOn(f.store, 'readHeadSnapshot').mockResolvedValue({ content: f.candidate.content, token: f.original });
    const snapshot = await f.adapter.readBoundSnapshot(f.original.locator, f.original.userId, 'owned-root');
    const memory = {}; f.adapter.bindLoaded(memory, snapshot, f.original.name, 'owned-root');
    f.adapter.beginUpdate(memory, f.original.userId, f.original.locator, f.original.name, 'owned-root');
    const getter = jest.fn(() => 'unsupported'); const metadata = { ...f.candidate.metadata };
    Object.defineProperty(metadata, 'description', { get: getter, enumerable: true });
    const dispatch = jest.spyOn(f.handoff, 'handoff');
    await expect(f.adapter.write(memory, f.original.userId, { ...f.candidate, metadata }))
      .rejects.toMatchObject({ code: 'EMEMORYHANDOFF' });
    expect(getter).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
    f.adapter.finishUpdate(memory);
  });
  it('mints only known-complete handoff authority and denies forged/reused receipts', async () => {
    const f = fixture(); const { receipt } = await retained(f);
    expect(f.statements.some(statement => statement.includes('INSERT INTO public.memory_candidate_handoffs'))).toBe(true);
    expect(() => f.handoff.consume({ ...receipt })).toThrow('Original durable');
    f.handoff.consume(receipt); expect(() => f.handoff.consume(receipt)).toThrow('Original durable');
  });
  it('unknown handoff completion closes admission and cannot expose a usable receipt', async () => {
    const f = fixture(); await f.boot.qualify(f.identity(), async () => {}); const capture = await f.gate.capture();
    const original = new Error('controlled lost handoff completion'); f.completion(() => { throw original; });
    expect(await f.handoff.handoff(capture, f.candidate, f.original)).toEqual({ status: 'unknown', cause: original });
    expect(f.boot.isQualified(f.identity())).toBe(false);
    expect(f.statements.some(statement => statement.includes("SET status='committed'"))).toBe(false);
  });
  it('closed boot after delivered handoff refuses consumption before head dispatch', async () => {
    const f = fixture(); await f.boot.qualify(f.identity(), async () => {}); const capture = await f.gate.capture();
    f.completion(() => f.boot.close());
    await expect(f.handoff.handoff(capture, f.candidate, f.original)).rejects.toMatchObject({ code: 'EMEMORYBOOT' });
    expect(f.statements.some(statement => statement.includes("SET status='committed'"))).toBe(false);
  });
  it('binds complete candidate data and locks the original row before conditional dispatch', async () => {
    const f = fixture(); const { capture, receipt } = await retained(f); f.handoff.consume(receipt);
    const outcome = await f.gate.withAdmittedWrite(capture, async authority => {
      await expect(f.handoff.requireBeforeDispatch(authority, receipt, { ...f.candidate,
        metadata: { ...f.candidate.metadata, description: 'different attempted metadata' } })).rejects.toMatchObject({ code: 'EMEMORYHANDOFF' });
      await f.handoff.requireBeforeDispatch(authority, receipt, f.candidate);
      expect(f.statements.at(-1)).toContain('FOR UPDATE');
    });
    expect(outcome.status).toBe('committed');
  });
  it('does not infer COMMIT from prospective SQL or a completed rollback', async () => {
    const f = fixture(); const { capture, receipt } = await retained(f); f.handoff.consume(receipt);
    const original = new Error('original protected failure');
    const outcome = await f.gate.withAdmittedWrite(capture, async authority => {
      await f.handoff.requireBeforeDispatch(authority, receipt, f.candidate);
      await f.handoff.recordCommitted(authority, receipt, f.candidate, { ...f.original, revision: '2' });
      expect(() => f.handoff.noteKnownCommit(receipt)).toThrow(); throw original;
    });
    expect(outcome).toEqual({ status: 'refused', cause: original });
    expect(() => f.handoff.noteKnownCommit(receipt)).toThrow();
    expect(f.statements.some(statement => statement.includes("SET status='published'"))).toBe(false);
  });
  it('failed owning publication does not retire the exact retained candidate', async () => {
    const f = fixture(); const { capture, receipt } = await retained(f); f.handoff.consume(receipt);
    await f.gate.withAdmittedWrite(capture, authority => f.handoff.recordCommitted(authority, receipt, f.candidate, { ...f.original, revision: '2' }));
    f.handoff.noteKnownCommit(receipt); const cause = new Error('actual publication failure');
    await expect(f.handoff.completePublication(receipt, async () => { throw cause; })).rejects.toBe(cause);
    expect(f.statements.some(statement => statement.includes('DELETE FROM public.memory_candidate_handoffs'))).toBe(false);
    await expect(f.handoff.completePublication(receipt, async () => 'blind second publication')).rejects.toMatchObject({ code: 'EMEMORYHANDOFF' });
  });
  it('retirement loss remains cleanup-unknown while actual publication success survives throwing observers', async () => {
    const f = fixture(); const { capture, receipt } = await retained(f); f.handoff.consume(receipt);
    await f.gate.withAdmittedWrite(capture, authority => f.handoff.recordCommitted(authority, receipt, f.candidate, { ...f.original, revision: '2' }));
    f.handoff.noteKnownCommit(receipt); f.completion(() => { throw new Error('controlled cleanup completion loss'); });
    const observe = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => { throw new Error('observer failed'); });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => { throw new Error('warning failed'); });
    expect(await f.handoff.completePublication(receipt, async () => 'Known successful publication')).toBe('Known successful publication');
    expect(observe.mock.calls).toHaveLength(1); expect(observe.mock.calls[0][0].details).toContain('head-outcome=known-committed');
    expect(warn).toHaveBeenCalled();
  });
  it('refuses old-tenant inspection delivery after an awaited read drifts', async () => {
    const f = fixture(); const encoded = encodeMemoryCandidate(f.candidate);
    f.rows([{ id: 'owned-evidence', status: 'prepared', envelope: encoded.bytes, digest: encoded.digest }]);
    f.statement(async statement => { if (statement.includes('SELECT id,status,envelope,digest')) f.setTenant(randomUUID()); });
    await expect(f.handoff.inspectRetained()).rejects.toMatchObject({ code: 'EMEMORYHANDOFF' });
  });
});
