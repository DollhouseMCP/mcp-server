/**
 * One text, one row: the database layer's callerNames (the text as written and its stripped name)
 * are ranked together by the shared selector, so an exact match on the stripped name ('readme')
 * beats a slug match on the text as written ('readme.md' → 'readme-md' = 'Readme MD'), for the read,
 * the existence check and the delete re-check's identity alike. Files agree.
 */
import { describe, expect, it } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { resolveNamedCandidateAmong } from '../../../src/storage/ElementNameKeys.js';
import { FAKE_DATABASE_USER, fakeDatabase, skillBody, type FakeRow } from '../../helpers/fakeDatabase.js';

const README = '6f1c2d3e-4a5b-4c6d-8e7f-0011223344aa';
const README_MD = '6f1c2d3e-4a5b-4c6d-8e7f-0011223344bb';

describe('the database name rule ranks every caller name together', () => {
  it('ranks by tier first, then the text as written before its stripped form; a remaining tie is ambiguous', () => {
    const candidates = [{ reference: 'a', name: 'Readme MD' }, { reference: 'b', name: 'readme' }];
    expect(resolveNamedCandidateAmong(['readme.md', 'readme'], candidates).selected?.reference).toBe('b');
    expect(resolveNamedCandidateAmong(['readme.md', 'readme'], [{ reference: 'c', name: 'readme.md' }, ...candidates]).selected?.reference).toBe('c');
    expect(resolveNamedCandidateAmong(['readme.md', 'readme'], [{ reference: 'd', name: 'README' }, candidates[1]]).competitors).toHaveLength(2);
  });

  it('reads, checks and resolves the identity of "readme.md" as the row "readme" on the database', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'database-name-rule-'));
    const rows: FakeRow[] = [
      { id: README_MD, name: 'Readme MD', description: 'slug match', rawContent: skillBody('Readme MD', 'slug match'), updatedAt: new Date(Date.now() - 60_000) },
      { id: README, name: 'readme', description: 'stripped match', rawContent: skillBody('readme', 'stripped match'), updatedAt: new Date(Date.now() - 60_000) },
    ];
    const db = fakeDatabase(rows, []);
    const layers = new Map<string, DatabaseStorageLayer>();
    const factory = { createForElement: (type: string) => layers.get(type) ?? layers.set(type, new DatabaseStorageLayer(db as never, () => FAKE_DATABASE_USER, type)).get(type)! };
    const suite = createRealManagerSuite(root, { storageLayerFactory: factory as never });
    try {
      for (const temperature of ['cold', 'warm']) {
        if (temperature === 'cold') suite.skillManager.clearCache();
        expect([temperature, (await suite.skillManager.findByName('readme.md'))?.metadata.name]).toEqual([temperature, 'readme']);
      }
      await expect(suite.skillManager.exists('readme.md')).resolves.toBe(true);
      const layer = layers.get('skills')!;
      await expect(layer.resolveContentIdentity('skills', 'readme.md')).resolves.toEqual({ id: README, name: 'readme' });
      await expect(layer.resolveContentIdentity('skills', 'Readme MD')).resolves.toEqual({ id: README_MD, name: 'Readme MD' });
    } finally {
      await Promise.all([suite.skillManager.dispose(), suite.memoryManager.dispose()]);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  const withDatabase = async (rows: FakeRow[], work: (suite: ReturnType<typeof createRealManagerSuite>,
    layers: Map<string, DatabaseStorageLayer>) => Promise<void>) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'database-name-rule-'));
    const db = fakeDatabase(rows, []);
    const layers = new Map<string, DatabaseStorageLayer>();
    const factory = { createForElement: (type: string) => layers.get(type) ?? layers.set(type, new DatabaseStorageLayer(db as never, () => FAKE_DATABASE_USER, type)).get(type)! };
    const suite = createRealManagerSuite(root, { storageLayerFactory: factory as never });
    try {
      await work(suite, layers);
    } finally {
      await Promise.all([suite.skillManager.dispose(), suite.memoryManager.dispose()]);
      await rm(root, { recursive: true, force: true });
    }
  };
  const row = (id: string, name: string): FakeRow =>
    ({ id, name, description: name, rawContent: skillBody(name, name), updatedAt: new Date(Date.now() - 60_000) });

  it('addresses the row a read selects when the console updates "readme.md" (#1018)', async () => {
    await withDatabase([row(README_MD, 'Readme MD'), row(README, 'readme')], async suite => {
      const target = await suite.skillManager.findForUpdate('readme.md');
      expect(target?.element.metadata.name).toBe('readme');
    });
  }, 30_000);

  it('never selects a row by its id through a filename-shaped text (#1019)', async () => {
    await withDatabase([row(README, 'readme')], async suite => {
      expect(await suite.skillManager.findByName(`${README}.md`)).toBeUndefined();
      await expect(suite.skillManager.exists(`${README}.md`)).resolves.toBe(false);
      expect((await suite.skillManager.findByName(README))?.metadata.name).toBe('readme');
    });
  }, 30_000);

  it('strips each type\'s own extension, and .yml as well as .yaml for memories (#1020c)', async () => {
    await withDatabase([], async () => {
      const db = fakeDatabase([], []);
      const memories = new DatabaseStorageLayer(db as never, () => FAKE_DATABASE_USER, 'memories');
      const skills = new DatabaseStorageLayer(db as never, () => FAKE_DATABASE_USER, 'skills');
      expect(memories.callerNames('notes.yml')).toEqual(['notes.yml', 'notes']);
      expect(memories.callerNames('notes.yaml')).toEqual(['notes.yaml', 'notes']);
      expect(memories.callerNames('Notes.YAML')).toEqual(['Notes.YAML', 'Notes']);
      expect(memories.callerNames('Notes.YML')).toEqual(['Notes.YML', 'Notes']);
      expect(skills.callerNames('Notes.MD')).toEqual(['Notes.MD', 'Notes']);
      expect(memories.callerNames('notes.md')).toEqual(['notes.md']);
      expect(skills.callerNames('notes.md')).toEqual(['notes.md', 'notes']);
      expect(skills.callerNames('notes.yml')).toEqual(['notes.yml']);
    });
  }, 30_000);

  it('ranks a new name as written, and names the row a read of that text selects when it is taken (L3)', async () => {
    await withDatabase([row(README_MD, 'My Notes.md'), row(README, 'my-notes')], async suite => {
      expect((await suite.skillManager.findByName('my-notes.md'))?.metadata.name).toBe('my-notes');
      await expect((suite.skillManager as any).nameTakenBy('my-notes.md')).resolves.toBe('my-notes');
    });
    await withDatabase([row(README, 'readme')], async suite => {
      await expect(suite.skillManager.exists('readme.md')).resolves.toBe(true);
      await expect((suite.skillManager as any).nameTakenBy('readme.md')).resolves.toBeUndefined();
    });
  }, 30_000);

  it('reads "readme.md" as the file readme.md on the file backend', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'file-name-rule-'));
    const suite = createRealManagerSuite(root);
    try {
      const dir = (suite.skillManager as any)['elementDir'];
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'readme.md'), skillBody('readme', 'file'));
      await writeFile(path.join(dir, 'readme-md.md'), skillBody('Readme MD', 'slug file'));
      await suite.skillManager.list();
      expect((await suite.skillManager.findByName('readme.md'))?.metadata.name).toBe('readme');
    } finally {
      await suite.skillManager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
