import { MAX_CACHED_DIRECTORY_STATES } from '../../../src/storage/DirectoryStateCache.js';
import { ElementStorageLayer } from '../../../src/storage/ElementStorageLayer.js';
import { MemoryStorageLayer } from '../../../src/storage/MemoryStorageLayer.js';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { BaseElementManager } from '../../../src/elements/base/BaseElementManager.js';
import type { IElement } from '../../../src/types/elements/IElement.js';
import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import { createStdioSession } from '../../../src/context/StdioSession.js';
import { PathService } from '../../../src/paths/PathService.js';
import { MIGRATION_MARKER_FILENAME } from '../../../src/paths/LegacyDetectingPathResolver.js';
import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { PersonaManager } from '../../../src/persona/PersonaManager.js';
import { ElementType } from '../../../src/portfolio/types.js';

const environmentKeys = ['DOLLHOUSE_HOME_DIR', 'DOLLHOUSE_PORTFOLIO_DIR', 'DOLLHOUSE_USER'] as const;

describe.each(['flat', 'per-user'])('%s storage directory resolution', layout => {
  let home: string;
  let container: DollhouseContainer;
  let savedEnvironment: (string | undefined)[];
  const inSession = async (work: () => Promise<void>, userId = 'storage-user') => {
    const tracker = container.resolve<ContextTracker>('ContextTracker');
    await tracker.runAsync(tracker.createSessionContext('background-task', { ...createStdioSession(), userId, sessionId: userId }), work);
  };
  beforeEach(async () => {
    savedEnvironment = environmentKeys.map(key => process.env[key]);
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-directory-'));
    const legacy = path.join(home, '.dollhouse');
    await fs.mkdir(legacy);
    // A pre-existing migration marker pins per-user detection across restarts.
    if (layout === 'per-user') await fs.writeFile(path.join(legacy, MIGRATION_MARKER_FILENAME), '{}');
    process.env.DOLLHOUSE_HOME_DIR = home;
    process.env.DOLLHOUSE_PORTFOLIO_DIR = layout === 'flat' ? path.join(legacy, 'portfolio') : legacy;
    process.env.DOLLHOUSE_USER = 'storage-user';
    container = new DollhouseContainer();
    await container.preparePortfolio();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await container.dispose();
    await fs.rm(home, { recursive: true, force: true });
    environmentKeys.forEach((key, index) => {
      if (savedEnvironment[index] === undefined) delete process.env[key];
      else process.env[key] = savedEnvironment[index];
    });
  });
  it.each([
    ['external change', 'Display Metadata'], ['external change', 'display-metadata'],
    ['failed save notification', 'Display Metadata'], ['failed save notification', 'display-metadata'],
  ])('recovers an invalidated index miss after %s for %s', async (invalidation, identifier) => {
    await inSession(async () => {
      const manager = container.resolve<BaseElementManager<IElement>>('SkillManager');
      const storage = manager['storageLayer'] as ElementStorageLayer;
      await manager.list();
      expect(storage.hasCompletedScan()).toBe(true);
      const absolutePath = path.join(manager['elementDir'], 'hand-written.md');
      await fs.writeFile(absolutePath,
        '---\nname: Display Metadata\ndescription: Added after the initial scan\n---\nFollow these detailed instructions.');
      if (invalidation === 'external change') {
        manager['_events'].handleExternalChange('hand-written.md');
      } else {
        jest.spyOn(storage['backend'], 'stat').mockRejectedValueOnce(new Error('Temporary stat failure'));
        await storage.notifySaved('hand-written.md', absolutePath);
      }
      expect(storage.hasCompletedScan()).toBe(false);
      const list = jest.spyOn(manager, 'list');
      expect((await manager.findByName(identifier))?.metadata.name).toBe('Display Metadata');
      expect(list).toHaveBeenCalledTimes(1);
    });
  });

  it.each(['slug', 'id'] as const)('preserves cold %s lookup for a noncanonical filename', async lookup => {
    await inSession(async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
      const manager = container.resolve<BaseElementManager<IElement>>('SkillManager');
      const directory = manager['elementDir'];
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'hand-written.md'),
        '---\nname: Display Metadata\ndescription: Flexible name fixture\n---\nFollow these detailed instructions.');
      const definition = await manager['loadElementDefinition']('hand-written.md');
      expect(manager['storageLayer'].hasCompletedScan()).toBe(false);
      const list = jest.spyOn(manager, 'list');
      const found = await manager.findByName(lookup === 'slug' ? 'display-metadata' : definition.id);
      expect(found?.metadata.name).toBe('Display Metadata');
      expect(list).toHaveBeenCalledTimes(1);
    });
  });

  it.each(['lookup', 'update target'] as const)('preserves another cached definition after an unrelated %s', async operation => {
    await inSession(async () => {
      const manager = container.resolve<BaseElementManager<IElement>>('SkillManager');
      const directory = manager['elementDir'];
      await fs.mkdir(directory, { recursive: true });
      const content = (name: string, description: string) =>
        `---\nname: ${name}\ndescription: ${description}\n---\nFollow these detailed instructions.`;
      const alphaPath = path.join(directory, 'alpha.md');
      await fs.writeFile(alphaPath, content('Alpha', 'Original definition'));
      await fs.writeFile(path.join(directory, 'beta.md'), content('Beta', 'Unrelated definition'));
      await manager.list();
      const original = await manager.findByName('Alpha');
      manager['uncacheByPath'](path.join(directory, 'beta.md'));
      const edit = async () => {
        const previous = await fs.stat(alphaPath);
        await fs.writeFile(alphaPath, content('Alpha', 'Edited definition'));
        await fs.utimes(alphaPath, new Date(), new Date(previous.mtimeMs + 2000));
        const storage = manager['storageLayer'] as ElementStorageLayer;
        jest.spyOn(Date, 'now').mockReturnValue(Date.now() + storage['scanCooldownMs'] + 1);
      };
      if (operation === 'lookup') {
        await edit();
        expect((await manager.findByName('Beta'))?.metadata.name).toBe('Beta');
      } else {
        const refresh = manager['scanAndEvict'].bind(manager);
        // Open the second-scan window after the update path's legitimate invalidation refresh.
        jest.spyOn(manager as any, 'scanAndEvict').mockImplementationOnce(async () => {
          await refresh();
          await edit();
        });
        expect((await manager['_persister'].resolveUpdateTarget('Beta'))?.path).toBe('beta.md');
      }
      const refreshed = (await manager.list()).find(element => element.metadata.name === 'Alpha');
      expect(refreshed?.metadata.description).toBe('Edited definition');
      expect(refreshed).not.toBe(original);
    });
  });

  it.each(['update target', 'auto-load'] as const)('resolves %s under retained-directory overflow', async operation => {
    await inSession(async () => {
      const type = operation === 'update target' ? ElementType.SKILL : ElementType.MEMORY;
      const manager = container.resolve<BaseElementManager<IElement>>(
        type === ElementType.SKILL ? 'SkillManager' : 'MemoryManager');
      const directory = manager['elementDir'];
      await fs.mkdir(directory, { recursive: true });
      const relative = type === ElementType.SKILL ? 'hand-written.md' : 'hand-written.yaml';
      const metadata = 'name: Display Metadata\ndescription: Retained directory fixture\nversion: 1.0.0\n';
      const content = type === ElementType.SKILL ? `---\n${metadata}---\nFollow these detailed instructions.`
        : `${metadata}autoLoad: true\npriority: 1\nentries: []\n`;
      await fs.writeFile(path.join(directory, relative), content);
      const storage = manager['storageLayer'] as ElementStorageLayer | MemoryStorageLayer;
      jest.spyOn(storage as any, 'retainDirectoryState').mockImplementation(dir => dir !== directory);
      for (let index = 0; index <= MAX_CACHED_DIRECTORY_STATES; index++) {
        storage['getState'](path.join(home, `retained-${index}`));
      }
      expect(storage['dirStates'].size).toBeGreaterThan(MAX_CACHED_DIRECTORY_STATES);
      // This scan's idle state cannot survive alongside the retained directories.
      const initial = storage['getState']();
      await storage.scan();
      if ('indexFile' in initial) await initial.indexFile.flush();
      expect(storage.hasCompletedScan()).toBe(false);
      if (operation === 'update target') {
        expect((await manager['_persister'].resolveUpdateTarget('Display Metadata'))?.path).toBe(relative);
        expect((await manager.findByName('Display Metadata'))?.metadata.name).toBe('Display Metadata');
      } else {
        const memories = await (manager as MemoryManager).getAutoLoadMemories();
        expect(memories.map(memory => memory.metadata.name)).toEqual(['Display Metadata']);
      }
    });
  });

  it.each([
    [ElementType.SKILL, true], [ElementType.SKILL, false],
    [ElementType.MEMORY, true], [ElementType.MEMORY, false],
  ] as const)('keeps %s reads fresh after churn (pinned: %s), saves and restart', async (type, pinned) => {
    const service = type === ElementType.SKILL ? 'SkillManager' : 'MemoryManager';
    // Root services are constructed before a request establishes its user scope.
    container.resolve<BaseElementManager<IElement>>(service);
    const relative = type === ElementType.SKILL ? 'directory-probe.md' : 'directory-probe.yaml';
    const metadata = 'name: directory-probe\ndescription: Initial description\nversion: 1.0.0\n';
    const content = type === ElementType.SKILL ? `---\n${metadata}---\nFollow the fixture instructions.` : `${metadata}autoLoad: true\nentries: []\n`;
    let directory: string;
    await inSession(async () => {
      const manager = container.resolve<BaseElementManager<IElement>>(service);
      directory = container.resolve<PathService>('PathService').getUserElementDir(type);
      const expected = layout === 'flat' ? path.join(home, '.dollhouse', 'portfolio', type)
        : path.join(home, '.dollhouse', 'users', 'storage-user', 'portfolio', type);
      expect(directory).toBe(expected);
      expect(manager['elementDir']).toBe(directory);
      await fs.mkdir(directory, { recursive: true });
      const file = path.join(directory, relative);
      await fs.writeFile(file, content);
      await manager['scanAndEvict']();
      expect(manager['storageLayer'].getPathByName('directory-probe')).toBe(relative);
      const warm = await manager.load(relative);
      warm.metadata.description = 'Saved description';
      const notify = jest.spyOn(manager['storageLayer'], 'notifySaved');
      await manager.save(warm, relative);
      expect(notify).toHaveBeenCalledWith(relative, file);
      expect(manager['storageLayer'].getPathByName('directory-probe')).toBe(relative);
      const saved = await fs.readFile(file, 'utf8');
      expect(saved).toContain('Saved description');
      const storage = manager['storageLayer'] as ElementStorageLayer | MemoryStorageLayer;
      const churnDirectoryState = async () => {
        const original = storage['getState']();
        if (!pinned) manager['uncacheByPath'](file);
        if ('indexFile' in original) await original.indexFile.flush();
        for (let i = 0; i < MAX_CACHED_DIRECTORY_STATES; i++) {
          storage['getState'](path.join(home, `idle-${i}`));
        }
        expect(storage['getState']() === original).toBe(pinned);
      };
      await churnDirectoryState();
      await fs.writeFile(file, saved.replace('Saved description', 'External description'));
      await fs.utimes(file, new Date(), new Date(Date.now() + 2000));
      if (!pinned) await manager.list();
      await manager['scanAndEvict']();
      const refreshed = await manager.findByName('directory-probe');
      expect(refreshed).not.toBe(warm);
      expect(refreshed?.metadata.description).toBe('External description');
      expect(manager['getCachedByAbsolutePath'](file)?.metadata.description).toBe('External description');
      expect((await manager['storageLayer'].listSummaries()).find(entry => entry.name === 'directory-probe')?.description)
        .toBe('External description');
    });
    await container.dispose();
    container = new DollhouseContainer();
    await container.preparePortfolio();
    container.resolve<BaseElementManager<IElement>>(service);
    await inSession(async () => {
      const manager = container.resolve<BaseElementManager<IElement>>(service);
      expect(manager['elementDir']).toBe(directory);
      await manager['scanAndEvict']();
      expect(manager['storageLayer'].getPathByName('directory-probe')).toBe(relative);
      expect((await manager.load(relative)).metadata.description).toBe('External description');
      const storage = manager['storageLayer'] as ElementStorageLayer | MemoryStorageLayer;
      const state = storage['getState']();
      if (!pinned) manager['uncacheByPath'](path.join(directory, relative));
      if ('indexFile' in state) await state.indexFile.flush();
      for (let i = 0; i < MAX_CACHED_DIRECTORY_STATES; i++) storage['getState'](path.join(home, `deleted-${i}`));
      await fs.unlink(path.join(directory, relative));
      await manager['scanAndEvict']();
      expect(manager['storageLayer'].getPathByName('directory-probe')).toBeUndefined();
      expect(manager['getCachedByAbsolutePath'](path.join(directory, relative))).toBeUndefined();
      expect(await manager.findByName('directory-probe')).toBeUndefined();
    });
  });
  it.each(['list', 'summaries', 'refresh'])('retains a directly activated persona after its first %s', async reader => {
    await inSession(async () => {
      const manager = container.resolve<PersonaManager>('PersonaManager');
      const dir = manager['elementDir'];
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'direct.md'), '---\nname: direct\ndescription: Directly loaded persona\n---\nFollow these instructions.');
      const result = await manager.activatePersona('direct');
      expect(result.success).toBe(true);
      const active = manager.getActivePersonas()[0];
      if (reader === 'list') await manager.list();
      else if (reader === 'summaries') await manager.listSummaries();
      else await manager['scanAndEvict']();
      expect(manager.getActivePersonas()).toEqual([active]);
    });
  });
  if (layout === 'per-user') it('retains directory states for more than 128 users with cached active personas', async () => {
    const manager = container.resolve<PersonaManager>('PersonaManager');
    const storage = manager['storageLayer'] as ElementStorageLayer;
    const states = new Map<string, unknown>();
    for (let i = 0; i < MAX_CACHED_DIRECTORY_STATES + 5; i++) {
      await inSession(async () => {
        const dir = manager['elementDir'];
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'active.md'), '---\nname: active\ndescription: User active persona\n---\nFollow these instructions.');
        expect((await manager.activatePersona('active')).success).toBe(true);
        await manager.listSummaries();
        states.set(dir, storage['getState']());
      }, `user-${i}`);
    }
    for (let i = 0; i < MAX_CACHED_DIRECTORY_STATES + 5; i++) {
      await inSession(async () => {
        expect(storage['getState']()).toBe(states.get(manager['elementDir']));
        expect(manager.getActivePersonas()).toHaveLength(1);
      }, `user-${i}`);
    }
  });
  it('retains a manifest while a file load is waiting to publish its cached object', async () => {
    await inSession(async () => {
      const manager = container.resolve<BaseElementManager<IElement>>('SkillManager');
      const dir = manager['elementDir'];
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'pending.md'), '---\nname: pending\ndescription: Pending load example\n---\nFollow these instructions.');
      await manager['scanAndEvict']();
      const storage = manager['storageLayer'] as ElementStorageLayer;
      const state = storage['getState']();
      const fileOps = manager['fileOperations'];
      const read = fileOps.readElementFile.bind(fileOps);
      let release!: () => void;
      let entered!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      jest.spyOn(fileOps, 'readElementFile').mockImplementation(async (...args) => {
        const content = await read(...args);
        entered();
        await pending;
        return content;
      });
      const load = manager.load('pending.md');
      await started;
      try {
        for (let i = 0; i < MAX_CACHED_DIRECTORY_STATES; i++) storage['getState'](path.join(home, `loading-${i}`));
        expect(storage['getState']()).toBe(state);
      } finally { release(); }
      await load;
    });
  });
  it.each(['snapshot', 'save'] as const)('keeps refresh correct after a paused %s and directory churn', async operation => {
    await inSession(async () => {
      const manager = container.resolve<BaseElementManager<IElement>>('SkillManager');
      const directory = manager['elementDir'];
      const file = path.join(directory, 'publication.md');
      await fs.mkdir(directory, { recursive: true });
      const content = '---\nname: publication\ndescription: Original description\n---\nFollow the fixture instructions.';
      await fs.writeFile(file, content);
      await manager['scanAndEvict']();
      const element = await manager.load('publication.md');
      manager['uncacheByPath'](file);
      const storage = manager['storageLayer'] as ElementStorageLayer;
      const state = storage['getState']();
      let release!: () => void;
      let entered!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const pause = async () => { entered(); await barrier; };
      if (operation === 'snapshot') {
        const fileOps = manager['fileOperations'];
        const read = fileOps.readElementFile.bind(fileOps);
        jest.spyOn(fileOps, 'readElementFile').mockImplementation(async (...args) => {
          const bytes = await read(...args);
          await pause();
          return bytes;
        });
        Object.assign(manager, { canDelete: async () => ({ allowed: false, reason: 'Retained fixture' }) });
      } else {
        Object.assign(manager, { afterSave: pause });
      }
      const pending = operation === 'snapshot'
        ? expect(manager.delete('publication.md')).rejects.toThrow('Retained fixture')
        : manager.save(element, 'publication.md');
      await started;
      try {
        for (let i = 0; i < MAX_CACHED_DIRECTORY_STATES; i++) storage['getState'](path.join(home, `publication-${i}`));
        expect(storage['getState']() === state).toBe(operation === 'save');
        if (operation === 'snapshot') {
          await fs.writeFile(file, content.replace('Original description', 'Edited description'));
          await fs.utimes(file, new Date(), new Date(Date.now() + 2000));
        }
      } finally { release(); }
      await pending;
      if (operation === 'snapshot') expect(manager['getCachedByAbsolutePath'](file)).toBeUndefined();
      else {
        await fs.writeFile(file, content.replace('Original description', 'Edited description'));
        await fs.utimes(file, new Date(), new Date(Date.now() + 2000));
      }
      await manager['scanAndEvict']();
      expect((await manager.load('publication.md')).metadata.description).toBe('Edited description');
    });
  });

});
