interface TimingContext { platform: string; node: string; worker: string | undefined }

/** Sole caller has already asserted exactly 100 functional results. No validation
 * calls or clocks here. Sort a copy only on failure; p95 uses nearest rank and
 * median averages the two central samples. Equality fails the existing strict
 * less-than assertions, so it is included in overLimitCount.
 */
export function validationTimingFailureSummary(
  results: readonly { duration: number }[], totalMs: number,
  individualLimitMs: number, totalLimitMs: number, context: TimingContext,
) {
  if (results.every(result => result.duration < individualLimitMs) && totalMs < totalLimitMs) return undefined;
  const durations = results.map(result => result.duration);
  const ordered = [...durations].sort((a, b) => a - b);
  const maxMs = ordered.at(-1)!, middle = Math.floor(ordered.length / 2);
  return {
    count: durations.length, worstIndex: durations.indexOf(maxMs), indexBase: 0,
    minMs: ordered[0], medianMs: (ordered[middle - 1] + ordered[middle]) / 2,
    p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1], maxMs,
    overLimitCount: durations.filter(duration => duration >= individualLimitMs).length,
    totalMs, individualLimitMs, totalLimitMs,
    platform: context.platform.slice(0, 32), node: context.node.slice(0, 32), worker: context.worker?.slice(0, 32) ?? null,
  };
}
