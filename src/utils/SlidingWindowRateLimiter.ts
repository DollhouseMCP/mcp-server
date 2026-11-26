/**
 * Simple sliding-window rate limiter.
 * Tracks timestamps of recent requests and evicts entries older than the window.
 */
export class SlidingWindowRateLimiter {
  private timestamps: number[] = [];
  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the request is allowed, false if rate-limited. */
  tryAcquire(): boolean {
    const updated = acquireSlidingWindow(this.timestamps, this.maxRequests, this.windowMs, Date.now());
    if (!updated) return false;
    this.timestamps = updated;
    return true;
  }
}

/** Apply the same window to timestamps kept in memory or under a file lock. */
export function acquireSlidingWindow(
  timestamps: readonly number[], maxRequests: number, windowMs: number, now: number,
): number[] | null {
  const active = timestamps.filter(timestamp => now - timestamp < windowMs);
  if (active.length >= maxRequests) return null;
  active.push(now);
  return active;
}
