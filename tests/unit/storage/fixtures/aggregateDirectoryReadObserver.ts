import { Dir, type Dirent } from 'node:fs';
const active = new Set<() => void>();

/** Test-only counters for the zero-argument promise form of Dir.read. */
export function observeDirectoryReads(owner: object = Dir.prototype) {
  const original = Object.getOwnPropertyDescriptor(owner, 'read');
  if (!original || typeof original.value !== 'function') throw new TypeError('Directory read method is unavailable');
  const read = original.value as (this: object) => Promise<Dirent | null>;
  const measured = { attemptedReads: 0, completedCensuses: 0 };
  // Like the previous async Jest implementation, synchronous native throws
  // become rejections; fulfilled entries and rejection causes pass unchanged.
  async function observed(this: object): Promise<Dirent | null> {
    measured.attemptedReads++;
    const entry = await read.call(this);
    if (!entry) measured.completedCensuses++;
    return entry;
  }
  Object.defineProperty(owner, 'read', { ...original, value: observed });
  let restored = false;
  const restore = (primary?: { cause: unknown }) => {
    if (restored) return;
    try {
      const current = Object.getOwnPropertyDescriptor(owner, 'read');
      if (!current || current.value !== observed || current.writable !== original.writable ||
          current.enumerable !== original.enumerable || current.configurable !== original.configurable) {
        throw new Error('Directory read observer no longer owns the method');
      }
      Object.defineProperty(owner, 'read', original);
      restored = true;
      active.delete(restore);
    } catch (cause) {
      if (primary) throw new AggregateError([primary.cause, cause], 'Directory operation and restoration failed');
      throw cause;
    }
  };
  active.add(restore);
  return { measured, restore };
}

/** Backstop for a Jest deadline: restore wrappers, then always run original cleanup.
 * This does not cancel pending reads or stop an expired test issuing later reads.
 */
export async function cleanupDirectoryReadObservers(cleanup: () => Promise<void>): Promise<void> {
  const failures: unknown[] = [];
  for (const restore of [...active].reverse()) {
    try { restore(); }
    catch (cause) { active.delete(restore); failures.push(cause); }
  }
  try { await cleanup(); } catch (cause) { failures.push(cause); }
  if (failures.length) throw new AggregateError(failures, 'Directory observation or original cleanup failed');
}
