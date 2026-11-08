import { describe, expect, it, jest } from '@jest/globals';
import { createElementManagerLookup, withMemoryManager } from '../../../src/elements/ElementManagerLookup.js';
import { ElementType } from '../../../src/portfolio/types.js';
import type { BaseElementManager } from '../../../src/elements/base/BaseElementManager.js';

function manager(label: string): BaseElementManager<any> {
  return { label } as unknown as BaseElementManager<any>;
}

function providers() {
  const resolved = Object.fromEntries(Object.values(ElementType).map(type => [type, jest.fn(() => manager(type))]));
  return resolved as Record<ElementType, jest.Mock<() => BaseElementManager<any>>>;
}

describe('ElementManagerLookup', () => {
  it('resolves each manager lazily on every call', () => {
    const resolve = providers();
    const lookup = createElementManagerLookup(resolve);
    expect(Object.values(resolve).some(provider => provider.mock.calls.length > 0)).toBe(false);
    expect(lookup.managerFor(ElementType.SKILL)).toMatchObject({ label: ElementType.SKILL });
    expect(lookup.managerFor(ElementType.SKILL)).toMatchObject({ label: ElementType.SKILL });
    expect(resolve[ElementType.SKILL]).toHaveBeenCalledTimes(2);
    expect(resolve[ElementType.PERSONA]).not.toHaveBeenCalled();
  });

  it('refuses an unknown type instead of answering with another manager', () => {
    const lookup = createElementManagerLookup(providers());
    expect(() => lookup.managerFor('widgets' as ElementType)).toThrow('No element manager is registered for type "widgets"');
    expect(() => lookup.managerFor('constructor' as ElementType)).toThrow('No element manager is registered');
  });

  it('answers memories from the bound operation manager and everything else from the shared lookup', () => {
    const resolve = providers();
    const bound = manager('bound-memory');
    const lookup = withMemoryManager(createElementManagerLookup(resolve), () => bound);
    expect(lookup.managerFor(ElementType.MEMORY)).toBe(bound);
    expect(resolve[ElementType.MEMORY]).not.toHaveBeenCalled();
    expect(lookup.managerFor(ElementType.AGENT)).toMatchObject({ label: ElementType.AGENT });
  });
});
