import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, unlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { deleteElement } from '../../../src/handlers/element-crud/deleteElement.js';
import { ElementMissingError, ElementReadError, ElementUnreadableError } from '../../../src/elements/base/ElementReadError.js';
import { DEFAULT_PERSONAS } from '../../../src/constants/defaultPersonas.js';

describe('exact-reference repair deletion', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'repair-deletion-'));
    suite = createRealManagerSuite(root);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(['skillManager', 'templateManager', 'agentManager', 'memoryManager', 'ensembleManager', 'personaManager']
      .map(key => (suite as any)[key].dispose()));
    await rm(root, { recursive: true, force: true });
  });

  async function corrupt(type: string, reference?: string) {
    const directory = path.join(root, type === 'memory' ? 'memories' : `${type}s`);
    const filename = reference ?? `broken.${type === 'memory' ? 'yaml' : 'md'}`;
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, filename), type === 'memory' ? 'metadata: [unfinished' : '---\nname: [unfinished\n---\n');
    return { filename, absolute: path.join(directory, filename) };
  }

  it.each(['skill', 'template', 'agent', 'memory', 'ensemble', 'persona'] as const)(
    'deletes malformed %s only by exact reference and renders its notice', async type => {
      const { filename, absolute } = await corrupt(type);
      const manager = suite[`${type}Manager`];
      await expect(manager.resolveDeletionTarget('broken')).rejects.toBeInstanceOf(ElementReadError);
      expect(await readFile(absolute, 'utf8')).toContain('unfinished');
      const stateDelete = jest.spyOn(suite.agentManager['stateStore'], 'delete');
      const response = await deleteElement({ ...suite, fileOperations: suite.fileOperationsService,
        getManagerForType: (requested: string) => (suite as any)[`${requested === 'memories' ? 'memory' : requested.replace(/s$/, '')}Manager`],
        ensureInitialized: async () => undefined } as any, { name: filename, type });
      expect(response.content[0].text).toContain('Successfully deleted');
      expect(response.content[0].text).toContain('Definition could not be read');
      await expect(readFile(absolute)).rejects.toMatchObject({ code: 'ENOENT' });
      if (type === 'agent') {
        expect(stateDelete).toHaveBeenCalledWith({ name: 'broken', agentElementId: filename });
        expect(response.content[0].text).toContain('different metadata-derived key was not touched');
      }
    });

  it.each(['exists', 'delete', 'edit', 'save'] as const)('reports a dangling definition as unreadable during %s', async operation => {
    const dir = path.join(root, 'skills');
    await mkdir(dir, { recursive: true });
    const reference = 'dangling.md';
    const full = path.join(dir, reference);
    await writeFile(full, '---\nname: dangling\ndescription: fixture\n---\nValid fixture instructions');
    const manager = suite.skillManager;
    const element = await manager.load(reference);
    await unlink(full);
    await symlink(path.join(dir, 'missing.md'), full);
    const read = () => {
      if (operation === 'exists') return manager.exists(reference);
      if (operation === 'delete') return manager.delete(reference);
      if (operation === 'edit') return manager.findForUpdate('dangling');
      return manager.save(element, reference);
    };
    await expect(read()).rejects.toMatchObject({ kind: 'unreadable', code: 'EIO' });
    expect((await lstat(full)).isSymbolicLink()).toBe(true);
  });

  it('refuses a dangling memory existence probe instead of certifying absence', async () => {
    const dir = path.join(root, 'memories');
    await mkdir(dir, { recursive: true });
    await symlink(path.join(dir, 'missing.yaml'), path.join(dir, 'dangling.yaml'));
    await expect(suite.memoryManager.exists('dangling.yaml')).rejects.toMatchObject({ kind: 'unreadable', code: 'EIO' });
    await expect(suite.memoryManager.exists('missing.yaml')).resolves.toBe(false);
    await expect(suite.memoryManager.exists('missing.md')).resolves.toBe(false);
  });

  it('blocks persona creation when its target reference is dangling', async () => {
    const dir = path.join(root, 'personas');
    await mkdir(dir, { recursive: true });
    const full = path.join(dir, 'dangling.md');
    await symlink(path.join(dir, 'missing.md'), full);
    await expect(suite.personaManager.create({ name: 'dangling', description: 'Fixture', instructions: 'Follow fixture instructions' }))
      .rejects.toMatchObject({ kind: 'unreadable', code: 'EIO' });
    expect((await lstat(full)).isSymbolicLink()).toBe(true);
  });

  it('keeps dangling agent deletion a storage refusal without deleting state', async () => {
    const dir = path.join(root, 'agents');
    await mkdir(dir, { recursive: true });
    await symlink(path.join(dir, 'missing.md'), path.join(dir, 'dangling.md'));
    const stateDelete = jest.spyOn(suite.agentManager['stateStore'], 'delete');
    await expect(suite.agentManager.delete('dangling.md')).rejects.toMatchObject({ kind: 'unreadable', code: 'EIO' });
    expect(stateDelete).not.toHaveBeenCalled();
  });

  it('refuses infrastructure failure before deleting definition or state', async () => {
    const { filename, absolute } = await corrupt('agent');
    const failure = new ElementUnreadableError('Storage unavailable');
    jest.spyOn(suite.agentManager as any, 'loadElementDefinition').mockRejectedValue(failure);
    const stateDelete = jest.spyOn(suite.agentManager['stateStore'], 'delete');
    await expect(suite.agentManager.delete(filename)).rejects.toBe(failure);
    expect(stateDelete).not.toHaveBeenCalled();
    expect(await readFile(absolute, 'utf8')).toContain('unfinished');
  });

  it('protects a default persona without hydrating its refused bytes', async () => {
    const { filename, absolute } = await corrupt('persona', DEFAULT_PERSONAS[0]);
    await expect(suite.personaManager.delete(filename)).rejects.toThrow('Cannot delete a default persona');
    expect(await readFile(absolute, 'utf8')).toContain('unfinished');
  });

  it('preserves direct memory absence idempotence while user resolution refuses absence', async () => {
    await expect(suite.memoryManager.delete('absent.yaml')).resolves.toBeUndefined();
    await expect(suite.memoryManager.resolveDeletionTarget('absent.yaml')).rejects.toBeInstanceOf(ElementMissingError);
  });

  it.each(['element', 'repair'] as const)('refuses guarded memory %s deletion before mutation', async kind => {
    const { filename, absolute } = await corrupt('memory');
    const manager = suite.memoryManager;
    const repair = await manager.resolveDeletionTarget(filename);
    const target = kind === 'repair' ? repair : {
      kind: 'element' as const, storageIdentity: filename, element: {} as any,
    };
    Object.defineProperty(manager, 'guardedUpdateAdapter', { value: {}, configurable: true });
    const committed = jest.fn();
    try {
      await expect(manager.deleteResolved(target, committed)).rejects.toThrow('supports UPDATE only');
      expect(committed).not.toHaveBeenCalled();
      expect(await readFile(absolute, 'utf8')).toContain('unfinished');
    } finally {
      Object.defineProperty(manager, 'guardedUpdateAdapter', { value: undefined, configurable: true });
    }
  });

  it('reports orphaned agent state and refuses absence when no state exists', async () => {
    const state = suite.agentManager['stateStore'];
    jest.spyOn(state, 'load').mockResolvedValueOnce({} as any).mockResolvedValue(null);
    const remove = jest.spyOn(state, 'delete').mockResolvedValue();
    const target = await suite.agentManager.resolveDeletionTarget('orphan.md');
    expect(target).toMatchObject({ kind: 'repair', repair: 'orphaned-state' });
    const observer = jest.fn(() => { throw new Error('Observer unavailable'); });
    const report = await suite.agentManager.deleteResolved(target, observer);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith({ name: 'orphan', agentElementId: 'orphan.md' });
    expect(report.notices.join(' ')).toContain('orphaned agent state');
    await expect(suite.agentManager.resolveDeletionTarget('absent.md')).rejects.toBeInstanceOf(ElementMissingError);
  });
});
