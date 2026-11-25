/**
 * One canonical element name everywhere: canonicalElementName is idempotent, and for every element
 * type on both backends the name a stored definition is indexed under is the name its hydrated
 * element carries, so the listing and a lookup by that name always agree. A name that is missing or
 * canonicalises to nothing gets the type's one default in the index and on the element alike.
 */
import { describe, expect, it, afterEach, beforeEach, jest } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite, createRealPersonaManager, createTestMetadataService } from '../../helpers/di-mocks.js';
import { canonicalElementName, defaultElementName, foldedNameKey, storedElementName } from '../../../src/storage/ElementNameKeys.js';
import { PersonaElement } from '../../../src/persona/PersonaElement.js';
import { sanitizeInput } from '../../../src/security/InputValidator.js';
import { UnicodeValidator } from '../../../src/security/validators/unicodeValidator.js';
import { FrontmatterParser } from '../../../src/storage/FrontmatterParser.js';
import { MemoryMetadataExtractor } from '../../../src/storage/MemoryMetadataExtractor.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { Skill } from '../../../src/elements/skills/Skill.js';
import { Template } from '../../../src/elements/templates/Template.js';
import { Ensemble } from '../../../src/elements/ensembles/Ensemble.js';
import { Memory } from '../../../src/elements/memories/Memory.js';
import { Agent } from '../../../src/elements/agents/Agent.js';
import { AgentManager as AgentManagerClass } from '../../../src/elements/agents/AgentManager.js';
import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { MemoryUpgradeLifecycle } from '../../../src/lifecycle/MemoryUpgradeLifecycle.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { createTestStorageFactory } from '../../helpers/createTestStorageFactory.js';

/** The reviewers' inputs plus Unicode, stripped characters and names over the limit. */
const CORPUS = [
  'Cafe"́', 'x'.repeat(99) + 'é', 'éx', 'a'.repeat(99) + '\u{1F600}x', 'x'.repeat(99) + ' y', 'x'.repeat(150),
  'Café Notes', 'Café Notes', 'Ａｂｃ', 'a​b', 'раураl', 'Αlpha',
  '<b>x</b>', 'a;b|c', 'Q&A', "Sam's Helper", '---', 'My Skill', 'v1.2', '日本語', '  padded  ', '<>', ';|&', '',
];
const TEST_USER = '11111111-1111-4111-8111-111111111111';
/** Whether the YAML security parser accepts a definition with this name at all; refused ones are never indexed. */
const storable = (name: string): boolean => {
  try { FrontmatterParser.extractMetadata(`---\nname: ${JSON.stringify(name)}\n---\nBody`, 'skills'); return true; } catch { return false; }
};
const quote = (name: string) => JSON.stringify(name);

