/**
 * Integration tests for DatabaseStorageLayer.
 * Tests the full element CRUD path against real Docker PostgreSQL.
 */

import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import {
  buildSkillContent,
  cleanupAllTestData,
  closeTestDb,
  ensureTestUser,
  ensureTestUserB,
  fixedUserId,
  getTestDb,
  isDatabaseAvailable,
} from './test-db-helpers.js';

let dbAvailable = false;

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    console.warn('Skipping DatabaseStorageLayer tests — PostgreSQL not available');
  }
});

afterEach(async () => {
  if (dbAvailable) await cleanupAllTestData();
});

afterAll(async () => {
  await closeTestDb();
});

describe('DatabaseStorageLayer', () => {
  // ── writeContent + readContent ────────────────────────────────────

  it('should write and read back content with byte-for-byte fidelity', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    const content = buildSkillContent('round-trip-skill', {
      description: 'Tests round-trip fidelity',
      tags: ['test', 'roundtrip'],
    });

    const elementId = await layer.writeContent('skills', 'round-trip-skill', content, {
      author: 'test-author', version: '1.0.0',
      description: 'Tests round-trip fidelity', tags: ['test', 'roundtrip'],
    });

    expect(elementId).toBeTruthy();
    expect(typeof elementId).toBe('string');

    // Read back and verify byte-for-byte fidelity
    const readBack = await layer.readContent(elementId);
    expect(readBack).toBe(content);
  });

  it('should update an existing element on conflict', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    const contentV1 = buildSkillContent('update-skill', { version: '1.0.0' });
    const id1 = await layer.writeContent('skills', 'update-skill', contentV1, {
      author: 'test-author', version: '1.0.0', description: 'v1', tags: [],
    });

    const contentV2 = buildSkillContent('update-skill', { version: '2.0.0' });
    const id2 = await layer.writeContent('skills', 'update-skill', contentV2, {
      author: 'test-author', version: '2.0.0', description: 'v2', tags: [],
    });

    // Same element, same ID (upsert, not duplicate)
    expect(id2).toBe(id1);

    // Read back should return v2 content
    const readBack = await layer.readContent(id2);
    expect(readBack).toBe(contentV2);
  });

  it('rejects canonical-equivalent names across database replicas', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const replicas = [
      new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills'),
      new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills'),
    ];
    const results = await Promise.allSettled([
      replicas[0].writeContent('skills', 'Foo Bar', buildSkillContent('Foo Bar'), {
        author: 'test', version: '1.0.0', description: '', tags: [],
      }, { exclusive: true, elementLabel: 'Skill' }),
      replicas[1].writeContent('skills', 'foo_bar', buildSkillContent('foo_bar'), {
        author: 'test', version: '1.0.0', description: '', tags: [],
      }, { exclusive: true, elementLabel: 'Skill' }),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });

  it('compare-and-swaps exact definition bytes and rejects a stale expected value', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const original = buildSkillContent('cas-skill', { description: 'original' });
    const replacement = buildSkillContent('cas-skill', { description: 'replacement' });
    const elementId = await layer.writeContent('skills', 'cas-skill', original, {
      author: 'test', version: '1.0.0', description: 'original', tags: [],
    });

    await expect(layer.compareAndSwapContent(
      'skills',
      elementId,
      'cas-skill',
      `${original}\n`,
      replacement,
      { author: 'test', version: '1.0.0', description: 'replacement', tags: [] },
    )).resolves.toBe(false);
    await expect(layer.readContent(elementId)).resolves.toBe(original);

    await expect(layer.compareAndSwapContent(
      'skills',
      elementId,
      'cas-skill',
      original,
      replacement,
      { author: 'test', version: '1.0.0', description: 'replacement', tags: [] },
    )).resolves.toBe(true);
    await expect(layer.readContent(elementId)).resolves.toBe(replacement);
  });

  it('compare-and-swaps a rename from a fresh replica without relying on its local name cache', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const writer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const freshReplica = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const original = buildSkillContent('before-rename', { description: 'original' });
    const replacement = buildSkillContent('after-rename', { description: 'renamed' });
    const elementId = await writer.writeContent('skills', 'before-rename', original, {
      author: 'test', version: '1.0.0', description: 'original', tags: [],
    });

    await expect(freshReplica.compareAndSwapContent(
      'skills',
      elementId,
      'after-rename',
      original,
      replacement,
      { author: 'test', version: '1.0.0', description: 'renamed', tags: [] },
    )).resolves.toBe(true);

    expect(freshReplica.getPathByName('before-rename')).toBeUndefined();
    expect(freshReplica.getPathByName('after-rename')).toBe(elementId);
    await expect(freshReplica.readContent(elementId)).resolves.toBe(replacement);
  });

  it('should use the caller-provided name over frontmatter name', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    // Frontmatter says "yaml-name", caller says "caller-name"
    const content = buildSkillContent('yaml-name');
    const elementId = await layer.writeContent('skills', 'caller-name', content, {
      author: '', version: '', description: '', tags: [],
    });

    // Should be findable by the caller-provided name
    expect(layer.getPathByName('caller-name')).toBe(elementId);
  });

  // ── deleteContent ─────────────────────────────────────────────────

  it('should delete an element by name', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    const content = buildSkillContent('delete-me');
    await layer.writeContent('skills', 'delete-me', content, {
      author: '', version: '', description: '', tags: [],
    });

    expect(layer.getPathByName('delete-me')).toBeDefined();

    await layer.deleteContent('skills', 'delete-me');

    expect(layer.getPathByName('delete-me')).toBeUndefined();
  });

  it('conditionally deletes exact definition bytes and preserves a concurrently changed row', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const firstReplica = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const secondReplica = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const original = buildSkillContent('conditional-delete', { description: 'original' });
    const changed = buildSkillContent('conditional-delete', { description: 'changed elsewhere' });
    const elementId = await firstReplica.writeContent('skills', 'conditional-delete', original, {
      author: 'test', version: '1.0.0', description: 'original', tags: [],
    });
    await secondReplica.writeContent('skills', 'conditional-delete', changed, {
      author: 'test', version: '1.0.0', description: 'changed elsewhere', tags: [],
    });

    await expect(firstReplica.deleteContentIfUnchanged('skills', elementId, original)).resolves.toBe(false);
    await expect(firstReplica.readContent(elementId)).resolves.toBe(changed);
    await expect(firstReplica.deleteContentIfUnchanged('skills', elementId, changed)).resolves.toBe(true);
    await expect(firstReplica.readContent(elementId)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes another replica\'s deletion from the local index on the next scan', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const observingReplica = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const deletingReplica = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const content = buildSkillContent('replica-delete');
    await observingReplica.writeContent('skills', 'replica-delete', content, {
      author: 'test', version: '1.0.0', description: 'delete scan', tags: [],
    });
    await observingReplica.scan();
    expect(observingReplica.getPathByName('replica-delete')).toBeDefined();

    await deletingReplica.deleteContent('skills', 'replica-delete');
    const diff = await observingReplica.scan();

    expect(diff.removed).toHaveLength(1);
    expect(observingReplica.getPathByName('replica-delete')).toBeUndefined();
  });

  it('should return ENOENT when reading a deleted element', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    const content = buildSkillContent('will-delete');
    const elementId = await layer.writeContent('skills', 'will-delete', content, {
      author: '', version: '', description: '', tags: [],
    });

    await layer.deleteContent('skills', 'will-delete');

    await expect(layer.readContent(elementId)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // ── scan ──────────────────────────────────────────────────────────

  it('should detect added elements on first scan', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    await layer.writeContent('skills', 'scan-a', buildSkillContent('scan-a'), {
      author: '', version: '', description: '', tags: [],
    });
    await layer.writeContent('skills', 'scan-b', buildSkillContent('scan-b'), {
      author: '', version: '', description: '', tags: [],
    });

    // New layer instance — no prior state
    const freshLayer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const diff = await freshLayer.scan();

    expect(diff.added).toHaveLength(2);
    expect(diff.modified).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('keeps scan indexes isolated when one shared layer serves different users', async () => {
    if (!dbAvailable) return;
    const userA = await ensureTestUser();
    const userB = await ensureTestUserB();
    let activeUserId = userA;
    const sharedLayer = new DatabaseStorageLayer(getTestDb(), () => activeUserId, 'skills');
    const writerA = new DatabaseStorageLayer(getTestDb(), fixedUserId(userA), 'skills');
    const writerB = new DatabaseStorageLayer(getTestDb(), fixedUserId(userB), 'skills');
    const idA = await writerA.writeContent('skills', 'user-a-skill', buildSkillContent('user-a-skill'), {
      author: '', version: '', description: '', tags: [],
    });
    const idB = await writerB.writeContent('skills', 'user-b-skill', buildSkillContent('user-b-skill'), {
      author: '', version: '', description: '', tags: [],
    });

    await sharedLayer.scan();
    expect(sharedLayer.getPathByName('user-a-skill')).toBe(idA);
    expect(sharedLayer.getPathByName('user-b-skill')).toBeUndefined();

    activeUserId = userB;
    await sharedLayer.scan();
    expect(sharedLayer.getPathByName('user-a-skill')).toBeUndefined();
    expect(sharedLayer.getPathByName('user-b-skill')).toBe(idB);

    activeUserId = userA;
    expect(sharedLayer.getPathByName('user-a-skill')).toBe(idA);
    expect(sharedLayer.getPathByName('user-b-skill')).toBeUndefined();
  });

  it('detects a replica addition after an earlier scan and then reports the stable row unchanged', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const observingReplica = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const writingReplica = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    await expect(observingReplica.scan()).resolves.toMatchObject({ added: [] });
    const elementId = await writingReplica.writeContent(
      'skills',
      'late-commit-visible',
      buildSkillContent('late-commit-visible'),
      { author: '', version: '', description: '', tags: [] },
    );

    await expect(observingReplica.scan()).resolves.toMatchObject({ added: [elementId] });
    await expect(observingReplica.scan()).resolves.toMatchObject({
      added: [],
      modified: [],
      removed: [],
      unchanged: [elementId],
    });
  });

  it('should detect removals on full scan after invalidate', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseStorageLayer(db, fixedUserId(userId), 'skills');

    await layer.writeContent('skills', 'will-remove', buildSkillContent('will-remove'), {
      author: '', version: '', description: '', tags: [],
    });

    // Initial scan populates the index
    await layer.scan();
    expect(layer.getPathByName('will-remove')).toBeDefined();

    // Simulate external deletion: delete from DB directly via a DIFFERENT
    // layer instance (bypassing this layer's index update)
    const externalLayer = new DatabaseStorageLayer(db, fixedUserId(userId), 'skills');
    await externalLayer.deleteContent('skills', 'will-remove');

    // Invalidate to force full scan — should detect the external removal
    layer.invalidate();
    const diff = await layer.scan();

    expect(diff.removed).toHaveLength(1);
    expect(layer.getPathByName('will-remove')).toBeUndefined();
  });

  // ── listSummaries ─────────────────────────────────────────────────

  it('should list summaries with correct metadata and tags', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    await layer.writeContent('skills', 'listed-skill', buildSkillContent('listed-skill', {
      description: 'A listed skill',
      author: 'tester',
      version: '3.0.0',
      tags: ['alpha', 'beta'],
    }), {
      author: 'tester', version: '3.0.0',
      description: 'A listed skill', tags: ['alpha', 'beta'],
    });

    const summaries = await layer.listSummaries();

    expect(summaries).toHaveLength(1);
    const s = summaries[0];
    expect(s.name).toBe('listed-skill');
    expect(s.description).toBe('A listed skill');
    expect(s.author).toBe('tester');
    expect(s.version).toBe('3.0.0');
    expect(s.tags).toEqual(expect.arrayContaining(['alpha', 'beta']));
    expect(s.sizeBytes).toBeGreaterThan(0);
    expect(s.mtimeMs).toBeGreaterThan(0);
  });

  it('should not list elements from a different element type', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const skillLayer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const agentLayer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'agents');

    await skillLayer.writeContent('skills', 'only-skill', buildSkillContent('only-skill'), {
      author: '', version: '', description: '', tags: [],
    });

    const agentSummaries = await agentLayer.listSummaries();
    expect(agentSummaries).toHaveLength(0);
  });

  // ── getPathByName + getNameById ───────────────────────────────────

  it('should maintain bidirectional name-to-id index', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    const elementId = await layer.writeContent('skills', 'indexed-skill', buildSkillContent('indexed-skill'), {
      author: '', version: '', description: '', tags: [],
    });

    expect(layer.getPathByName('indexed-skill')).toBe(elementId);
    expect(layer.getNameById(elementId)).toBe('indexed-skill');
  });

  // ── clear / invalidate ────────────────────────────────────────────

  it('should clear all state', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    await layer.writeContent('skills', 'clear-test', buildSkillContent('clear-test'), {
      author: '', version: '', description: '', tags: [],
    });

    layer.clear();

    expect(layer.getPathByName('clear-test')).toBeUndefined();
    expect(layer.hasCompletedScan()).toBe(false);
  });

  // ── body content extraction ───────────────────────────────────────

  it('should extract body content from frontmatter', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const db = getTestDb();

    const content = buildSkillContent('body-test');
    const elementId = await layer.writeContent('skills', 'body-test', content, {
      author: '', version: '', description: '', tags: [],
    });

    // Query body_content via RLS-scoped transaction
    const { withUserRead } = await import('../../../src/database/rls.js');
    const { elements: elemTable } = await import('../../../src/database/schema/elements.js');
    const { eq: eqOp } = await import('drizzle-orm');
    const rows = await withUserRead(db, userId, async (tx) =>
      tx.select({ bodyContent: elemTable.bodyContent }).from(elemTable).where(eqOp(elemTable.id, elementId))
    );

    expect(rows[0].bodyContent).toContain('This is the body content for body-test');
  });
});
