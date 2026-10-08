/** Controlled transport tests; real PostgreSQL locking is a separate acceptance case. */
import { describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DatabaseInstance } from '../../../../src/database/connection.js';
import { DatabaseSharedPoolWriteStrategy } from '../../../../src/collection/shared-pool/SharedPoolInstaller.js';
import { SYSTEM_USER_UUID } from '../../../../src/collection/shared-pool/SharedPoolConfig.js';
import { DatabaseTenantMemoryRegistry } from '../../../../src/storage/DatabaseTenantMemoryRegistry.js';
import { DATABASE_MEMORY_LEGACY_PROFILE } from '../../../../src/storage/DatabaseMemoryLegacyMutationGuard.js';

function fixture(modeRows: Record<string, unknown>[] = []) {
  const execute = jest.fn(async (query: SQL) => {
    const compiled = new PgDialect().sqlToQuery(query);
    if (compiled.sql.includes('canBypassRls')) return [{ currentUser: 'owned-system', canBypassRls: true }];
    if (compiled.sql.includes('memory_backend_modes')) {
      expect(compiled.sql).toContain('FOR SHARE'); expect(compiled.params).toEqual([SYSTEM_USER_UUID]); return modeRows;
    }
    return [];
  });
  const values = jest.fn((_value: unknown) => builder);
  const returning = jest.fn(async () => [{ id: 'owned-shared-id' }]);
  const builder = { values, onConflictDoUpdate: jest.fn(() => builder), returning };
  const insert = jest.fn(() => builder);
  const systemDb = { transaction: async (body: (tx: unknown) => Promise<unknown>) => body({ execute, insert }) } as unknown as DatabaseInstance;
  const applicationDb = {} as DatabaseInstance;
  const registry = new DatabaseTenantMemoryRegistry({ db: applicationDb, getEffectiveTenant: () => SYSTEM_USER_UUID,
    createManagerDeps: () => { throw new Error('No selected manager initialization permitted'); },
    getAttribution: () => ({ contextRoot: 'controlled', sessionId: 'controlled', transport: 'http' }) });
  return { systemDb, applicationDb, registry, execute, insert, values };
}
const request = { name: 'shared-fixture', elementType: 'memories', content: 'name: shared-fixture\nentries: []',
  origin: 'deployment_seed' as const, sourceUrl: 'file://owned-fixture', sourceVersion: '1' };
const legacy = { protocol_version: 1, profile: DATABASE_MEMORY_LEGACY_PROFILE, mode: 'legacy', generation: '1' };

describe('configured SYSTEM shared-memory writes', () => {
  it.each([{ rows: [] }, { rows: [{ ...legacy, mode: 'guarded' }] }, { rows: [{ ...legacy, mode: 'read_only' }] }, { rows: [{ ...legacy, generation: '0' }] }])(
    'refuses missing or unsupported durable permission before actual insert: %j', async ({ rows }) => {
      const f = fixture(rows);
      await expect(new DatabaseSharedPoolWriteStrategy(f.systemDb, f).writeElement(request, 'a'.repeat(64)))
        .rejects.toMatchObject({ code: 'EMEMORYLEGACYDENIED' });
      expect(f.insert).not.toHaveBeenCalled();
    });
  it('checks the explicit LEGACY tuple in the same transaction before the real upsert', async () => {
    const f = fixture([legacy]);
    await expect(new DatabaseSharedPoolWriteStrategy(f.systemDb, f).writeElement(request, 'a'.repeat(64)))
      .resolves.toBe('owned-shared-id');
    expect(f.insert).toHaveBeenCalledTimes(1); expect(f.values).toHaveBeenCalledWith(expect.objectContaining({ userId: SYSTEM_USER_UUID, elementType: 'memories' }));
    expect(f.execute.mock.calls.some(([query]) => new PgDialect().sqlToQuery(query).sql.includes('memory_backend_modes'))).toBe(true);
  });
  it('preserves configured non-memory and omitted ordinary construction without mode reads', async () => {
    for (const configured of [true, false]) {
      const f = fixture(); const strategy = configured ? new DatabaseSharedPoolWriteStrategy(f.systemDb, f) : new DatabaseSharedPoolWriteStrategy(f.systemDb);
      await expect(strategy.writeElement({ ...request, elementType: configured ? 'skills' : 'memories' }, 'a'.repeat(64))).resolves.toBe('owned-shared-id');
      expect(f.execute.mock.calls.some(([query]) => new PgDialect().sqlToQuery(query).sql.includes('memory_backend_modes'))).toBe(false);
    }
  });
  it('refuses configured missing or mismatched actual registry before any transaction', () => {
    const f = fixture();
    expect(() => new DatabaseSharedPoolWriteStrategy(f.systemDb, undefined)).toThrow('Actual application memory registry');
    expect(() => new DatabaseSharedPoolWriteStrategy(f.systemDb, { registry: f.registry, applicationDb: {} as DatabaseInstance })).toThrow('Actual application memory registry');
    expect(f.execute).not.toHaveBeenCalled();
  });
});
