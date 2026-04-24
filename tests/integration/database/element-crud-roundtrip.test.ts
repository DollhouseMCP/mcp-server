/**
 * End-to-End Element CRUD Round-Trip Integration Tests
 *
 * Tests the full lifecycle through actual element managers with database
 * storage: create → verify DB state → load → edit → verify DB updated →
 * load again → verify round-trip fidelity.
 *
 * Covers all 6 element types: personas, skills, templates, agents,
 * ensembles, and memories (YAML format with entries).
 *
 * These tests exercise the BaseElementManager DB branching code
 * (save/load/delete/list/exists) that production code uses.
 */

import { eq } from 'drizzle-orm';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { withUserRead } from '../../../src/database/rls.js';
import { elements, elementTags } from '../../../src/database/schema/elements.js';
import { memoryEntries } from '../../../src/database/schema/memories.js';
import { FrontmatterParser } from '../../../src/storage/FrontmatterParser.js';
import { SecureYamlParser } from '../../../src/security/secureYamlParser.js';
import { cleanupAllTestData, closeTestDb, ensureTestUser, fixedUserId, getTestDb, isDatabaseAvailable } from './test-db-helpers.js';

let dbAvailable = false;

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    console.warn('Skipping element CRUD round-trip tests — PostgreSQL not available');
  }
});

afterEach(async () => {
  if (dbAvailable) await cleanupAllTestData();
});

afterAll(async () => {
  await closeTestDb();
});

// ── Helpers ─────────────────────────────────────────────────────────

/** Query the elements table directly to verify DB column state. */
async function getElementRow(userId: string, elementId: string) {
  const db = getTestDb();
  return withUserRead(db, userId, async (tx) => {
    const rows = await tx.select().from(elements).where(eq(elements.id, elementId));
    return rows[0] ?? null;
  });
}

/** Query tags for an element. */
async function getElementTags(userId: string, elementId: string): Promise<string[]> {
  const db = getTestDb();
  return withUserRead(db, userId, async (tx) => {
    const rows = await tx
      .select({ tag: elementTags.tag })
      .from(elementTags)
      .where(eq(elementTags.elementId, elementId));
    return rows.map(r => r.tag).sort();
  });
}

/** Query memory entries count. */
async function getMemoryEntryCount(userId: string, memoryId: string): Promise<number> {
  const db = getTestDb();
  return withUserRead(db, userId, async (tx) => {
    const rows = await tx
      .select({ id: memoryEntries.id })
      .from(memoryEntries)
      .where(eq(memoryEntries.memoryId, memoryId));
    return rows.length;
  });
}

// ── Markdown Element Types (personas, skills, templates, agents, ensembles) ──

