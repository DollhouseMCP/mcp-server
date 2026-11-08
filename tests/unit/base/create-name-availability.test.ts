/**
 * One create availability check for every type: the requested name is certified through the shared
 * selector. An unreadable sibling that could never hold the name does not block the create; a
 * stored definition the name selects by any tier is a duplicate.
 */
import { describe, expect, it, afterEach, beforeEach, jest } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite, createRealPersonaManager } from '../../helpers/di-mocks.js';
import { createTestStorageFactory } from '../../helpers/createTestStorageFactory.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';

const skill = (name: string) => `---\nname: ${name}\ndescription: fixture\n---\nFollow these detailed instructions.`;
const BROKEN = '---\nname: [broken\n---\n';

describe('create name availability', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  let persona: ReturnType<typeof createRealPersonaManager>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'create-availability-'));
    suite = createRealManagerSuite(root);
    persona = createRealPersonaManager(root);
  });
  afterEach(async () => {
    for (const manager of [suite.skillManager, suite.templateManager, suite.agentManager, suite.ensembleManager, suite.memoryManager, persona]) {
      await manager.dispose();
    }
    await rm(root, { recursive: true, force: true });
  });

  async function brokenSibling(manager: object, file: string, content = BROKEN): Promise<void> {
    const dir = (manager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, file), content);
  }

  it('creates an unrelated name beside one unreadable sibling, for every type', async () => {
    await brokenSibling(suite.skillManager, 'broken.md');
    await brokenSibling(suite.templateManager, 'broken.md');
    await brokenSibling(suite.agentManager, 'broken.md');
    await brokenSibling(suite.ensembleManager, 'broken.md');
    await brokenSibling(persona, 'broken.md');
    await brokenSibling(suite.memoryManager, 'broken.yaml', 'metadata: [broken\n');

    await expect(suite.skillManager.create({ name: 'Fresh Skill', description: 'd', content: 'Follow these detailed instructions.' })).resolves.toBeDefined();
    await expect(suite.templateManager.create({ name: 'Fresh Template', description: 'd', content: 'Template body {{x}}' })).resolves.toBeDefined();
    const agent = await suite.agentManager.create('fresh-agent', 'd', 'Agent instructions here.', {} as never);
    expect(agent.success ? 'created' : agent.message).toBe('created');
    await expect(suite.ensembleManager.create({ name: 'Fresh Ensemble', description: 'd', elements: [] } as never)).resolves.toBeDefined();
    await expect(persona.create({ name: 'Fresh Persona', description: 'd', content: 'You are a helpful persona with detail.' })).resolves.toBeDefined();
    await expect(suite.memoryManager.create({ name: 'Fresh Memory', description: 'd', content: 'entry' })).resolves.toBeDefined();
  });

  it('refuses a name the selector maps onto a stored definition', async () => {
    const dir = (suite.skillManager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'my-skill.md'), skill('My-Skill'));
    await expect(suite.skillManager.create({ name: 'my skill', description: 'd', content: 'Follow these detailed instructions.' }))
      .rejects.toThrow('A skill named "my skill" already exists (stored as "My-Skill")');
    await expect(suite.skillManager.create({ name: 'MY-SKILL', description: 'd', content: 'Follow these detailed instructions.' }))
      .rejects.toThrow('already exists');
  });

  it('refuses a name an unreadable definition could hold, as an indeterminate identity', async () => {
    await brokenSibling(suite.skillManager, 'my-skill.md');
    await expect(suite.skillManager.create({ name: 'My Skill', description: 'd', content: 'Follow these detailed instructions.' }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });
});

describe('create name availability (database backend)', () => {
  it('refuses a slug-colliding name on the database too, naming the stored element', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'create-availability-db-'));
    const files = createTestStorageFactory();
    const writeContent = jest.fn();
    const storageLayerFactory = { createForElement: (...args: Parameters<typeof files.createForElement>) =>
      Object.assign(files.createForElement(...args), {
        writeContent,
        cachedInstanceCurrency: 'unverifiable',
        isExactStorageReference: (reference: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(reference),
        // The warm database index holds the stored row 'My-Skill'.
        readIndexedPath: async () => ({ path: undefined, indexComplete: true, authoritative: true, unindexed: [], failures: new Map(),
          candidates: [{ reference: '11111111-1111-4111-8111-111111111111', name: 'My-Skill' }] }),
      }) } as never;
    const suite = createRealManagerSuite(root, { storageLayerFactory });
    try {
      await expect(suite.skillManager.create({ name: 'my skill', description: 'd', content: 'Follow these detailed instructions.' }))
        .rejects.toThrow('A skill named "my skill" already exists (stored as "My-Skill")');
      expect(writeContent).not.toHaveBeenCalled();
    } finally {
      await suite.skillManager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('create name availability on fresh evidence (database layer)', () => {
  it('refuses a case variant another process stored after the index was built', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'create-fresh-db-'));
    let rows: Array<{ id: string; name: string; updatedAt: Date }> = [];
    const where = jest.fn(async () => rows);
    const select = jest.fn(() => ({ from: jest.fn(() => ({ where })) }));
    const tx = { select, execute: jest.fn(async () => undefined) };
    const db = { transaction: async (work: (value: typeof tx) => Promise<unknown>) => work(tx) } as never;
    const files = createTestStorageFactory();
    const storageLayerFactory = { createForElement: (...args: Parameters<typeof files.createForElement>) =>
      args[0] === 'skills' ? new DatabaseStorageLayer(db, () => '11111111-1111-4111-8111-111111111111', 'skills')
        : files.createForElement(...args) } as never;
    const suite = createRealManagerSuite(root, { storageLayerFactory });
    const layer = (suite.skillManager as any).storageLayer as DatabaseStorageLayer;
    const writeContent = jest.spyOn(layer, 'writeContent');
    try {
      await layer.scan();
      // Another process stores 'my skill' once this process's index is warm.
      rows = [{ id: '22222222-2222-4222-8222-222222222222', name: 'my skill', updatedAt: new Date() }];
      await expect(suite.skillManager.create({ name: 'My Skill', description: 'd', content: 'Follow these detailed instructions.' }))
        .rejects.toThrow('A skill named "My Skill" already exists (stored as "my skill")');
      expect(writeContent).not.toHaveBeenCalled();
    } finally {
      await suite.skillManager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
