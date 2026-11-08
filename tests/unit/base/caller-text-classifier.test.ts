import { describe, expect, it, afterEach, beforeEach, jest } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { ValidationError } from '../../../src/security/errors.js';
import { SkillActivationStrategy } from '../../../src/handlers/strategies/SkillActivationStrategy.js';
import { editElement } from '../../../src/handlers/element-crud/editElement.js';
import { validateElement } from '../../../src/handlers/element-crud/validateElement.js';
import type { ElementCrudContext } from '../../../src/handlers/element-crud/types.js';
import { createTestStorageFactory } from '../../helpers/createTestStorageFactory.js';

const skill = (name: string) => `---\nname: ${name}\ndescription: Caller text fixture\n---\nFollow these detailed instructions.`;

describe('one caller-text classifier (file backend, real layer)', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  let dir: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'caller-text-'));
    suite = createRealManagerSuite(root);
    dir = (suite.skillManager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await suite.skillManager.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('reads, resolves and deletes a stored name with a dot identically, by name', async () => {
    await writeFile(path.join(dir, 'release.md'), skill('v1.2'));
    const manager = suite.skillManager;
    expect((await manager.findByName('v1.2'))?.metadata.name).toBe('v1.2');
    expect((await manager.load('v1.2')).metadata.name).toBe('v1.2');
    expect((await manager.load('release.md')).metadata.name).toBe('v1.2');
    await manager.delete('v1.2');
    await expect(access(path.join(dir, 'release.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('certifies display names the reference policy would refuse through the index, and refuses path-shaped text bare', async () => {
    // Names the reference policy refuses as filenames (spaces) are still stored names.
    await writeFile(path.join(dir, 'strict.md'), skill('Code Reviewer Strict'));
    await writeFile(path.join(dir, 'helper.md'), skill('My Skill'));
    const manager = suite.skillManager;
    expect((await manager.findByName('Code Reviewer Strict'))?.metadata.name).toBe('Code Reviewer Strict');
    expect((await manager.load('My Skill')).metadata.name).toBe('My Skill');
    await manager.delete('Code Reviewer Strict');
    await expect(access(path.join(dir, 'strict.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Path-shaped text is a reference: its syntax is checked bare and refused when invalid,
    // never certified as a name.
    for (const text of [path.join('..', 'outside'), path.join('team', '..', '..', 'x'), path.resolve(dir, 'helper.md')]) {
      await expect(manager.findByName(text)).rejects.toThrow(ValidationError);
      await expect(manager.load(text)).rejects.toThrow(ValidationError);
    }
    // Percent-encoded text is never decoded, and is not the layer's canonical reference form even with the
    // type's extension (ruling #584 item 3): no stored name holds it, so it is refused as path syntax.
    await expect(manager.load('%2e%2e%2fhelper.md')).rejects.toThrow(ValidationError);
  });

  it('reads separator text as a name-only lookup that never selects a slug-colliding element, and refuses path syntax no stored name holds', async () => {
    // 'team/notes' slugs to 'team-notes', the stored element's own filename key: a separated name selects
    // only by exact or folded name, so it selects nothing and deletes nothing (ruling #581 item 1).
    await writeFile(path.join(dir, 'team-notes.md'), skill('Team Notes'));
    const manager = suite.skillManager;
    for (const text of ['team/notes', String.raw`team\notes`]) {
      await expect(manager.findByName(text)).resolves.toBeUndefined();
      await expect(manager.load(text)).rejects.toMatchObject({ kind: 'absent' });
      await expect(manager.exists(text)).resolves.toBe(false);
      await expect(manager.delete(text)).rejects.toMatchObject({ kind: 'absent' });
    }
    // Path syntax is first offered as a stored name (ruling #584 item 2): an index lookup, never a
    // definition read; with no stored name of that text it is refused, and nothing is read or deleted.
    const reads = jest.spyOn(manager['storageLayer'], 'readContent');
    // Caller text, not filesystem paths: literal so the '..' segment is kept as written.
    for (const text of ['foo%2Fbar', 'team%2Fnotes', 'team/../notes', String.raw`team\..\notes`, path.resolve(dir, 'team-notes')]) {
      await expect(manager.findByName(text)).rejects.toThrow(ValidationError);
      await expect(manager.load(text)).rejects.toThrow(ValidationError);
      await expect(manager.exists(text)).rejects.toThrow(ValidationError);
      await expect(manager.delete(text)).rejects.toThrow(ValidationError);
    }
    expect(reads).not.toHaveBeenCalled();
    await expect(access(path.join(dir, 'team-notes.md'))).resolves.toBeUndefined();
    expect((await manager.findByName('Team Notes'))?.metadata.name).toBe('Team Notes');
    expect((await manager.findByName('team-notes'))?.metadata.name).toBe('Team Notes');
  });

  it('lists a raw-file name containing a separator, finds it by that name, and keeps it reachable by its storage reference', async () => {
    // No supported create path stores such a name; a raw file can ('<b>x</b>' sanitises to 'bx/b').
    await writeFile(path.join(dir, 'bold.md'), skill('"<b>x</b>"'));
    const manager = suite.skillManager;
    expect((await manager.listReport()).items.map(item => item.metadata.name)).toEqual(['bx/b']);
    expect((await manager.findByName('bx/b'))?.metadata.name).toBe('bx/b');
    expect((await manager.load('bold.md')).metadata.name).toBe('bx/b');
    expect((await manager.findByStorageIdentity('bold.md'))?.metadata.name).toBe('bx/b');
  });

  it.each([['warm', 'parse'], ['cold', 'parse'], ['warm', 'EACCES'], ['cold', 'EACCES']] as const)(
    'finds an exact reference beside a previously indexed failed sibling on the %s path (%s)', async (mode, failure) => {
    const manager = suite.skillManager;
    const storage = manager['storageLayer'];
    await writeFile(path.join(dir, 'foo.md'), skill('Foo'));
    await writeFile(path.join(dir, 'bar.md'), skill('Foo'));
    await manager.listReport();
    if (failure === 'parse') {
      await writeFile(path.join(dir, 'bar.md'), '---\nname: [broken\n---');
    } else {
      await writeFile(path.join(dir, 'bar.md'), skill('Foo') + '\nChanged while unreadable.');
      const read = suite.fileOperationsService.readFile.bind(suite.fileOperationsService);
      jest.spyOn(suite.fileOperationsService, 'readFile').mockImplementation((target, options) =>
        target === path.join(dir, 'bar.md')
          ? Promise.reject(Object.assign(new Error('Read denied'), { code: 'EACCES' })) : read(target, options));
    }
    await manager['scanAndEvict']();
    const evidence = await storage.readIndexedPath(['foo.md']);
    expect(evidence.failures.get('bar.md')?.candidateNames).toContain('Foo');
    expect(evidence.authoritative).toBe(true);
    if (mode === 'cold') {
      jest.spyOn(storage, 'readIndexedPath').mockResolvedValueOnce({ ...evidence, authoritative: false });
    }
    const collection = jest.spyOn(storage, 'readCollection');
    expect((await manager.findByName('foo.md'))?.metadata.name).toBe('Foo');
    expect(collection).toHaveBeenCalledTimes(mode === 'cold' ? 1 : 0);
    expect((await manager.load('foo.md')).metadata.name).toBe('Foo');
    await expect(manager.findByName('Foo')).rejects.toMatchObject({ kind: 'indeterminate' });
    const details = await new SkillActivationStrategy(manager).getElementDetails('foo.md');
    expect(details.content[0].text).toContain('Foo');
    const context = { ...suite, ensureInitialized: async () => {}, getPersonaIndicator: () => '',
      getManagerForType: () => manager } as unknown as ElementCrudContext;
    const validation = await validateElement(context, { name: 'foo.md', type: 'skills' });
    expect(validation.content[0].text).toContain('Validation');
    const edited = await editElement(context, { name: 'foo.md', type: 'skills', input: { description: 'Updated exact reference' } });
    expect(edited.isError).not.toBe(true);
    expect((await manager.load('foo.md')).metadata.description).toBe('Updated exact reference');
  });

  it('loads a healthy exact reference beside a failed sibling that could hold its name, and lists one survivor and one failure', async () => {
    await writeFile(path.join(dir, 'code-review.md'), skill('Code Review'));
    await writeFile(path.join(dir, 'Code Review.md'), '---\nname: [broken\n---');
    const manager = suite.skillManager;
    expect((await manager.load('code-review.md')).metadata.name).toBe('Code Review');
    const report = await manager.listReport();
    expect(report.items.map(item => item.metadata.name)).toEqual(['Code Review']);
    expect(report.failures.map(failure => failure.reference)).toEqual(['Code Review.md']);
  });
});

describe('one caller-text classifier (database backend)', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  const lookups = {
    resolveReference: jest.fn(async (requested: string) => ({ kind: 'name', name: requested })),
    resolveContentIdentity: jest.fn(async () => undefined),
    readIndexedPath: jest.fn(async () => ({ path: undefined, indexComplete: true, authoritative: true, unindexed: [], failures: new Map(), candidates: [] })),
  };
  const deleteContent = jest.fn();
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'caller-text-db-'));
    const files = createTestStorageFactory();
    // A writable layer with the database's reference shape; any lookup it is asked for is recorded.
    const storageLayerFactory = { createForElement: (...args: Parameters<typeof files.createForElement>) =>
      Object.assign(files.createForElement(...args), {
        writeContent: jest.fn(),
        deleteContent,
        cachedInstanceCurrency: 'unverifiable',
        isExactStorageReference: (reference: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(reference),
        ...lookups,
      }) } as never;
    suite = createRealManagerSuite(root, { storageLayerFactory });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await suite.skillManager.dispose();
    await rm(root, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('refuses path syntax on the database that no stored name holds, before any row read or deletion', async () => {
    const manager = suite.skillManager;
    for (const text of ['foo%2Fbar', 'team/../notes.md', String.raw`team\..\notes`, '/absolute/notes.md', String.raw`C:\notes`]) {
      await expect(manager.findByName(text)).rejects.toThrow(ValidationError);
      await expect(manager.load(text)).rejects.toThrow(ValidationError);
      await expect(manager.delete(text)).rejects.toThrow(ValidationError);
    }
    // Only the name index is consulted (ruling #584 item 2); no row is resolved or deleted.
    expect(lookups.resolveReference).not.toHaveBeenCalled();
    expect(lookups.resolveContentIdentity).not.toHaveBeenCalled();
    expect(deleteContent).not.toHaveBeenCalled();
  });

  it('reads separator text on the database as a name-only lookup: absent, and nothing deleted', async () => {
    const manager = suite.skillManager;
    for (const text of ['team/notes', 'team/notes.md', String.raw`team\notes.md`]) {
      await expect(manager.findByName(text)).resolves.toBeUndefined();
      await expect(manager.load(text)).rejects.toMatchObject({ kind: 'absent' });
      await expect(manager.delete(text)).rejects.toMatchObject({ kind: 'absent' });
    }
    expect(deleteContent).not.toHaveBeenCalled();
  });
});
