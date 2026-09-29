import { and, eq, sql } from 'drizzle-orm';
import { withUserContext } from '../../../src/database/rls.js';
import { elements } from '../../../src/database/schema/elements.js';
import { memoryEntries } from '../../../src/database/schema/memories.js';
import { memoryVolumes } from '../../../src/database/schema/memoryVolumes.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { DatabaseMemoryReconciliationInspector } from '../../../src/storage/DatabaseMemoryReconciliationInspector.js';
import { DatabaseMemoryVolumeStore } from '../../../src/storage/DatabaseMemoryVolumeStore.js';
import {
  buildMemoryContent, cleanupAllTestData, closeTestDb, ensureTestUser, ensureTestUserB,
  fixedUserId, getTestAdminDb, getTestDb,
} from './test-db-helpers.js';

const writeMetadata = { author: 'test-author', version: '1.0.0', description: '', tags: [] };
const describePg = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

beforeAll(async () => { await ensureTestUser(); });
afterEach(async () => { await cleanupAllTestData(); });
afterAll(async () => { await closeTestDb(); });

describePg('read-only database memory reconciliation inspection', () => {
  it('proves a normal persisted head equivalent even while its legacy dirty flag is set, without writing', async () => {
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const inspector = new DatabaseMemoryReconciliationInspector(db, fixedUserId(userId));
    const raw = buildMemoryContent('equivalent', [{ id: 'one', content: 'First', timestamp: '2026-09-28T12:00:00.000Z' }]);
    const id = await layer.writeContent('memories', 'equivalent', raw, writeMetadata);
    await withUserContext(db, userId, tx => tx.update(elements).set({ memoryEntriesOutOfSync: true })
      .where(eq(elements.id, id)));
    const before = await withUserContext(db, userId, tx => tx.select().from(elements).where(eq(elements.id, id)));
    const result = await inspector.inspect({ userId, memoryId: id });
    const after = await withUserContext(db, userId, tx => tx.select().from(elements).where(eq(elements.id, id)));
    expect(result).toMatchObject({ status: 'equivalent', canApply: false, dirty: true,
      counts: { rawEntries: 1, childEntries: 1, volumes: 0 }, diagnostics: [] });
    expect(after).toEqual(before);
    expect(await layer.getEntries(id)).toHaveLength(1);
    expect(result).not.toHaveProperty('rawContent');
  });

  it('compares persisted array-valued entry JSON exactly', async () => {
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const inspector = new DatabaseMemoryReconciliationInspector(db, fixedUserId(userId));
    const raw = buildMemoryContent('patterns', [
      { id: 'one', content: 'One', timestamp: '2026-09-28T12:00:00.000Z' },
    ]).replace('    timestamp: "2026-09-28T12:00:00.000Z"', [
      '    timestamp: "2026-09-28T12:00:00.000Z"',
      '    sanitizedPatterns:',
      '      - pattern: first',
      '        replacement: one',
      '      - pattern: second',
      '        replacement: two',
      '    metadata:',
      '      - source: first',
      '      - source: second',
    ].join('\n'));
    const id = await layer.writeContent('memories', 'patterns', raw, writeMetadata);
    expect((await inspector.inspect({ userId, memoryId: id })).status).toBe('equivalent');

    await withUserContext(db, userId, tx => tx.update(memoryEntries)
      .set({ sanitizedPatterns: [
        { pattern: 'second', replacement: 'two' },
        { pattern: 'first', replacement: 'one' },
      ] }).where(and(eq(memoryEntries.userId, userId), eq(memoryEntries.memoryId, id))));
    const changed = await inspector.inspect({ userId, memoryId: id });
    expect(changed.status).toBe('divergent');
    expect(changed.diagnostics).toContainEqual({ code: 'entry_projection_mismatch', path: 'entries[0]' });

    await withUserContext(db, userId, tx => tx.update(memoryEntries)
      .set({
        sanitizedPatterns: [
          { pattern: 'first', replacement: 'one' },
          { pattern: 'second', replacement: 'two' },
        ],
        entryMetadata: [{ source: 'second' }, { source: 'first' }],
      }).where(and(eq(memoryEntries.userId, userId), eq(memoryEntries.memoryId, id))));
    const changedMetadata = await inspector.inspect({ userId, memoryId: id });
    expect(changedMetadata.status).toBe('divergent');
    expect(changedMetadata.diagnostics).toContainEqual({ code: 'entry_projection_mismatch', path: 'entries[0]' });
  });

  it('reads more than the normal 1,000-entry query cap without truncation', async () => {
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const inspector = new DatabaseMemoryReconciliationInspector(db, fixedUserId(userId));
    const entries = Array.from({ length: 1001 }, (_, index) => ({
      id: `entry-${index}`, content: `Value ${index}`,
      timestamp: new Date(Date.UTC(2026, 8, 28, 0, 0, index)).toISOString(),
    }));
    const id = await layer.writeContent('memories', 'large', buildMemoryContent('large', entries.reverse()), writeMetadata);
    expect(await layer.getEntries(id)).toHaveLength(1000);
    const result = await inspector.inspect({ userId, memoryId: id });
    expect(result.status).toBe('equivalent');
    expect(result.counts).toMatchObject({ rawEntries: 1001, childEntries: 1001 });
  });

  it('reports a newer child row as divergence without replaying stale raw YAML', async () => {
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const inspector = new DatabaseMemoryReconciliationInspector(db, fixedUserId(userId));
    const raw = buildMemoryContent('diverged', [{ id: 'original', content: 'Keep', timestamp: '2026-09-28T12:00:00.000Z' }]);
    const id = await layer.writeContent('memories', 'diverged', raw, writeMetadata);
    await layer.addEntry(id, { entryId: 'newer', timestamp: new Date('2026-09-28T13:00:00Z'), content: 'Accepted child' });
    const result = await inspector.inspect({ userId, memoryId: id });
    expect(result).toMatchObject({ status: 'divergent', canApply: false,
      counts: { rawEntries: 1, childEntries: 2 }, diagnostics: [{ code: 'entry_count_mismatch', path: 'entries' }] });
    expect(await layer.readContent(id)).toBe(raw);
    expect((await layer.getEntries(id)).map(entry => entry.entryId)).toContain('newer');
  });

  it('marks mixed metadata and equal-time entry ordering ambiguous', async () => {
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const inspector = new DatabaseMemoryReconciliationInspector(db, fixedUserId(userId));
    const mixed = 'name: top\nmetadata:\n  name: nested\nentries: []\n';
    const mixedId = await layer.writeContent('memories', 'top', mixed, writeMetadata);
    const mixedResult = await inspector.inspect({ userId, memoryId: mixedId });
    expect(mixedResult.status).toBe('ambiguous');
    expect(mixedResult.diagnostics).toContainEqual({ code: 'mixed_metadata_sources', path: 'metadata' });

    const tied = buildMemoryContent('ties', [
      { id: 'a', content: 'A', timestamp: '2026-09-28T12:00:00.000Z' },
      { id: 'b', content: 'B', timestamp: '2026-09-28T12:00:00.000Z' },
    ]);
    const tiedId = await layer.writeContent('memories', 'ties', tied, writeMetadata);
    const tiedResult = await inspector.inspect({ userId, memoryId: tiedId });
    expect(tiedResult.status).toBe('ambiguous');
    expect(tiedResult.diagnostics).toContainEqual({ code: 'unproven_equal_time_order', path: 'entries' });
  });

  it('does not call missing or unrepresented metadata equivalent', async () => {
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const inspector = new DatabaseMemoryReconciliationInspector(db, fixedUserId(userId));
    const missingId = await layer.writeContent('memories', 'minimal', 'name: minimal\nentries: []\n', writeMetadata);
    const missing = await inspector.inspect({ userId, memoryId: missingId });
    expect(missing.status).toBe('ambiguous');
    expect(missing.diagnostics).toContainEqual({ code: 'indexed_field_mismatch', path: 'author' });

    const unknownEntry = `${buildMemoryContent('unknown', [
      { id: 'one', content: 'One', timestamp: '2026-09-28T12:00:00.000Z' },
    ])}\n    customState: preserve\n`;
    const unknownId = await layer.writeContent('memories', 'unknown', unknownEntry, writeMetadata);
    const unknown = await inspector.inspect({ userId, memoryId: unknownId });
    expect(unknown.status).toBe('ambiguous');
    expect(unknown.diagnostics).toContainEqual({ code: 'unsupported_raw_entry_field', path: 'entries[0]' });
  });

  it('flags corrupt parent hash/size and created-date columns without changing them', async () => {
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const inspector = new DatabaseMemoryReconciliationInspector(db, fixedUserId(userId));
    const raw = buildMemoryContent('parent-integrity');
    const id = await layer.writeContent('memories', 'parent-integrity', raw, writeMetadata);
    await withUserContext(db, userId, tx => tx.update(elements).set({
      contentHash: '0'.repeat(64), byteSize: 1, elementCreated: '2026-01-01',
    }).where(eq(elements.id, id)));
    const before = await withUserContext(db, userId, tx => tx.select({
      contentHash: elements.contentHash, byteSize: elements.byteSize,
      elementCreated: elements.elementCreated, revision: elements.storageRevision,
    }).from(elements).where(eq(elements.id, id)));
    const result = await inspector.inspect({ userId, memoryId: id });
    const after = await withUserContext(db, userId, tx => tx.select({
      contentHash: elements.contentHash, byteSize: elements.byteSize,
      elementCreated: elements.elementCreated, revision: elements.storageRevision,
    }).from(elements).where(eq(elements.id, id)));
    expect(result.status).toBe('ambiguous');
    expect(result.diagnostics).toContainEqual({ code: 'raw_integrity_mismatch', path: 'rawContent' });
    expect(result.diagnostics).toContainEqual({ code: 'unrepresented_element_created', path: 'elementCreated' });
    expect(after).toEqual(before);
    expect(await layer.readContent(id)).toBe(raw);
  });

  it('reports an unindexed durable archive and an over-limit legacy raw head without fetching archives', async () => {
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const inspector = new DatabaseMemoryReconciliationInspector(db, fixedUserId(userId));
    const id = await layer.writeContent('memories', 'archive', buildMemoryContent('archive'), writeMetadata);
    const archive = new DatabaseMemoryVolumeStore(db, fixedUserId(userId));
    await archive.createExclusive({ userId, memoryId: id }, {
      minimumVolume: 1, rawContent: 'metadata:\n  name: sealed\nentries: []\n',
      entryCount: 0, sealedAt: new Date('2026-09-28T12:00:00.000Z'),
    });
    const unindexed = await inspector.inspect({ userId, memoryId: id });
    expect(unindexed.status).toBe('ambiguous');
    expect(unindexed.diagnostics).toContainEqual({ code: 'volume_index_mismatch', path: 'metadata.volumes' });
    expect(JSON.stringify(unindexed)).not.toContain('name: sealed');

    await withUserContext(db, userId, tx => tx.update(elements)
      .set({ rawContent: 'x'.repeat(2 * 1024 * 1024 + 1) }).where(eq(elements.id, id)));
    const oversized = await inspector.inspect({ userId, memoryId: id });
    expect(oversized).toMatchObject({ status: 'ineligible', canApply: false,
      rawUnits: 2 * 1024 * 1024 + 1, diagnostics: [{ code: 'legacy_size_limit', path: 'rawContent' }] });
  });

  it('treats an unrepresentable authoritative timestamp as ambiguous instead of throwing', async () => {
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const inspector = new DatabaseMemoryReconciliationInspector(db, fixedUserId(userId));
    const id = await layer.writeContent('memories', 'infinity', buildMemoryContent('infinity', [
      { id: 'one', content: 'One', timestamp: '2026-09-28T12:00:00.000Z' },
    ]), writeMetadata);
    await withUserContext(db, userId, tx => tx.update(memoryEntries)
      .set({ timestamp: sql`'infinity'::timestamptz` })
      .where(and(eq(memoryEntries.userId, userId), eq(memoryEntries.memoryId, id))));
    const result = await inspector.inspect({ userId, memoryId: id });
    expect(result.status).toBe('ambiguous');
    expect(result.diagnostics).toContainEqual({ code: 'unrepresentable_child_timestamp', path: 'entries[0]' });
  });

  it('does not declare sub-millisecond child timestamps equivalent after Date conversion', async () => {
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const inspector = new DatabaseMemoryReconciliationInspector(db, fixedUserId(userId));
    const id = await layer.writeContent('memories', 'microseconds', buildMemoryContent('microseconds', [
      { id: 'one', content: 'One', timestamp: '2026-09-28T12:00:00.000Z' },
    ]), writeMetadata);
    await withUserContext(db, userId, tx => tx.update(memoryEntries)
      .set({ timestamp: sql`'2026-09-28 12:00:00.000123+00'::timestamptz` })
      .where(and(eq(memoryEntries.userId, userId), eq(memoryEntries.memoryId, id))));
    const result = await inspector.inspect({ userId, memoryId: id });
    expect(result.status).toBe('ambiguous');
    expect(result.diagnostics).toContainEqual({ code: 'unrepresentable_child_timestamp', path: 'entries[0]' });
  });

  it('does not declare a raw sub-millisecond timestamp equivalent to its rounded child', async () => {
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const inspector = new DatabaseMemoryReconciliationInspector(db, fixedUserId(userId));
    const id = await layer.writeContent('memories', 'raw-microseconds', buildMemoryContent('raw-microseconds', [
      { id: 'one', content: 'One', timestamp: '2026-09-28T12:00:00.000123Z' },
    ]), writeMetadata);
    const result = await inspector.inspect({ userId, memoryId: id });
    expect(result.status).toBe('ambiguous');
    expect(result.diagnostics).toContainEqual({ code: 'unrepresentable_raw_timestamp', path: 'entries[0]' });
  });

  it('does not equate invalid raw and persisted archive dates', async () => {
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const inspector = new DatabaseMemoryReconciliationInspector(db, fixedUserId(userId));
    const id = await layer.writeContent('memories', 'volume-dates', buildMemoryContent('volume-dates'), writeMetadata);
    const archive = new DatabaseMemoryVolumeStore(db, fixedUserId(userId));
    const row = await archive.createExclusive({ userId, memoryId: id }, {
      minimumVolume: 1, rawContent: 'metadata:\n  name: sealed\nentries: []\n',
      entryCount: 0, sealedAt: new Date('2026-09-28T12:00:00.000Z'),
    });
    const indexed = [
      'metadata:', '  name: volume-dates', '  description: Test memory volume-dates',
      '  author: test-author', '  version: 1.0.0', '  memoryType: user',
      '  autoLoad: false', '  tags:', '    - test', '  volumes:',
      '    - volume: 1', `      file: volumes/${id}/v0001.yaml`,
      `      sha256: ${row.sha256}`, '      entryCount: 0',
      '      sealedAt: 2026-09-28T12:00:00.000Z',
      '      firstEntryAt: invalid-date', 'entries: []', '',
    ].join('\n');
    await layer.writeContent('memories', 'volume-dates', indexed, writeMetadata);
    // Archive rows are immutable to the application role. Admin-only test
    // mutation models corrupt/legacy PostgreSQL values the inspector must read.
    await getTestAdminDb().update(memoryVolumes)
      .set({ firstEntryAt: sql`'infinity'::timestamptz` })
      .where(and(eq(memoryVolumes.userId, userId), eq(memoryVolumes.memoryId, id)));
    const result = await inspector.inspect({ userId, memoryId: id });
    expect(result.status).toBe('ambiguous');
    expect(result.diagnostics).toContainEqual({ code: 'unrepresentable_volume_timestamp', path: 'metadata.volumes[0]' });

    await layer.writeContent('memories', 'volume-dates',
      indexed.replace('firstEntryAt: invalid-date', 'firstEntryAt: 2026-09-28T11:00:00.000Z'), writeMetadata);
    await getTestAdminDb().update(memoryVolumes)
      .set({ firstEntryAt: sql`'2026-09-28 11:00:00.000123+00'::timestamptz` })
      .where(and(eq(memoryVolumes.userId, userId), eq(memoryVolumes.memoryId, id)));
    const storedPrecision = await withUserContext(db, userId, tx => tx.select({
      text: sql<string>`${memoryVolumes.firstEntryAt}::text`,
      microseconds: sql<string>`extract(microseconds from ${memoryVolumes.firstEntryAt})::text`,
    }).from(memoryVolumes).where(and(eq(memoryVolumes.userId, userId), eq(memoryVolumes.memoryId, id))));
    expect(storedPrecision[0]).toEqual({ text: '2026-09-28 11:00:00.000123+00', microseconds: '123' });
    const precise = await inspector.inspect({ userId, memoryId: id });
    expect(precise.status).toBe('ambiguous');
    expect(precise.diagnostics).toContainEqual({ code: 'unrepresentable_volume_timestamp', path: 'metadata.volumes[0]' });
  });

  it('reports when bounded diagnostics omit additional mismatches', async () => {
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const inspector = new DatabaseMemoryReconciliationInspector(db, fixedUserId(userId));
    const entries = Array.from({ length: 25 }, (_, index) => ({
      id: `entry-${index}`, content: `Original ${index}`,
      timestamp: new Date(Date.UTC(2026, 8, 28, 0, 0, 25 - index)).toISOString(),
    }));
    const id = await layer.writeContent('memories', 'many-errors', buildMemoryContent('many-errors', entries), writeMetadata);
    await withUserContext(db, userId, tx => tx.update(memoryEntries).set({ content: 'Changed' })
      .where(and(eq(memoryEntries.userId, userId), eq(memoryEntries.memoryId, id))));
    const result = await inspector.inspect({ userId, memoryId: id });
    expect(result.status).toBe('divergent');
    expect(result.diagnostics).toHaveLength(20);
    expect(result.diagnosticsTruncated).toBe(true);
  });

  it('denies another tenant and mismatched active user', async () => {
    const userA = await ensureTestUser();
    const userB = await ensureTestUserB();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userA));
    const id = await layer.writeContent('memories', 'owned', buildMemoryContent('owned'), writeMetadata);
    const other = new DatabaseMemoryReconciliationInspector(db, fixedUserId(userB));
    await expect(other.inspect({ userId: userB, memoryId: id })).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(other.inspect({ userId: userA, memoryId: id })).rejects.toThrow('does not match the active user');
  });

  it('holds one consistent read snapshot across a concurrent accepted child write', async () => {
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const id = await layer.writeContent('memories', 'snapshot', buildMemoryContent('snapshot', [
      { id: 'old', content: 'Old', timestamp: '2026-09-28T12:00:00.000Z' },
    ]), writeMetadata);
    const reached = gate();
    const resume = gate();
    class PausedInspector extends DatabaseMemoryReconciliationInspector {
      protected override async afterParentRead(): Promise<void> { reached.release(); await resume.promise; }
    }
    const inspector = new PausedInspector(db, fixedUserId(userId));
    const inFlight = inspector.inspect({ userId, memoryId: id });
    await reached.promise;
    try {
      await layer.addEntry(id, { entryId: 'new', timestamp: new Date('2026-09-28T13:00:00Z'), content: 'New' });
    } finally { resume.release(); }
    const result = await inFlight;
    expect(result).toMatchObject({ status: 'equivalent', counts: { rawEntries: 1, childEntries: 1 } });
    const current = await new DatabaseMemoryReconciliationInspector(db, fixedUserId(userId)).inspect({ userId, memoryId: id });
    expect(current).toMatchObject({ status: 'divergent', counts: { rawEntries: 1, childEntries: 2 } });
    expect(current.revision).not.toBe(result.revision);
  });
});
