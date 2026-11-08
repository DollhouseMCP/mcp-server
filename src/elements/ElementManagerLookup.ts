import { ElementType } from '../portfolio/types.js';
import type { BaseElementManager } from './base/BaseElementManager.js';

/**
 * Resolves the one manager that owns an element type. Every type has a manager, so a lookup
 * that cannot answer is a programming error and throws; callers never fall back to storage
 * listings or directory scans when a manager is missing.
 */
export interface ElementManagerLookup {
  managerFor(type: ElementType): BaseElementManager<any>;
}

export type ElementManagerProviders = Readonly<Record<ElementType, () => BaseElementManager<any>>>;

/** Resolve each manager lazily on every call so bound or session-scoped instances are honoured. */
export function createElementManagerLookup(providers: ElementManagerProviders): ElementManagerLookup {
  return {
    managerFor(type: ElementType): BaseElementManager<any> {
      const provider = Object.hasOwn(providers, type) ? providers[type] : undefined;
      if (!provider) throw new Error(`No element manager is registered for type ${JSON.stringify(type)}`);
      return provider();
    },
  };
}

/** A caller bound to one memory operation answers memories from that operation's manager. */
export function withMemoryManager(lookup: ElementManagerLookup, memoryManager: () => BaseElementManager<any>): ElementManagerLookup {
  return {
    managerFor: type => type === ElementType.MEMORY ? memoryManager() : lookup.managerFor(type),
  };
}
