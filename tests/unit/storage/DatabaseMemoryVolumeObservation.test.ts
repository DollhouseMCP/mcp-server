import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { DatabaseInstance } from '../../../src/database/connection.js';

const statements: Array<{ sql: string; params: unknown[] }> = [];
let rows: unknown[] = [];
const db = drizzle(postgres('postgres://unused:unused@127.0.0.1:1/unused')) as DatabaseInstance;
const read = jest.fn(async (_db: unknown, _user: unknown, callback: unknown) => {
  const query = (callback as (tx: DatabaseInstance) => { toSQL(): { sql: string; params: unknown[] } })(db);
  statements.push(query.toSQL());
  return rows;
});
const write = jest.fn();
await jest.unstable_mockModule('../../../src/database/rls.js', () => ({ withUserRead: read, withUserContext: write }));
const { DatabaseMemoryVolumeStore, MAX_MEMORY_VOLUME_RAW_BYTES } = await import('../../../src/storage/DatabaseMemoryVolumeStore.js');
const owner = { userId: '11111111-1111-4111-8111-111111111111', memoryId: '22222222-2222-4222-8222-222222222222' };
const store = new DatabaseMemoryVolumeStore(db, () => owner.userId);
const info = { id: '33333333-3333-4333-8333-333333333333', ...owner, volume: 1,
  sha256: 'a'.repeat(64), entryCount: 0, firstEntryAt: null, lastEntryAt: null, sealedAt: new Date(0), sealedUnrepresentable: false, firstUnrepresentable: false, lastUnrepresentable: false };
beforeEach(() => { statements.length = 0; rows = []; read.mockClear(); write.mockClear(); });

describe('bounded database archive observations', () => {
  it('guards raw bytes in the single read projection without filtering row existence', async () => {
    rows = [{ ...info, byteLength: MAX_MEMORY_VOLUME_RAW_BYTES + 1, rawContent: null }];
    await expect(store.read(owner, 1)).rejects.toMatchObject({ code: 'EVOLUMEUNSAFE' });
    expect(statements).toHaveLength(1);
    const query = statements[0];
    expect(query.sql).toContain('CASE WHEN octet_length("raw_content") <=');
    expect(query.sql.split(' where ')[1]).not.toContain('octet_length');
    expect(query.params).toContain(MAX_MEMORY_VOLUME_RAW_BYTES);
  });

  it('lists only bounded metadata with a same-statement owner witness', async () => {
    rows = [{ ownerId: owner.memoryId, archive: info }, { ownerId: owner.memoryId, archive: { ...info, volume: 2 } }];
    expect(await store.list(owner, { entryLimit: 1 })).toMatchObject({ complete: false, returnedCount: 1,
      observedCount: 2, acceptedCount: 2, totalCount: null });
    expect(statements[0].sql).toContain('left join "memory_volumes"');
    expect(statements[0].sql).not.toContain('raw_content');
    expect(statements[0].params.at(-1)).toBe(2);
  });

  it.each([0, -1, 129, 1.5, NaN, Infinity, null, '1'])('rejects invalid entry limit %s before I/O', async value => {
    await expect(store.list(owner, { entryLimit: value as number })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it('distinguishes an owned empty namespace from unavailable ownership', async () => {
    rows = [{ ownerId: owner.memoryId, archive: null }];
    expect(await store.list(owner)).toMatchObject({ complete: true, entries: [], totalCount: 0 });
    rows = [];
    await expect(store.list(owner)).rejects.toMatchObject({ code: 'EVOLUMEOWNER' });
  });

  it('requires projected precision evidence instead of silently accepting omitted flags', async () => {
    const { sealedUnrepresentable: _sealed, ...missingFlag } = info;
    rows = [{ ownerId: owner.memoryId, archive: missingFlag }];
    expect(await store.list(owner)).toMatchObject({ complete: false, entries: [], diagnostics: [{ reason: 'corrupt' }] });
    expect(statements[0].sql).toContain('extract(microseconds');
  });

  it('bounds diagnostic count and never exposes corrupt source fields', async () => {
    rows = Array.from({ length: 129 }, () => ({ ownerId: owner.memoryId, archive: { ...info, sealedAt: new Date(NaN) } }));
    const result = await store.list(owner);
    expect(result).toMatchObject({ complete: false, entries: [], observedCount: 129, acceptedCount: 0,
      totalCount: null, diagnosticsTruncated: true });
    expect(result.diagnostics).toHaveLength(64);
    expect(result.diagnostics.every(item => item.message.length <= 128)).toBe(true);
  });

  it.each([{ label: 'surrogate', rawContent: 'name: \ud800\nentries: []\n' }, { label: 'oversize', rawContent: 'x'.repeat(MAX_MEMORY_VOLUME_RAW_BYTES + 1) }])('rejects unsafe $label create source before insert', async ({ rawContent }) => {
    await expect(store.createExclusive(owner, { minimumVolume: 1, rawContent, entryCount: 0, sealedAt: new Date(0) }))
      .rejects.toMatchObject({ code: 'EVOLUMEUNSAFE' });
    expect(write).not.toHaveBeenCalled();
  });
});
