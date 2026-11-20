import { visitSequentially } from '../utils/visitSequentially.js';

/** One I/O budget for file scan reads, stats and symlink inspection. */
export const STORAGE_SCAN_CONCURRENCY = 32;

/** Preserve input order while bounding the number of live operations. */
export async function mapStorageItems<T, R>(items: readonly T[], visit: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const iterator = items.entries();
  const worker = () => visitSequentially(iterator, async ([index, item]) => {
    results[index] = await visit(item);
  });
  const settled = await Promise.allSettled(Array.from({ length: Math.min(items.length, STORAGE_SCAN_CONCURRENCY) }, worker));
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
  return results;
}