describe('Markdown Element Round-Trip', () => {
  const elementConfigs = [
    {
      type: 'personas',
      name: 'test-persona',
      buildContent: (name: string, desc: string, tags: string[], version = '1.0.0') => {
        const tagLines = tags.map(t => `  - ${t}`).join('\n');
        return [
          '---',
          `name: ${name}`,
          `description: ${desc}`,
          'author: test-author',
          `version: ${version}`,
          'type: persona',
          tags.length ? `tags:\n${tagLines}` : 'tags: []',
          '---',
          '',
          `Identity and behavioral profile for ${name}.`,
        ].join('\n');
      },
    },
    {
      type: 'skills',
      name: 'test-skill',
      buildContent: (name: string, desc: string, tags: string[], version = '1.0.0') => {
        const tagLines = tags.map(t => `  - ${t}`).join('\n');
        return [
          '---',
          `name: ${name}`,
          `description: ${desc}`,
          'author: test-author',
          `version: ${version}`,
          'type: skill',
          tags.length ? `tags:\n${tagLines}` : 'tags: []',
          '---',
          '',
          `Skill instructions for ${name}.`,
        ].join('\n');
      },
    },
    {
      type: 'templates',
      name: 'test-template',
      buildContent: (name: string, desc: string, tags: string[], version = '1.0.0') => {
        const tagLines = tags.map(t => `  - ${t}`).join('\n');
        return [
          '---',
          `name: ${name}`,
          `description: ${desc}`,
          'author: test-author',
          `version: ${version}`,
          'type: template',
          tags.length ? `tags:\n${tagLines}` : 'tags: []',
          '---',
          '',
          `Template content for ${name}.`,
        ].join('\n');
      },
    },
    {
      type: 'agents',
      name: 'test-agent',
      buildContent: (name: string, desc: string, tags: string[], version = '1.0.0') => {
        const tagLines = tags.map(t => `  - ${t}`).join('\n');
        return [
          '---',
          `name: ${name}`,
          `description: ${desc}`,
          'author: test-author',
          `version: ${version}`,
          'type: agent',
          tags.length ? `tags:\n${tagLines}` : 'tags: []',
          '---',
          '',
          `Agent workflow instructions for ${name}.`,
        ].join('\n');
      },
    },
    {
      type: 'ensembles',
      name: 'test-ensemble',
      buildContent: (name: string, desc: string, tags: string[], version = '1.0.0') => {
        const tagLines = tags.map(t => `  - ${t}`).join('\n');
        return [
          '---',
          `name: ${name}`,
          `description: ${desc}`,
          'author: test-author',
          `version: ${version}`,
          'type: ensemble',
          tags.length ? `tags:\n${tagLines}` : 'tags: []',
          '---',
          '',
          `Ensemble configuration for ${name}.`,
        ].join('\n');
      },
    },
  ];

  for (const config of elementConfigs) {
    describe(`${config.type}`, () => {
      it(`should create a ${config.type} element and store raw_content + extracted metadata`, async () => {
        if (!dbAvailable) return;
        const userId = await ensureTestUser();
        const db = getTestDb();
        const layer = new DatabaseStorageLayer(db, fixedUserId(userId), config.type);

        const content = config.buildContent(config.name, `A test ${config.type} element`, ['tag-a', 'tag-b']);
        const elementId = await layer.writeContent(config.type, config.name, content, {
          author: 'test-author',
          version: '1.0.0',
          description: `A test ${config.type} element`,
          tags: ['tag-a', 'tag-b'],
        });

        // Verify DB row
        const row = await getElementRow(userId, elementId);
        expect(row).not.toBeNull();

        // raw_content is byte-for-byte the original document
        expect(row!.rawContent).toBe(content);

        // Extracted metadata columns match the document
        expect(row!.name).toBe(config.name);
        expect(row!.description).toBe(`A test ${config.type} element`);
        expect(row!.author).toBe('test-author');
        expect(row!.version).toBe('1.0.0');
        expect(row!.elementType).toBe(config.type);
        expect(row!.byteSize).toBe(Buffer.byteLength(content, 'utf8'));
        expect(row!.contentHash).toHaveLength(64); // SHA-256 hex

        // body_content is the markdown after frontmatter
        expect(row!.bodyContent).toContain(config.name);
        expect(row!.bodyContent).not.toContain('---');

        // Tags stored correctly
        const tags = await getElementTags(userId, elementId);
        expect(tags).toEqual(['tag-a', 'tag-b']);
      });

      it(`should read back ${config.type} content with byte-for-byte fidelity`, async () => {
        if (!dbAvailable) return;
        const userId = await ensureTestUser();
        const db = getTestDb();
        const layer = new DatabaseStorageLayer(db, fixedUserId(userId), config.type);

        const content = config.buildContent(config.name, 'Round-trip test', ['fidelity']);
        const elementId = await layer.writeContent(config.type, config.name, content, {
          author: 'test-author', version: '1.0.0', description: 'Round-trip test', tags: ['fidelity'],
        });

        const readBack = await layer.readContent(elementId);
        expect(readBack).toBe(content);

        // Parse the read-back content — should produce valid frontmatter
        const parsed = FrontmatterParser.extractMetadata(readBack);
        expect(parsed.name).toBe(config.name);
        expect(parsed.description).toBe('Round-trip test');
        expect(parsed.author).toBe('test-author');
        expect(parsed.version).toBe('1.0.0');
      });

      it(`should update ${config.type} and reflect changes in both raw_content and metadata`, async () => {
        if (!dbAvailable) return;
        const userId = await ensureTestUser();
        const db = getTestDb();
        const layer = new DatabaseStorageLayer(db, fixedUserId(userId), config.type);

        // Create v1
        const contentV1 = config.buildContent(config.name, 'Version 1 description', ['old-tag'], '1.0.0');
        const elementId = await layer.writeContent(config.type, config.name, contentV1, {
          author: 'test-author', version: '1.0.0', description: 'Version 1 description', tags: ['old-tag'],
        });

        // Update to v2 (same name = upsert, same ID) — version in document AND metadata
        const contentV2 = config.buildContent(config.name, 'Version 2 updated description', ['new-tag', 'extra-tag'], '2.0.0');
        const elementIdV2 = await layer.writeContent(config.type, config.name, contentV2, {
          author: 'test-author', version: '2.0.0', description: 'Version 2 updated description', tags: ['new-tag', 'extra-tag'],
        });

        // Same element (upsert, not duplicate)
        expect(elementIdV2).toBe(elementId);

        // Verify raw_content updated
        const row = await getElementRow(userId, elementId);
        expect(row!.rawContent).toBe(contentV2);
        expect(row!.rawContent).not.toBe(contentV1);

        // Verify metadata columns updated
        expect(row!.description).toBe('Version 2 updated description');
        expect(row!.version).toBe('2.0.0');

        // Verify tags updated (old tags replaced, not accumulated)
        const tags = await getElementTags(userId, elementId);
        expect(tags).toEqual(['extra-tag', 'new-tag']);

        // Read back and parse — should match v2
        const readBack = await layer.readContent(elementId);
        expect(readBack).toBe(contentV2);
        const parsed = FrontmatterParser.extractMetadata(readBack);
        expect(parsed.description).toBe('Version 2 updated description');
        expect(parsed.version).toBe('2.0.0');
      });

      it(`should delete ${config.type} and remove from DB completely`, async () => {
        if (!dbAvailable) return;
        const userId = await ensureTestUser();
        const db = getTestDb();
        const layer = new DatabaseStorageLayer(db, fixedUserId(userId), config.type);

        const content = config.buildContent(config.name, 'Will be deleted', ['doomed']);
        const elementId = await layer.writeContent(config.type, config.name, content, {
          author: 'test-author', version: '1.0.0', description: 'Will be deleted', tags: ['doomed'],
        });

        await layer.deleteContent(config.type, config.name);

        // Element row gone
        const row = await getElementRow(userId, elementId);
        expect(row).toBeNull();

        // Tags cascade-deleted
        const tags = await getElementTags(userId, elementId);
        expect(tags).toHaveLength(0);

        // Read returns ENOENT
        await expect(layer.readContent(elementId)).rejects.toMatchObject({ code: 'ENOENT' });
      });

      it(`should list ${config.type} via listSummaries with correct metadata`, async () => {
        if (!dbAvailable) return;
        const userId = await ensureTestUser();
        const db = getTestDb();
        const layer = new DatabaseStorageLayer(db, fixedUserId(userId), config.type);

        await layer.writeContent(config.type, `${config.name}-a`,
          config.buildContent(`${config.name}-a`, 'Element A', ['shared']), {
            author: 'a-author', version: '1.0.0', description: 'Element A', tags: ['shared'],
          });
        await layer.writeContent(config.type, `${config.name}-b`,
          config.buildContent(`${config.name}-b`, 'Element B', ['shared', 'extra']), {
            author: 'b-author', version: '2.0.0', description: 'Element B', tags: ['shared', 'extra'],
          });

        const summaries = await layer.listSummaries();
        expect(summaries).toHaveLength(2);

        const a = summaries.find(s => s.name === `${config.name}-a`);
        const b = summaries.find(s => s.name === `${config.name}-b`);

        expect(a).toBeDefined();
        expect(a!.description).toBe('Element A');
        expect(a!.author).toBe('a-author');
        expect(a!.tags).toContain('shared');

        expect(b).toBeDefined();
        expect(b!.description).toBe('Element B');
        expect(b!.version).toBe('2.0.0');
        expect(b!.tags).toEqual(expect.arrayContaining(['shared', 'extra']));
      });
    });
  }
});

