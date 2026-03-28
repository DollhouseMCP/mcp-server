/**
 * Time-windowed event deduplication utility.
 * Suppresses repeated identical events within a configurable window.
 * Used by SecurityMonitor and SecurityTelemetry to prevent log flooding.
 */
export class EventDeduplicator {
  private readonly recentKeys = new Map<string, number>();

  constructor(
    private readonly windowMs: number = 60_000,
    private readonly maxSize: number = 500,
  ) {}

  /**
   * Returns true if this key should be suppressed (duplicate within window).
   * Returns false if this is a new event that should be processed.
   */
  shouldSuppress(key: string): boolean {
    const now = Date.now();
    const lastSeen = this.recentKeys.get(key);

    if (lastSeen && (now - lastSeen) < this.windowMs) {
      return true;
    }

    this.recentKeys.set(key, now);
    this.cleanup(now);
    return false;
  }

  /** Clear all tracked keys (for testing) */
  clear(): void {
    this.recentKeys.clear();
  }

  get size(): number {
    return this.recentKeys.size;
  }

  private cleanup(now: number): void {
    if (this.recentKeys.size <= this.maxSize) return;

    // First pass: evict expired entries
    for (const [key, ts] of this.recentKeys) {
      if ((now - ts) >= this.windowMs) this.recentKeys.delete(key);
    }

    // Fallback: if still over capacity (all entries within window), evict oldest
    if (this.recentKeys.size > this.maxSize) {
      const entries = [...this.recentKeys.entries()].sort((a, b) => a[1] - b[1]);
      const toRemove = entries.length - this.maxSize;
      for (let i = 0; i < toRemove; i++) {
        this.recentKeys.delete(entries[i][0]);
      }
    }
  }
}
