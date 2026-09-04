/**
 * Integration tests for DatabaseMemoryStorageLayer.
 * Tests memory-specific storage including entry sync, entry-level ops,
 * and memory-specific metadata against real Docker PostgreSQL.
 */

import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { buildMemoryContent, cleanupAllTestData, closeTestDb, ensureTestUser, fixedUserId, getTestDb, isDatabaseAvailable } from './test-db-helpers.js';

let dbAvailable = false;

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    console.warn('Skipping DatabaseMemoryStorageLayer tests — PostgreSQL not available');
  }
});

afterEach(async () => {
  if (dbAvailable) await cleanupAllTestData();
});

afterAll(async () => {
  await closeTestDb();
});

describe('DatabaseMemoryStorageLayer', () => {
  // ── writeContent + readContent ────────────────────────────────────

  it('should write and read back memory content', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));

    const content = buildMemoryContent('test-memory');
    const elementId = await layer.writeContent('memories', 'test-memory', content, {
      author: 'test-author', version: '1.0.0',
      description: 'Test memory', tags: ['test'],
    });

    expect(elementId).toBeTruthy();

    const readBack = await layer.readContent(elementId);
    expect(readBack).toBe(content);
  });

  // ── Entry sync (within same transaction) ──────────────────────────

  it('should sync entries from YAML content atomically', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));

    const content = buildMemoryContent('entry-memory', [
      { id: 'entry-1', content: 'First entry' },
      { id: 'entry-2', content: 'Second entry' },
    ]);

    const elementId = await layer.writeContent('memories', 'entry-memory', content, {
      author: '', version: '', description: '', tags: [],
    });

    const entries = await layer.getEntries(elementId);
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.entryId).sort((a, b) => a.localeCompare(b))).toEqual(['entry-1', 'entry-2']);
    expect(entries[0].content).toBeTruthy();
  });

  it('should sync entries for memories whose YAML exceeds 64KB (#2329)', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));

    // Issue #2329: memories up to MAX_YAML_SIZE (256KB) are valid; entry sync
    // previously parsed with a 64KB frontmatter cap and silently skipped,
    // leaving memory_entries stale while the element row persisted.
    const bigText = 'research finding lorem ipsum dolor sit amet '.repeat(400);
    const content = buildMemoryContent('large-memory-2329', Array.from({ length: 6 }, (_, i) => ({
      id: `big-entry-${i}`,
      content: `entry-${i} ${bigText}`,
    })));
    expect(content.length).toBeGreaterThan(64 * 1024);

    const elementId = await layer.writeContent('memories', 'large-memory-2329', content, {
      author: '', version: '', description: '', tags: [],
    });

    const entries = await layer.getEntries(elementId);
    expect(entries).toHaveLength(6);

    const summaries = await layer.listSummaries();
    const summary = summaries.find(s => s.name === 'large-memory-2329');
    expect(summary?.totalEntries).toBe(6);
  });

  it('should replace entries on update (not duplicate)', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));

    const contentV1 = buildMemoryContent('replace-memory', [
      { id: 'e1', content: 'Old' },
      { id: 'e2', content: 'Also old' },
    ]);
    const elementId = await layer.writeContent('memories', 'replace-memory', contentV1, {
      author: '', version: '', description: '', tags: [],
    });

    const contentV2 = buildMemoryContent('replace-memory', [
      { id: 'e1', content: 'New' },
      { id: 'e3', content: 'Brand new' },
    ]);
    await layer.writeContent('memories', 'replace-memory', contentV2, {
      author: '', version: '', description: '', tags: [],
    });

    const entries = await layer.getEntries(elementId);
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.entryId).sort((a, b) => a.localeCompare(b))).toEqual(['e1', 'e3']);
  });

  // ── Entry-level operations ────────────────────────────────────────

  it('should add individual entries', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));

    const content = buildMemoryContent('add-entry-memory');
    const elementId = await layer.writeContent('memories', 'add-entry-memory', content, {
      author: '', version: '', description: '', tags: [],
    });

    await layer.addEntry(elementId, {
      entryId: 'manual-1',
      timestamp: new Date(),
      content: 'Manually added entry',
      tags: ['manual'],
    });

    const entries = await layer.getEntries(elementId);
    expect(entries.some(e => e.entryId === 'manual-1')).toBe(true);
  });

  it('should remove individual entries', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));

    const content = buildMemoryContent('remove-entry-memory', [
      { id: 'keep', content: 'Keep this' },
      { id: 'remove', content: 'Remove this' },
    ]);
    const elementId = await layer.writeContent('memories', 'remove-entry-memory', content, {
      author: '', version: '', description: '', tags: [],
    });

    await layer.removeEntry(elementId, 'remove');

    const entries = await layer.getEntries(elementId);
    expect(entries).toHaveLength(1);
    expect(entries[0].entryId).toBe('keep');
  });

  it('should upsert entries via addEntry (not duplicate)', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));

    const content = buildMemoryContent('upsert-entry-memory');
    const elementId = await layer.writeContent('memories', 'upsert-entry-memory', content, {
      author: '', version: '', description: '', tags: [],
    });

    await layer.addEntry(elementId, {
      entryId: 'dup', timestamp: new Date(), content: 'Version 1',
    });
    await layer.addEntry(elementId, {
      entryId: 'dup', timestamp: new Date(), content: 'Version 2',
    });

    const entries = await layer.getEntries(elementId);
    const dup = entries.filter(e => e.entryId === 'dup');
    expect(dup).toHaveLength(1);
    expect(dup[0].content).toBe('Version 2');
  });

  // ── deleteContent ─────────────────────────────────────────────────

  it('should cascade-delete entries when memory is deleted', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));

    const content = buildMemoryContent('cascade-memory', [
      { id: 'e1', content: 'Entry 1' },
    ]);
    const elementId = await layer.writeContent('memories', 'cascade-memory', content, {
      author: '', version: '', description: '', tags: [],
    });

    await layer.deleteContent('memories', 'cascade-memory');

    // Entries should be gone too (cascade)
    await expect(layer.readContent(elementId)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deletes a canonical alias by its authorized durable identity', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));
    const rawName = 'Atomic_Memory';
    const elementId = await layer.writeContent('memories', rawName, buildMemoryContent(rawName), {
      author: '', version: '', description: '', tags: [],
    });
    const identity = await layer.resolveContentIdentity('memories', 'atomic-memory');
    expect(identity).toEqual({ id: elementId, name: rawName });

    await expect(layer.deleteContentByIdentity('memories', 'atomic-memory', identity))
      .resolves.toEqual(identity);
    await expect(layer.readContent(elementId)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when a memory identity changes before its authorized delete', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const externalLayer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));
    const rawName = 'Stale_Memory';
    const originalId = await layer.writeContent('memories', rawName, buildMemoryContent(rawName), {
      author: '', version: '', description: '', tags: [],
    });
    const identity = await layer.resolveContentIdentity('memories', 'stale-memory');
    expect(identity).toEqual({ id: originalId, name: rawName });
    const siblingId = await externalLayer.writeContent(
      'memories', 'stale-memory', buildMemoryContent('stale-memory'),
      { author: '', version: '', description: '', tags: [] },
    );

    await expect(layer.deleteContentByIdentity('memories', 'stale-memory', identity))
      .rejects.toMatchObject({ code: 'ESTALE' });
    await expect(layer.readContent(originalId)).resolves.toBeTruthy();
    await expect(layer.readContent(siblingId)).resolves.toBeTruthy();
  });

  it('reports ENOENT instead of succeeding when no memory row is deleted', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));

    await expect(layer.deleteContent('memories', 'missing-memory'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  // ── listSummaries with totalEntries ───────────────────────────────

  it('should include totalEntries count in summaries', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));

    const content = buildMemoryContent('counted-memory', [
      { id: 'e1', content: 'One' },
      { id: 'e2', content: 'Two' },
      { id: 'e3', content: 'Three' },
    ]);
    await layer.writeContent('memories', 'counted-memory', content, {
      author: '', version: '', description: '', tags: ['test'],
    });

    const summaries = await layer.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].totalEntries).toBe(3);
    expect(summaries[0].memoryType).toBe('user');
    expect(summaries[0].tags).toContain('test');
  });

  // ── purgeExpiredEntries ───────────────────────────────────────────

  it('should purge expired entries', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));

    const content = buildMemoryContent('expiry-memory');
    const elementId = await layer.writeContent('memories', 'expiry-memory', content, {
      author: '', version: '', description: '', tags: [],
    });

    // Add an already-expired entry
    await layer.addEntry(elementId, {
      entryId: 'expired',
      timestamp: new Date(),
      content: 'Expired content',
      expiresAt: new Date(Date.now() - 60000), // 1 minute ago
    });

    // Add a non-expired entry
    await layer.addEntry(elementId, {
      entryId: 'fresh',
      timestamp: new Date(),
      content: 'Fresh content',
    });

    const purged = await layer.purgeExpiredEntries();
    expect(purged).toBe(1);

    const entries = await layer.getEntries(elementId);
    expect(entries).toHaveLength(1);
    expect(entries[0].entryId).toBe('fresh');
  });

  // ── Memory YAML without entries ───────────────────────────────────

  it('should handle memory content with no entries section', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));

    const content = buildMemoryContent('no-entries-memory');
    const elementId = await layer.writeContent('memories', 'no-entries-memory', content, {
      author: '', version: '', description: '', tags: [],
    });

    const entries = await layer.getEntries(elementId);
    expect(entries).toHaveLength(0);
  });
});
