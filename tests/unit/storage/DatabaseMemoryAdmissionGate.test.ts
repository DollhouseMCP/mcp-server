import { randomUUID } from 'node:crypto';
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { MemoryHeadUpdateAdapter } from '../../../src/storage/MemoryHeadUpdateAdapter.js';
import { DatabaseMemoryAdmissionGate, DATABASE_MEMORY_ADMISSION_PROFILE as profile,
  type DatabaseMemoryAdmissionBinding } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { logger } from '../../../src/utils/logger.js';

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
  const adapter = new MemoryHeadUpdateAdapter({ backend: 'database', store }, () => tenant);
  let binding: DatabaseMemoryAdmissionBinding = { tenant, backend: 'database', db, store, adapter, enabled: true, profile };
  const gate = new DatabaseMemoryAdmissionGate(db, store, () => binding);
  return { gate, db, store, adapter, tx, execute, transaction, statements,
    binding: () => binding, change: (value: Partial<DatabaseMemoryAdmissionBinding>) => { binding = { ...binding, ...value }; },
    tenant: (value: string) => { tenant = value; binding = { ...binding, tenant }; },
    mode: (value: Record<string, unknown>[]) => { mode = value; }, role: (value: typeof role) => { role = value; },
    afterRead: (value: () => void) => { afterRead = value; } };
}

