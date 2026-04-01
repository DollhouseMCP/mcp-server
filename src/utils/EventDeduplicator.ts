/**
 * Time-windowed event deduplication utility.
 * Suppresses repeated identical events within a configurable window.
 * Used by SecurityMonitor and SecurityTelemetry to prevent log flooding.
 *
 * @example
 * ```ts
 * const dedup = new EventDeduplicator(60_000, 500);
 *
 * if (!dedup.shouldSuppress('injection\0/api/query\0SQL detected')) {
 *   logger.warn('New security event');
 * }
 * // Same key within 60s → suppressed
 * dedup.shouldSuppress('injection\0/api/query\0SQL detected'); // true
 *
 * // Check how much noise was filtered
 * const stats = dedup.getStats();
 * // { suppressedCount: 1, processedCount: 1, cacheSize: 1 }
 * ```
 */
export class EventDeduplicator {
  private readonly recentKeys = new Map<string, number>();
  private _suppressedCount = 0;
  private _processedCount = 0;

  constructor(
    private readonly windowMs: number = 60_000,
    private readonly maxSize: number = 500,
  ) {}

  /**
   * Returns true if this key should be suppressed (duplicate within window).
   * Returns false if this is a new event that should be processed.
   */
  shouldSuppress(key: string): boolean {
    // NFC-normalize to ensure canonical Unicode equivalents deduplicate correctly
    // (e.g. 'Café' decomposed vs composed). Uses String.normalize directly to
    // avoid circular dependency with UnicodeValidator → SecurityMonitor → this.
    // Falls back to raw key if normalize throws (e.g. mocked in tests).
    try { key = key.normalize('NFC'); } catch { /* use raw key */ }
    const now = Date.now();
    const lastSeen = this.recentKeys.get(key);

    if (lastSeen && (now - lastSeen) < this.windowMs) {
      this._suppressedCount++;
      return true;
    }

    this._processedCount++;
    this.recentKeys.set(key, now);
    try { this.cleanup(now); } catch { /* eviction failure is non-fatal */ }
    return false;
  }

  /** Clear all tracked keys and counters */
  clear(): void {
    this.recentKeys.clear();
    this._suppressedCount = 0;
    this._processedCount = 0;
  }

  get size(): number {
    return this.recentKeys.size;
  }

  /** Returns deduplication statistics for metrics and observability */
  getStats(): { suppressedCount: number; processedCount: number; cacheSize: number } {
    return {
      suppressedCount: this._suppressedCount,
      processedCount: this._processedCount,
      cacheSize: this.recentKeys.size,
    };
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
