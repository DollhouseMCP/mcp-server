/**
 * LRU bookkeeping without eviction telemetry: diagnostic keys can identify
 * another caller, so evictions must not log them in the current request.
 */
export class BoundedDiagnosticMap<T> extends Map<string, T> {
  constructor(private readonly limit: number) {
    super();
  }

  override get(key: string): T | undefined {
    const value = super.get(key);
    // Reads refresh LRU recency. Stored undefined is treated as absent;
    // diagnostic values are Maps, Sets, or booleans.
    if (value !== undefined) {
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }

  override set(key: string, value: T): this {
    super.delete(key);
    super.set(key, value);
    if (this.size > this.limit) {
      const oldest = this.keys().next().value;
      if (oldest !== undefined) super.delete(oldest);
    }
    return this;
  }
}
