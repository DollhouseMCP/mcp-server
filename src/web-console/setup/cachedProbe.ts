/**
 * Bounds how often a read-only probe runs, however often it is asked.
 *
 * Concurrent callers share one run, and its result is reused for `ttlMs`. A
 * run that throws is not kept, so the next caller tries again.
 */
export function cacheProbe<Result>(
  probe: () => Promise<Result>,
  ttlMs: number,
  now: () => number = Date.now,
): () => Promise<Result> {
  let last: { readonly result: Result; readonly at: number } | null = null;
  let inFlight: Promise<Result> | null = null;
  return () => {
    if (last && now() - last.at < ttlMs) return Promise.resolve(last.result);
    inFlight ??= probe()
      .then(result => {
        last = { result, at: now() };
        return result;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
}