describe('canonical element name', () => {
  it.each(CORPUS.map(name => [quote(name), name]))('is idempotent for %s', (_label, raw) => {
    const once = canonicalElementName(raw);
    expect(canonicalElementName(once)).toBe(once);
    const stored = storedElementName(raw, 'skills');
    expect(storedElementName(stored, 'skills')).toBe(stored);
  });

  it('gives a missing or all-stripped name the type default on the element as in the index', () => {
    const metadata = createTestMetadataService();
    for (const raw of ['<>', ';|&', '', undefined]) {
      expect(new Skill({ name: raw as string }, 'Body', metadata).metadata.name).toBe(defaultElementName('skills'));
      expect(new Template({ name: raw as string }, 'Body', metadata).metadata.name).toBe(defaultElementName('templates'));
      expect(new Memory({ name: raw as string }, metadata).metadata.name).toBe(defaultElementName('memories'));
      expect(storedElementName(raw, 'skills')).toBe('Untitled Skill');
    }
    // A persona keeps its raw text only when some of it survives canonicalisation: an all-stripped
    // name takes the persona default, the name the index holds it under (ruling #592 item 2).
    for (const raw of ['<>', ';|&']) {
      expect(new PersonaElement({ name: raw }, 'Body', '', metadata).metadata.name).toBe(defaultElementName('personas'));
    }
  });

  it('lists, finds and activates an all-stripped persona under the persona default', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stripped-persona-'));
    const suite = createRealManagerSuite(root);
    try {
      const personas = suite.personaManager;
      const dir = (personas as any)['elementDir'];
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'stripped.md'),
        '---\nname: "<>"\ndescription: stripped persona\nunique_id: stripped-persona\n---\nYou are a careful and detailed assistant persona.');
      expect((await personas.listReport()).items.map(item => item.metadata.name)).toEqual(['Untitled Persona']);
      personas.clearCache();
      expect((await personas.findByName('Untitled Persona'))?.filename).toBe('stripped.md');
      expect((await personas.activatePersona('Untitled Persona')).success).toBe(true);
    } finally {
      await suite.personaManager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a persona\'s name as written through the base, as beta does', () => {
    const metadata = createTestMetadataService();
    for (const raw of ['Test: Persona with "quotes"', 'Cafe"\u0301', 'Q&A']) {
      expect(new PersonaElement({ name: raw }, 'Body', '', metadata).metadata.name).toBe(raw);
    }
  });

  it('builds the same element id as beta for ordinary names (the id input equals beta\'s one-pass name)', () => {
    const metadata = createTestMetadataService();
    const betaOnePass = (name: string) => sanitizeInput(UnicodeValidator.normalize(name).normalizedContent, 100);
    for (const name of ['My Skill', 'v1.2', 'Q&A', "Sam's Helper", 'Caf\u00e9 Notes', 'release-notes', 'Element Name 42']) {
      expect(canonicalElementName(name)).toBe(betaOnePass(name));
      const skill = new Skill({ name }, 'Body', metadata);
      const slug = betaOnePass(name).toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/(^-)|(-$)/g, '');
      expect(skill.id.replace(/_\d+$/u, '')).toBe(`skills_${slug}`);
    }
  });

  it('applies the name rule to a deserialized skill and template, as to a constructed one', () => {
    const metadata = createTestMetadataService();
    const raw = 'Cafe\"\u0301';
    for (const element of [new Skill({ name: 'seed' }, 'Body', metadata), new Template({ name: 'seed' }, 'Body', metadata)]) {
      element.deserialize(JSON.stringify({ metadata: { name: raw }, content: 'Body' }));
      expect(element.metadata.name).toBe(canonicalElementName(raw));
      expect(element.metadata.name).not.toBe(raw);
    }
  });

  it('hydrates every type with the name the shared reader indexes', () => {
    const metadata = createTestMetadataService();
    for (const raw of CORPUS.filter(name => storedElementName(name, 'skills') !== 'Untitled Skill' && storable(name))) {
      const indexed = (type: string) => FrontmatterParser.extractMetadata(`---\nname: ${quote(raw)}\n---\nBody`, type).name;
      expect(new Skill({ name: raw }, 'Body', metadata).metadata.name).toBe(indexed('skills'));
      expect(new Template({ name: raw }, 'Body', metadata).metadata.name).toBe(indexed('templates'));
      expect(new Agent({ name: raw }, metadata).metadata.name).toBe(indexed('agents'));
      expect(new Ensemble({ name: raw }, [], metadata).metadata.name).toBe(indexed('ensembles'));
      // Memories and personas keep their raw stored name as identity; their keys agree.
      const memoryIndexed = MemoryMetadataExtractor.extractMetadata(`metadata:\n  name: ${quote(raw)}\nentries: []\n`, 'fallback').name;
      expect(foldedNameKey(new Memory({ name: raw }, metadata).metadata.name)).toBe(foldedNameKey(memoryIndexed));
      expect(foldedNameKey(new PersonaElement({ name: raw }, 'Body', '', metadata).metadata.name)).toBe(foldedNameKey(indexed('personas')));
    }
  });
});

/** A drizzle-shaped transaction that records every inserted row and answers no existing rows. */
function recordingDb() {
  const inserted: Array<Record<string, unknown>> = [];
  const chain = (rows: unknown[]) => {
    const value: Record<string, unknown> = {};
    for (const name of ['from', 'where', 'limit', 'onConflictDoUpdate', 'onConflictDoNothing', 'set', 'for']) value[name] = () => value;
    value.values = (row: Record<string, unknown>) => { inserted.push(row); return value; };
    value.returning = () => Promise.resolve([{ id: '22222222-2222-4222-8222-222222222222' }]);
    value.then = (resolve: (rows: unknown[]) => unknown, reject: (cause: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
    return value;
  };
  const tx = {
    execute: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    select: jest.fn(() => chain([])), insert: jest.fn(() => chain([])), update: jest.fn(() => chain([])), delete: jest.fn(() => chain([])),
  };
  const transaction = jest.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx));
  return { inserted, db: { transaction } as never };
}

