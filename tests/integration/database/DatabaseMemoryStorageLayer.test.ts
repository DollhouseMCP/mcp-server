/**
 * Integration tests for DatabaseMemoryStorageLayer.
 * Tests memory-specific storage including entry sync, entry-level ops,
 * and memory-specific metadata against real Docker PostgreSQL.
 */

import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { buildMemoryContent, cleanupAllTestData, closeTestDb, ensureTestUser, fixedUserId, getTestDb, isDatabaseAvailable } from './test-db-helpers.js';

const dbAvailable = await isDatabaseAvailable();
const databaseIt = dbAvailable ? it : it.skip;
if (!dbAvailable) {
  console.warn('Skipping DatabaseMemoryStorageLayer tests — PostgreSQL not available');
}

afterEach(async () => {
  if (dbAvailable) await cleanupAllTestData();
});

afterAll(async () => {
  await closeTestDb();
});

describe('DatabaseMemoryStorageLayer', () => {
  // ── writeContent + readContent ────────────────────────────────────

  databaseIt('should write and read back memory content', async () => {
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

  databaseIt('should sync entries from YAML content atomically', async () => {
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

  databaseIt('should sync entries for memories whose YAML exceeds 64KB (#2329)', async () => {
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));

    // Issue #2329/#2473: memories up to MAX_YAML_SIZE are valid; entry sync
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

  databaseIt('should replace entries on update (not duplicate)', async () => {
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

  databaseIt('rolls back the canonical row and entries when updated memory YAML cannot be parsed', async () => {
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));
    const original = buildMemoryContent('rollback-memory', [
      { id: 'original-entry', content: 'must survive' },
    ]);
    const elementId = await layer.writeContent('memories', 'rollback-memory', original, {
      author: '', version: '1.0.0', description: 'original', tags: [],
    });

    await expect(layer.writeContent(
      'memories',
      'rollback-memory',
      'metadata: [unterminated\nentries: []',
      { author: '', version: '2.0.0', description: 'bad update', tags: [] },
    )).rejects.toThrow();

    await expect(layer.readContent(elementId)).resolves.toBe(original);
    const entries = await layer.getEntries(elementId);
    expect(entries.map(entry => entry.entryId)).toEqual(['original-entry']);
    expect(entries[0]?.content).toBe('must survive');
  });

  databaseIt('rolls back instead of retaining stale normalized entries when entries is not an array', async () => {
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));
    const original = buildMemoryContent('invalid-entries-memory', [
      { id: 'original-entry', content: 'must survive' },
    ]);
    const elementId = await layer.writeContent('memories', 'invalid-entries-memory', original, {
      author: '', version: '1.0.0', description: 'original', tags: [],
    });

    const invalidUpdate = [
      'metadata:',
      '  name: invalid-entries-memory',
      'entries:',
      '  unexpected: object',
      '',
    ].join('\n');
    await expect(layer.writeContent('memories', 'invalid-entries-memory', invalidUpdate, {
      author: '', version: '2.0.0', description: 'bad update', tags: [],
    })).rejects.toThrow('Memory entries must be an array');

    await expect(layer.readContent(elementId)).resolves.toBe(original);
    await expect(layer.getEntries(elementId)).resolves.toEqual([
      expect.objectContaining({ entryId: 'original-entry', content: 'must survive' }),
    ]);
  });

  databaseIt('treats an omitted entries section as an empty replacement', async () => {
    const userId = await ensureTestUser();
    const layer = new DatabaseMemoryStorageLayer(getTestDb(), fixedUserId(userId));
    const original = buildMemoryContent('entries-removed-memory', [
      { id: 'old-entry', content: 'must be removed' },
    ]);
    const elementId = await layer.writeContent('memories', 'entries-removed-memory', original, {
      author: '', version: '1.0.0', description: 'original', tags: [],
    });

    const withoutEntries = [
      'name: entries-removed-memory',
      'description: replacement without entries',
      'version: 2.0.0',
      '',
    ].join('\n');
    await layer.writeContent('memories', 'entries-removed-memory', withoutEntries, {
      author: '', version: '2.0.0', description: 'replacement', tags: [],
    });

    await expect(layer.readContent(elementId)).resolves.toBe(withoutEntries);
    await expect(layer.getEntries(elementId)).resolves.toEqual([]);
  });

  // ── Entry-level operations ────────────────────────────────────────

  databaseIt('should add individual entries', async () => {
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

  databaseIt('should remove individual entries', async () => {
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

  databaseIt('should upsert entries via addEntry (not duplicate)', async () => {
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

  databaseIt('should cascade-delete entries when memory is deleted', async () => {
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

  databaseIt('should include totalEntries count in summaries', async () => {
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

  databaseIt('should purge expired entries', async () => {
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

  databaseIt('should handle memory content with no entries section', async () => {
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
