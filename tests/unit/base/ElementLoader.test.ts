import { describe, expect, it, jest } from '@jest/globals';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ElementLoader, MAX_LOAD_FAILURE_NAMESPACES } from '../../../src/elements/base/ElementLoader.js';
import { LRUCache } from '../../../src/cache/LRUCache.js';
import { ElementCache } from '../../../src/elements/base/ElementCache.js';
import type { ElementEventCoordinator } from '../../../src/elements/base/ElementEventCoordinator.js';
import type { IElement } from '../../../src/types/elements/IElement.js';
import { createTestMetadataService } from '../../helpers/di-mocks.js';
import { Skill } from '../../../src/elements/skills/Skill.js';
import { ElementType } from '../../../src/portfolio/types.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import type { IStorageLayer } from '../../../src/storage/IStorageLayer.js';

function fixture() {
  const context = new AsyncLocalStorage<string>();
  const cache = new ElementCache<IElement>(ElementType.SKILL, {
    elementDir: '/virtual/skills', getCacheNamespace: () => context.getStore() ?? 'system',
    resolveAbsolutePath: file => `/virtual/skills/${file}`,
  }, {});
  const emitAsync = jest.fn();
  const events = {
    eventDispatcher: { emit: jest.fn(), emitAsync },
    createEventPayload: (payload: unknown) => payload,
  } as unknown as ElementEventCoordinator<IElement>;
  let readable = false;
  const loader = new ElementLoader<IElement>({
    elementType: ElementType.SKILL, elementDir: '/virtual/skills',
    normalizeAndValidatePath: async file => ({ relativePath: file, absolutePath: `/virtual/skills/${file}` }),
    parseContent: () => {
      if (!readable) throw new Error('Invalid definition');
      return { data: {}, content: 'Valid definition content' };
    },
    migrateMetadataDefaults: () => {},
    parseMetadata: async () => ({ name: 'unused', description: 'unused' }),
    createElement: () => new Skill({ name: 'Shared skill', description: 'Readable definition' }, 'Valid skill content', createTestMetadataService()),
    getElementLabel: () => 'skill', getElementLabelCapitalized: () => 'Skill',
  }, cache, events, { readElementFile: async () => 'invalid' } as unknown as FileOperationsService,
  {} as IStorageLayer, {});
  const fail = () => expect(loader.load('shared.md')).rejects.toThrow('Invalid definition');
  return { context, loader, emitAsync, fail, makeReadable: () => { readable = true; } };
}

describe('ElementLoader namespace diagnostics', () => {
  it('isolates the same path and repeated-error emission between callers', async () => {
    const { context, loader, emitAsync, fail, makeReadable } = fixture();
    await context.run('alice', async () => { await fail(); await fail(); });
    context.run('bob', () => expect(loader.getInvalidElements()).toEqual([]));
    await context.run('bob', async () => { await fail(); await fail(); });
    expect(emitAsync).toHaveBeenCalledTimes(2);
    makeReadable();
    await context.run('bob', () => loader.load('shared.md'));
    context.run('alice', () => expect(loader.getInvalidElements()).toHaveLength(1));
    context.run('bob', () => expect(loader.getInvalidElements()).toEqual([]));
  });

  it('bounds namespace churn and records an evicted caller on its next failure', async () => {
    const { context, loader, emitAsync, fail } = fixture();
    const evictions: unknown[] = [];
    const off = LRUCache.addLogListener((_level, message, data) => {
      if (message === 'Evict entry') evictions.push(data);
    });
    try {
      await context.run('first', async () => { await fail(); await fail(); });
      await Promise.all(Array.from({ length: MAX_LOAD_FAILURE_NAMESPACES }, (_, index) =>
        context.run(`user-${index}`, async () => { await fail(); await fail(); })));
      expect(loader['invalidElements'].size).toBe(MAX_LOAD_FAILURE_NAMESPACES);
      expect(loader['suppressedLoadPaths'].size).toBe(MAX_LOAD_FAILURE_NAMESPACES);
      context.run('first', () => expect(loader.getInvalidElements()).toEqual([]));
      const before = emitAsync.mock.calls.length;
      await context.run('first', fail);
      expect(emitAsync.mock.calls).toHaveLength(before + 1);
      context.run('first', () => expect(loader.getInvalidElements()).toHaveLength(1));
      expect(evictions).toEqual([]);
    } finally {
      off();
    }
  });
});
