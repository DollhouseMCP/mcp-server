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
    expect(entries.map(e => e.entryId).sort()).toEqual(['entry-1', 'entry-2']);
    expect(entries[0].content).toBeTruthy();
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
    expect(entries.map(e => e.entryId).sort()).toEqual(['e1', 'e3']);
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
