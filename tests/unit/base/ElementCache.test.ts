import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as path from 'node:path';

import { ElementCache } from '../../../src/elements/base/ElementCache.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { ElementStatus, type IElement } from '../../../src/types/elements/IElement.js';

function publish(cache: ElementCache<IElement>, element: IElement, filePath: string): void {
  cache.withDirectoryPin(lease => cache.cacheElement(element, filePath, lease));
}

function createElement(id: string, name: string): IElement {
  return {
    id,
    type: ElementType.AGENT,
    version: '1.0.0',
    metadata: { name, description: name },
    validate: () => ({ valid: true }),
    serialize: () => name,
    deserialize: () => undefined,
    getStatus: () => ElementStatus.INACTIVE,
  };
}

describe('ElementCache storage identity', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps path lookups isolated when distinct elements share a runtime ID', () => {
    const elementDir = path.resolve('/virtual/agents');
    const cache = new ElementCache<IElement>(ElementType.AGENT, {
      elementDir,
      getCacheNamespace: () => 'test-user',
      resolveAbsolutePath: filePath => path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.join(elementDir, filePath),
    }, {
      elementCacheTTL: 0,
      pathCacheTTL: 0,
    });
    const sharedRuntimeId = 'agents_canonical-name_1800000000000';
    const first = createElement(sharedRuntimeId, 'Canonical_Name');
    const second = createElement(sharedRuntimeId, 'canonical-name');

    publish(cache, first, '11111111-1111-4111-8111-111111111111');
    publish(cache, second, '22222222-2222-4222-8222-222222222222');

    expect(cache.getCachedByPath('11111111-1111-4111-8111-111111111111')).toBe(first);
    expect(cache.getCachedByPath('22222222-2222-4222-8222-222222222222')).toBe(second);

    cache.uncacheByPath('11111111-1111-4111-8111-111111111111');
    expect(cache.getCachedByPath('22222222-2222-4222-8222-222222222222')).toBe(second);
  });

  it('keeps a path lookup live when only the path-index TTL has elapsed', () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_800_000_000_000);
    const elementDir = path.resolve('/virtual/agents');
    const cache = new ElementCache<IElement>(ElementType.AGENT, {
      elementDir,
      getCacheNamespace: () => 'test-user',
      resolveAbsolutePath: filePath => path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.join(elementDir, filePath),
    }, {
      elementCacheTTL: 1_000,
      pathCacheTTL: 10,
    });
    const element = createElement('agents_ttl_1800000000000', 'TTL agent');

    publish(cache, element, '11111111-1111-4111-8111-111111111111');
    jest.advanceTimersByTime(11);

    expect(cache.getCachedByPath('11111111-1111-4111-8111-111111111111')).toBe(element);
  });

  it('does not return a path entry after the primary element TTL has elapsed', () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_800_000_000_000);
    const elementDir = path.resolve('/virtual/agents');
    const cache = new ElementCache<IElement>(ElementType.AGENT, {
      elementDir,
      getCacheNamespace: () => 'test-user',
      resolveAbsolutePath: filePath => path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.join(elementDir, filePath),
    }, {
      elementCacheTTL: 10,
      pathCacheTTL: 1_000,
    });
    const element = createElement('agents_ttl_1800000000000', 'TTL agent');

    publish(cache, element, '11111111-1111-4111-8111-111111111111');
    jest.advanceTimersByTime(11);

    expect(cache.getCachedByPath('11111111-1111-4111-8111-111111111111')).toBeUndefined();
  });

  it('does not return a path entry after primary LRU eviction', () => {
    const elementDir = path.resolve('/virtual/agents');
    const cache = new ElementCache<IElement>(ElementType.AGENT, {
      elementDir,
      getCacheNamespace: () => 'test-user',
      resolveAbsolutePath: filePath => path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.join(elementDir, filePath),
    }, {
      elementCacheTTL: 0,
      pathCacheTTL: 0,
    });
    const element = createElement('agents_evicted_1800000000000', 'Evicted agent');

    publish(cache, element, '11111111-1111-4111-8111-111111111111');
    expect(cache.elements.evictOne()).toBe(true);

    expect(cache.getCachedByPath('11111111-1111-4111-8111-111111111111')).toBeUndefined();
  });

  it('caches an existing element reference without scanning the primary cache', () => {
    const elementDir = path.resolve('/virtual/agents');
    const cache = new ElementCache<IElement>(ElementType.AGENT, {
      elementDir,
      getCacheNamespace: () => 'test-user',
      resolveAbsolutePath: filePath => path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.join(elementDir, filePath),
    }, { elementCacheTTL: 0, pathCacheTTL: 0 });
    const element = createElement('agents_o1_1800000000000', 'Indexed agent');
    publish(cache, element, 'first.md');
    const entriesSpy = jest.spyOn(cache.elements, 'entries')
      .mockImplementation(() => { throw new Error('primary scan'); });

    expect(() => publish(cache, element, 'second.md')).not.toThrow();
    expect(entriesSpy).not.toHaveBeenCalled();
  });

  it('touches an ID without scanning the primary cache', () => {
    const elementDir = path.resolve('/virtual/agents');
    const cache = new ElementCache<IElement>(ElementType.AGENT, {
      elementDir,
      getCacheNamespace: () => 'test-user',
      resolveAbsolutePath: filePath => path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.join(elementDir, filePath),
    }, { elementCacheTTL: 0, pathCacheTTL: 0 });
    const element = createElement('agents_o1_1800000000001', 'Touched agent');
    publish(cache, element, 'touched.md');
    const entriesSpy = jest.spyOn(cache.elements, 'entries')
      .mockImplementation(() => { throw new Error('primary scan'); });

    expect(cache.touchById(element.id)).toBe(element);
    expect(entriesSpy).not.toHaveBeenCalled();
  });

  it('gets the latest generation for an ID without scanning the primary cache', () => {
    const elementDir = path.resolve('/virtual/agents');
    const cache = new ElementCache<IElement>(ElementType.AGENT, {
      elementDir,
      getCacheNamespace: () => 'test-user',
      resolveAbsolutePath: filePath => path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.join(elementDir, filePath),
    }, { elementCacheTTL: 0, pathCacheTTL: 0 });
    const element = createElement('agents_o1_1800000000002', 'Generation agent');
    publish(cache, element, 'generation.md');
    const entriesSpy = jest.spyOn(cache.elements, 'entries')
      .mockImplementation(() => { throw new Error('primary scan'); });

    expect(cache.getGeneration(element.id)).toBe(1);
    expect(entriesSpy).not.toHaveBeenCalled();
  });

  it('retires the displaced object identity when the same cache key is replaced', () => {
    const elementDir = path.resolve('/virtual/agents');
    const cache = new ElementCache<IElement>(ElementType.AGENT, {
      elementDir,
      getCacheNamespace: () => 'test-user',
      resolveAbsolutePath: filePath => path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.join(elementDir, filePath),
    }, { elementCacheTTL: 0, pathCacheTTL: 0 });
    const id = 'agents_replaced_1800000000003';
    const displaced = createElement(id, 'Displaced agent');
    const replacement = createElement(id, 'Replacement agent');

    publish(cache, displaced, 'stable.md');
    publish(cache, replacement, 'stable.md');
    publish(cache, displaced, 'displaced-new-path.md');

    expect(cache.getCachedByPath('stable.md')).toBe(replacement);
    expect(cache.getCachedByPath('displaced-new-path.md')).toBe(displaced);
  });

  it('prunes obsolete path metadata when one object is rebound repeatedly', () => {
    const elementDir = path.resolve('/virtual/agents');
    const cache = new ElementCache<IElement>(ElementType.AGENT, {
      elementDir,
      getCacheNamespace: () => 'test-user',
      resolveAbsolutePath: filePath => path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.join(elementDir, filePath),
    }, { elementCacheTTL: 0, pathCacheTTL: 0 });
    const element = createElement('agents_rebound_1800000000004', 'Rebound agent');

    for (let index = 0; index < 20; index += 1) {
      publish(cache, element, `path-${index}.md`);
    }

    expect(cache.getCachedByPath('path-0.md')).toBeUndefined();
    expect(cache.getCachedByPath('path-18.md')).toBeUndefined();
    expect(cache.getCachedByPath('path-19.md')).toBe(element);
    expect(cache.getCacheStats().pathMappings).toBe(1);
  });
});

