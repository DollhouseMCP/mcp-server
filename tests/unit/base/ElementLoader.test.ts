import * as path from 'node:path';
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
import type { IStorageLayer } from '../../../src/storage/IStorageLayer.js';
import { ValidationError } from '../../../src/security/errors.js';

function fixture(rejectReference?: Error, current = true, currency: 'currency-check' | 'unverifiable' = 'currency-check') {
  const directory = path.resolve('virtual', 'skills');
  const context = new AsyncLocalStorage<string>();
  const cache = new ElementCache<IElement>(ElementType.SKILL, {
    elementDir: directory, getCacheNamespace: () => context.getStore() ?? 'system',
    resolveAbsolutePath: file => path.resolve(directory, file),
  }, {});
  const emitAsync = jest.fn();
  const events = {
    eventDispatcher: { emit: jest.fn(), emitAsync },
    createEventPayload: (payload: unknown) => payload,
  } as unknown as ElementEventCoordinator<IElement>;
  let readable = false;
  const vouch = jest.fn(async () => current);
  const readContent = jest.fn(async () => 'invalid');
  const parseMetadata = jest.fn(async () => ({ name: 'unused', description: 'unused' }));
  const loader = new ElementLoader<IElement>({
    elementType: ElementType.SKILL, elementDir: directory,
    normalizeAndValidatePath: async file => {
      if (rejectReference) throw rejectReference;
      return { relativePath: file, absolutePath: path.resolve(directory, file) };
    },
    parseContent: () => {
      if (!readable) throw new Error('Invalid definition');
      return { data: {}, content: 'Valid definition content' };
    },
    migrateMetadataDefaults: () => {},
    parseMetadata,
    createElement: () => new Skill({ name: 'Shared skill', description: 'Readable definition' }, 'Valid skill content', createTestMetadataService()),
    getElementLabel: () => 'skill', getElementLabelCapitalized: () => 'Skill',
  }, cache, events,
  { readCacheVersion: async () => ({ mtimeMs: 1, sizeBytes: 1 }), cachedInstanceCurrency: currency, isCachedReferenceCurrent: vouch, readIndexedPath: async () => ({ authoritative: true, indexComplete: true, unindexed: [], failures: new Map(), candidates: [] }),
    readContent } as unknown as IStorageLayer);
  const fail = () => expect(loader.load('shared.md')).rejects.toMatchObject({
    kind: 'unreadable', cause: expect.objectContaining({ message: 'Invalid definition' }),
  });
  return { context, loader, emitAsync, fail, readContent, parseMetadata, vouch, makeReadable: () => { readable = true; } };
}

describe('ElementLoader cached-instance rule (cachedInstanceCurrency)', () => {
  it.each(['loadDefinitionFromContent', 'hydrateDefinitionFromContent', 'loadElementSnapshot'] as const)(
    'classifies secondary metadata ENOENT in %s as unreadable', async method => {
      const f = fixture();
      f.makeReadable();
      const cause = Object.assign(new Error('Missing metadata dependency'), { code: 'ENOENT' });
      f.parseMetadata.mockRejectedValue(cause);
      const read = method === 'loadElementSnapshot' ? f.loader[method]('present.md') : f.loader[method]('content', 'present.md');
      await expect(read).rejects.toMatchObject({ kind: 'unreadable', cause });
    });

  it('classifies ENOENT only at the definition read boundary', async () => {
    const cause = Object.assign(new Error('Missing'), { code: 'ENOENT' });
    const definition = fixture();
    definition.readContent.mockRejectedValue(cause);
    await expect(definition.loader.load('missing.md')).rejects.toMatchObject({ kind: 'absent' });
    const validation = fixture(cause);
    await expect(validation.loader.load('present.md')).rejects.toMatchObject({ kind: 'unreadable', cause });
  });

  it('serves a lookup by reference only through the currency check on a currency-checked layer', async () => {
    const { context, loader, readContent, vouch, makeReadable } = fixture(undefined, false, 'currency-check');
    makeReadable();
    await context.run('alice', async () => {
      const first = await loader.load('shared.md');
      const second = await loader.loadByReference('shared.md', reference => loader.load(reference));
      expect(second).not.toBe(first);
      expect(readContent).toHaveBeenCalledTimes(2);
      expect(vouch).toHaveBeenCalled();
    });
  });

  it('keeps the resolved instance for a lookup by reference on an unverifiable layer, and always reads on a load', async () => {
    const { context, loader, readContent, vouch, makeReadable } = fixture(undefined, true, 'unverifiable');
    makeReadable();
    await context.run('alice', async () => {
      const first = await loader.load('shared.md');
      expect(await loader.loadByReference('shared.md', reference => loader.load(reference))).toBe(first);
      expect(readContent).toHaveBeenCalledTimes(1);
      expect(await loader.load('shared.md')).not.toBe(first);
      expect(readContent).toHaveBeenCalledTimes(2);
      // One meaning: an unverifiable layer is never asked to vouch.
      expect(vouch).not.toHaveBeenCalled();
    });
  });
});

describe('ElementLoader namespace diagnostics', () => {
  it('returns the same cached instance on repeat load without reading or parsing again', async () => {
    const { context, loader, makeReadable } = fixture();
    makeReadable();
    await context.run('alice', async () => {
      const first = await loader.load('shared.md');
      const second = await loader.load('shared.md');
      expect(second).toBe(first);
    });
  });

  it('reads the stored bytes on every load and snapshot while the storage layer does not vouch for the cached instance', async () => {
    // The database layer never vouches: another process may have edited or deleted the row (beta read it by id).
    const { context, loader, readContent, makeReadable } = fixture(undefined, false);
    makeReadable();
    await context.run('alice', async () => {
      const first = await loader.load('shared.md');
      const second = await loader.load('shared.md');
      expect(second).not.toBe(first);
      expect(await loader.loadElementSnapshot('shared.md')).not.toBe(second);
    });
    expect(readContent).toHaveBeenCalledTimes(3);
  });

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

describe('ElementLoader read contract', () => {
  it('attributes failed loads by the shared filename rule', async () => {
    const { context, loader, fail } = fixture();
    await context.run('alice', async () => {
      await fail();
      expect(loader.getInvalidElement('shared')?.filePath).toBe('shared.md');
      expect(loader.getInvalidElement('Shared')?.filePath).toBe('shared.md');
      expect(loader.getInvalidElement('shared.md')?.filePath).toBe('shared.md');
      expect(loader.getInvalidElement('other')).toBeUndefined();
    });
  });

  it('classifies a path policy rejection of a stored reference inside the read contract', async () => {
    const rejection = new ValidationError('Invalid skill path: Path access denied');
    const { context, loader } = fixture(rejection);
    await context.run('alice', () => expect(loader.load('outside.md')).rejects.toMatchObject({
      kind: 'unreadable', cause: rejection, failures: [{ reference: 'outside.md', reason: 'Invalid skill path: Path access denied' }],
    }));
  });
});