afterEach(() => { jest.restoreAllMocks(); });
describe('dormant database admission', () => {
  it('captures privately and dispatches only after same-transaction locked revalidation', async () => {
    const f = fixture(); const capture = await f.gate.capture();
    expect(Object.isFrozen(capture)).toBe(true);
    const body = jest.fn(async (tx: unknown) => { expect(tx).toBe(f.tx); return 'accepted'; });
    expect(await f.gate.withAdmission(capture, body)).toBe('accepted');
    expect(body).toHaveBeenCalledTimes(1);
    expect(f.statements.some(s => s.includes('SET TRANSACTION READ ONLY'))).toBe(true);
    expect(f.statements.filter(s => s.includes('memory_backend_modes'))).toHaveLength(2);
    expect(f.statements.at(-1)).toContain('FOR SHARE');
    expect(f.transaction).toHaveBeenCalledTimes(2);
  });
  it.each([{ enabled: false }, { enabled: undefined }, { adapter: undefined }, { backend: 'file' },
    { profile: undefined }, { profile: 'unsupported' }, { tenant: '' }, { tenant: 'not-a-uuid' }])(
    'fails before database access for invalid trusted selection %j', async change => {
      const f = fixture(); f.change(change);
      await expect(f.gate.capture()).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
      expect(f.transaction).not.toHaveBeenCalled();
    });
  it('checks actual store/database/adapter and effective owner identity', async () => {
    const f = fixture(); const other = fixture(); f.change({ db: other.db });
    await expect(f.gate.capture()).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    f.change({ db: f.db, adapter: other.adapter });
    await expect(f.gate.capture()).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    f.change({ adapter: f.adapter, tenant: randomUUID() });
    await expect(f.gate.capture()).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each([[], [{ protocol_version: 2 }], [{ profile: 'unknown' }], [{ mode: 'read_only' }],
    [{ generation: '0' }], [{ generation: '-1' }], [{ generation: '1.0' }], [{ generation: '9223372036854775808' }],
    [{ generation: 1 }], [{ protocol_version: '1' }]].map(rows => ({ rows })))('refuses missing/malformed/unsupported durable state %j', async ({ rows }) => {
      const f = fixture(); f.mode(rows.map(row => ({ protocol_version: 1, profile, mode: 'guarded', generation: '1', ...row })));
      await expect(f.gate.capture()).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    });
  it.each([{ rolsuper: true, rolbypassrls: false }, { rolsuper: false, rolbypassrls: true }])(
    'refuses a privileged runtime database role %j', async role => {
      const f = fixture(); f.role(role);
      await expect(f.gate.capture()).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
      expect(f.statements.some(s => s.includes('memory_backend_modes'))).toBe(false);
    });
  it('rechecks tenant drift after captured read and does not mint authority', async () => {
    const f = fixture(); f.afterRead(() => f.tenant(randomUUID()));
    await expect(f.gate.capture()).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
  });
  it('refuses forged, copied and cross-gate captures', async () => {
    const f = fixture(); const capture = await f.gate.capture(); const body = jest.fn(async () => 'bad');
    await expect(f.gate.withAdmission({ ...capture }, body)).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    const restarted = new DatabaseMemoryAdmissionGate(f.db, f.store, f.binding);
    await expect(restarted.withAdmission(capture, body)).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    expect(body).not.toHaveBeenCalled();
  });
  it('refuses flag-off, missing adapter and generation change without dispatch or legacy fallback', async () => {
    const f = fixture(); const capture = await f.gate.capture(); const body = jest.fn(async () => 'bad');
    f.change({ enabled: false });
    await expect(f.gate.withAdmission(capture, body)).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    f.change({ enabled: true, adapter: undefined });
    await expect(f.gate.withAdmission(capture, body)).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    f.change({ adapter: f.adapter }); f.mode([{ protocol_version: 1, profile, mode: 'guarded', generation: '2' }]);
    await expect(f.gate.withAdmission(capture, body)).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    expect(body).not.toHaveBeenCalled();
  });
  it('refuses drift during locked read before dispatch and after body before commit', async () => {
    const f = fixture(); const capture = await f.gate.capture(); const body = jest.fn(async () => 'bad');
    f.afterRead(() => f.change({ enabled: false }));
    await expect(f.gate.withAdmission(capture, body)).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
    expect(body).not.toHaveBeenCalled();
    const g = fixture(); const c = await g.gate.capture();
    await expect(g.gate.withAdmission(c, async () => { g.change({ enabled: false }); return 'bad'; }))
      .rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
  });
  it('blocks overlapping use of one capture while preserving exact callback result', async () => {
    const f = fixture(); const c = await f.gate.capture();
    await f.gate.withAdmission(c, async () => {
      const body = jest.fn(async () => 'bad');
      await expect(f.gate.withAdmission(c, body)).rejects.toMatchObject({ code: 'EMEMORYADMISSION' });
      expect(body).not.toHaveBeenCalled(); return 'ok';
    });
  });
  it.each([null, undefined, new Error('private callback sentinel')])('preserves callback causes even when both observers throw: %p', async cause => {
    const f = fixture(); const c = await f.gate.capture();
    jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => { throw new Error('observer'); });
    jest.spyOn(logger, 'warn').mockImplementation(() => { throw new Error('fallback'); });
    await expect(f.gate.withAdmission(c, async () => { throw cause; })).rejects.toBe(cause);
  });
  it('preserves commit transport failure without claiming rollback or replay safety', async () => {
    const f = fixture(); const c = await f.gate.capture(); const cause = new Error('unknown commit');
    f.transaction.mockImplementationOnce(async body => { await body(f.tx); throw cause; });
    await expect(f.gate.withAdmission(c, async () => 'body completed')).rejects.toBe(cause);
  });
  it('emits only redacted boundary data and propagates unexpected storage errors', async () => {
    const f = fixture(); const cause = new Error('private SQL sentinel');
    f.execute.mockRejectedValueOnce(cause);
    const observer = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => undefined);
    await expect(f.gate.capture()).rejects.toBe(cause);
    const event = observer.mock.calls.at(-1)![0];
    expect(event).toMatchObject({ source: 'DatabaseMemoryAdmissionGate', type: 'OPERATION_FAILED' });
    expect(JSON.stringify(event)).not.toContain(f.binding().tenant);
    expect(JSON.stringify(event)).not.toContain('private SQL sentinel');
    expect(JSON.stringify(event)).toContain('storage-outcome=unclassified');
  });
});
