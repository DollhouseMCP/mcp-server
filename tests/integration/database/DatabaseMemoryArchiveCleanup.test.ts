/** Real PostgreSQL cleanup qualification; no resource provisioning or privilege changes. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseMemoryVolumeStore } from '../../../src/storage/DatabaseMemoryVolumeStore.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { memoryVolumes } from '../../../src/database/schema/memoryVolumes.js';
import { elements } from '../../../src/database/schema/elements.js';
import { withUserContext } from '../../../src/database/rls.js';
import { closeTestDb, ensureTestUser, fixedUserId, getTestAdminDb, getTestDb } from './test-db-helpers.js';

const db = getTestDb();
const admin = getTestAdminDb();
let userId: string;
const created: string[] = [];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
class PausedCleanup extends DatabaseMemoryVolumeStore {
  readonly arrived = gate();
  readonly resume = gate();
  constructor(private readonly phase: 'parent-locked' | 'before-delete') { super(db, () => userId); }
  protected override async cleanupBarrier(phase: 'parent-locked' | 'before-delete' | 'after-delete') {
    if (phase === this.phase) { this.arrived.release(); await this.resume.promise; }
  }
}
beforeAll(async () => {
  await db.execute(sql`SELECT 1`); // unavailable required DB is failure, never a passing skip
  userId = await ensureTestUser();
  const role = await db.execute(sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`);
  expect(role[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  const flags = await db.execute(sql`SELECT relforcerowsecurity FROM pg_class WHERE oid='public.memory_volumes'::regclass`);
  expect(flags[0].relforcerowsecurity).toBe(true);
  const policies = await db.execute(sql`SELECT polcmd FROM pg_policy WHERE polrelid='public.memory_volumes'::regclass`);
  expect(policies.some(row => row.polcmd === 'w' || row.polcmd === '*')).toBe(false);
});
afterEach(async () => {
  for (const id of created.splice(0)) await withUserContext(db, userId,
    tx => tx.delete(elements).where(and(eq(elements.id, id), eq(elements.userId, userId))));
});
afterAll(async () => { await closeTestDb(); });
async function fixture() {
  const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
  const name = `cleanup-${randomUUID()}`;
  const id = await layer.writeContent('memories', name, JSON.stringify({ metadata: { name }, entries: [] }),
    { author: '', version: '', description: '', tags: [] });
  created.push(id);
  const store = new DatabaseMemoryVolumeStore(db, () => userId);
  const archive = await store.createExclusive({ userId, memoryId: id }, {
    minimumVolume: 1, rawContent: JSON.stringify({ entries: [] }), entryCount: 0, sealedAt: new Date(0),
  });
  return { layer, store, archive, snapshot: await layer.readHeadSnapshot(id) };
}
async function archiveRows(id: string) {
  return withUserContext(db, userId, tx => tx.select().from(memoryVolumes).where(eq(memoryVolumes.memoryId, id)));
}

describe('protected archive cleanup with actual FORCE RLS', () => {
  it('removes exactly an unindexed archive, preserving the head and clean token', async () => {
    const f = await fixture();
    expect(await f.store.removeUnreferenced(f.snapshot.token, f.archive)).toEqual({ status: 'removed', reason: 'removed' });
    expect(await archiveRows(f.archive.memoryId)).toHaveLength(0);
    expect(await f.layer.readHeadSnapshot(f.archive.memoryId)).toEqual(f.snapshot);
    expect(await f.store.removeUnreferenced(f.snapshot.token, f.archive)).toEqual({ status: 'absent', reason: 'absent' });
  });

  it('refuses an actual owner-row overflow without deleting any archive', async () => {
    const f = await fixture();
    await admin.execute(sql`INSERT INTO memory_volumes (user_id, memory_id, volume, raw_content, sha256, entry_count, sealed_at)
      SELECT ${userId}::uuid, ${f.archive.memoryId}::uuid, n, '{}', ${'a'.repeat(64)}, 0, '1970-01-01T00:00:00Z'::timestamptz
      FROM generate_series(2, 10001) AS n`);
    expect(await f.store.removeUnreferenced(f.snapshot.token, f.archive)).toEqual({ status: 'refused', reason: 'resource' });
    const count = await admin.execute(sql`SELECT count(*)::int AS count FROM memory_volumes
      WHERE user_id = ${userId}::uuid AND memory_id = ${f.archive.memoryId}::uuid`);
    expect(count[0].count).toBe(10_001);
    expect(await f.layer.readHeadSnapshot(f.archive.memoryId)).toEqual(f.snapshot);
  });

  it('supports a nonempty unrelated index and preserves its referenced row', async () => {
    const f = await fixture();
    const retained = await f.store.createExclusive({ userId, memoryId: f.archive.memoryId }, {
      minimumVolume: 2, rawContent: JSON.stringify({ entries: [] }), entryCount: 0, sealedAt: new Date(0),
    });
    const reference = { volume: retained.volume, file: retained.file, sha256: retained.sha256, entryCount: 0,
      sealedAt: retained.sealedAt.toISOString(), firstEntryAt: null, lastEntryAt: null };
    const content = JSON.stringify({ metadata: { name: f.snapshot.token.name, volumes: [reference] }, entries: [] });
    await f.layer.writeHeadIfCurrent(f.snapshot.token, f.snapshot.token.name, content,
      { author: '', version: '', description: '', tags: [] });
    const current = await f.layer.readHeadSnapshot(f.archive.memoryId);
    expect(await f.store.removeUnreferenced(current.token, f.archive)).toEqual({ status: 'removed', reason: 'removed' });
    expect(await archiveRows(f.archive.memoryId)).toHaveLength(1);
    expect((await archiveRows(f.archive.memoryId))[0].id).toBe(retained.id);
    expect(await f.layer.readHeadSnapshot(f.archive.memoryId)).toEqual(current);
  });

  it('preserves a same-number replacement instead of deleting by volume alone', async () => {
    const f = await fixture();
    await admin.delete(memoryVolumes).where(eq(memoryVolumes.id, f.archive.id));
    const replacement = await f.store.createExclusive({ userId, memoryId: f.archive.memoryId }, {
      minimumVolume: 1, rawContent: JSON.stringify({ entries: [] }), entryCount: 0, sealedAt: new Date(0),
    });
    expect(await f.store.removeUnreferenced(f.snapshot.token, f.archive)).toEqual({ status: 'refused', reason: 'mismatch' });
    expect((await archiveRows(f.archive.memoryId))[0].id).toBe(replacement.id);
  });

  it.each(['parent-reference-update', 'archive-insert'] as const)('holds the parent against actual %s during cleanup', async kind => {
    const f = await fixture(); const store = new PausedCleanup('parent-locked');
    const cleanup = store.removeUnreferenced(f.snapshot.token, f.archive);
    void cleanup.catch(() => undefined);
    try {
      await Promise.race([store.arrived.promise, cleanup.then(() => { throw new Error('Cleanup settled before interleaving barrier'); })]);
      const competing = admin.transaction(async tx => {
        await tx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
        if (kind === 'parent-reference-update') return tx.update(elements).set({ metadata: { volumes: [] } }).where(eq(elements.id, f.archive.memoryId));
        return tx.insert(memoryVolumes).values({ userId, memoryId: f.archive.memoryId, volume: 9,
          rawContent: '{}', sha256: 'a'.repeat(64), entryCount: 0, sealedAt: new Date(0) });
      });
      await expect(competing).rejects.toMatchObject({ cause: { code: '55P03' } });
    } finally { store.resume.release(); await cleanup; }
    expect(await cleanup).toMatchObject({ status: 'removed' });
  });

  it.each(['id', 'volume'] as const)('rechecks privileged target %s mutation with exact DELETE predicates', async kind => {
    const f = await fixture(); const store = new PausedCleanup('before-delete');
    const cleanup = store.removeUnreferenced(f.snapshot.token, f.archive);
    void cleanup.catch(() => undefined);
    const replacementId = randomUUID();
    try {
      await Promise.race([store.arrived.promise, cleanup.then(() => { throw new Error('Cleanup settled before interleaving barrier'); })]);
      await admin.update(memoryVolumes).set(kind === 'id' ? { id: replacementId } : { volume: 7 }).where(eq(memoryVolumes.id, f.archive.id));
    } finally { store.resume.release(); await cleanup; }
    expect(await cleanup).toEqual(kind === 'id' ? { status: 'refused', reason: 'mismatch' } : { status: 'absent', reason: 'absent' });
    const rows = await archiveRows(f.archive.memoryId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(kind === 'id' ? replacementId : f.archive.id);
  });
  it('refuses a referenced target number even when its declared digest differs', async () => {
    const f = await fixture();
    const reference = { volume: 1, file: f.archive.file, sha256: 'b'.repeat(64), entryCount: 0,
      sealedAt: new Date(0).toISOString(), firstEntryAt: null, lastEntryAt: null };
    await f.layer.writeHeadIfCurrent(f.snapshot.token, f.snapshot.token.name,
      JSON.stringify({ metadata: { name: f.snapshot.token.name, volumes: [reference] }, entries: [] }),
      { author: '', version: '', description: '', tags: [] });
    const current = await f.layer.readHeadSnapshot(f.archive.memoryId);
    const before = await archiveRows(f.archive.memoryId);
    expect(await f.store.removeUnreferenced(current.token, f.archive)).toMatchObject({ status: 'refused', reason: 'referenced' });
    expect(await archiveRows(f.archive.memoryId)).toEqual(before);
    expect(await f.layer.readHeadSnapshot(f.archive.memoryId)).toEqual(current);
  });

  it.each([null, undefined])('rolls back an actual DELETE when the precommit barrier throws %s', async cause => {
    const f = await fixture();
    class RefusingCleanup extends DatabaseMemoryVolumeStore {
      protected override cleanupBarrier(phase: 'parent-locked' | 'before-delete' | 'after-delete'): Promise<void> {
        if (phase === 'after-delete') return Promise.reject(cause);
        return Promise.resolve();
      }
    }
    const before = await archiveRows(f.archive.memoryId);
    const result = await new RefusingCleanup(db, () => userId).removeUnreferenced(f.snapshot.token, f.archive);
    expect(result).toEqual({ status: 'refused', reason: 'query' });
    expect(Object.hasOwn(result, 'cause')).toBe(true);
    expect(result.cause).toBe(cause);
    expect(await archiveRows(f.archive.memoryId)).toEqual(before);
    expect(await f.layer.readHeadSnapshot(f.archive.memoryId)).toEqual(f.snapshot);
  });

});
