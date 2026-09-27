import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as path from 'node:path';

import { ElementCache } from '../../../src/elements/base/ElementCache.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { ElementStatus, type IElement } from '../../../src/types/elements/IElement.js';

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

    cache.cacheElement(first, '11111111-1111-4111-8111-111111111111');
    cache.cacheElement(second, '22222222-2222-4222-8222-222222222222');

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

    cache.cacheElement(element, '11111111-1111-4111-8111-111111111111');
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

    cache.cacheElement(element, '11111111-1111-4111-8111-111111111111');
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

    cache.cacheElement(element, '11111111-1111-4111-8111-111111111111');
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
    cache.cacheElement(element, 'first.md');
    const entriesSpy = jest.spyOn(cache.elements, 'entries')
      .mockImplementation(() => { throw new Error('primary scan'); });

    expect(() => cache.cacheElement(element, 'second.md')).not.toThrow();
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
    cache.cacheElement(element, 'touched.md');
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
    cache.cacheElement(element, 'generation.md');
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

    cache.cacheElement(displaced, 'stable.md');
    cache.cacheElement(replacement, 'stable.md');
    cache.cacheElement(displaced, 'displaced-new-path.md');

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
      cache.cacheElement(element, `path-${index}.md`);
    }

    expect(cache.getCachedByPath('path-0.md')).toBeUndefined();
    expect(cache.getCachedByPath('path-18.md')).toBeUndefined();
    expect(cache.getCachedByPath('path-19.md')).toBe(element);
    expect(cache.getCacheStats().pathMappings).toBe(1);
  });
});

describe('ElementCache in-flight load generations', () => {
  function fixture() {
    const elementDir = path.resolve('/virtual/agents');
    let namespace = 'user-a';
    const cache = new ElementCache<IElement>(ElementType.AGENT, {
      elementDir,
      getCacheNamespace: () => namespace,
      resolveAbsolutePath: filePath => path.resolve(elementDir, filePath),
    }, { elementCacheTTL: 0, pathCacheTTL: 0 });
    return { cache, setNamespace: (value: string) => { namespace = value; } };
  }

  it('invalidates only the affected identity and namespace, including cache misses', () => {
    const { cache, setNamespace } = fixture();
    const a = cache.beginLoad('same.md');
    const other = cache.beginLoad('other.md');
    setNamespace('user-b');
    const b = cache.beginLoad('same.md');
    cache.uncacheByPath('same.md');
    expect(b.isCurrent()).toBe(false);
    setNamespace('user-a');
    expect(a.isCurrent()).toBe(true);
    expect(other.isCurrent()).toBe(true);
    cache.cacheElement(createElement('a', 'User A'), 'same.md', a);
    expect(cache.getCachedByPath('same.md')?.metadata.name).toBe('User A');
    a.release();
    b.release();
    other.release();
    cache.dispose();
  });

  it('keeps overlapping readers live and cannot revive a released or invalidated token', () => {
    const { cache } = fixture();
    const first = cache.beginLoad('same.md');
    const second = cache.beginLoad('same.md');
    first.release();
    first.release();
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    cache.uncacheByPath('same.md');
    const newer = cache.beginLoad('same.md');
    second.release();
    expect(newer.isCurrent()).toBe(true);
    cache.cacheElement(createElement('new', 'New'), 'same.md', newer);
    cache.cacheElement(createElement('old', 'Old'), 'same.md', second);
    expect(cache.getCachedByPath('same.md')?.metadata.name).toBe('New');
    newer.release();
    cache.dispose();
  });

  it.each(['clear', 'dispose'] as const)('%s fences pending reads without fencing later loads', action => {
    const { cache } = fixture();
    const old = cache.beginLoad('same.md');
    cache[action]();
    expect(old.isCurrent()).toBe(false);
    const newer = cache.beginLoad('same.md');
    old.release();
    expect(newer.isCurrent()).toBe(true);
    cache.cacheElement(createElement('old', 'Old'), 'same.md', old);
    expect(cache.getCachedByPath('same.md')).toBeUndefined();
    newer.release();
    cache.dispose();
  });
});
