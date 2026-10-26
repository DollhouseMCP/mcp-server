/**
 * Visit a caller-owned iterator in order without snapshotting its membership.
 * In particular, live Set iterators observe additions and skip removals while
 * a visit is suspended. The caller owns any iterator-specific cleanup.
 * Recursion satisfies the no-await-in-loop rule for small collections, with one pending continuation per visit.
 */
export async function visitSequentially<T>(iterator: Iterator<T>, visit: (value: T) => Promise<void>): Promise<void> {
  const entry = iterator.next();
  if (entry.done) return;
  await visit(entry.value);
  await visitSequentially(iterator, visit);
}
