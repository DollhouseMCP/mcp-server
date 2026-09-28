import { eq } from 'drizzle-orm';
import { withUserContext } from '../../../src/database/rls.js';
import { elements } from '../../../src/database/schema/elements.js';
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
      withUserContext(db, userId, tx => tx.update(elements)
        .set({ rawContent: newContent })
        .where(eq(elements.id, id))),
    ]);
    const after = await layer.readHeadSnapshot(id);
    expect(after.content).toBe(newContent);
    expect(BigInt(after.token.revision)).toBe(BigInt(before.token.revision) + 1n);
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
    const a = buildMemoryContent('aba');
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

    const current = await layer.readHeadSnapshot(id);
    expect(current.content).toBe(content); // Child API does not rewrite raw YAML.
    expect(BigInt(current.token.revision)).toBeGreaterThan(BigInt(old.token.revision));
    await expect(layer.writeHeadIfCurrent(old.token, 'child-entry', content, metadata))
      .rejects.toMatchObject({ code: 'ESTALE' });
    expect((await layer.getEntries(id)).map(entry => entry.entryId)).toEqual(['direct']);
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
