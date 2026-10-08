import { randomUUID } from 'node:crypto';
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { MemoryHeadUpdateAdapter } from '../../../src/storage/MemoryHeadUpdateAdapter.js';
import { DatabaseMemoryAdmissionGate, DATABASE_MEMORY_ADMISSION_PROFILE as profile,
  type DatabaseMemoryAdmissionBinding, requireDatabaseMemoryWriteAuthority, type DatabaseMemoryWriteAuthority } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import type { MemoryHeadToken } from '../../../src/storage/IMemoryHeadStore.js';

function fixture() {
  let tenant: string = randomUUID();
  let mode: Record<string, unknown>[] = [{ protocol_version: 1, profile, mode: 'guarded', generation: '1' }];
  let role = { rolsuper: false, rolbypassrls: false };
  let afterRead: (() => void) | undefined;
  const statements: string[] = [];
  const execute = jest.fn(async (query: SQL) => {
    const statement = new PgDialect().sqlToQuery(query).sql;
    statements.push(statement);
    if (statement.includes('pg_roles')) return [role];
    if (statement.includes('memory_backend_modes')) { const result = mode; afterRead?.(); return result; }
    return [];
  });
  const tx = { execute };
  const transaction = jest.fn(async (body: (value: typeof tx) => Promise<unknown>) => body(tx));
  const db = { transaction } as unknown as DatabaseInstance;
  const store = new DatabaseMemoryStorageLayer(db, () => tenant);
  let gate: DatabaseMemoryAdmissionGate;
  const adapter = new MemoryHeadUpdateAdapter({ backend: 'database', store }, () => tenant, () => gate);
  let binding: DatabaseMemoryAdmissionBinding = { tenant, backend: 'database', db, store, adapter, enabled: true, profile };
  gate = new DatabaseMemoryAdmissionGate(db, store, () => binding);
  return { gate, db, store, adapter, tx, execute, transaction, statements,
    binding: () => binding, change: (value: Partial<DatabaseMemoryAdmissionBinding>) => { binding = { ...binding, ...value }; },
    tenant: (value: string) => { tenant = value; binding = { ...binding, tenant }; },
    mode: (value: Record<string, unknown>[]) => { mode = value; }, role: (value: typeof role) => { role = value; },
    afterRead: (value: () => void) => { afterRead = value; } };
}

afterEach(() => { jest.restoreAllMocks(); });
const candidate = { name: 'Owned head', content: 'Preserved attempted head',
  metadata: { author: 'author', version: '1.0.0', description: 'description', tags: ['tag'] } };
async function loaded() {
  const f = fixture();
  const tenant = f.binding().tenant;
  const ownerId = randomUUID();
  const original: MemoryHeadToken = { backend: 'database', userId: tenant, ownerId,
    locator: ownerId, name: candidate.name, revision: '1' };
  const next = { ...original, revision: '2' };
  jest.spyOn(f.store, 'readHeadSnapshot').mockResolvedValue({ content: 'Original bytes', token: original });
  const ordinary = jest.spyOn(f.store, 'writeHeadIfCurrent').mockResolvedValue(next);
  const publication = jest.fn<() => void>();
  const prepare = jest.spyOn(f.store, 'prepareHeadWriteInAdmission').mockImplementation(async authority => {
    expect(requireDatabaseMemoryWriteAuthority(authority, f.store, tenant)).toBe(f.tx);
    return { token: next, publish: publication };
  });
  const memory = {};
  const snapshot = await f.adapter.readBoundSnapshot(original.locator, tenant, 'root');
  f.adapter.bindLoaded(memory, snapshot, candidate.name, 'root');
  f.adapter.beginUpdate(memory, tenant, original.locator, candidate.name, 'root');
  return { ...f, tenantId: tenant, memory, original, next, ordinary, prepare, publication };
}

