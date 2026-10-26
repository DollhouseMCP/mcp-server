import type { BaseElementManager } from '../../src/elements/base/BaseElementManager.js';
import type { IElement } from '../../src/types/elements/IElement.js';

/** Publish an already-created fixture through the manager's cache authority. */
export function publishCachedElement<T extends IElement>(manager: BaseElementManager<T>, element: T, filePath: string): void {
  manager['withCachePublication'](lease => manager['cacheElement'](element, filePath, lease));
}
