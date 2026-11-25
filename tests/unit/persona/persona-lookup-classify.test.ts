import { caseSensitiveTest } from '../../helpers/caseSensitiveTest.js';
/**
 * Persona lookups classify caller text before any cache step: path syntax that merely resolves to a
 * held file is refused warm and cold alike, and a refused lookup evicts nothing. A cached instance
 * is replaced only by a successful read, so a transient read failure never hides an active persona.
 * Concurrent lookups share an answer only for the same text, and a copy-on-write edit returns its copy.
 */
import { describe, expect, it, afterEach, beforeEach, afterAll } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { FAKE_DATABASE_USER, fakeDatabase, type FakeRow } from '../../helpers/fakeDatabase.js';
import type { PersonaManager } from '../../../src/persona/PersonaManager.js';

const BOUND = 30_000;
const persona = (name: string, id: string) =>
  `---\nname: ${JSON.stringify(name)}\ndescription: fixture persona\nunique_id: ${id}\n---\nYou are a careful and detailed assistant persona.`;
const nameOf = (found: { metadata: { name: string } } | undefined | null) => found?.metadata.name ?? null;

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'persona-lookup-classify-'));
const caseSensitiveIt = await caseSensitiveTest(fixtureRoot);
afterAll(() => rm(fixtureRoot, { recursive: true, force: true }));

describe('persona lookups on files', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  let personas: PersonaManager;
  let dir: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(fixtureRoot, 'fixture-'));
    suite = createRealManagerSuite(root);
    personas = suite.personaManager;
    dir = (personas as any)['elementDir'];
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await Promise.all([personas.dispose(), suite.memoryManager.dispose(), suite.skillManager.dispose()]);
    await rm(root, { recursive: true, force: true });
  });

  it('answers path syntax that resolves to a held file the same warm and cold: refused (H1)', async () => {
    await writeFile(path.join(dir, 'xavier.md'), persona('Xavier', 'p-xavier'));
    for (const text of ['./xavier.md', 'sub/../xavier.md', `../${path.basename(dir)}/xavier.md`]) {
      personas.clearCache();
      const cold = await personas.findPersonaAsync(text).then(nameOf, error => (error as Error).name);
      personas.clearCache();
      await personas.list();
      const warm = await personas.findPersonaAsync(text).then(nameOf, error => (error as Error).name);
      expect([text, warm]).toEqual([text, cold]);
      expect(cold).toBe('ValidationError');
      expect([text, nameOf(personas.findPersona(text))]).toEqual([text, null]);
      const activated = await personas.activatePersona(text).then(result => result.success, error => (error as Error).name);
      expect([text, activated]).toEqual([text, 'ValidationError']);
      expect(personas.getActivePersonaIds()).toEqual([]);
    }
  }, BOUND);

  it('refuses an absolute path without evicting the cached persona (H1)', async () => {
    await writeFile(path.join(dir, 'xavier.md'), persona('Xavier', 'p-xavier'));
    await personas.list();
    const absolute = path.join(dir, 'xavier.md');
    expect(nameOf(personas.findPersona(absolute))).toBeNull();
    await expect(personas.findPersonaAsync(absolute)).rejects.toThrow();
    expect(personas.getCachedElementByStorageIdentity('xavier.md')?.metadata.name).toBe('Xavier');
    expect(nameOf(personas.findPersona('xavier.md'))).toBe('Xavier');
  }, BOUND);

  caseSensitiveIt.each(['cold', 'warm'])('resolves and activates concurrent case-differing references as themselves (%s, H5)', async temperature => {
    await writeFile(path.join(dir, 'Alpha.md'), persona('Upper Persona', 'p-upper'));
    await writeFile(path.join(dir, 'alpha.md'), persona('Lower Persona', 'p-lower'));
    const reset = async () => {
      personas.clearCache();
      if (temperature === 'warm') await personas.list();
    };
    await reset();
    const found = await Promise.all([personas.findPersonaAsync('Alpha.md'), personas.findPersonaAsync('alpha.md')]);
    expect(found.map(nameOf)).toEqual(['Upper Persona', 'Lower Persona']);
    await reset();
    await Promise.all([personas.activatePersona('Alpha.md'), personas.activatePersona('alpha.md')]);
    expect(personas.getActivePersonas().map(nameOf).sort((a, b) => String(a).localeCompare(String(b))))
      .toEqual(['Lower Persona', 'Upper Persona']);
  }, BOUND);

  it('returns the writable copy a copy-on-write edit of a default persona saved (#1020a)', async () => {
    await writeFile(path.join(dir, 'creative-writer.md'), persona('Creative Writer', 'creative-writer'));
    await personas.list();
    const original = personas.findPersona('creative-writer.md')!;
    const updated = await personas.editExistingPersona(original, 'description', 'An edited copy');
    expect(updated.metadata.description).toBe('An edited copy');
    expect((updated as any).filename).not.toBe('creative-writer.md');
    expect(personas.findPersona('creative-writer.md')?.metadata.description).toBe('fixture persona');
  }, BOUND);
});

describe('persona lookups on the database', () => {
  it('keeps an active persona active and deactivatable through a transient read failure (H3)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'persona-lookup-db-'));
    const rows: FakeRow[] = [{ id: '6f1c2d3e-4a5b-4c6d-8e7f-001122334455', name: 'Xavier', description: 'x',
      rawContent: persona('Xavier', 'p-xavier'), updatedAt: new Date(Date.now() - 60_000) }];
    let failing = false;
    const log: string[] = [];
    const db = fakeDatabase(rows, log, { failContentReads: () => failing });
    const factory = { createForElement: (type: string) => new DatabaseStorageLayer(db as never, () => FAKE_DATABASE_USER, type) };
    const suite = createRealManagerSuite(root, { storageLayerFactory: factory as never });
    const personas = suite.personaManager;
    try {
      await personas.list();
      expect((await personas.activatePersona('Xavier')).success).toBe(true);
      const [key] = personas.getActivePersonaIds();
      // The resolved instance is kept on a layer that never vouches: no row read per lookup by id.
      const reads = log.filter(entry => entry.startsWith('readContent')).length;
      for (let i = 0; i < 3; i++) expect(nameOf(await personas.findPersonaAsync(key))).toBe('Xavier');
      expect(log.filter(entry => entry.startsWith('readContent'))).toHaveLength(reads);
      failing = true;
      await personas.findPersonaAsync(key).catch(() => undefined);
      failing = false;
      expect(personas.getActivePersonas().map(nameOf)).toEqual(['Xavier']);
      expect(personas.isPersonaActive('Xavier')).toBe(true);
      expect((await personas.deactivatePersona('Xavier')).success).toBe(true);
      expect(personas.getActivePersonas()).toEqual([]);
    } finally {
      await Promise.all([personas.dispose(), suite.memoryManager.dispose(), suite.skillManager.dispose()]);
      await rm(root, { recursive: true, force: true });
    }
  }, BOUND);
});
