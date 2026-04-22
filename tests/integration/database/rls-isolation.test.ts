/**
 * Integration tests for RLS-based user isolation.
 * Verifies that user A cannot see user B's elements, tags,
 * or relationships when using the database storage layers.
 */

import { eq, sql } from 'drizzle-orm';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { withUserContext, withUserRead } from '../../../src/database/rls.js';
import { elements } from '../../../src/database/schema/elements.js';
import { buildMemoryContent, buildSkillContent, cleanupAllTestData, closeTestDb, ensureTestUser, ensureTestUserB, fixedUserId, getTestDb, isDatabaseAvailable } from './test-db-helpers.js';

let dbAvailable = false;

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    console.warn('Skipping RLS isolation tests — PostgreSQL not available');
  }
});

afterEach(async () => {
  if (dbAvailable) await cleanupAllTestData();
});

afterAll(async () => {
  await closeTestDb();
});

describe('RLS User Isolation', () => {
  it('should isolate elements: user A cannot see user B skills', async () => {
    if (!dbAvailable) return;
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();

    const layerA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
    const layerB = new DatabaseStorageLayer(db, fixedUserId(userIdB), 'skills');

    // User A creates a skill
    await layerA.writeContent('skills', 'secret-skill', buildSkillContent('secret-skill', {
      description: 'User A only',
    }), {
      author: 'userA', version: '1.0.0', description: 'User A only', tags: ['private'],
    });

    // User B creates a different skill
    await layerB.writeContent('skills', 'public-skill', buildSkillContent('public-skill', {
      description: 'User B only',
    }), {
      author: 'userB', version: '1.0.0', description: 'User B only', tags: ['public'],
    });

    // User A should only see their own skill
    const summariesA = await layerA.listSummaries();
    expect(summariesA).toHaveLength(1);
    expect(summariesA[0].name).toBe('secret-skill');

    // User B should only see their own skill
    const summariesB = await layerB.listSummaries();
    expect(summariesB).toHaveLength(1);
    expect(summariesB[0].name).toBe('public-skill');
  });

  it('should isolate scan results between users', async () => {
    if (!dbAvailable) return;
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();

    const layerA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
    const layerB = new DatabaseStorageLayer(db, fixedUserId(userIdB), 'skills');

    await layerA.writeContent('skills', 'a-skill', buildSkillContent('a-skill'), {
      author: '', version: '', description: '', tags: [],
    });
    await layerB.writeContent('skills', 'b-skill', buildSkillContent('b-skill'), {
      author: '', version: '', description: '', tags: [],
    });

    // Fresh layers to test scan
    const freshA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
    const freshB = new DatabaseStorageLayer(db, fixedUserId(userIdB), 'skills');

    const diffA = await freshA.scan();
    const diffB = await freshB.scan();

    expect(diffA.added).toHaveLength(1);
    expect(diffB.added).toHaveLength(1);

    // Each user's getPathByName should only resolve their own elements
    expect(freshA.getPathByName('a-skill')).toBeDefined();
    expect(freshA.getPathByName('b-skill')).toBeUndefined();
    expect(freshB.getPathByName('b-skill')).toBeDefined();
    expect(freshB.getPathByName('a-skill')).toBeUndefined();
  });

  it('should isolate readContent: user A cannot read user B content', async () => {
    if (!dbAvailable) return;
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();

    const layerA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
    const layerB = new DatabaseStorageLayer(db, fixedUserId(userIdB), 'skills');

    const elementIdB = await layerB.writeContent('skills', 'b-only', buildSkillContent('b-only'), {
      author: '', version: '', description: '', tags: [],
    });

    // User A trying to read User B's element by ID should get ENOENT
    await expect(layerA.readContent(elementIdB)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should isolate memory elements and entries', async () => {
    if (!dbAvailable) return;
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();

    const memLayerA = new DatabaseMemoryStorageLayer(db, fixedUserId(userIdA));
    const memLayerB = new DatabaseMemoryStorageLayer(db, fixedUserId(userIdB));

    const contentA = buildMemoryContent('memory-a', [
      { id: 'e1', content: 'User A secret' },
    ]);
    const elementIdA = await memLayerA.writeContent('memories', 'memory-a', contentA, {
      author: '', version: '', description: '', tags: [],
    });

    const contentB = buildMemoryContent('memory-b', [
      { id: 'e1', content: 'User B data' },
    ]);
    await memLayerB.writeContent('memories', 'memory-b', contentB, {
      author: '', version: '', description: '', tags: [],
    });

    // Each user sees only their memory
    const summariesA = await memLayerA.listSummaries();
    const summariesB = await memLayerB.listSummaries();
    expect(summariesA).toHaveLength(1);
    expect(summariesA[0].name).toBe('memory-a');
    expect(summariesB).toHaveLength(1);
    expect(summariesB[0].name).toBe('memory-b');

    // User B cannot access User A's entries
    const entriesB = await memLayerB.getEntries(elementIdA);
    expect(entriesB).toHaveLength(0);
  });

  it('should allow same element name for different users', async () => {
    if (!dbAvailable) return;
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();

    const layerA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
    const layerB = new DatabaseStorageLayer(db, fixedUserId(userIdB), 'skills');

    // Both users create a skill with the same name
    const idA = await layerA.writeContent('skills', 'common-name',
      buildSkillContent('common-name', { description: 'User A version' }), {
        author: 'A', version: '1.0.0', description: 'User A version', tags: [],
      });

    const idB = await layerB.writeContent('skills', 'common-name',
      buildSkillContent('common-name', { description: 'User B version' }), {
        author: 'B', version: '1.0.0', description: 'User B version', tags: [],
      });

    // Different IDs (different rows)
    expect(idA).not.toBe(idB);

    // Each user reads their own version
    const contentA = await layerA.readContent(idA);
    const contentB = await layerB.readContent(idB);
    expect(contentA).toContain('User A version');
    expect(contentB).toContain('User B version');
  });

  it('should not allow cross-user deletion', async () => {
    if (!dbAvailable) return;
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();

    const layerA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
    const layerB = new DatabaseStorageLayer(db, fixedUserId(userIdB), 'skills');

    await layerA.writeContent('skills', 'protected-skill', buildSkillContent('protected-skill'), {
      author: '', version: '', description: '', tags: [],
    });

    // User B tries to delete User A's skill — should silently fail (RLS blocks it)
    await layerB.deleteContent('skills', 'protected-skill');

    // User A's skill should still exist
    const summaries = await layerA.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].name).toBe('protected-skill');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Visibility-aware RLS (Phase 4.4 Piece 1)
//
// Migration 0005 split the single FOR ALL policy on elements into per-
// operation policies. SELECT now permits 'user_id = :me OR visibility =
// public'; INSERT/UPDATE/DELETE stay strictly owner-only. This block
// verifies the new semantics without asserting any MCP-surface change
// (discovery in list_elements is Piece 2, intentionally not wired here).
// ═══════════════════════════════════════════════════════════════════════════

describe('RLS visibility — public elements', () => {
  it('should allow cross-user readContent when visibility is public', async () => {
    if (!dbAvailable) return;
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();

    const layerA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
    const layerB = new DatabaseStorageLayer(db, fixedUserId(userIdB), 'skills');

    const publicId = await layerA.writeContent(
      'skills', 'public-skill', buildSkillContent('public-skill', { description: 'public one' }),
      { author: 'A', version: '1.0.0', description: 'public one', tags: [], visibility: 'public' },
    );

    // User B can read user A's public element by UUID
    const content = await layerB.readContent(publicId);
    expect(content).toContain('public-skill');
    expect(content).toContain('public one');
  });

  it('should still block cross-user readContent when visibility is private', async () => {
    if (!dbAvailable) return;
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();

    const layerA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
    const layerB = new DatabaseStorageLayer(db, fixedUserId(userIdB), 'skills');

    const privateId = await layerA.writeContent(
      'skills', 'secret-skill', buildSkillContent('secret-skill'),
      { author: 'A', version: '1.0.0', description: '', tags: [] }, // default visibility = private
    );

    await expect(layerB.readContent(privateId)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should not surface public elements in user B\'s listSummaries by default', async () => {
    if (!dbAvailable) return;
    // Default listing stays per-user-scoped — public discovery requires an
    // explicit include_public flag (Step 4.4 Piece 2).
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();

    const layerA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
    const layerB = new DatabaseStorageLayer(db, fixedUserId(userIdB), 'skills');

    await layerA.writeContent(
      'skills', 'public-on-A', buildSkillContent('public-on-A'),
      { author: 'A', version: '1.0.0', description: '', tags: [], visibility: 'public' },
    );

    const summariesB = await layerB.listSummaries();
    expect(summariesB.map(s => s.name)).not.toContain('public-on-A');
  });

  it('should surface public elements in user B\'s listSummaries when includePublic=true', async () => {
    if (!dbAvailable) return;
    // Piece 2: with the discovery flag set, listSummaries includes public
    // rows owned by other users (the RLS select policy from Piece 1 makes
    // them readable; listSummaries opens the predicate when asked).
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();

    const layerA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
    const layerB = new DatabaseStorageLayer(db, fixedUserId(userIdB), 'skills');

    // User A: one public skill + one private skill
    await layerA.writeContent(
      'skills', 'public-discoverable', buildSkillContent('public-discoverable'),
      { author: 'A', version: '1.0.0', description: '', tags: [], visibility: 'public' },
    );
    await layerA.writeContent(
      'skills', 'private-hidden', buildSkillContent('private-hidden'),
      { author: 'A', version: '1.0.0', description: '', tags: [] }, // private default
    );
    // User B: one own skill
    await layerB.writeContent(
      'skills', 'user-b-own-skill', buildSkillContent('user-b-own-skill'),
      { author: 'B', version: '1.0.0', description: '', tags: [] },
    );

    const summariesB = await layerB.listSummaries({ includePublic: true });
    const names = summariesB.map(s => s.name);

    expect(names).toContain('user-b-own-skill');      // own
    expect(names).toContain('public-discoverable');   // public from user A
    expect(names).not.toContain('private-hidden');    // private from user A — still hidden
  });

  it('should include tags for cross-user public elements (element_tags RLS 0006)', async () => {
    if (!dbAvailable) return;
    // Regression test for the security-review finding: before migration 0006,
    // element_tags RLS was strict owner-only, so cross-user public elements
    // came back with tags: [] silently. 0006 extends element_tags SELECT
    // to permit reads when the attached element is public.
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();

    const layerA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
    const layerB = new DatabaseStorageLayer(db, fixedUserId(userIdB), 'skills');

    await layerA.writeContent(
      'skills', 'tagged-public', buildSkillContent('tagged-public'),
      {
        author: 'A', version: '1.0.0', description: '',
        tags: ['verified', 'official'], // tags attached by owner
        visibility: 'public',
      },
    );

    const summariesB = await layerB.listSummaries({ includePublic: true });
    const tagged = summariesB.find(s => s.name === 'tagged-public');
    expect(tagged).toBeDefined();
    expect(tagged?.tags).toEqual(expect.arrayContaining(['verified', 'official']));
  });

  it('should not leak public elements through the per-manager cache across flag-off calls', async () => {
    if (!dbAvailable) return;
    // Regression test for the code-review finding: BaseElementManager's LRU
    // previously retained foreign public elements loaded during an
    // includePublic=true call. listFromDatabase now uncaches foreign rows
    // after loading, keyed on the userId returned in each summary.
    //
    // This test drives the eviction path through a real SkillManager (which
    // extends BaseElementManager) — the storage layer alone has no LRU, so
    // exercising listSummaries in isolation would pass regardless of
    // whether the eviction block works. We inspect the manager's internal
    // filePathToId map via `as any` because the cache is private and
    // there's no public accessor; adding one just for test peek would
    // leak storage internals into the API surface.
    const os = await import('node:os');
    const path = await import('node:path');
    const { SkillManager } = await import('../../../src/elements/skills/SkillManager.js');
    const { PortfolioManager } = await import('../../../src/portfolio/PortfolioManager.js');
    const { FileOperationsService } = await import('../../../src/services/FileOperationsService.js');
    const { FileLockManager } = await import('../../../src/security/fileLockManager.js');
    const { SerializationService } = await import('../../../src/services/SerializationService.js');
    const { ValidationRegistry } = await import('../../../src/services/validation/ValidationRegistry.js');
    const { ValidationService } = await import('../../../src/services/validation/ValidationService.js');
    const { TriggerValidationService } = await import('../../../src/services/validation/TriggerValidationService.js');
    const { MetadataService } = await import('../../../src/services/MetadataService.js');
    const { ElementEventDispatcher } = await import('../../../src/events/ElementEventDispatcher.js');

    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();

    // Seed user A's public skill via the raw storage layer (simpler than
    // standing up a second full manager just for the write side).
    const layerA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
    await layerA.writeContent(
      'skills', 'mgr-cache-leak-check', buildSkillContent('mgr-cache-leak-check'),
      { author: 'A', version: '1.0.0', description: '', tags: [], visibility: 'public' },
    );

    // Build a SkillManager that resolves userId to user B. The
    // PortfolioManager here points at a temp directory — it's not used for
    // element I/O since DB mode takes over, but PathValidator construction
    // requires a real directory.
    const tempDir = path.join(os.tmpdir(), `base-mgr-cache-${Date.now()}`);
    process.env.DOLLHOUSE_PORTFOLIO_DIR = tempDir;
    const fileLockManager = new FileLockManager();
    const fileOperations = new FileOperationsService(fileLockManager);
    const portfolioManager = new PortfolioManager(fileOperations, { baseDir: tempDir });
    await portfolioManager.initialize();
    const metadataService = new MetadataService();
    const validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService,
    );
    const { DatabaseStorageLayerFactory } = await import('../../../src/storage/DatabaseStorageLayerFactory.js');
    const skillManager = new SkillManager({
      portfolioManager,
      fileLockManager,
      fileOperationsService: fileOperations,
      validationRegistry,
      serializationService: new SerializationService(),
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
      getCurrentUserId: fixedUserId(userIdB),
      storageLayerFactory: new DatabaseStorageLayerFactory(db, fixedUserId(userIdB)),
    });

    try {
      // First call with flag on: foreign element is surfaced AND must be
      // loaded into the BaseElementManager's cache by load(). The eviction
      // block in listFromDatabase runs afterwards and removes it.
      const withFlag = await skillManager.list({ includePublic: true });
      const withFlagNames = withFlag.map(s => s.metadata.name);
      expect(withFlagNames).toContain('mgr-cache-leak-check');

      // After the eviction loop, the manager's filePathToId map must not
      // retain any mapping whose value is the foreign UUID. `filePathToId`
      // is private; cast to any to peek. We look up the foreign element's
      // UUID from the storage layer's index rather than hard-coding.
      // (If the eviction block is reverted, this assertion fails.)
      // After BaseElementManager decomposition, caches live on _cache service.
      const cacheService = (skillManager as unknown as {
        _cache: {
          filePathToId: { values(): IterableIterator<string> };
          elements: Map<string, unknown>;
        };
      });
      const cachedIds = [...cacheService._cache.filePathToId.values()];

      // Find the foreign element's UUID by querying layer A (user A owns it).
      const layerAforId = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
      const summariesA = await layerAforId.listSummaries();
      const foreignUuid = summariesA.find(s => s.name === 'mgr-cache-leak-check')?.filePath;
      expect(foreignUuid).toBeDefined();

      expect(cachedIds).not.toContain(foreignUuid);
      expect(cacheService._cache.elements.has(foreignUuid!)).toBe(false);

      // Second call with flag off: foreign element must not appear in results
      // (covered by the storage-layer test earlier, asserted here too to
      // keep the regression envelope tight).
      const withoutFlag = await skillManager.list();
      expect(withoutFlag.map(s => s.metadata.name)).not.toContain('mgr-cache-leak-check');
    } finally {
      const fs = await import('node:fs/promises');
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should return tags=[] for public elements when includePublic is off (tags only on request)', async () => {
    if (!dbAvailable) return;
    // Negative case for the tag-visibility behavior: without the discovery
    // flag, user B's own-scoped list never sees user A's public row or its
    // tags, regardless of the 0006 RLS change.
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();

    const layerA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
    const layerB = new DatabaseStorageLayer(db, fixedUserId(userIdB), 'skills');

    await layerA.writeContent(
      'skills', 'public-with-tags-off', buildSkillContent('public-with-tags-off'),
      { author: 'A', version: '1.0.0', description: '', tags: ['t1'], visibility: 'public' },
    );

    const summariesB = await layerB.listSummaries(); // flag off
    expect(summariesB.map(s => s.name)).not.toContain('public-with-tags-off');
  });

  it('file-mode ElementStorageLayer returns identical results with and without includePublic', async () => {
    // File-mode ElementStorageLayer accepts the flag but is a no-op today
    // (no shared/ directory exists yet; lands in Step 4.5). This test locks
    // the contract: the flag must not change observable behavior in file
    // mode until per-user file layout ships. Guards against accidental
    // divergence (e.g., someone wiring a file-mode shared path before the
    // broader 4.5 refactor is ready).
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const { ElementStorageLayer } = await import('../../../src/storage/ElementStorageLayer.js');
    const { FileOperationsService } = await import('../../../src/services/FileOperationsService.js');

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'element-storage-piece2-'));
    try {
      const fileOps = new FileOperationsService({} as never);
      const layer = new ElementStorageLayer(fileOps, {
        elementDir: tempDir,
        fileExtension: '.md',
      });

      const withoutFlag = await layer.listSummaries();
      const withFlag = await layer.listSummaries({ includePublic: true });

      // Both should be empty on a fresh tempdir; key assertion is identity.
      expect(withFlag.map(s => s.name).sort()).toEqual(withoutFlag.map(s => s.name).sort());
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should not surface public elements in user B\'s getPathByName', async () => {
    if (!dbAvailable) return;
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();

    const layerA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
    const layerB = new DatabaseStorageLayer(db, fixedUserId(userIdB), 'skills');

    await layerA.writeContent(
      'skills', 'public-for-name-lookup', buildSkillContent('public-for-name-lookup'),
      { author: 'A', version: '1.0.0', description: '', tags: [], visibility: 'public' },
    );

    // Force a scan on layer B
    await layerB.scan();
    expect(layerB.getPathByName('public-for-name-lookup')).toBeUndefined();
  });

  it('should block cross-user UPDATE on a public row (raw SQL under user B)', async () => {
    if (!dbAvailable) return;
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();

    const layerA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
    const publicId = await layerA.writeContent(
      'skills', 'public-no-mutate', buildSkillContent('public-no-mutate', { description: 'original' }),
      { author: 'A', version: '1.0.0', description: 'original', tags: [], visibility: 'public' },
    );

    // User B tries to update user A's row directly. RLS elements_update policy
    // filters by owner, so UPDATE matches zero rows and returns no ids.
    const updatedIds = await withUserContext(db, userIdB, async (tx) =>
      tx.update(elements)
        .set({ description: 'hijacked' })
        .where(eq(elements.id, publicId))
        .returning({ id: elements.id }),
    );
    expect(updatedIds).toHaveLength(0);

    // User A confirms their row is untouched.
    const rows = await withUserRead(db, userIdA, async (tx) =>
      tx.select({ description: elements.description })
        .from(elements)
        .where(eq(elements.id, publicId))
        .limit(1),
    );
    expect(rows[0]?.description).toBe('original');
  });

  it('should block cross-user DELETE on a public row (raw SQL under user B)', async () => {
    if (!dbAvailable) return;
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();

    const layerA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
    const publicId = await layerA.writeContent(
      'skills', 'public-no-delete', buildSkillContent('public-no-delete'),
      { author: 'A', version: '1.0.0', description: '', tags: [], visibility: 'public' },
    );

    const deletedIds = await withUserContext(db, userIdB, async (tx) =>
      tx.delete(elements)
        .where(eq(elements.id, publicId))
        .returning({ id: elements.id }),
    );
    expect(deletedIds).toHaveLength(0);

    // Row still there (via user A's read-context)
    const stillThere = await withUserRead(db, userIdA, async (tx) =>
      tx.select({ id: elements.id })
        .from(elements)
        .where(eq(elements.id, publicId))
        .limit(1),
    );
    expect(stillThere).toHaveLength(1);
  });

  it('should reject invalid visibility values via CHECK constraint', async () => {
    if (!dbAvailable) return;
    const userIdA = await ensureTestUser();
    const db = getTestDb();

    // Insert with an unsupported visibility literal — elements_visibility_check
    // in migration 0005 restricts the column to ('private', 'public'). Drizzle
    // wraps the pg error in its own "Failed query" wrapper, so we inspect the
    // chained cause to confirm it's the CHECK constraint specifically.
    let caught: Error | null = null;
    try {
      await withUserContext(db, userIdA, async (tx) =>
        tx.execute(sql`
          INSERT INTO elements (user_id, element_type, name, raw_content, content_hash, byte_size, visibility)
          VALUES (${userIdA}::uuid, 'skills', 'bad-visibility', 'body', 'h', 4, 'shared')
        `),
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    const combined = `${caught?.message ?? ''} ${(caught as { cause?: { message?: string; code?: string; constraint_name?: string } } | null)?.cause?.message ?? ''} ${(caught as { cause?: { constraint_name?: string } } | null)?.cause?.constraint_name ?? ''}`;
    const pgCode = (caught as { cause?: { code?: string } } | null)?.cause?.code;
    // Either the pg error code is 23514 (check_violation) or the text
    // mentions the constraint name. Both satisfy "CHECK constraint fired".
    expect(pgCode === '23514' || /elements_visibility_check|violates check/i.test(combined)).toBe(true);
  });

  it('should block INSERT that spoofs user_id to another user (WITH CHECK)', async () => {
    if (!dbAvailable) return;
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();

    // User B tries to insert a row claiming user A as owner. elements_insert's
    // WITH CHECK forces user_id to match the caller's app.current_user_id.
    // pg error code 42501 = insufficient_privilege (RLS policy violation).
    let caught: Error | null = null;
    try {
      await withUserContext(db, userIdB, async (tx) =>
        tx.execute(sql`
          INSERT INTO elements (user_id, element_type, name, raw_content, content_hash, byte_size, visibility)
          VALUES (${userIdA}::uuid, 'skills', 'spoofed', 'body', 'h', 4, 'private')
        `),
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    const pgCode = (caught as { cause?: { code?: string } } | null)?.cause?.code;
    const combined = `${caught?.message ?? ''} ${(caught as { cause?: { message?: string } } | null)?.cause?.message ?? ''}`;
    expect(pgCode === '42501' || /row-level security|violates row-level/i.test(combined)).toBe(true);
  });
});
