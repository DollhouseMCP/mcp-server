import { jest } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { withUserContext } from '../../../src/database/rls.js';
import { elements } from '../../../src/database/schema/elements.js';
import { memoryEntries } from '../../../src/database/schema/memories.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import {
  buildMemoryContent, cleanupAllTestData, closeTestDb, ensureTestUser,
  ensureTestUserB, fixedUserId, getTestDb, isDatabaseAvailable,
} from './test-db-helpers.js';

const metadata = { author: '', version: '1.0.0', description: '', tags: ['head-test'] };
let dbAvailable = false;

beforeAll(async () => { dbAvailable = await isDatabaseAvailable(); });
afterEach(async () => { if (dbAvailable) await cleanupAllTestData(); });
afterAll(async () => { await closeTestDb(); });

describe('DatabaseMemoryStorageLayer versioned head contract', () => {
  it('returns content and owned token from one row, then returns the final revision after entry sync', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));
    const first = buildMemoryContent('versioned', [{ id: 'first', content: 'First' }]);
    const id = await layer.writeContent('memories', 'versioned', first, metadata);
    const snapshot = await layer.readHeadSnapshot(id);
    expect(snapshot).toEqual({
      content: first,
      token: { backend: 'database', userId, ownerId: id, locator: id,
        name: 'versioned', revision: expect.stringMatching(/^[1-9][0-9]*$/u) },
    });

    const second = buildMemoryContent('versioned', [{ id: 'second', content: 'Second' }]);
    const saved = await layer.writeHeadIfCurrent(snapshot.token, 'versioned', second, metadata);
    expect(BigInt(saved.revision)).toBeGreaterThan(BigInt(snapshot.token.revision));
    expect(saved).toEqual((await layer.readHeadSnapshot(id)).token);
    await expect(layer.readContent(id)).resolves.toBe(second);
    expect((await layer.getEntries(id)).map(entry => entry.entryId)).toEqual(['second']);
  });

  it('pairs a concurrent read with either the complete old or complete new row', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const oldContent = buildMemoryContent('read-race');
    const newContent = buildMemoryContent('read-race', [{ id: 'new', content: 'New' }]);
    const id = await layer.writeContent('memories', 'read-race', oldContent, metadata);
    const before = await layer.readHeadSnapshot(id);

    const [during] = await Promise.all([
      layer.readHeadSnapshot(id),
      layer.writeContent('memories', 'read-race', newContent, metadata),
    ]);
    const after = await layer.readHeadSnapshot(id);
    expect(after.content).toBe(newContent);
    expect(BigInt(after.token.revision)).toBeGreaterThan(BigInt(before.token.revision));
    if (during.token.revision === before.token.revision) {
      expect(during.content).toBe(oldContent);
    } else {
      expect(during.token.revision).toBe(after.token.revision);
      expect(during.content).toBe(newContent);
    }
  });

  it('rejects a stale token after an A-to-B-to-A byte cycle', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));
    const a = buildMemoryContent('aba', [{ id: 'a', content: 'A' }]);
    const b = buildMemoryContent('aba', [{ id: 'b', content: 'B' }]);
    const id = await layer.writeContent('memories', 'aba', a, metadata);
    const old = await layer.readHeadSnapshot(id);
    await layer.writeContent('memories', 'aba', b, metadata);
    await layer.writeContent('memories', 'aba', a, metadata);
    const current = await layer.readHeadSnapshot(id);
    expect(current.content).toBe(old.content);
    expect(BigInt(current.token.revision)).toBeGreaterThan(BigInt(old.token.revision));

    await expect(layer.writeHeadIfCurrent(old.token, 'aba', b, metadata))
      .rejects.toMatchObject({ code: 'ESTALE' });
    expect(await layer.readHeadSnapshot(id)).toEqual(current);
  });

  it('allows only one of two concurrent writes from the same snapshot', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const firstLayer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const secondLayer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const id = await firstLayer.writeContent('memories', 'race', buildMemoryContent('race'), metadata);
    const snapshot = await firstLayer.readHeadSnapshot(id);
    const first = buildMemoryContent('race', [{ id: 'first', content: 'First' }]);
    const second = buildMemoryContent('race', [{ id: 'second', content: 'Second' }]);

    const results = await Promise.allSettled([
      firstLayer.writeHeadIfCurrent(snapshot.token, 'race', first, metadata),
      secondLayer.writeHeadIfCurrent(snapshot.token, 'race', second, metadata),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(result => result.status === 'rejected');
    expect(failed).toMatchObject({ reason: { code: 'ESTALE' } });
    const current = await firstLayer.readHeadSnapshot(id);
    expect([first, second]).toContain(current.content);
    const winner = results.find(result => result.status === 'fulfilled');
    expect(winner).toMatchObject({ value: current.token });
  });

  it('reports transaction deadlocks and serialization aborts as recoverable head conflicts', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));
    const original = buildMemoryContent('aborted-write');
    const id = await layer.writeContent('memories', 'aborted-write', original, metadata);
    const before = await layer.readHeadSnapshot(id);
    for (const code of ['40P01', '40001']) {
      const testLayer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));
      const cause = Object.assign(new Error('PostgreSQL aborted transaction'), { code });
      const internals = testLayer as unknown as { persistMemoryContent: () => Promise<never> };
      internals.persistMemoryContent = jest.fn().mockRejectedValue(cause);
      await expect(testLayer.writeHeadIfCurrent(before.token, 'aborted-write', original, metadata))
        .rejects.toMatchObject({ code: 'EHEADCONFLICT', cause });
    }
    expect(await layer.readHeadSnapshot(id)).toEqual(before);
  });

  it('rejects a token for a deleted owner even when its name is recreated', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));
    const id = await layer.writeContent('memories', 'recreated', buildMemoryContent('recreated'), metadata);
    const old = await layer.readHeadSnapshot(id);
    await layer.deleteContentByIdentity('memories', 'recreated', { id, name: 'recreated' });
    const replacement = buildMemoryContent('recreated', [{ id: 'keep', content: 'Keep' }]);
    const newId = await layer.writeContent('memories', 'recreated', replacement, metadata);

    await expect(layer.writeHeadIfCurrent(old.token, 'recreated', buildMemoryContent('recreated'), metadata))
      .rejects.toMatchObject({ code: 'ESTALE' });
    await expect(layer.readHeadSnapshot(id)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(layer.readContent(newId)).resolves.toBe(replacement);
  });

  it('renames one current owner, then rejects the old name token', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));
    const id = await layer.writeContent('memories', 'old-name', buildMemoryContent('old-name'), metadata);
    const old = await layer.readHeadSnapshot(id);
    const renamed = buildMemoryContent('new-name');
    const next = await layer.writeHeadIfCurrent(old.token, 'new-name', renamed, metadata);
    expect(next).toMatchObject({ ownerId: id, locator: id, name: 'new-name' });
    expect(await layer.readHeadSnapshot(id)).toEqual({ content: renamed, token: next });
    await expect(layer.resolveContentIdentity('memories', 'old-name')).resolves.toBeUndefined();
    await expect(layer.writeHeadIfCurrent(old.token, 'old-name', buildMemoryContent('old-name'), metadata))
      .rejects.toMatchObject({ code: 'ESTALE' });
    await expect(layer.writeHeadIfCurrent({ ...next, name: 'wrong-name' }, 'new-name', renamed, metadata))
      .rejects.toMatchObject({ code: 'ESTALE' });
    await expect(layer.writeHeadIfCurrent(next, '', renamed, metadata))
      .rejects.toThrow('Memory head name must be a non-empty string');
    expect(await layer.readHeadSnapshot(id)).toEqual({ content: renamed, token: next });
  });

  it('rejects another tenant and malformed revision tokens before writing', async () => {
    if (!dbAvailable) return;
    const userA = await ensureTestUser();
    const userB = await ensureTestUserB();
    const db = getTestDb();
    const layerA = new DatabaseMemoryStorageLayer(db, fixedUserId(userA));
    const layerB = new DatabaseMemoryStorageLayer(db, fixedUserId(userB));
    const original = buildMemoryContent('private-head');
    const id = await layerA.writeContent('memories', 'private-head', original, metadata);
    const snapshot = await layerA.readHeadSnapshot(id);
    await expect(layerB.readHeadSnapshot(id)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(layerB.writeHeadIfCurrent(snapshot.token, 'private-head', original, metadata))
      .rejects.toMatchObject({ code: 'ESTALE' });
    await expect(layerB.addEntry(id, { entryId: 'wrong-owner', timestamp: new Date(), content: 'Wrong' }))
      .rejects.toThrow();
    for (const invalid of ['0', '1'.repeat(1000), '1.5', '-1', '9223372036854775808']) {
      await expect(layerA.writeHeadIfCurrent({ ...snapshot.token, revision: invalid }, 'private-head', original, metadata))
        .rejects.toMatchObject({ code: 'ESTALE' });
    }
    await expect(layerA.readHeadSnapshot(id)).resolves.toEqual(snapshot);
  });

  it('invalidates a captured head token after direct child-entry mutation', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));
    const content = buildMemoryContent('child-entry');
    const id = await layer.writeContent('memories', 'child-entry', content, metadata);
    const old = await layer.readHeadSnapshot(id);
    await layer.addEntry(id, { entryId: 'direct', timestamp: new Date(), content: 'Direct child row' });

    // Direct child APIs do not rewrite raw YAML. A fresh snapshot must fail
    // closed too, rather than gaining a current token over stale raw entries.
    await expect(layer.readHeadSnapshot(id)).rejects.toMatchObject({ code: 'EHEADOUTOFSYNC' });
    await expect(layer.writeHeadIfCurrent(old.token, 'child-entry', content, metadata))
      .rejects.toMatchObject({ code: 'ESTALE' });
    expect((await layer.getEntries(id)).map(entry => entry.entryId)).toEqual(['direct']);
  });

  it('keeps parent deletion valid when its child rows cascade away', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));
    const content = buildMemoryContent('cascade-head', [{ id: 'one', content: 'One' }]);
    const id = await layer.writeContent('memories', 'cascade-head', content, metadata);
    await layer.deleteContentByIdentity('memories', 'cascade-head', { id, name: 'cascade-head' });
    await expect(layer.readHeadSnapshot(id)).rejects.toMatchObject({ code: 'ENOENT' });
    const remaining = await withUserContext(getTestDb(), userId, tx => tx.select({ id: memoryEntries.id })
      .from(memoryEntries).where(eq(memoryEntries.memoryId, id)));
    expect(remaining).toHaveLength(0);
  });

  it('synchronizes a representative many-entry head and returns its final revision', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));
    const first = buildMemoryContent('many-entries', [{ id: 'initial', content: 'Initial' }]);
    const id = await layer.writeContent('memories', 'many-entries', first, metadata);
    const before = await layer.readHeadSnapshot(id);
    const entries = Array.from({ length: 200 }, (_, i) => ({ id: `entry-${i}`, content: `Content ${i}` }));
    const next = buildMemoryContent('many-entries', entries);
    const saved = await layer.writeHeadIfCurrent(before.token, 'many-entries', next, metadata);
    expect(BigInt(saved.revision)).toBeGreaterThan(BigInt(before.token.revision) + 200n);
    expect((await layer.getEntries(id, { limit: 201 })).map(entry => entry.entryId)).toHaveLength(200);
    expect(await layer.readHeadSnapshot(id)).toEqual({ content: next, token: saved });
  });

  it('keeps existing or externally edited heads unqualified until an explicit full sync', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const content = buildMemoryContent('legacy-head');
    // This models an existing row when migration 0056 supplies its default.
    const [row] = await withUserContext(db, userId, tx => tx.insert(elements).values({
      userId, rawContent: content, contentHash: '0'.repeat(64),
      byteSize: Buffer.byteLength(content), elementType: 'memories', name: 'legacy-head',
    }).returning({ id: elements.id }));
    await expect(layer.readHeadSnapshot(row.id)).rejects.toMatchObject({ code: 'EHEADOUTOFSYNC' });

    await layer.writeContent('memories', 'legacy-head', content, metadata);
    const qualified = await layer.readHeadSnapshot(row.id);
    expect(qualified.content).toBe(content);

    await withUserContext(db, userId, tx => tx.update(elements)
      .set({ rawContent: buildMemoryContent('legacy-head', [{ id: 'external', content: 'External' }]) })
      .where(eq(elements.id, row.id)));
    await expect(layer.readHeadSnapshot(row.id)).rejects.toMatchObject({ code: 'EHEADOUTOFSYNC' });
  });

  it('rolls back a failed child sync with the parent content and revision', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));
    const original = buildMemoryContent('rollback', [{ id: 'keep', content: 'Keep' }]);
    const id = await layer.writeContent('memories', 'rollback', original, metadata);
    const before = await layer.readHeadSnapshot(id);
    const bad = buildMemoryContent('rollback', [{ id: 'x'.repeat(256), content: 'Cannot fit varchar' }]);

    await expect(layer.writeHeadIfCurrent(before.token, 'rollback', bad, metadata)).rejects.toThrow();
    expect(await layer.readHeadSnapshot(id)).toEqual(before);
    expect((await layer.getEntries(id)).map(entry => entry.entryId)).toEqual(['keep']);
  });
});