describe('database rows keep the hydrated name', () => {
  it.each(CORPUS.filter(name => name !== '' && storable(name)).map(name => [quote(name), name]))('stores %s under the name its element carries', async (_label, raw) => {
    const metadata = createTestMetadataService();
    const elements = recordingDb();
    const layer = new DatabaseStorageLayer(elements.db, () => TEST_USER, 'skills');
    await layer.writeContent('skills', '', `---\nname: ${quote(raw)}\n---\nBody`, { author: '', version: '1.0.0', description: '', tags: [] });
    expect(elements.inserted.at(-1)?.name).toBe(new Skill({ name: raw }, 'Body', metadata).metadata.name);
    // A memory row keeps the name it was written with (its guarded identity, #574); its key is the
    // element's. A name that canonicalises to nothing keeps its raw row name (beta's write, unchanged).
    if (canonicalElementName(raw) === '') return;
    const memories = recordingDb();
    const memoryLayer = new DatabaseMemoryStorageLayer(memories.db, () => TEST_USER);
    await memoryLayer.writeContent('memories', raw, `metadata:\n  name: ${quote(raw)}\nentries: []\n`, { author: '', version: '1.0.0', description: '', tags: [] });
    expect(foldedNameKey(String(memories.inserted.at(-1)?.name))).toBe(foldedNameKey(new Memory({ name: raw }, metadata).metadata.name));
  });
});

