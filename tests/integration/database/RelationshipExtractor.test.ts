/**
 * Integration tests for RelationshipExtractor.
 * Tests relationship extraction and persistence for agents, templates,
 * and ensembles against real Docker PostgreSQL.
 */

import { eq } from 'drizzle-orm';
import { RelationshipExtractor } from '../../../src/storage/RelationshipExtractor.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { withUserRead } from '../../../src/database/rls.js';
import { elementRelationships } from '../../../src/database/schema/elements.js';
import { ensembleMembers } from '../../../src/database/schema/ensembles.js';
import { buildAgentContent, cleanupAllTestData, closeTestDb, ensureTestUser, fixedUserId, getTestDb, isDatabaseAvailable } from './test-db-helpers.js';

let dbAvailable = false;

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    console.warn('Skipping RelationshipExtractor tests — PostgreSQL not available');
  }
});

afterEach(async () => {
  if (dbAvailable) await cleanupAllTestData();
});

afterAll(async () => {
  await closeTestDb();
});

describe('RelationshipExtractor', () => {
  it('should extract agent activates relationships', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseStorageLayer(db, fixedUserId(userId), 'agents');

    const content = buildAgentContent('test-agent', {
      personas: ['helper-persona'],
      skills: ['code-review', 'debugging'],
    });

    const elementId = await layer.writeContent('agents', 'test-agent', content, {
      author: '', version: '', description: '', tags: [],
    });

    // Wait for fire-and-forget relationship extraction
    await new Promise(resolve => setTimeout(resolve, 500));

    // Query relationships via RLS-scoped transaction
    const rels = await withUserRead(db, userId, async (tx) =>
      tx.select().from(elementRelationships).where(eq(elementRelationships.sourceId, elementId))
    );

    expect(rels).toHaveLength(3);
    expect(rels.map(r => r.targetName).sort()).toEqual(['code-review', 'debugging', 'helper-persona']);
    expect(rels.every(r => r.relationship === 'activates')).toBe(true);
    expect(rels.every(r => r.userId === userId)).toBe(true);
  });

  it('should replace relationships on re-save (not accumulate)', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseStorageLayer(db, fixedUserId(userId), 'agents');

    const contentV1 = buildAgentContent('replace-agent', { skills: ['old-skill'] });
    const elementId = await layer.writeContent('agents', 'replace-agent', contentV1, {
      author: '', version: '', description: '', tags: [],
    });
    await new Promise(resolve => setTimeout(resolve, 500));

    const contentV2 = buildAgentContent('replace-agent', { skills: ['new-skill'] });
    await layer.writeContent('agents', 'replace-agent', contentV2, {
      author: '', version: '', description: '', tags: [],
    });
    await new Promise(resolve => setTimeout(resolve, 500));

    const rels = await withUserRead(db, userId, async (tx) =>
      tx.select().from(elementRelationships).where(eq(elementRelationships.sourceId, elementId))
    );

    expect(rels).toHaveLength(1);
    expect(rels[0].targetName).toBe('new-skill');
  });

  it('should not extract relationships for skills (no relationship fields)', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseStorageLayer(db, fixedUserId(userId), 'skills');

    const content = '---\nname: plain-skill\ndescription: No relationships\nauthor: test\nversion: 1.0.0\n---\nBody.';
    const elementId = await layer.writeContent('skills', 'plain-skill', content, {
      author: 'test', version: '1.0.0', description: 'No relationships', tags: [],
    });
    await new Promise(resolve => setTimeout(resolve, 500));

    const rels = await withUserRead(db, userId, async (tx) =>
      tx.select().from(elementRelationships).where(eq(elementRelationships.sourceId, elementId))
    );

    expect(rels).toHaveLength(0);
  });

  it('should handle soft integrity — extraction failure does not throw', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const extractor = new RelationshipExtractor(getTestDb(), fixedUserId(userId));

    // Pass a non-existent elementId — the FK constraint will fail
    // but extractAndPersist should catch and log, not throw
    await expect(
      extractor.extractAndPersist(
        '00000000-0000-4000-a000-000000000000', // non-existent
        'agents',
        { activates: { skills: ['some-skill'] } },
      )
    ).resolves.toBeUndefined(); // should not throw
  });

  it('should extract ensemble members', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseStorageLayer(db, fixedUserId(userId), 'ensembles');

    const content = [
      '---',
      'name: test-ensemble',
      'description: Test ensemble',
      'author: test',
      'version: 1.0.0',
      'members:',
      '  - name: helper',
      '    type: persona',
      '    role: primary',
      '    priority: 1',
      '    activation: always',
      '  - name: coder',
      '    type: skill',
      '    role: support',
      '    priority: 2',
      '    activation: on-demand',
      '---',
      'Ensemble body.',
    ].join('\n');

    const elementId = await layer.writeContent('ensembles', 'test-ensemble', content, {
      author: 'test', version: '1.0.0', description: 'Test ensemble', tags: [],
    });
    await new Promise(resolve => setTimeout(resolve, 500));

    const members = await withUserRead(db, userId, async (tx) =>
      tx.select().from(ensembleMembers).where(eq(ensembleMembers.ensembleId, elementId))
    );

    expect(members).toHaveLength(2);
    expect(members.map(m => m.memberName).sort()).toEqual(['coder', 'helper']);
    expect(members.find(m => m.memberName === 'helper')?.role).toBe('primary');
    expect(members.find(m => m.memberName === 'coder')?.activation).toBe('on-demand');
    expect(members.every(m => m.userId === userId)).toBe(true);
  });
});
