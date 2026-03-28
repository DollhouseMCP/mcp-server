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
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxRequests) return false;
    this.timestamps.push(now);
    return true;
  }
}