it('counts type roots across rebind, collision, expiry and clear without read-time walks', async () => {
  let user = 'alice';
  const directory = () => path.resolve('/portfolio', user, 'memories');
  const cache = new ElementCache<IElement>(ElementType.MEMORY, {
    get elementDir() { return directory(); },
    getCacheNamespace: () => user,
    resolveAbsolutePath: file => path.resolve(directory(), file),
  }, { elementCacheTTL: 100, pathCacheTTL: 100 });
  jest.useFakeTimers();
  try {
    const alice = createElement('alice', 'Alice');
    publish(cache, alice, '2026-10-24/a.yaml');
    publish(cache, alice, '2026-10-25/a.yaml');
    expect(cache['directoryCounts'].get(directory())).toBe(1);
    publish(cache, createElement('replacement', 'Replacement'), '2026-10-25/a.yaml');
    expect(cache['directoryCounts'].get(directory())).toBe(1);
    publish(cache, createElement('shared', 'Shared'), '/shared/a.yaml');
    expect(cache['directoryCounts'].get(directory())).toBe(1);
    user = 'bob';
    publish(cache, createElement('bob', 'Bob'), 'b.yaml');
    const walk = jest.spyOn(cache['pathToElementKey'], Symbol.iterator);
    for (let i = 0; i < 100; i++) {
      user = i % 2 ? 'alice' : 'bob';
      expect(cache.getCachedByPath(user === 'alice' ? '2026-10-25/a.yaml' : 'b.yaml')).toBeDefined();
    }
    expect(walk).not.toHaveBeenCalled();
    jest.advanceTimersByTime(101);
    expect(cache.hasDirectoryEntries(directory())).toBe(false);
    expect(cache['directoryCounts'].size).toBe(0);
    await cache.withDirectoryPin(async () => {
      cache.clear();
      expect(cache.hasDirectoryEntries(directory())).toBe(true);
    });
    expect(cache.hasDirectoryEntries(directory())).toBe(false);
    publish(cache, alice, 'again.yaml');
    cache.clear();
    expect(cache['directoryCounts'].size).toBe(0);
  } finally { jest.useRealTimers(); }
});