// ── Memory Elements (YAML format with entries) ──────────────────────

function buildMemoryYaml(name: string, desc: string, entries: Array<{ id: string; content: string }>) {
  const entryBlock = entries.length
    ? ['entries:', ...entries.map(e => `  - id: "${e.id}"\n    content: "${e.content}"\n    timestamp: "${new Date().toISOString()}"`)]
    : [];

  return [
    `name: ${name}`,
    `description: ${desc}`,
    'author: test-author',
    'version: 1.0.0',
    'memoryType: user',
    'autoLoad: false',
    'tags:',
    '  - memory-test',
    ...entryBlock,
  ].join('\n');
}

describe('Memory Element Round-Trip', () => {
  it('should create a memory and store raw_content + extracted metadata + entries', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));

    const content = buildMemoryYaml('test-memory', 'A test memory', [
      { id: 'entry-1', content: 'First entry content' },
      { id: 'entry-2', content: 'Second entry content' },
    ]);

    const elementId = await layer.writeContent('memories', 'test-memory', content, {
      author: 'test-author', version: '1.0.0', description: 'A test memory', tags: ['memory-test'],
    });

    // Verify DB row
    const row = await getElementRow(userId, elementId);
    expect(row).not.toBeNull();
    expect(row!.rawContent).toBe(content);
    expect(row!.name).toBe('test-memory');
    expect(row!.description).toBe('A test memory');
    expect(row!.elementType).toBe('memories');
    expect(row!.memoryType).toBe('user');
    expect(row!.autoLoad).toBe(false);

    // body_content should be null for YAML memories (no frontmatter delimiter)
    expect(row!.bodyContent).toBeNull();

    // Tags stored
    const tags = await getElementTags(userId, elementId);
    expect(tags).toEqual(['memory-test']);

    // Entries synced to memory_entries table
    const entryCount = await getMemoryEntryCount(userId, elementId);
    expect(entryCount).toBe(2);
  });

  it('should read back memory content with byte-for-byte fidelity', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));

    const content = buildMemoryYaml('fidelity-memory', 'Round-trip test', []);
    const elementId = await layer.writeContent('memories', 'fidelity-memory', content, {
      author: 'test-author', version: '1.0.0', description: 'Round-trip test', tags: [],
    });

    const readBack = await layer.readContent(elementId);
    expect(readBack).toBe(content);

    // Parse the YAML — should produce valid metadata
    const parsed = SecureYamlParser.parseRawYaml(readBack, 64 * 1024);
    expect(parsed.name).toBe('fidelity-memory');
    expect(parsed.description).toBe('Round-trip test');
  });

  it('should update memory and reflect changes in raw_content, metadata, and entries', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));

    // Create v1 with 2 entries
    const contentV1 = buildMemoryYaml('update-memory', 'Version 1', [
      { id: 'e1', content: 'Old entry' },
      { id: 'e2', content: 'Another old entry' },
    ]);
    const elementId = await layer.writeContent('memories', 'update-memory', contentV1, {
      author: 'test-author', version: '1.0.0', description: 'Version 1', tags: ['v1'],
    });

    expect(await getMemoryEntryCount(userId, elementId)).toBe(2);

    // Update to v2 with 3 entries (replaces old entries atomically)
    const contentV2 = buildMemoryYaml('update-memory', 'Version 2 updated', [
      { id: 'e1', content: 'New entry 1' },
      { id: 'e3', content: 'Brand new entry' },
      { id: 'e4', content: 'Another new entry' },
    ]);
    const elementIdV2 = await layer.writeContent('memories', 'update-memory', contentV2, {
      author: 'test-author', version: '2.0.0', description: 'Version 2 updated', tags: ['v2'],
    });

    // Same element (upsert)
    expect(elementIdV2).toBe(elementId);

    // raw_content updated
    const row = await getElementRow(userId, elementId);
    expect(row!.rawContent).toBe(contentV2);
    expect(row!.description).toBe('Version 2 updated');
    expect(row!.version).toBe('2.0.0');

    // Tags replaced
    const tags = await getElementTags(userId, elementId);
    expect(tags).toEqual(['v2']);

    // Entries replaced (2 old → 3 new, atomically)
    expect(await getMemoryEntryCount(userId, elementId)).toBe(3);

    // Read back and parse
    const readBack = await layer.readContent(elementId);
    expect(readBack).toBe(contentV2);
  });

  it('should delete memory and cascade-remove entries and tags', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));

    const content = buildMemoryYaml('delete-memory', 'Will be deleted', [
      { id: 'e1', content: 'Doomed entry' },
    ]);
    const elementId = await layer.writeContent('memories', 'delete-memory', content, {
      author: 'test-author', version: '1.0.0', description: 'Will be deleted', tags: ['doomed'],
    });

    await layer.deleteContent('memories', 'delete-memory');

    // Element, tags, and entries all gone
    expect(await getElementRow(userId, elementId)).toBeNull();
    expect(await getElementTags(userId, elementId)).toHaveLength(0);
    expect(await getMemoryEntryCount(userId, elementId)).toBe(0);
  });

  it('should list memories with totalEntries count in summaries', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));

    await layer.writeContent('memories', 'counted-memory',
      buildMemoryYaml('counted-memory', 'Has entries', [
        { id: 'e1', content: 'One' },
        { id: 'e2', content: 'Two' },
      ]), {
        author: 'test-author', version: '1.0.0', description: 'Has entries', tags: [],
      });

    const summaries = await layer.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].totalEntries).toBe(2);
    expect(summaries[0].memoryType).toBe('user');
    expect(summaries[0].autoLoad).toBe(false);
  });

  it('should support individual entry operations alongside container writes', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseMemoryStorageLayer(db, fixedUserId(userId));

    // Create memory with 1 entry from YAML
    const content = buildMemoryYaml('entry-ops-memory', 'Entry ops test', [
      { id: 'yaml-entry', content: 'From YAML' },
    ]);
    const elementId = await layer.writeContent('memories', 'entry-ops-memory', content, {
      author: '', version: '', description: '', tags: [],
    });

    // Add an entry programmatically
    await layer.addEntry(elementId, {
      entryId: 'manual-entry',
      timestamp: new Date(),
      content: 'Added programmatically',
    });

    // Should now have 2 entries
    const entries = await layer.getEntries(elementId);
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.entryId).sort((a, b) => a.localeCompare(b))).toEqual(['manual-entry', 'yaml-entry']);

    // Remove one
    await layer.removeEntry(elementId, 'yaml-entry');
    const remaining = await layer.getEntries(elementId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].entryId).toBe('manual-entry');
  });
});

