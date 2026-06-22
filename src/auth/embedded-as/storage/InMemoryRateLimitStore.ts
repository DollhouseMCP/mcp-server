import type {
  IRateLimitStore,
  RateLimitEntry,
  RateLimitUpdate,
  RateLimitUpdateOptions,
} from './IRateLimitStore.js';

interface StoredRateLimitEntry {
  state: unknown;
  version: number;
  expiresAt?: number;
}

export class InMemoryRateLimitStore implements IRateLimitStore {
  private readonly entries = new Map<string, StoredRateLimitEntry>();

  async get<TState>(scope: string, key: string): Promise<RateLimitEntry<TState> | null> {
    const composite = makeKey(scope, key);
    const entry = this.entries.get(composite);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt < Date.now()) {
      this.entries.delete(composite);
      return null;
    }
    return { state: entry.state as TState, version: entry.version };
  }

  async update<TState, TResult = void>(
    scope: string,
    key: string,
    compute: (prev: TState | null) => RateLimitUpdate<TState, TResult>,
    options: RateLimitUpdateOptions = {},
  ): Promise<RateLimitUpdate<TState, TResult>> {
    const composite = makeKey(scope, key);
    const current = await this.get<TState>(scope, key);
    const next = compute(current?.state ?? null);
    if (next.state === null) {
      this.entries.delete(composite);
      return next;
    }
    this.entries.set(composite, {
      state: next.state,
      version: (current?.version ?? 0) + 1,
      expiresAt: options.expiresAt,
    });
    return next;
  }

  async reset(scope: string, key: string): Promise<void> {
    this.entries.delete(makeKey(scope, key));
  }

  async sweep(): Promise<void> {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt < now) {
        this.entries.delete(key);
      }
    }
  }
}

function makeKey(scope: string, key: string): string {
  return `${scope}\0${key}`;
}
