/** Process-local provenance for refusals determined by the inspected content. */
const contentRejections = new WeakSet<Error>();

/** Mark only at a byte-derived refusal site, never at a generic catch boundary. */
export function markContentRejection<T extends Error>(error: T): T {
  contentRejections.add(error);
  return error;
}

/** Wrapping preserves provenance; names, codes and severity do not establish it. */
export function isContentRejection(error: unknown): boolean {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (contentRejections.has(current)) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}
