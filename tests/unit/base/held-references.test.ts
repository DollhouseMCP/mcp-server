/**
 * The storage layer decides what a reference is, and a selected reference is never classified as
 * caller text again:
 * - a held file whose name carries %xx ('save-50%25.md') lists, loads, resolves and activates;
 * - certification reads its selection through the loader, so classification cannot re-enter;
 * - findByStorageIdentity uses the one classifier, so path-syntax stored names resolve through
 *   the caller's name fallback (personas);
 * - every collection read evicts its diff, so a path-syntax lookup's snapshot never leaves a
 *   stale active agent cached for enforcement;
 * - an indeterminate index is never turned into a path refusal.
 * Every test is time-bounded, so a regression fails instead of exhausting the heap.
 */
import { describe, expect, it, afterEach, beforeEach, jest } from '@jest/globals';
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { ElementIndeterminateError } from '../../../src/elements/base/ElementReadError.js';
import { ValidationError } from '../../../src/security/errors.js';
import { RegistrySessionActivationStateAdapter } from '../../../src/web-console/modules/activations/SessionActivationStateAdapter.js';

const BOUND = 15_000;
const skill = (name: string) => `---\nname: ${JSON.stringify(name)}\ndescription: Held reference fixture\n---\nFollow these detailed instructions.`;
const persona = (name: string, id: string) => `---\nname: ${JSON.stringify(name)}\ndescription: Held reference persona\nunique_id: ${id}\n---\nYou are a careful and detailed assistant persona.`;