it('requires a live publication lease owned by this cache and namespace', async () => {
  let namespace = 'alice';
  const host = { elementDir: '/virtual/skills', getCacheNamespace: () => namespace,
    resolveAbsolutePath: (file: string) => path.resolve('/virtual/skills', file) };
  const cache = new ElementCache<IElement>(ElementType.SKILL, host, { elementCacheTTL: 0, pathCacheTTL: 0 });
  const other = new ElementCache<IElement>(ElementType.SKILL, host, { elementCacheTTL: 0, pathCacheTTL: 0 });
  const element = createElement('leased', 'Leased');
  // @ts-expect-error Publication without a lease is also rejected at runtime.
  expect(() => cache.cacheElement(element, 'leased.md')).toThrow('active lease');
  const released = cache.withDirectoryPin(lease => {
    expect(() => other.cacheElement(element, 'leased.md', lease)).toThrow('active lease');
    namespace = 'bob';
    expect(() => cache.cacheElement(element, 'leased.md', lease)).toThrow('active lease');
    namespace = 'alice';
    cache.cacheElement(element, 'leased.md', lease);
    return lease;
  });
  await Promise.resolve();
  expect(() => cache.cacheElement(element, 'leased.md', released)).toThrow('active lease');
  cache.clear();
  await expect(cache.withDirectoryPin(async () => { throw new Error('Read failed'); })).rejects.toThrow('Read failed');
  expect(cache.hasDirectoryEntries(host.elementDir)).toBe(false);
  cache.dispose();
  other.dispose();
});
