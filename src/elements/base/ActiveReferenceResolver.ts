import type { CollectionReport, CollectionFailure } from './CollectionReport.js';
import { ElementUnreadableError, GuardedReadConflict, elementReadFailure } from './ElementReadError.js';
import { visitSequentially } from '../../utils/visitSequentially.js';

export interface ActiveReferenceRead<T> {
  references: ReadonlySet<string>;
  scan: () => Promise<void>;
  resolve: (reference: string) => Promise<T | undefined>;
  afterLookup?: (element: T, reference: string) => Promise<void>;
  assertCurrent?: () => void;
}

function failure(cause: unknown, reference?: string): CollectionFailure {
  const error = elementReadFailure(cause, reference);
  if (error instanceof GuardedReadConflict) throw error;
  return { reference, error };
}

/** Walk live activation membership sequentially, preserving every failure for the caller. */
export async function resolveActiveReferenceReport<T>(read: ActiveReferenceRead<T>): Promise<CollectionReport<T>> {
  const items: T[] = [];
  const failures: CollectionFailure[] = [];
  read.assertCurrent?.();
  // Nothing active has nothing to read: no collection read for an empty active set.
  if (read.references.size === 0) return { items, failures, complete: true };
  try {
    await read.scan();
  } catch (cause) {
    for (const reference of read.references) failures.push(failure(cause, reference));
    if (failures.length === 0) failures.push(failure(cause));
  } finally {
    read.assertCurrent?.();
  }
  if (failures.length) return { items, failures, complete: false };
  await visitSequentially(read.references.values(), async reference => {
    let element: T | undefined;
    let problem: CollectionFailure | undefined;
    try { element = await read.resolve(reference); }
    catch (cause) { problem = failure(cause, reference); }
    finally { read.assertCurrent?.(); }
    if (!read.references.has(reference)) return;
    if (problem || !element) {
      failures.push(problem ?? { reference, error: new ElementUnreadableError('Active definition is missing', {
        failures: [{ reference, reason: 'not found' }],
      }) });
      return;
    }
    try { await read.afterLookup?.(element, reference); }
    catch (cause) { problem = failure(cause, reference); }
    finally { read.assertCurrent?.(); }
    if (!read.references.has(reference)) return;
    if (problem) failures.push(problem);
    else items.push(element);
  });
  return { items, failures, complete: failures.length === 0 };
}
