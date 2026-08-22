import type { IElement } from '../../types/elements/IElement.js';

export interface ElementPersistenceRevision {
  readonly relativePath: string;
  readonly rawContent: string;
}

const revisions = new WeakMap<IElement, ElementPersistenceRevision>();

export function recordElementPersistenceRevision(
  element: IElement,
  revision: ElementPersistenceRevision,
): void {
  revisions.set(element, revision);
}

export function getElementPersistenceRevision(
  element: IElement,
): ElementPersistenceRevision | undefined {
  return revisions.get(element);
}

export function clearElementPersistenceRevision(element: IElement): void {
  revisions.delete(element);
}
