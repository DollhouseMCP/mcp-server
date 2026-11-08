import { afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { withUserContext } from '../../../src/database/rls.js';
import { elements } from '../../../src/database/schema/elements.js';
import { agentStates } from '../../../src/database/schema/agents.js';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { expectPartialNamesRefused } from '../../helpers/partialNameCases.js';
import { DatabaseStorageLayerFactory } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { ElementReadError } from '../../../src/elements/base/ElementReadError.js';
import { ValidationError } from '../../../src/security/errors.js';
import { deleteElement } from '../../../src/handlers/element-crud/deleteElement.js';
import { editElement } from '../../../src/handlers/element-crud/editElement.js';
import { canonicalElementName } from '../../../src/storage/ElementNameKeys.js';
import { buildSkillContent, buildMemoryContent, cleanupAllTestData, closeTestDb, ensureTestUser, fixedUserId, getTestDb } from './test-db-helpers.js';

afterAll(closeTestDb);
afterEach(() => jest.restoreAllMocks());

describe('database exact-reference repair deletion', () => {
  it('keeps UUID references readable beside a failed Foo row but refuses a competing name', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'database-exact-sibling-'));
    const user = fixedUserId(await ensureTestUser());
    const suite = createRealManagerSuite(root, { storageLayerFactory: new DatabaseStorageLayerFactory(getTestDb(), user) });
    const storage = new DatabaseStorageLayer(getTestDb(), user, 'skills');
    const write = (name: string) => storage.writeContent('skills', name, buildSkillContent(name),
      { author: 'test', version: '1.0.0', description: 'Exact sibling fixture', tags: [] });
    try {
      const healthy = await write('Foo');
      const broken = await write('foo');
      await suite.skillManager.listReport();
      await withUserContext(getTestDb(), user(), tx => tx.update(elements)
        .set({ rawContent: '---\nname: [invalid\n---' }).where(eq(elements.id, broken)));
      await suite.skillManager['scanAndEvict']();
      expect((await suite.skillManager.findByName(healthy))?.metadata.name).toBe('Foo');
      expect((await suite.skillManager.load(healthy)).metadata.name).toBe('Foo');
      await expect(suite.skillManager.findByName('Foo')).rejects.toMatchObject({ kind: 'indeterminate' });
      await expect(suite.skillManager.findByName('foo.md')).rejects.toMatchObject({ kind: 'indeterminate' });
      // A sibling named like the UUID must not block the literal row reference either.
      const uuidNamed = await write(healthy);
      await suite.skillManager.listReport();
      await withUserContext(getTestDb(), user(), tx => tx.update(elements)
        .set({ rawContent: '---\nname: [invalid\n---' }).where(eq(elements.id, uuidNamed)));
      await suite.skillManager['scanAndEvict']();
      expect((await suite.skillManager.findByName(healthy))?.metadata.name).toBe('Foo');
    } finally {
      await Promise.all([suite.skillManager, suite.templateManager, suite.memoryManager, suite.ensembleManager,
        suite.agentManager, suite.personaManager].map(manager => manager.dispose()));
      await rm(root, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });

  it('protects a malformed default persona selected by UUID using stored metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'database-persona-repair-'));
    const user = fixedUserId(await ensureTestUser());
    const suite = createRealManagerSuite(root, { storageLayerFactory: new DatabaseStorageLayerFactory(getTestDb(), user) });
    try {
      const identity = await new DatabaseStorageLayer(getTestDb(), user, 'personas').writeContent(
        'personas', 'Business Consultant', buildSkillContent('Business Consultant'),
        { author: 'test', version: '1.0.0', description: 'Protected persona fixture', tags: [] });
      await withUserContext(getTestDb(), user(), tx => tx.update(elements)
        .set({ rawContent: '---\nname: [invalid\n---' }).where(eq(elements.id, identity)));
      const committed = jest.fn();
      await expect(suite.personaManager.delete(identity, committed)).rejects.toThrow('Cannot delete a default persona');
      expect(committed).not.toHaveBeenCalled();
      expect(await withUserContext(getTestDb(), user(), tx => tx.select().from(elements).where(eq(elements.id, identity)))).toHaveLength(1);
    } finally {
      await Promise.all([suite.skillManager, suite.templateManager, suite.memoryManager, suite.ensembleManager,
        suite.agentManager, suite.personaManager].map(manager => manager.dispose()));
      await rm(root, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });

  it('refuses ambiguous storage aliases before selecting an identity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'database-alias-'));
    const user = fixedUserId(await ensureTestUser());
    const suite = createRealManagerSuite(root, { storageLayerFactory: new DatabaseStorageLayerFactory(getTestDb(), user) });
    const storage = new DatabaseStorageLayer(getTestDb(), user, 'skills');
    try {
      await Promise.all(['reference_name', 'reference-name'].map(name =>
        storage.writeContent('skills', name, buildSkillContent(name),
          { author: 'test', version: '1.0.0', description: 'Alias fixture', tags: [] })));
      // The deletion target is selected by the shared name rule, as a read of the same text is.
      await expect(suite.skillManager.resolveDeletionTarget('Reference Name.md')).rejects.toMatchObject({ name: 'ElementIndeterminateError' });
      await expect(suite.skillManager.findByName('Reference Name.md')).rejects.toMatchObject({ name: 'ElementIndeterminateError' });
    } finally {
      await Promise.all([suite.skillManager, suite.templateManager, suite.memoryManager, suite.ensembleManager,
        suite.agentManager, suite.personaManager].map(manager => manager.dispose()));
      await rm(root, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });

  it('addresses the row "readme", not the slug match "Readme MD", for read, exists, delete and the agent read of "readme.md"', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'database-ranked-names-'));
    const user = fixedUserId(await ensureTestUser());
    const suite = createRealManagerSuite(root, { storageLayerFactory: new DatabaseStorageLayerFactory(getTestDb(), user) });
    const rowsOf = async (collection: string) => (await withUserContext(getTestDb(), user(), tx => tx.select({ name: elements.name })
      .from(elements).where(eq(elements.elementType, collection)))).map(row => row.name).sort();
    try {
      const skills = new DatabaseStorageLayer(getTestDb(), user, 'skills');
      for (const name of ['readme', 'Readme MD']) {
        await skills.writeContent('skills', name, buildSkillContent(name), { author: 'test', version: '1.0.0', description: 'Ranked fixture', tags: [] });
      }
      await suite.skillManager['scanAndEvict']();
      expect((await suite.skillManager.findByName('readme.md'))?.metadata.name).toBe('readme');
      await expect(suite.skillManager.exists('readme.md')).resolves.toBe(true);
      await suite.skillManager.delete('readme.md');
      expect(await rowsOf('skills')).toEqual(['Readme MD']);
      // The agent 'readme' is created normally; a competing 'Readme MD' row (not a valid agent name to
      // create) is written directly, and only has to compete for the name.
      expect((await suite.agentManager.create('readme', 'Ranked agent', 'Follow these detailed agent instructions.', {} as never)).success).toBe(true);
      await new DatabaseStorageLayer(getTestDb(), user, 'agents').writeContent('agents', 'Readme MD', buildSkillContent('Readme MD'),
        { author: 'test', version: '1.0.0', description: 'Competing row', tags: [] });
      expect((await suite.agentManager.read('readme.md'))?.metadata.name).toBe('readme');
    } finally {
      await Promise.all([suite.skillManager, suite.templateManager, suite.memoryManager, suite.ensembleManager,
        suite.agentManager, suite.personaManager].map(manager => manager.dispose()));
      await rm(root, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });

  it('refuses a partial name for details, edit, delete and template activate on the database; the slug resolves', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'database-partial-names-'));
    const user = fixedUserId(await ensureTestUser());
    const suite = createRealManagerSuite(root, { storageLayerFactory: new DatabaseStorageLayerFactory(getTestDb(), user) });
    try {
      await expectPartialNamesRefused(suite);
    } finally {
      await Promise.all([suite.skillManager, suite.templateManager, suite.memoryManager, suite.ensembleManager,
        suite.agentManager, suite.personaManager].map(manager => manager.dispose()));
      await rm(root, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });

  it('finds a row another process created after the index was built, on a warm lookup with no handler refresh', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'database-warm-miss-'));
    const user = fixedUserId(await ensureTestUser());
    const suite = createRealManagerSuite(root, { storageLayerFactory: new DatabaseStorageLayerFactory(getTestDb(), user) });
    const write = (name: string) => new DatabaseStorageLayer(getTestDb(), user, 'skills').writeContent('skills', name,
      buildSkillContent(name), { author: 'test', version: '1.0.0', description: 'Warm-miss fixture', tags: [] });
    try {
      await write('Existing Row');
      await suite.skillManager.list();
      await write('Created Elsewhere');
      expect((await suite.skillManager.findByName('Created Elsewhere'))?.metadata.name).toBe('Created Elsewhere');
      await expect(suite.skillManager.findByName('Never Created')).resolves.toBeUndefined();
    } finally {
      await Promise.all([suite.skillManager, suite.templateManager, suite.memoryManager, suite.ensembleManager,
        suite.agentManager, suite.personaManager].map(manager => manager.dispose()));
      await rm(root, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });

  it.each([['skills', 'skillManager', '.md'], ['memories', 'memoryManager', '.yaml']] as const)(
    'reads and deletes the same %s row for every text: the name as written first, the stripped name only when that selects none',
    async (collection, managerKey, extension) => {
      const root = await mkdtemp(path.join(tmpdir(), 'database-extension-names-'));
      const user = fixedUserId(await ensureTestUser());
      const suite = createRealManagerSuite(root, { storageLayerFactory: new DatabaseStorageLayerFactory(getTestDb(), user) });
      const manager = suite[managerKey];
      const storage = new DatabaseStorageLayer(getTestDb(), user, collection);
      const write = (name: string) => storage.writeContent(collection, name,
        collection === 'memories' ? buildMemoryContent(name) : buildSkillContent(name),
        { author: 'test', version: '1.0.0', description: 'Extension-name fixture', tags: [] });
      const rows = async () => (await withUserContext(getTestDb(), user(), tx => tx.select({ name: elements.name }).from(elements)
        .where(eq(elements.elementType, collection)))).map(row => row.name).sort();
      try {
        const bare = 'readme';
        const suffixed = `readme${extension}`;
        await write(bare);
        await write(suffixed);
        await manager['scanAndEvict']();
        expect((await manager.findByName(suffixed))?.metadata.name).toBe(suffixed);
        expect((await manager.findByName(bare))?.metadata.name).toBe(bare);
        await manager.delete(suffixed);
        expect(await rows()).toEqual([bare]);
        await write(suffixed);
        await manager['scanAndEvict']();
        await manager.delete(bare);
        expect(await rows()).toEqual([suffixed]);
        // Only the suffixed row: read and delete of its own text agree.
        expect((await manager.findByName(suffixed))?.metadata.name).toBe(suffixed);
        await manager.delete(suffixed);
        expect(await rows()).toEqual([]);
        // Only the bare row: the suffixed text selects it by its stripped name, for read and delete alike.
        await write(bare);
        await manager['scanAndEvict']();
        expect((await manager.findByName(suffixed))?.metadata.name).toBe(bare);
        await manager.delete(suffixed);
        expect(await rows()).toEqual([]);
      } finally {
        await Promise.all([suite.skillManager, suite.templateManager, suite.memoryManager, suite.ensembleManager,
          suite.agentManager, suite.personaManager].map(item => item.dispose()));
        await rm(root, { recursive: true, force: true });
        await cleanupAllTestData();
      }
    });

  it.each(['skill', 'agent'] as const)('repairs rejected %s bytes by UUID and preserves state on infrastructure failure', async type => {
    const root = await mkdtemp(path.join(tmpdir(), 'database-repair-'));
    const user = fixedUserId(await ensureTestUser());
    const suite = createRealManagerSuite(root, { storageLayerFactory: new DatabaseStorageLayerFactory(getTestDb(), user) });
    const manager = suite[`${type}Manager`];
    try {
      const collection = `${type}s`;
      const identity = await new DatabaseStorageLayer(getTestDb(), user, collection).writeContent(
        collection, 'repair-target', buildSkillContent('repair-target'),
        { author: 'test', version: '1.0.0', description: 'Repair fixture', tags: [] });
      if (type === 'agent') await withUserContext(getTestDb(), user(), tx => tx.insert(agentStates).values({
        agentId: identity, userId: user(), sessionId: 'repair-session',
      }));
      await withUserContext(getTestDb(), user(), tx => tx.update(elements)
        .set({ rawContent: '---\nname: [invalid\n---', updatedAt: new Date() }).where(eq(elements.id, identity)));
      await expect(manager.resolveDeletionTarget('repair-target')).rejects.toBeInstanceOf(ElementReadError);
      await expect(manager.resolveDeletionTarget('repair-target.md')).rejects.toBeInstanceOf(ElementReadError);
      const read = jest.spyOn(manager['storageLayer'], 'readContent').mockRejectedValueOnce(new Error('Database unavailable'));
      await expect(manager.delete(identity)).rejects.toBeInstanceOf(ElementReadError);
      read.mockRestore();
      expect(await withUserContext(getTestDb(), user(), tx => tx.select().from(elements).where(eq(elements.id, identity)))).toHaveLength(1);
      if (type === 'agent') expect(await withUserContext(getTestDb(), user(), tx => tx.select().from(agentStates)
        .where(eq(agentStates.agentId, identity)))).toHaveLength(1);
      const result = await deleteElement({ ...suite, fileOperations: suite.fileOperationsService,
        getManagerForType: (requested: string) => (suite as any)[`${requested === 'memories' ? 'memory' : requested.replace(/s$/, '')}Manager`],
        ensureInitialized: async () => undefined } as any, { name: identity, type });
      expect(result.content[0].text).toContain('Successfully deleted');
      expect(result.content[0].text).toContain('Definition could not be read');
      expect(await withUserContext(getTestDb(), user(), tx => tx.select().from(elements).where(eq(elements.id, identity)))).toEqual([]);
      expect(await withUserContext(getTestDb(), user(), tx => tx.select().from(agentStates).where(eq(agentStates.agentId, identity)))).toEqual([]);
    } finally {
      await Promise.all([suite.skillManager, suite.templateManager, suite.memoryManager, suite.ensembleManager,
        suite.agentManager, suite.personaManager].map(manager => manager.dispose()));
      await rm(root, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });
});

describe.each(['file', 'database'] as const)('%s element read contract', backend => {
  it('refuses an ambiguous name identically on the warm and cold paths and selects only by filename tie-break', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'element-read-ambiguity-'));
    const user = backend === 'database' ? fixedUserId(await ensureTestUser()) : undefined;
    const factory = user ? new DatabaseStorageLayerFactory(getTestDb(), user) : undefined;
    const suite = createRealManagerSuite(root, { storageLayerFactory: factory });
    const manager = suite.skillManager;
    const write = async (reference: string, name: string) => {
      if (user) {
        return new DatabaseStorageLayer(getTestDb(), user, 'skills').writeContent('skills', name, buildSkillContent(name),
          { author: 'test', version: '1.0.0', description: 'Ambiguity fixture', tags: [] });
      }
      const directory = path.join(root, 'skills');
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, reference), buildSkillContent(name));
      return reference;
    };
    try {
      const first = await write('first.md', 'Ambiguous Skill');
      const second = await write('second.md', user ? 'ambiguous skill' : 'Ambiguous Skill');
      const refused = { name: 'ElementIndeterminateError', failures: expect.arrayContaining([
        expect.objectContaining({ reference: first, reason: 'Competing definition name' }),
        expect.objectContaining({ reference: second, reason: 'Competing definition name' }),
      ]) };
      await expect(manager.findByName('AMBIGUOUS SKILL')).rejects.toMatchObject(refused);
      expect(manager['storageLayer'].hasCompletedScan()).toBe(true);
      await expect(manager.findByName('AMBIGUOUS SKILL')).rejects.toMatchObject(refused);
      if (user) await expect(manager.exists('AMBIGUOUS SKILL')).rejects.toMatchObject(refused);
      if (!user) {
        // A name load and an update target never pick a duplicate by modification time either.
        await expect(manager.load('AMBIGUOUS SKILL')).rejects.toMatchObject(refused);
        await expect(manager.findForUpdate('AMBIGUOUS SKILL')).rejects.toMatchObject(refused);
        await write('ambiguous-skill.md', 'Ambiguous Skill');
        // A certified name is read through the loader route (loadStoredReference), never back through load().
        const load = jest.spyOn(manager as any, 'loadStoredReference');
        await manager['scanAndEvict']();
        expect((await manager.findByName('Ambiguous Skill'))?.metadata.name).toBe('Ambiguous Skill');
        expect(load.mock.calls.map(([reference]) => reference)).toEqual(['ambiguous-skill.md']);
        expect((await manager.findByName('ambiguous skill'))?.metadata.name).toBe('Ambiguous Skill');
        expect((await manager.findForUpdate('Ambiguous Skill'))?.path).toBe('ambiguous-skill.md');
      }
    } finally {
      await Promise.all([suite.skillManager, suite.templateManager, suite.memoryManager, suite.ensembleManager,
        suite.agentManager, suite.personaManager].map(manager => manager.dispose()));
      await rm(root, { recursive: true, force: true });
      if (user) await cleanupAllTestData();
    }
  });

  it('resolves name variants identically for reads, update targets and deletion on the database', async () => {
    if (backend !== 'database') return;
    const user = fixedUserId(await ensureTestUser());
    const root = await mkdtemp(path.join(tmpdir(), 'element-name-variants-'));
    const suite = createRealManagerSuite(root, { storageLayerFactory: new DatabaseStorageLayerFactory(getTestDb(), user) });
    const manager = suite.skillManager;
    const write = (name: string) => new DatabaseStorageLayer(getTestDb(), user, 'skills').writeContent('skills', name, buildSkillContent(name),
      { author: 'test', version: '1.0.0', description: 'Variant fixture', tags: [] });
    try {
      const camel = await write('MySkill');
      const dotted = await write('foo.bar');
      const accent = await write('Caf\u00e9 Notes');
      for (const [identifier, id, name] of [['my-skill', camel, 'MySkill'], ['foo-bar', dotted, 'foo.bar'], ['Cafe\u0301 notes', accent, 'Caf\u00e9 Notes']] as const) {
        expect((await manager.findByName(identifier))?.metadata.name).toBe(name);
        expect((await manager.findForUpdate(identifier))?.path).toBe(id);
      }
      await manager.delete('my-skill');
      await expect(manager.findByName('MySkill')).resolves.toBeUndefined();
      // A case variant of an existing row is ambiguous for every path, never an arbitrary row.
      const first = await write('Ambiguous Row');
      const second = await write('ambiguous row');
      // Rows written through another layer instance reach this manager's index on its next scan.
      await manager['scanAndEvict']();
      await expect(manager.findByName('AMBIGUOUS ROW')).rejects.toMatchObject({ name: 'ElementIndeterminateError' });
      await expect(manager.findForUpdate('AMBIGUOUS ROW')).rejects.toMatchObject({ code: 'EAMBIGUOUS' });
      await expect(manager.delete('AMBIGUOUS ROW')).rejects.toMatchObject({ name: 'ElementIndeterminateError' });
      expect([first, second]).toHaveLength(2);
    } finally {
      await Promise.all([suite.skillManager, suite.templateManager, suite.memoryManager, suite.ensembleManager,
        suite.agentManager, suite.personaManager].map(manager => manager.dispose()));
      await rm(root, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });

  it('an edited name carries the canonical form in the response, the instance and the stored definition', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'element-read-contract-'));
    const user = backend === 'database' ? fixedUserId(await ensureTestUser()) : undefined;
    const suite = createRealManagerSuite(root, { storageLayerFactory: user ? new DatabaseStorageLayerFactory(getTestDb(), user) : undefined });
    const raw = '  Cafe\u0301 Notes  ';
    const canonical = canonicalElementName(raw);
    try {
      if (!user) await mkdir(path.join(root, 'skills'), { recursive: true });
      await suite.skillManager.create({ name: 'Edit Me', description: 'd', content: 'Follow these detailed instructions.' });
      const context = { ...suite, ensureInitialized: async () => {}, getPersonaIndicator: () => '',
        getManagerForType: (type: string) => (type === 'skills' ? suite.skillManager : undefined) } as never;
      const edited = await editElement(context, { name: 'Edit Me', type: 'skills', input: { name: raw } });
      expect((edited as { content: Array<{ text: string }> }).content.map(part => part.text).join('\n')).toContain(canonical);
      const instance = await suite.skillManager.findByName(canonical);
      expect(instance?.metadata.name).toBe(canonical);
      const stored = user
        ? (await withUserContext(getTestDb(), user(), tx => tx.select({ name: elements.name, rawContent: elements.rawContent }).from(elements)
          .where(eq(elements.elementType, 'skills'))))
        : await Promise.all((await readdir(path.join(root, 'skills'))).filter(file => file.endsWith('.md'))
          .map(async file => ({ name: undefined, rawContent: await readFile(path.join(root, 'skills', file), 'utf8') })));
      expect(stored.some(row => row.rawContent.includes(`name: ${canonical}`))).toBe(true);
      if (user) expect(stored.map(row => row.name)).toContain(canonical);
    } finally {
      await suite.skillManager.dispose();
      await rm(root, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });

  it('enforcement sees another process\'s edit of an agent activated the real way (storage identity key)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'element-read-contract-'));
    const user = backend === 'database' ? fixedUserId(await ensureTestUser()) : undefined;
    const suite = createRealManagerSuite(root, { storageLayerFactory: user ? new DatabaseStorageLayerFactory(getTestDb(), user) : undefined });
    const agents = suite.agentManager;
    try {
      if (!user) await mkdir(path.join(root, 'agents'), { recursive: true });
      expect((await agents.create('gate-agent', 'Original description', 'Follow these detailed agent instructions.', {} as never)).success).toBe(true);
      expect((await agents.activateAgent('gate-agent')).success).toBe(true);
      const before = await agents.getActiveReferenceReport();
      expect(before.items.map(item => item.metadata.description)).toEqual(['Original description']);
      if (user) {
        const [row] = await withUserContext(getTestDb(), user(), tx => tx.select({ id: elements.id, rawContent: elements.rawContent })
          .from(elements).where(eq(elements.elementType, 'agents')));
        // A second process's edit; its updated_at is not after this process's last scan.
        await withUserContext(getTestDb(), user(), tx => tx.update(elements)
          .set({ rawContent: row.rawContent.replace('Original description', 'Edited description'), updatedAt: new Date(Date.now() - 60_000) })
          .where(eq(elements.id, row.id)));
      } else {
        const file = path.join(root, 'agents', 'gate-agent.md');
        await writeFile(file, (await readFile(file, 'utf8')).replace('Original description', 'Edited description'));
        await utimes(file, new Date(), new Date(Date.now() + 5_000));
      }
      const after = await agents.getActiveReferenceReport();
      expect(after.complete).toBe(true);
      expect(after.items.map(item => item.metadata.description)).toEqual(['Edited description']);
    } finally {
      await agents.dispose();
      await rm(root, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });

  it('lists, finds, activates, enforces and deletes stored names that are path syntax; traversal forms delete nothing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'element-read-contract-'));
    const user = backend === 'database' ? fixedUserId(await ensureTestUser()) : undefined;
    const suite = createRealManagerSuite(root, { storageLayerFactory: user ? new DatabaseStorageLayerFactory(getTestDb(), user) : undefined });
    const manager = suite.skillManager;
    const names = ['Pros // Cons', 'Input/Output/', 'and/or/..', 'Save 50%25 Now', 'C:', '/slash first', 'Notes', 'Beta'];
    try {
      if (!user) await mkdir(path.join(root, 'skills'), { recursive: true });
      for (const [index, name] of names.entries()) {
        const content = buildSkillContent('placeholder').replace('name: placeholder', `name: ${JSON.stringify(name)}`);
        if (user) {
          await new DatabaseStorageLayer(getTestDb(), user, 'skills').writeContent(
            'skills', name, content, { author: 'test', version: '1.0.0', description: 'Fixture', tags: [] });
        } else {
          await writeFile(path.join(root, 'skills', name === 'Beta' ? 'beta.md' : `s${index}.md`), content);
        }
      }
      expect((await manager.listReport()).failures).toEqual([]);
      for (const name of names) {
        expect((await manager.findByName(name))?.metadata.name).toBe(name);
        expect((await manager.activateSkill(name)).success).toBe(true);
        await expect(manager.getActiveReferenceReport()).resolves.toMatchObject({ complete: true, failures: [] });
        expect((await manager.deactivateSkill(name)).success).toBe(true);
      }
      await expect(manager.delete('x/../beta.md')).rejects.toThrow(ValidationError);
      await expect(manager.load('C:alpha.md')).rejects.toThrow(ValidationError);
      // A letter and a colon followed by a name is a name (ruling #588 item 4): absent, not refused.
      await expect(manager.findByName('Q: Interview Prep')).resolves.toBeUndefined();
      expect((await manager.findByName('Beta'))?.metadata.name).toBe('Beta');
      // exists() certifies the text as written: never stripped to 'notes' or ' Cons' (#992).
      await expect(manager.exists('team/notes')).resolves.toBe(false);
      await expect(manager.exists('Pros // Cons')).resolves.toBe(true);
      for (const name of names.slice(0, -1)) await manager.delete(name);
      expect((await manager.list()).map(item => item.metadata.name)).toEqual(['Beta']);
      // A stored name carrying %xx, held by the layer, resolves and activates on both backends (#991).
      const held = buildSkillContent('placeholder').replace('name: placeholder', 'name: "Save Fifty"');
      if (user) {
        await new DatabaseStorageLayer(getTestDb(), user, 'skills').writeContent(
          'skills', 'Save 50%25 Off', held.replace('"Save Fifty"', '"Save 50%25 Off"'), { author: 'test', version: '1.0.0', description: 'Fixture', tags: [] });
        // Another process wrote the row after this process's index was built (a freshness case, not a
        // held-reference one): the listing brings it into the index first.
        await manager.listReport();
        expect((await manager.findByName('Save 50%25 Off'))?.metadata.name).toBe('Save 50%25 Off');
        expect((await manager.activateSkill('Save 50%25 Off')).success).toBe(true);
      } else {
        await writeFile(path.join(root, 'skills', 'save-50%25.md'), held);
        // Cold: a manager that has read nothing yet. The classifier's evidence read indexes the file, then
        // the layer is asked again, so the held reference resolves on the first call (ruling #588 item 2).
        const cold = createRealManagerSuite(root).skillManager;
        try {
          expect((await cold.findByStorageIdentity('save-50%25.md'))?.metadata.name).toBe('Save Fifty');
        } finally {
          await cold.dispose();
        }
        // This warm manager built its index before the file was written (a freshness case): it lists first.
        await manager.listReport();
        expect((await manager.load('save-50%25.md')).metadata.name).toBe('Save Fifty');
        expect((await manager.findByName('Save Fifty'))?.metadata.name).toBe('Save Fifty');
        expect((await manager.activateSkill('Save Fifty')).success).toBe(true);
      }
      await expect(manager.getActiveReferenceReport()).resolves.toMatchObject({ complete: true, failures: [] });
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });

  it('finds, activates, enforces and deletes a stored name holding a separator, and never selects by its slug', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'element-read-contract-'));
    const user = backend === 'database' ? fixedUserId(await ensureTestUser()) : undefined;
    const suite = createRealManagerSuite(root, { storageLayerFactory: user ? new DatabaseStorageLayerFactory(getTestDb(), user) : undefined });
    const manager = suite.skillManager;
    try {
      for (const name of ['CI/CD Helper', 'Team Notes']) {
        if (user) {
          await new DatabaseStorageLayer(getTestDb(), user, 'skills').writeContent(
            'skills', name, buildSkillContent(name), { author: 'test', version: '1.0.0', description: 'Fixture', tags: [] });
        } else {
          await mkdir(path.join(root, 'skills'), { recursive: true });
          await writeFile(path.join(root, 'skills', `${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}.md`), buildSkillContent(name));
        }
      }
      expect((await manager.listReport()).failures).toEqual([]);
      expect((await manager.findByName('CI/CD Helper'))?.metadata.name).toBe('CI/CD Helper');
      expect(await manager.findByName('team/notes')).toBeUndefined();
      const activated = await manager.activateSkill('CI/CD Helper');
      expect(activated.success ? 'activated' : activated.message).toBe('activated');
      await expect(manager.getActiveReferenceReport()).resolves.toMatchObject({ complete: true, failures: [] });
      await manager.deactivateSkill('CI/CD Helper');
      await expect(manager.delete('team/notes')).rejects.toMatchObject({ kind: 'absent' });
      await manager.delete('CI/CD Helper');
      expect((await manager.list()).map(item => item.metadata.name)).toEqual(['Team Notes']);
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });

  it('refuses a create of a name another process stored as a case variant since the index was built', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'element-read-contract-'));
    const user = backend === 'database' ? fixedUserId(await ensureTestUser()) : undefined;
    const suite = createRealManagerSuite(root, { storageLayerFactory: user ? new DatabaseStorageLayerFactory(getTestDb(), user) : undefined });
    const manager = suite.skillManager;
    try {
      if (!user) await mkdir(path.join(root, 'skills'), { recursive: true });
      await manager.list();
      // Another process stores 'my skill' after this process built its index.
      if (user) {
        await new DatabaseStorageLayer(getTestDb(), user, 'skills').writeContent(
          'skills', 'my skill', buildSkillContent('my skill'), { author: 'test', version: '1.0.0', description: 'Other process', tags: [] });
      } else {
        await writeFile(path.join(root, 'skills', 'my-skill.md'), buildSkillContent('my skill'));
      }
      await expect(manager.create({ name: 'My Skill', description: 'd', content: 'Follow these detailed instructions.' } as any))
        .rejects.toThrow(new Error('A skill named "My Skill" already exists (stored as "my skill")'));
      expect((await manager.list()).map(skill => skill.metadata.name)).toEqual(['my skill']);
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });

  it.each(['skill', 'memory'] as const)('a warm direct %s load sees another process\'s edit and delete of the stored definition', async type => {
    const root = await mkdtemp(path.join(tmpdir(), 'element-read-contract-'));
    const user = backend === 'database' ? fixedUserId(await ensureTestUser()) : undefined;
    const suite = createRealManagerSuite(root, { storageLayerFactory: user ? new DatabaseStorageLayerFactory(getTestDb(), user) : undefined });
    const manager = suite[`${type}Manager`];
    const name = `external-change-${type}`;
    const collection = type === 'memory' ? 'memories' : 'skills';
    const build = type === 'memory' ? buildMemoryContent : buildSkillContent;
    // The fixture's description line, so the edit changes neither the name nor the body shape.
    const marker = `Test ${type} ${name}`;
    try {
      let identity: string;
      if (user) {
        identity = await new DatabaseStorageLayer(getTestDb(), user, collection).writeContent(
          collection, name, build(name), { author: 'test', version: '1.0.0', description: 'Fixture', tags: [] });
      } else {
        identity = `${name}.${type === 'memory' ? 'yaml' : 'md'}`;
        await mkdir(path.join(root, collection), { recursive: true });
        await writeFile(path.join(root, collection, identity), build(name));
      }
      await manager.list();
      const warm = await manager.load(identity);
      const edited = build(name).replace(marker, `${marker} edited`);
      expect(edited).not.toBe(build(name));
      if (user) {
        await withUserContext(getTestDb(), user(), tx => tx.update(elements).set({ rawContent: edited, updatedAt: new Date() }).where(eq(elements.id, identity)));
      } else {
        const file = path.join(root, collection, identity);
        await writeFile(file, edited);
        await utimes(file, new Date(), new Date(Date.now() + 5_000));
      }
      const afterEdit = await manager.load(identity);
      expect(afterEdit).not.toBe(warm);
      expect(afterEdit.metadata.description).toBe(`${marker} edited`);
      if (user) await withUserContext(getTestDb(), user(), tx => tx.delete(elements).where(eq(elements.id, identity)));
      else await rm(path.join(root, collection, identity));
      await expect(manager.load(identity)).rejects.toMatchObject({ kind: 'absent' });
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });

  it.each(['skill', 'template', 'memory', 'ensemble', 'agent', 'persona'] as const)(
    'preserves %s instance identity, distinguishes absence from read failure and never overwrites on create', async type => {
      const root = await mkdtemp(path.join(tmpdir(), 'element-read-contract-'));
      const user = backend === 'database' ? fixedUserId(await ensureTestUser()) : undefined;
      const factory = user ? new DatabaseStorageLayerFactory(getTestDb(), user) : undefined;
      const suite = createRealManagerSuite(root, { storageLayerFactory: factory });
      const manager = suite[`${type}Manager`];
      const name = `identity-${type}`;
      const collection = type === 'memory' ? 'memories' : `${type}s`;
      const content = type === 'memory' ? buildMemoryContent(name) : buildSkillContent(name) +
        (type === 'template' ? '\n<template><h1>Safe template</h1></template>\n<style>h1 {color: blue}</style>\n<script>console.log("template body");</script>' : '');
      const survivorName = `survivor-${type}`;
      const survivorContent = type === 'memory' ? buildMemoryContent(survivorName) : buildSkillContent(survivorName);
      let identity: string;
      try {
        if (user) {
          identity = await new DatabaseStorageLayer(getTestDb(), user, collection).writeContent(
            collection, name, content, { author: 'test', version: '1.0.0', description: 'Identity fixture', tags: [] });
          await new DatabaseStorageLayer(getTestDb(), user, collection).writeContent(
            collection, survivorName, survivorContent, { author: 'test', version: '1.0.0', description: 'Survivor fixture', tags: [] });
        } else {
          const directory = path.join(root, collection);
          await mkdir(directory, { recursive: true });
          identity = `${name}.${type === 'memory' ? 'yaml' : 'md'}`;
          await writeFile(path.join(directory, identity), content);
          await writeFile(path.join(directory, `${survivorName}.${type === 'memory' ? 'yaml' : 'md'}`), survivorContent);
        }
        const storage = manager['storageLayer'];
        const filename = `${name}.${type === 'memory' ? 'yaml' : 'md'}`;
        await expect(storage.resolveReference(identity)).resolves.toEqual({ kind: 'identity', storageIdentity: identity, requested: identity });
        // On the database any text but a row id is a name, which the manager selects by the shared rule.
        await expect(storage.resolveReference(filename)).resolves.toEqual(user
          ? { kind: 'name', name: filename } : { kind: 'identity', storageIdentity: identity, requested: filename });
        await expect(storage.resolveReference(name)).resolves.toEqual({ kind: 'name', name });
        await expect(storage.resolveReference('proven-absent')).resolves.toEqual({ kind: 'name', name: 'proven-absent' });
        if (user) {
          expect((await manager.resolveDeletionTarget(filename)).storageIdentity).toBe(identity);
          expect((await manager.resolveDeletionTarget(name)).storageIdentity).toBe(identity);
        }
        // A certified name is read through the loader route (loadStoredReference), never back through load().
        const hydrate = jest.spyOn(manager as any, 'loadStoredReference');
        const cold = await manager.findByName(name);
        expect(hydrate).toHaveBeenCalledTimes(1);
        expect(hydrate).toHaveBeenCalledWith(identity);
        hydrate.mockRestore();
        const reads = [await manager.load(identity), await manager.load(identity), await manager.findByName(name),
          await manager.findByStorageIdentity(identity)];
        if (user) {
          // The database layer never vouches for a cached row (#959): another process may have changed it,
          // so every load by id or name returns the row as read now, as beta's loader did.
          for (const [index, read] of reads.slice(0, 3).entries()) {
            expect(read).not.toBe(index === 0 ? cold : reads[index - 1]);
            expect(read?.metadata.name).toBe(cold?.metadata.name);
          }
          // findByStorageIdentity keeps beta's own cache-first step (ruling #582): the instance just read.
          expect(reads[3]).toBe(reads[2]);
        } else {
          // The file layer vouches while the file keeps its indexed size and mtime: the same instance.
          for (const read of reads) expect(read).toBe(cold);
        }
        const held = reads[3]!;
        if (type === 'agent') {
          const replace = async (suffix: string) => {
            const updated = `${content}\n${suffix}`;
            if (user) await withUserContext(getTestDb(), user(), tx => tx.update(elements)
              .set({ rawContent: updated, updatedAt: new Date() }).where(eq(elements.id, identity)));
            else await writeFile(path.join(root, collection, identity), updated);
            manager['storageLayer'].invalidate();
          };
          await replace('Definition discovery observes an external edit.');
          const discovery = await manager['_listOps'].discoverReport(reference => manager['loadElementDefinition'](reference));
          expect(discovery.complete).toBe(true);
          expect(discovery.items.find(item => item.metadata.name === name)).not.toBe(held);
          // Every collection read evicts what it saw change (ruling #586 item 3): the stale instance is gone.
          expect(manager['getCachedElementByStorageIdentity'](identity)).toBeUndefined();
          await replace('A later external edit must evict the held instance during ordinary listing.');
          const listing = await manager.listReport();
          expect(listing.complete).toBe(true);
          expect(listing.items.find(item => item.metadata.name === name)).not.toBe(held);
        }
        if (type !== 'template') {
          const active = manager['getActivationSet']();
          active.add('pending');
          active.add('removed');
          let release!: () => void;
          let enter!: () => void;
          const blocked = new Promise<void>(resolve => { release = resolve; });
          const entered = new Promise<void>(resolve => { enter = resolve; });
          const lookup = jest.spyOn(manager as any, 'findActiveReference').mockImplementation(async reference => {
            if (reference === 'pending') { enter(); await blocked; }
            return held;
          });
          const activeRead = manager.getActiveReferenceReport();
          await Promise.race([entered, activeRead.then(report => { throw new Error(`Active read ended before lookup: ${JSON.stringify(report)}`); })]);
          active.delete('removed');
          active.add('added');
          release();
          const activeReport = await activeRead;
          const visited = lookup.mock.calls.map(([reference]) => reference);
          lookup.mockRestore();
          active.clear();
          expect(activeReport.items.map(item => item.metadata.name)).toHaveLength(2);
          expect(activeReport.items.every(item => item === held)).toBe(true);
          expect(visited).toEqual(['pending', 'added']);
        }
        expect(await manager.findByName('proven-missing')).toBeUndefined();
        expect(await manager.findByStorageIdentity(user ? randomUUID() : 'missing.md')).toBeUndefined();

        manager.clearCache();
        const storedBytes = async () => user
          ? (await withUserContext(getTestDb(), user(), tx => tx.select({ rawContent: elements.rawContent })
            .from(elements).where(eq(elements.id, identity))))[0]?.rawContent
          : readFile(path.join(root, collection, identity), 'utf8');
        const before = await storedBytes();
        const read = backend === 'database'
          ? jest.spyOn(storage, 'readContent').mockRejectedValue(new Error('Storage unavailable'))
          : jest.spyOn(suite.fileOperationsService, 'readFile').mockRejectedValue(new Error('Storage unavailable'));
        await expect(manager.load(identity)).rejects.toBeInstanceOf(ElementReadError);
        await expect(manager.findByStorageIdentity(identity)).rejects.toBeInstanceOf(ElementReadError);
        await expect(manager.list()).rejects.toBeInstanceOf(ElementReadError);
        // The database's name evidence is the name column, so the name is provably taken without the
        // body (ruling #579); the file layer's evidence is the parsed file, so the read failure leaves it
        // indeterminate. Both refuse and write nothing. The body reads above cover the read failure.
        // One duplicate-name message for every type.
        const duplicate = `${type === 'ensemble' || type === 'agent' ? 'An' : 'A'} ${type} named "${name}" already exists`;
        if (type === 'agent') {
          const created = await suite.agentManager.create(name, 'Existing definition must be checked', 'Detailed content for a duplicate check.');
          expect(created.success).toBe(false);
          if (user) expect(created.message).toBe(duplicate);
          else expect(created.message).toMatch(/Element identity could not be determined/);
        } else {
          const created = manager.create({ name, description: 'Existing definition must be checked',
            content: 'Detailed content for a duplicate check.', instructions: 'Detailed instructions for a duplicate check.' } as any);
          if (user) await expect(created).rejects.toThrow(new Error(duplicate));
          else await expect(created).rejects.toThrow(/Element identity could not be determined/);
          if (!user) await expect(created).rejects.toBeInstanceOf(ElementReadError);
        }
        expect(await manager.listReport()).toMatchObject({ complete: false });
        read.mockRestore();
        expect(await storedBytes()).toBe(before);

        manager.clearCache();
        const scan = backend === 'database'
          ? jest.spyOn(storage, 'scan').mockRejectedValue(new Error('Scan unavailable'))
          : jest.spyOn(suite.fileOperationsService, 'listDirectoryWithTypes').mockRejectedValue(new Error('Scan unavailable'));
        await expect(manager.list()).rejects.toBeInstanceOf(ElementReadError);
        expect(await manager.listReport()).toMatchObject({ complete: false });
        scan.mockRestore();
        const malformed = type === 'memory' ? 'metadata: [unfinished' : '---\nname: [unfinished\n---\n';
        if (user) {
          await withUserContext(getTestDb(), user(), tx => tx.update(elements).set({ rawContent: malformed })
            .where(eq(elements.id, identity)));
        } else {
          await writeFile(path.join(root, collection, identity), malformed);
        }
        manager.clearCache();
        await expect(manager.findByName(name)).rejects.toBeInstanceOf(ElementReadError);
        await expect(manager.list()).rejects.toBeInstanceOf(ElementReadError);
        const invalid = await manager.listReport();
        expect(invalid.complete).toBe(false);
        expect(invalid.failures.map(failure => failure.reference)).toContain(identity);
        expect(invalid.items.map(item => item.metadata.name)).toContain(survivorName);
        expect(invalid.items.map(item => item.metadata.name)).not.toContain(name);
        const selectedRead = jest.spyOn(manager as any, 'loadStoredReference');
        manager.clearCache();
        expect((await manager.findByName(survivorName))?.metadata.name).toBe(survivorName);
        expect(selectedRead).toHaveBeenCalledTimes(1);
        selectedRead.mockRestore();
        if (user) expect(await manager.findByName('another-missing-name')).toBeUndefined();
        if (type === 'persona') {
          const script = `${content}\n<script>alert("unsafe persona body");</script>`;
          if (user) {
            await expect(new DatabaseStorageLayer(getTestDb(), user, collection).writeContent(collection, name, script,
              { description: 'Unsafe body fixture', author: 'test', version: '1.0.0', tags: [] })).rejects.toThrow('Security threat');
            await withUserContext(getTestDb(), user(), tx => tx.update(elements).set({ rawContent: script }).where(eq(elements.id, identity)));
          } else await writeFile(path.join(root, collection, identity), script);
          manager.clearCache();
          await expect(manager.load(identity)).rejects.toMatchObject({
            kind: 'unreadable', message: expect.stringContaining('Definition content could not be read or validated'),
          });
          expect((await manager.listReport()).complete).toBe(false);
        }
      } finally {
        await Promise.all(['skillManager', 'templateManager', 'memoryManager', 'ensembleManager', 'agentManager', 'personaManager']
          .map(key => suite[key as `${typeof type}Manager`].dispose()));
        await rm(root, { recursive: true, force: true });
        if (user) await cleanupAllTestData();
      }
    });
});
