import { and, eq, sql } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { withUserContext } from '../../../src/database/rls.js';
import { elements, elementTags } from '../../../src/database/schema/elements.js';
import { users } from '../../../src/database/schema/users.js';
import { getErrorCode } from '../../../src/database/db-utils.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import {
  buildMemoryContent, cleanupAllTestData, closeTestDb, ensureTestUser,
  ensureTestUserB, fixedUserId, getTestDb, getTestAdminDb,
} from './test-db-helpers.js';

const metadata = { author: '', version: '1.0.0', description: '', tags: ['original'] };
const db = getTestDb();
let userId: string;
let otherUserId: string;
let layer: DatabaseMemoryStorageLayer;

beforeAll(async () => {
  // This qualification must fail when PostgreSQL is unavailable, never pass
  // silently with its RLS and concurrency assertions skipped.
  await db.execute(sql`SELECT 1`);
  userId = await ensureTestUser();
  otherUserId = await ensureTestUserB();
  layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
  const result = await db.execute(sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
  expect(result[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  const tables = await db.execute(sql`SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('elements', 'element_tags')`);
  expect(tables).toHaveLength(2);
  expect(tables.every(row => row.relforcerowsecurity === true)).toBe(true);
});
afterEach(async () => { await cleanupAllTestData(); });
afterAll(async () => { await closeTestDb(); });

async function memory(name: string, owner = userId, visibility: 'private' | 'public' = 'private') {
  const writer = new DatabaseMemoryStorageLayer(db, fixedUserId(owner));
  return writer.writeContent('memories', name, buildMemoryContent(name), { ...metadata, visibility });
}
async function parent(id: string, owner = userId) {
  return withUserContext(db, owner, async tx => (await tx.select().from(elements).where(eq(elements.id, id)))[0]);
}
async function tags(id: string) {
  return withUserContext(db, userId, tx => tx.select().from(elementTags).where(eq(elementTags.elementId, id)));
}
async function failureCode(action: Promise<unknown>) {
  return action.then(() => undefined, error => getErrorCode(error));
}

it.each(['insert', 'update', 'delete'] as const)('invalidates stale memory tokens on direct tag %s', async operation => {
  const id = await memory(`tag-${operation}`);
  const before = await layer.readHeadSnapshot(id);
  await withUserContext(db, userId, async tx => {
    if (operation === 'insert') await tx.insert(elementTags).values({ elementId: id, userId, tag: 'added' });
    if (operation === 'update') await tx.update(elementTags).set({ tag: 'changed' }).where(eq(elementTags.elementId, id));
    if (operation === 'delete') await tx.delete(elementTags).where(eq(elementTags.elementId, id));
  });
  const current = await parent(id);
  expect(current.storageRevision).toBe(BigInt(before.token.revision) + 1n);
  expect(current.memoryEntriesOutOfSync).toBe(true);
  await expect(layer.readHeadSnapshot(id)).rejects.toMatchObject({ code: 'EHEADOUTOFSYNC' });
  await expect(layer.writeHeadIfCurrent(before.token, before.token.name, before.content, metadata))
    .rejects.toMatchObject({ code: 'ESTALE' });
});

it('rejects an A-to-B-to-A tag cycle although tags return to their original value', async () => {
  const id = await memory('tag-aba');
  const before = await layer.readHeadSnapshot(id);
  for (const tag of ['changed', 'original']) {
    await withUserContext(db, userId, tx => tx.update(elementTags).set({ tag }).where(eq(elementTags.elementId, id)));
  }
  expect((await tags(id)).map(row => row.tag)).toEqual(['original']);
  expect((await parent(id)).storageRevision).toBe(BigInt(before.token.revision) + 2n);
  await expect(layer.writeHeadIfCurrent(before.token, 'tag-aba', before.content, metadata)).rejects.toMatchObject({ code: 'ESTALE' });
});

it('invalidates both moved memory owners exactly once in either UUID order', async () => {
  const a = await memory('move-a');
  const b = await memory('move-b');
  await withUserContext(db, userId, tx => tx.delete(elementTags).where(eq(elementTags.elementId, b)));
  for (const [from, to] of [[a, b], [b, a]]) {
    const previousA = await parent(a); const previousB = await parent(b);
    await withUserContext(db, userId, tx => tx.update(elementTags).set({ elementId: to }).where(eq(elementTags.elementId, from)));
    expect((await parent(a)).storageRevision).toBe(previousA.storageRevision + 1n);
    expect((await parent(b)).storageRevision).toBe(previousB.storageRevision + 1n);
    expect((await parent(a)).memoryEntriesOutOfSync).toBe(true);
    expect((await parent(b)).memoryEntriesOutOfSync).toBe(true);
  }
});

it.each(['private', 'public'] as const)('denies foreign %s memory tag insertion and moves without partial invalidation', async visibility => {
  const foreign = await memory(`foreign-${visibility}`, otherUserId, visibility);
  const own = await memory('own');
  const previous = await parent(own); const foreignPrevious = await parent(foreign, otherUserId);
  expect(await failureCode(withUserContext(db, userId, tx => tx.insert(elementTags).values({ elementId: foreign, userId, tag: 'attack' })))).toBe('23503');
  expect(await failureCode(withUserContext(db, userId, tx => tx.update(elementTags).set({ elementId: foreign }).where(eq(elementTags.elementId, own))))).toBe('23503');
  expect(await parent(own)).toEqual(previous);
  expect(await parent(foreign, otherUserId)).toEqual(foreignPrevious);
  expect((await tags(own)).map(row => row.tag)).toEqual(['original']);
});

it('denies missing owners and spoofed tag tenants', async () => {
  const id = await memory('tenant');
  const before = await parent(id);
  expect(await failureCode(withUserContext(db, userId, tx => tx.insert(elementTags).values({ elementId: randomUUID(), userId, tag: 'missing' })))).toBe('23503');
  expect(await failureCode(withUserContext(db, userId, tx => tx.insert(elementTags).values({ elementId: id, userId: otherUserId, tag: 'spoof' })))).toBe('23503');
  expect(await parent(id)).toEqual(before);
});

it('preserves visible nonmemory behavior and invalidates only the memory side of moves', async () => {
  const id = await memory('nonmemory');
  await withUserContext(db, userId, tx => tx.update(elements).set({ elementType: 'skills' }).where(eq(elements.id, id)));
  const before = await parent(id);
  await withUserContext(db, userId, async tx => {
    await tx.insert(elementTags).values({ elementId: id, userId, tag: 'extra' });
    await tx.update(elementTags).set({ tag: 'changed' }).where(and(eq(elementTags.elementId, id), eq(elementTags.tag, 'extra')));
    await tx.delete(elementTags).where(and(eq(elementTags.elementId, id), eq(elementTags.tag, 'changed')));
  });
  expect(await parent(id)).toEqual(before);
  const target = await memory('memory-side');
  await withUserContext(db, userId, tx => tx.delete(elementTags).where(eq(elementTags.elementId, target)));
  const memoryBefore = await parent(target);
  await withUserContext(db, userId, tx => tx.update(elementTags).set({ elementId: target }).where(eq(elementTags.elementId, id)));
  expect(await parent(id)).toEqual(before);
  expect((await parent(target)).storageRevision).toBe(memoryBefore.storageRevision + 1n);
});

it('returns the final post-tag revision and rolls back tags, parent and revision on candidate failure', async () => {
  const id = await memory('whole-save');
  const before = await layer.readHeadSnapshot(id);
  const saved = await layer.writeHeadIfCurrent(before.token, 'whole-save', before.content, { ...metadata, tags: ['one', 'two'] });
  expect(saved).toEqual((await layer.readHeadSnapshot(id)).token);
  // Parent update, old tag deletion, two inserts, clean qualification update.
  expect(BigInt(saved.revision)).toBe(BigInt(before.token.revision) + 5n);
  const oldRow = await parent(id); const oldTags = await tags(id);
  const invalid = buildMemoryContent('whole-save', [{ id: 'x'.repeat(256), content: 'invalid' }]);
  await expect(layer.writeHeadIfCurrent(saved, 'whole-save', invalid, { ...metadata, tags: ['replacement'] }))
    .rejects.toMatchObject({ code: 'EINVALIDHEAD' });
  expect(await parent(id)).toEqual(oldRow);
  expect(await tags(id)).toEqual(oldTags);
});

it('allows parent cascade and invisible malformed cleanup but rejects visible mismatched memory deletion', async () => {
  const id = await memory('cascade');
  await withUserContext(db, userId, tx => tx.delete(elements).where(eq(elements.id, id)));
  expect(await tags(id)).toEqual([]);
  for (const visibility of ['private', 'public'] as const) {
    const foreign = await memory(`legacy-${visibility}`, otherUserId, visibility);
    const original = await parent(foreign, otherUserId);
    // Simulate a pre-0057 malformed tag using a local test admin transaction.
    await getTestAdminDb().transaction(async tx => {
      await tx.execute(sql`ALTER TABLE element_tags DISABLE TRIGGER element_tags_memory_head_revision_change`);
      await tx.insert(elementTags).values({ elementId: foreign, userId, tag: 'legacy' });
      await tx.execute(sql`ALTER TABLE element_tags ENABLE TRIGGER element_tags_memory_head_revision_change`);
    });
    const cleanup = withUserContext(db, userId, tx => tx.delete(elementTags).where(and(eq(elementTags.elementId, foreign), eq(elementTags.tag, 'legacy'))));
    expect(await failureCode(cleanup)).toBe(visibility === 'public' ? '23503' : undefined);
    // Privileged cleanup is local fixture teardown, not an application bypass.
    await getTestAdminDb().transaction(async tx => {
      await tx.execute(sql`ALTER TABLE element_tags DISABLE TRIGGER element_tags_memory_head_revision_change`);
      await tx.delete(elementTags).where(and(eq(elementTags.elementId, foreign), eq(elementTags.tag, 'legacy')));
      await tx.execute(sql`ALTER TABLE element_tags ENABLE TRIGGER element_tags_memory_head_revision_change`);
    });
    expect(await parent(foreign, otherUserId)).toEqual(original);
  }
});

it('allows valid account cascade but rejects visible malformed foreign-parent account erasure', async () => {
  const [account] = await getTestAdminDb().insert(users).values({ username: `tag-cascade-${randomUUID()}` }).returning();
  const foreign = await memory('account-foreign', otherUserId, 'public');
  const own = await memory('account-own', account.id);
  const foreignBefore = await parent(foreign, otherUserId);
  await getTestAdminDb().transaction(async tx => {
    await tx.execute(sql`ALTER TABLE element_tags DISABLE TRIGGER element_tags_memory_head_revision_change`);
    await tx.insert(elementTags).values({ elementId: foreign, userId: account.id, tag: 'legacy-account' });
    await tx.execute(sql`ALTER TABLE element_tags ENABLE TRIGGER element_tags_memory_head_revision_change`);
  });
  expect(await failureCode(getTestAdminDb().delete(users).where(eq(users.id, account.id)))).toBe('23503');
  expect(await parent(own, account.id)).toBeDefined();
  await getTestAdminDb().transaction(async tx => {
    await tx.execute(sql`ALTER TABLE element_tags DISABLE TRIGGER element_tags_memory_head_revision_change`);
    await tx.delete(elementTags).where(and(eq(elementTags.elementId, foreign), eq(elementTags.tag, 'legacy-account')));
    await tx.execute(sql`ALTER TABLE element_tags ENABLE TRIGGER element_tags_memory_head_revision_change`);
  });
  await getTestAdminDb().delete(users).where(eq(users.id, account.id));
  expect(await parent(own, account.id)).toBeUndefined();
  expect(await parent(foreign, otherUserId)).toEqual(foreignBefore);
});

it('rolls back the loser of a barrier-controlled tag-row versus guarded-save lock inversion', async () => {
  const id = await memory('tag-lock-race');
  const before = await layer.readHeadSnapshot(id);
  let tagLocked!: () => void; const locked = new Promise<void>(resolve => { tagLocked = resolve; });
  let parentLocked!: () => void; const parentReady = new Promise<void>(resolve => { parentLocked = resolve; });
  let releaseSave!: () => void; const saveRelease = new Promise<void>(resolve => { releaseSave = resolve; });
  // Test-only barrier after writeElementRow holds the parent, before tag sync.
  const writer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
  const internals = writer as unknown as { replaceTags: (...args: unknown[]) => Promise<void> };
  const replaceTags = internals.replaceTags.bind(writer);
  internals.replaceTags = async (...args) => { parentLocked(); await saveRelease; await replaceTags(...args); };
  const direct = withUserContext(db, userId, async tx => {
    await tx.execute(sql`SELECT 1 FROM element_tags WHERE element_id = ${id} FOR UPDATE`);
    tagLocked();
    await parentReady;
    const update = tx.update(elementTags).set({ tag: 'direct-winner' }).where(eq(elementTags.elementId, id)).execute();
    releaseSave();
    await update;
  });
  await locked;
  const candidate = buildMemoryContent('tag-lock-race', [{ id: 'saved', content: 'Save winner' }]);
  const guarded = writer.writeHeadIfCurrent(before.token, 'tag-lock-race', candidate, { ...metadata, tags: ['save-winner'] });
  const [directResult, guardedResult] = await Promise.allSettled([direct, guarded]);
  expect([directResult, guardedResult].filter(result => result.status === 'fulfilled')).toHaveLength(1);
  if (guardedResult.status === 'fulfilled') {
    expect(directResult.status).toBe('rejected');
    if (directResult.status === 'rejected') expect(['40P01', '40001']).toContain(getErrorCode(directResult.reason));
    expect(guardedResult.value).toEqual((await layer.readHeadSnapshot(id)).token);
    expect((await tags(id)).map(row => row.tag)).toEqual(['save-winner']);
    expect((await parent(id)).rawContent).toBe(candidate);
  } else {
    expect(guardedResult.reason).toMatchObject({ code: 'EHEADCONFLICT' });
    expect(['40P01', '40001']).toContain(getErrorCode(guardedResult.reason.cause));
    expect((await tags(id)).map(row => row.tag)).toEqual(['direct-winner']);
    expect((await parent(id)).rawContent).toBe(before.content);
    expect((await parent(id)).memoryEntriesOutOfSync).toBe(true);
  }
});

it('preserves foreign visible nonmemory compatibility but rejects invisible nonmemory targets', async () => {
  for (const visibility of ['private', 'public'] as const) {
    const id = await memory(`foreign-skill-${visibility}`, otherUserId, visibility);
    await withUserContext(db, otherUserId, tx => tx.update(elements).set({ elementType: 'skills' }).where(eq(elements.id, id)));
    const before = await parent(id, otherUserId);
    const insertion = withUserContext(db, userId, tx => tx.insert(elementTags).values({ elementId: id, userId, tag: 'legacy-compatible' }));
    expect(await failureCode(insertion)).toBe(visibility === 'private' ? '23503' : undefined);
    expect(await parent(id, otherUserId)).toEqual(before);
    if (visibility === 'public') {
      await withUserContext(db, userId, tx => tx.delete(elementTags).where(and(eq(elementTags.elementId, id), eq(elementTags.tag, 'legacy-compatible'))));
      expect(await parent(id, otherUserId)).toEqual(before);
    }
  }
});


it('installs on a populated schema without qualifying preexisting clean tag drift', async () => {
  const id = await memory('preexisting-clean-drift');
  const before = await parent(id);
  const migration = await readFile(new URL('../../../src/database/migrations/0057_memory_tag_revision.sql', import.meta.url), 'utf8');
  const rollback = new Error('rollback isolated installation qualification');
  await expect(getTestAdminDb().transaction(async tx => {
    await tx.execute(sql`DROP TRIGGER element_tags_memory_head_revision_change ON element_tags`);
    await tx.execute(sql`DROP FUNCTION bump_memory_tag_head_revision()`);
    await tx.execute(sql`DROP FUNCTION invalidate_memory_tag_owner(UUID, UUID, BOOLEAN)`);
    await tx.update(elementTags).set({ tag: 'preexisting-drift' }).where(eq(elementTags.elementId, id));
    for (const statement of migration.split('--> statement-breakpoint')) {
      await tx.execute(sql.raw(statement));
    }
    const [row] = await tx.select().from(elements).where(eq(elements.id, id));
    expect(row.storageRevision).toBe(before.storageRevision);
    expect(row.memoryEntriesOutOfSync).toBe(false);
    // Installing safeguards cannot retroactively qualify this row.
    throw rollback;
  })).rejects.toBe(rollback);
  expect(await parent(id)).toEqual(before);
  expect((await tags(id)).map(row => row.tag)).toEqual(['original']);
});
