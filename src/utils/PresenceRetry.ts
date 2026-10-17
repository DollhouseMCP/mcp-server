/** Jitter spreads a recovering database's retries across a ±50% window. */
export function presenceRetryDelay(failures: number, intervalMs: number, random = Math.random): number {
  const base = Math.min(intervalMs, 100 * 2 ** Math.min(Math.max(0, failures - 1), 8));
  return Math.max(1, Math.round(base * (0.5 + random())));
}
