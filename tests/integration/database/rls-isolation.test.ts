/**
 * Integration tests for RLS-based user isolation.
 * Verifies that user A cannot see user B's elements, tags,
 * or relationships when using the database storage layers.
 */

import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
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
