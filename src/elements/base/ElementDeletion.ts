import type { IElement } from '../../types/elements/IElement.js';

/** Repair targets require an exact caller-supplied storage reference, never a guessed name. */
export type ElementDeletionTarget<T extends IElement> = {
  readonly kind: 'element';
  readonly storageIdentity: string;
  readonly element: T;
  readonly requestedReference?: string;
} | {
  readonly kind: 'repair';
  readonly storageIdentity: string;
  readonly reason: string;
  readonly repair: 'rejected-definition' | 'orphaned-state';
};

export interface DeletionReport {
  readonly storageIdentity: string;
  readonly notices: string[];
}