describe('file backend: the listing and the lookup agree for every type', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  let persona: ReturnType<typeof createRealPersonaManager>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'canonical-names-'));
    suite = createRealManagerSuite(root);
    persona = createRealPersonaManager(root);
  });
  afterEach(async () => {
    for (const manager of [suite.skillManager, suite.templateManager, suite.agentManager, suite.ensembleManager, suite.memoryManager, persona]) {
      await manager.dispose();
    }
    await rm(root, { recursive: true, force: true });
  });

  const definition = (type: string, raw: string) => type === 'ensembles'
    ? `---\nname: ${quote(raw)}\ndescription: fixture\nelements: []\n---\nBody`
    : `---\nname: ${quote(raw)}\ndescription: fixture\n---\nFollow these detailed instructions.`;

  // Names over the limit are refused by every type's read-time field validator (fail closed), so they list as failures.
  it.each(['Cafe"́', 'x'.repeat(99) + 'é', 'Café Notes', 'e\u0301x'].map(name => [quote(name), name]))(
    'lists %s under the name a lookup finds, for every markdown type', async (_label, raw) => {
      const managers = { skills: suite.skillManager, templates: suite.templateManager, agents: suite.agentManager } as const;
      for (const [type, manager] of Object.entries(managers)) {
        const dir = (manager as any)['elementDir'];
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'stored.md'), definition(type, raw));
        const report = await manager.listReport();
        expect(report.failures).toEqual([]);
        const [item] = report.items;
        const entries = (await (manager as any).storageLayer.readCollection()).entries;
        expect(entries.map((entry: { name: string }) => entry.name)).toEqual([item.metadata.name]);
        expect((await manager.findByName(item.metadata.name))?.metadata.name).toBe(item.metadata.name);
      }
    });

  it('names a nameless skill by its file stem and an all-stripped one by the type default, in the listing and the lookup alike', async () => {
    const manager = suite.skillManager;
    const dir = (manager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'stripped.md'), definition('skills', '<>'));
    await writeFile(path.join(dir, 'nameless.md'), '---\ndescription: Nameless fixture\n---\nFollow these detailed instructions.');
    expect((await manager.listReport()).items.map(item => item.metadata.name).sort()).toEqual(['Untitled Skill', 'nameless']);
    expect((await (manager as any).storageLayer.readCollection()).entries.map((entry: { name: string }) => entry.name).sort())
      .toEqual(['Untitled Skill', 'nameless']);
    expect((await manager.findByName('Untitled Skill'))?.metadata.name).toBe('Untitled Skill');
    expect((await manager.findByName('nameless'))?.metadata.name).toBe('nameless');
  });

  it('refuses the shared default name as ambiguous when several stripped definitions carry it', async () => {
    const manager = suite.skillManager;
    const dir = (manager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'first.md'), definition('skills', '<>'));
    await writeFile(path.join(dir, 'second.md'), definition('skills', ';|&'));
    expect((await manager.listReport()).items.map(item => item.metadata.name)).toEqual(['Untitled Skill', 'Untitled Skill']);
    await expect(manager.findByName('Untitled Skill')).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  /** The ruling's inputs for the two raw-identity types: the reviewer's, an ampersand and an over-limit name. */
  const RAW_IDENTITY = ['Cafe"\u0301', 'x'.repeat(99) + '\u00e9', 'R&D', 'y'.repeat(120)];

  it.each(RAW_IDENTITY.map(name => [quote(name), name]))('resolves a persona listed as %s by its listed name, keys equal to the index', async (_label, raw) => {
    const dir = (persona as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'stored.md'), definition('personas', raw));
    const report = await persona.listReport();
    const entries = (await (persona as any).storageLayer.readCollection()).entries;
    for (const item of report.items) {
      expect(entries.map((entry: { name: string }) => foldedNameKey(entry.name))).toContain(foldedNameKey(item.metadata.name));
      expect((await persona.findByName(item.metadata.name))?.metadata.name).toBe(item.metadata.name);
    }
    // An over-limit persona name is a typed failure of its file; every other name lists.
    const overLimit = raw.length > 100;
    expect([report.items.length, report.failures.map(failure => failure.reference)]).toEqual(overLimit ? [0, ['stored.md']] : [1, []]);
  });

  it.each(RAW_IDENTITY.map(name => [quote(name), name]))('resolves and drains a memory listed as %s by its listed name', async (_label, raw) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'canonical-drain-'));
    const metadata = createTestMetadataService();
    const locks = new FileLockManager();
    const files = new FileOperationsService(locks);
    const lifecycle = new MemoryUpgradeLifecycle();
    const manager = new MemoryManager({ portfolioManager: new PortfolioManager(files, { baseDir: directory }),
      fileLockManager: locks, fileOperationsService: files,
      validationRegistry: new ValidationRegistry(new ValidationService(), new TriggerValidationService(), metadata),
      serializationService: new SerializationService(), metadataService: metadata,
      eventDispatcher: new ElementEventDispatcher(), storageLayerFactory: createTestStorageFactory(),
      memoryUpgradeLifecycle: lifecycle });
    try {
      const folder = path.join(directory, 'memories', '2026-01-01');
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, 'stored.yaml'), `metadata:\n  name: ${quote(raw)}\n  description: fixture\nentries: []\n`);
      const report = await manager.listReport();
      // Every memory name in the corpus lists, with no failure.
      expect([report.items.length, report.failures]).toEqual([1, []]);
      const entries = (await (manager as any).storageLayer.readCollection()).entries;
      for (const item of report.items) {
        expect(entries.map((entry: { name: string }) => foldedNameKey(entry.name))).toContain(foldedNameKey(item.metadata.name));
        expect((await manager.findByName(item.metadata.name))?.metadata.name).toBe(item.metadata.name);
        await expect(manager.runFreshMemoryMutation(item.metadata.name, async memory => memory.metadata.name))
          .resolves.toBe(item.metadata.name);
      }
    } finally {
      await lifecycle.quiesceAndDrain();
      await manager.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('per-type name keys use the shared keys', () => {
  it('detects an agent activation self-loop whose names differ only in Unicode form', () => {
    const stack = (AgentManagerClass as any).createActivationCycleStack('Café', ['Café']);
    expect(stack.selfLoop).toEqual(['Café', 'Café']);
  });

  it('names an ensemble\'s known members when its reference is released by a case-folded key', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ensemble-release-'));
    const suite = createRealManagerSuite(root);
    try {
      await mkdir((suite.ensembleManager as any)['elementDir'], { recursive: true });
      await suite.ensembleManager.create({ name: 'Ops Team', description: 'd',
        elements: [{ element_name: 'deploy-helper', element_type: 'skill', role: 'support', activation: 'always' }] } as never);
      await suite.ensembleManager.list();
      const released = suite.ensembleManager.releaseActivationReference('ops team');
      expect(released.message).toContain('Known members: skill "deploy-helper"');
    } finally {
      await suite.ensembleManager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