describe('held references and reads that never re-enter the caller-text entry', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'held-references-'));
    suite = createRealManagerSuite(root);
  });
  afterEach(async () => {
    await Promise.all([suite.skillManager.dispose(), suite.personaManager.dispose(), suite.agentManager.dispose(), suite.memoryManager.dispose()]);
    await rm(root, { recursive: true, force: true });
  });

  it.each(['cold', 'failed', 'corrupted'])('repairs a failed percent-bearing reference after %s discovery', async state => {
    const manager = suite.skillManager;
    const dir = (manager as any)['elementDir'];
    const reference = 'save-50%25.md';
    await mkdir(dir, { recursive: true });
    if (state === 'corrupted') {
      await writeFile(path.join(dir, reference), skill('Save Fifty'));
      await manager.listReport();
    }
    await writeFile(path.join(dir, reference), '---\nname: [unfinished\n---\n');
    if (state !== 'cold') {
      (manager as any)['storageLayer'].invalidate();
      await manager.listReport();
      expect((manager as any)['storageLayer'].holdsReference(reference)).toBe(true);
    }
    await manager.delete(reference);
    await expect(readFile(path.join(dir, reference))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(manager.delete('never-held%25.md')).rejects.toBeInstanceOf(ValidationError);
  }, BOUND);

  it('lists, loads, resolves, activates and reports a held file whose name carries %xx', async () => {
    const manager = suite.skillManager;
    const dir = (manager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'save-50%25.md'), skill('Save Fifty'));
    await writeFile(path.join(dir, 'plain.md'), skill('Plain'));
    const report = await manager.listReport();
    expect(report.failures).toEqual([]);
    expect(report.items.map(item => item.metadata.name).sort()).toEqual(['Plain', 'Save Fifty']);
    expect((await manager.load('save-50%25.md')).metadata.name).toBe('Save Fifty');
    expect((await manager.findByName('Save Fifty'))?.metadata.name).toBe('Save Fifty');
    expect((await manager.findByStorageIdentity('save-50%25.md'))?.metadata.name).toBe('Save Fifty');
    expect((await manager.activateSkill('Save Fifty')).success).toBe(true);
    await expect(manager.getActiveReferenceReport()).resolves.toMatchObject({ complete: true, failures: [] });
  }, BOUND);

  it('never classifies a selected reference again: certification reads it through the loader', async () => {
    const manager = suite.skillManager;
    const dir = (manager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'save-50%25.md'), skill('Save Fifty'));
    await manager.listReport();
    const classify = jest.spyOn(manager as any, 'classifyCallerText');
    for (const lookup of [() => manager.findByName('Save Fifty'), () => manager.load('Save Fifty'), () => manager.activateSkill('Save Fifty')]) {
      classify.mockClear();
      manager.clearCache();
      await lookup();
      // Only the caller's own text is classified; the reference certification selected never is.
      expect(classify.mock.calls.map(([text]) => text)).not.toContain('save-50%25.md');
    }
    // With the index built, the held reference is a reference: classified once, then read through the loader.
    await manager.listReport();
    classify.mockClear();
    await manager.load('save-50%25.md');
    expect(classify.mock.calls).toEqual([['save-50%25.md']]);
  }, BOUND);

  it.each(['and/or/..', '/slash first', 'Pros // Cons'])('activates and finds the persona stored as %j by name from a cold cache', async name => {
    const personas = suite.personaManager;
    const dir = (personas as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'p0.md'), persona(name, 'held-persona-0'));
    await personas.listReport();
    personas.clearCache();
    expect((await personas.findByStorageIdentity(name)) ?? undefined).toBeUndefined();
    personas.clearCache();
    expect((await personas.findPersonaAsync(name))?.metadata.name).toBe(name);
    personas.clearCache();
    expect((await personas.activatePersona(name)).success).toBe(true);
  }, BOUND);

  it('a path-syntax lookup after a pending invalidation never leaves a stale active agent for enforcement', async () => {
    const agents = suite.agentManager;
    await mkdir((agents as any)['elementDir'], { recursive: true });
    expect((await agents.create('gate-agent', 'Original description', 'Follow these detailed agent instructions.', {} as never)).success).toBe(true);
    expect((await agents.activateAgent('gate-agent')).success).toBe(true);
    await agents.getActiveReferenceReport();
    const file = path.join((agents as any)['elementDir'], 'gate-agent.md');
    await writeFile(file, (await readFile(file, 'utf8')).replace('Original description', 'Edited description, longer'));
    await utimes(file, new Date(), new Date(Date.now() + 5_000));
    (agents as any)['storageLayer'].invalidate();
    await expect(agents.findByName('x/../zzz')).rejects.toBeInstanceOf(ValidationError);
    const after = await agents.getActiveReferenceReport();
    expect(after.items.map(item => item.metadata.description)).toEqual(['Edited description, longer']);
  }, BOUND);

  it('reports an indeterminate index for a path-syntax name instead of refusing it as a path', async () => {
    const manager = suite.skillManager;
    const dir = (manager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 's0.md'), skill('Pros // Cons'));
    await manager.listReport();
    const layer = (manager as any)['storageLayer'];
    const unknown = { authoritative: false, indexComplete: false, unindexed: [], failures: new Map(), candidates: [], path: undefined };
    jest.spyOn(layer, 'readIndexedPath').mockResolvedValue(unknown as never);
    jest.spyOn(layer, 'readCollection').mockResolvedValue({ entries: [], unindexed: new Map(), authoritative: false, complete: false,
      diff: { added: [], modified: [], removed: [], unchanged: [] } } as never);
    await expect(manager.findByName('Pros // Cons')).rejects.toBeInstanceOf(ElementIndeterminateError);
  }, BOUND);

  it('resolves a held %xx reference by storage identity on the first, cold call', async () => {
    const manager = suite.skillManager;
    const dir = (manager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'save-50%25.md'), skill('Save Fifty'));
    // Nothing has read the collection yet: the classifier's own evidence read indexes it, then the
    // layer is asked again, so the held reference is a reference on this first call.
    expect((manager as any)['storageLayer'].isExactStorageReference('save-50%25.md', '.md')).toBe(false);
    expect((await manager.findByStorageIdentity('save-50%25.md'))?.metadata.name).toBe('Save Fifty');
    const pending = RegistrySessionActivationStateAdapter.prototype['resolvePendingTarget' as never] as
      (this: unknown, manager: unknown, name: string, storedKey?: string) => Promise<{ metadata: { name: string } } | undefined>;
    manager.clearCache();
    expect((await pending.call({}, manager, 'Save Fifty', 'save-50%25.md'))?.metadata.name).toBe('Save Fifty');
  }, BOUND);

  it('finds a memory by name in a sub-folder the index has not seen yet', async () => {
    const memories = suite.memoryManager;
    const dir = (memories as any)['memoriesDir'];
    for (const folder of ['2026-01-01', 'system']) await mkdir(path.join(dir, folder), { recursive: true });
    await writeFile(path.join(dir, '2026-01-01', 'alpha.yaml'), 'name: alpha\ndescription: a\nentries: []\n');
    await memories.listSummaries();
    await writeFile(path.join(dir, '2026-01-01', 'fresh-note.yaml'), 'name: fresh-note\ndescription: f\nentries: []\n');
    await writeFile(path.join(dir, 'system', 'sys-note.yaml'), 'name: sys-note\ndescription: s\nentries: []\n');
    expect((await memories.findByName('fresh-note'))?.metadata.name).toBe('fresh-note');
    expect((await memories.findByName('sys-note'))?.metadata.name).toBe('sys-note');
    expect((await memories.load('fresh-note.yaml')).metadata.name).toBe('fresh-note');
  }, BOUND);

  it('reads a name that starts with a letter and a colon as a name; only drive paths are path syntax', async () => {
    const manager = suite.skillManager;
    await mkdir((manager as any)['elementDir'], { recursive: true });
    for (const name of ['Q: Interview Prep', 'Notes: Plain']) {
      await expect(manager.findByName(name)).resolves.toBeUndefined();
    }
    for (const text of ['C:alpha.md', 'C:/alpha', 'C:']) {
      const reference = text.endsWith('.md') ? text : `${text}.md`;
      const message = path.isAbsolute(reference)
        ? 'Absolute skill paths are not allowed'
        : 'Invalid skill reference: elements are addressed by name or storage reference, not by path';
      const lookup = manager.findByName(text);
      await expect(lookup).rejects.toBeInstanceOf(ValidationError);
      await expect(lookup).rejects.toHaveProperty('message', message);
    }
  }, BOUND);

  it('reloads a watched reference through the stored-reference read, never the caller-text entry', async () => {
    const manager = suite.skillManager;
    const dir = (manager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'save-50%25.md'), skill('Save Fifty'));
    await manager.listReport();
    const classify = jest.spyOn(manager as any, 'classifyCallerText');
    const stored = jest.spyOn(manager as any, 'loadStoredReference');
    (manager as any)['_events'].handleExternalChange('save-50%25.md');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(stored).toHaveBeenCalledWith('save-50%25.md');
    expect(classify).not.toHaveBeenCalled();
  }, BOUND);
});