describe('dormant same-transaction admitted UPDATE', () => {
  it('refuses an unavailable configured admission gate before reading a snapshot', async () => {
    const f = fixture();
    const adapter = new MemoryHeadUpdateAdapter({ backend: 'database', store: f.store }, () => f.binding().tenant,
      () => undefined as unknown as DatabaseMemoryAdmissionGate);
    const read = jest.spyOn(f.store, 'readHeadSnapshot');
    await expect(adapter.readBoundSnapshot('owner', f.binding().tenant, 'root')).rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([null, undefined, new Error('reused original cause')])('proves rollback only through the private sentinel and unwraps %p', async cause => {
    const f = fixture(); const capture = await f.gate.capture();
    const outcome = await f.gate.withAdmittedWrite(capture, async () => { throw cause; });
    expect(outcome).toEqual({ status: 'refused', cause });
    const original = await f.gate.withAdmittedWrite(capture, async () => 'next');
    expect(original).toEqual({ status: 'committed', value: 'next' });
  });

  it.each([null, undefined, new Error('reused connection/body cause')])('does not mistake a connection race using original %p for rollback', async cause => {
    const f = fixture(); const capture = await f.gate.capture();
    f.transaction.mockImplementationOnce(async body => {
      try { await body(f.tx); } catch { throw cause; }
    });
    expect(await f.gate.withAdmittedWrite(capture, async () => { throw cause; }))
      .toEqual({ status: 'unknown', cause });
  });

  it('expires authority when connection completion races a still-running callback', async () => {
    const f = fixture(); const capture = await f.gate.capture(); const cause = new Error('connection close race');
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const entry = new Promise<void>(resolve => { entered = resolve; });
    let retained: DatabaseMemoryWriteAuthority | undefined;
    let callback: Promise<unknown> | undefined;
    f.transaction.mockImplementationOnce(async body => {
      callback = body(f.tx);
      await entry;
      return Promise.race([callback, Promise.reject(cause)]);
    });
    try {
      expect(await f.gate.withAdmittedWrite(capture, async authority => {
        retained = authority; entered(); await held; return 'late completion';
      })).toEqual({ status: 'unknown', cause });
      expect(() => requireDatabaseMemoryWriteAuthority(retained!, f.store, f.binding().tenant)).toThrow();
    } finally { release(); await callback; }
  });

  it('does not mint late authority after a connection race during protected setup', async () => {
    const f = fixture(); const capture = await f.gate.capture(); const cause = new Error('setup close race');
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const entry = new Promise<void>(resolve => { entered = resolve; });
    let callback: Promise<unknown> | undefined;
    const execute = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async query => {
      if (new PgDialect().sqlToQuery(query).sql.includes('pg_roles')) { entered(); await held; }
      return execute(query);
    });
    f.transaction.mockImplementationOnce(async body => {
      callback = body(f.tx); await entry;
      return Promise.race([callback, Promise.reject(cause)]);
    });
    const body = jest.fn(async () => 'late write');
    try {
      expect(await f.gate.withAdmittedWrite(capture, body)).toEqual({ status: 'unknown', cause });
    } finally { release(); await callback?.catch(() => undefined); }
    expect(body).not.toHaveBeenCalled();
  });

  it('contains authority to its exact active callback, actual store and tenant', async () => {
    const f = fixture(); const other = fixture(); const c = await f.gate.capture();
    let retained: DatabaseMemoryWriteAuthority | undefined;
    const result = await f.gate.withAdmittedWrite(c, async authority => {
      retained = authority;
      expect(requireDatabaseMemoryWriteAuthority(authority, f.store, f.binding().tenant)).toBe(f.tx);
      expect(() => requireDatabaseMemoryWriteAuthority({ ...authority }, f.store, f.binding().tenant)).toThrow();
      expect(() => requireDatabaseMemoryWriteAuthority(authority, other.store, f.binding().tenant)).toThrow();
      expect(() => requireDatabaseMemoryWriteAuthority(authority, f.store, other.binding().tenant)).toThrow();
      return 'prepared';
    });
    expect(result).toEqual({ status: 'committed', value: 'prepared' });
    expect(() => requireDatabaseMemoryWriteAuthority(retained!, f.store, f.binding().tenant)).toThrow();
  });

  it('waits for outer COMMIT before returning a token or publishing and never calls the ordinary writer', async () => {
    const f = await loaded();
    let release!: () => void; let prepared!: () => void;
    const completion = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { prepared = resolve; });
    f.transaction.mockImplementationOnce(async body => { const value = await body(f.tx); prepared(); await completion; return value; });
    let settled = false;
    const writing = f.adapter.write(f.memory, f.tenantId, candidate).then(value => { settled = true; return value; });
    await Promise.race([entered, writing]);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.ordinary).not.toHaveBeenCalled();
    expect(f.publication).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    release();
    expect(await writing).toMatchObject({ status: 'committed', token: f.next });
    expect(f.publication).toHaveBeenCalledTimes(1);
    f.adapter.finishUpdate(f.memory);
    expect(f.adapter.beginUpdate(f.memory, f.tenantId, f.original.locator, candidate.name, 'root')).toEqual(f.next);
  });

  it('retains attempted bytes and original authority on failed COMMIT even with a familiar error code', async () => {
    const f = await loaded(); const cause = Object.assign(new Error('commit transport'), { code: 'ESTALE' });
    f.transaction.mockImplementationOnce(async body => { await body(f.tx); throw cause; });
    expect(await f.adapter.write(f.memory, f.tenantId, candidate)).toEqual({ status: 'unknown', cause });
    expect(f.publication).not.toHaveBeenCalled();
    expect(f.adapter.getPendingUpdate(f.memory)).toMatchObject({ status: 'unknown', candidate, originalToken: f.original, cause });
    f.adapter.finishUpdate(f.memory);
    expect(() => f.adapter.beginUpdate(f.memory, f.tenantId, f.original.locator, candidate.name, 'root')).toThrow();
  });

  it('preserves failed rollback transport instead of exposing the private sentinel or body cause as completion proof', async () => {
    const f = await loaded(); const bodyCause = new Error('body failure'); const transport = new Error('rollback transport');
    f.prepare.mockRejectedValueOnce(bodyCause);
    f.transaction.mockImplementationOnce(async body => { try { await body(f.tx); } catch { throw transport; } });
    expect(await f.adapter.write(f.memory, f.tenantId, candidate)).toEqual({ status: 'unknown', cause: transport });
    expect(f.adapter.getPendingUpdate(f.memory)?.candidate).toEqual(candidate);
    expect(f.publication).not.toHaveBeenCalled();
  });

  it('rolls back post-body binding drift rather than publishing a prospective token', async () => {
    const f = await loaded();
    f.prepare.mockImplementationOnce(async () => { f.change({ enabled: false }); return { token: f.next, publish: f.publication }; });
    const result = await f.adapter.write(f.memory, f.tenantId, candidate);
    expect(result).toMatchObject({ status: 'refused', cause: { code: 'EMEMORYADMISSION' } });
    expect(f.publication).not.toHaveBeenCalled();
    expect(f.adapter.getPendingUpdate(f.memory)?.originalToken).toEqual(f.original);
  });

  it('retains known committed identity when publication fails after the outer commit', async () => {
    const f = await loaded(); const cause = new Error('publication failure');
    f.publication.mockImplementation(() => { throw cause; });
    expect(await f.adapter.write(f.memory, f.tenantId, candidate)).toEqual({ status: 'committed', token: f.next, cause });
    expect(f.adapter.getPendingUpdate(f.memory)).toMatchObject({ status: 'committed-publication-failed',
      candidate, originalToken: f.original, committedToken: f.next, cause });
    f.adapter.finishUpdate(f.memory);
    expect(f.adapter.beginUpdate(f.memory, f.tenantId, f.original.locator, candidate.name, 'root')).toEqual(f.next);
  });

  it('rejects an invalid prospective token inside the outer callback', async () => {
    const f = await loaded();
    f.prepare.mockResolvedValueOnce({ token: { ...f.next, ownerId: randomUUID() }, publish: f.publication });
    expect(await f.adapter.write(f.memory, f.tenantId, candidate)).toMatchObject({ status: 'refused' });
    expect(f.publication).not.toHaveBeenCalled();
    expect(f.adapter.getPendingUpdate(f.memory)?.originalToken).toEqual(f.original);
  });

  it('refuses copied snapshot authority without reaching any conditional writer', async () => {
    const f = await loaded();
    expect(() => f.adapter.bindLoaded({}, { content: 'Original bytes', token: f.original }, candidate.name, 'root')).toThrow();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.ordinary).not.toHaveBeenCalled();
  });
});