// ── Cross-Cutting Concerns ──────────────────────────────────────────

describe('Cross-Cutting Round-Trip Verification', () => {
  it('should produce identical content hash for identical content', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseStorageLayer(db, fixedUserId(userId), 'skills');

    const content = '---\nname: hash-test\ndescription: Hash test\nauthor: test\nversion: 1.0.0\n---\nBody.';

    const id1 = await layer.writeContent('skills', 'hash-test', content, {
      author: 'test', version: '1.0.0', description: 'Hash test', tags: [],
    });

    const row = await getElementRow(userId, id1);
    const hash1 = row!.contentHash;

    // Delete and re-create with identical content
    await layer.deleteContent('skills', 'hash-test');
    const id2 = await layer.writeContent('skills', 'hash-test', content, {
      author: 'test', version: '1.0.0', description: 'Hash test', tags: [],
    });

    const row2 = await getElementRow(userId, id2);
    expect(row2!.contentHash).toBe(hash1);
  });

  it('should extract raw_content that can be loaded by the file-backed parser', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseStorageLayer(db, fixedUserId(userId), 'skills');

    const content = [
      '---',
      'name: parser-compat',
      'description: Tests that raw_content is valid for file-backed loading',
      'author: compatibility-test',
      'version: 3.5.0',
      'tags:',
      '  - compat',
      '  - round-trip',
      '---',
      '',
      '## Instructions',
      '',
      'This skill does important things.',
      '',
      '### Step 1',
      '',
      'Do the first thing.',
    ].join('\n');

    const elementId = await layer.writeContent('skills', 'parser-compat', content, {
      author: 'compatibility-test', version: '3.5.0',
      description: 'Tests that raw_content is valid for file-backed loading',
      tags: ['compat', 'round-trip'],
    });

    // Read raw_content from DB
    const rawContent = await layer.readContent(elementId);

    // Parse with the SAME parser the file-backed path uses
    const parsed = SecureYamlParser.safeMatter(rawContent);

    expect(parsed.data.name).toBe('parser-compat');
    expect(parsed.data.description).toBe('Tests that raw_content is valid for file-backed loading');
    expect(parsed.data.author).toBe('compatibility-test');
    expect(parsed.data.version).toBe('3.5.0');
    expect(parsed.data.tags).toEqual(['compat', 'round-trip']);
    expect(parsed.content).toContain('## Instructions');
    expect(parsed.content).toContain('Do the first thing.');
  });
});
