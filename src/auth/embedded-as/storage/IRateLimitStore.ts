export interface RateLimitEntry<TState> {
  state: TState;
  version: number;
}

export interface RateLimitUpdate<TState, TResult = void> {
  state: TState | null;
  result?: TResult;
}

export interface RateLimitUpdateOptions {
  expiresAt?: number;
  maxRetries?: number;
}

export interface IRateLimitStore {
  get<TState>(scope: string, key: string): Promise<RateLimitEntry<TState> | null>;

  update<TState, TResult = void>(
    scope: string,
    key: string,
    compute: (prev: TState | null) => RateLimitUpdate<TState, TResult>,
    options?: RateLimitUpdateOptions,
  ): Promise<RateLimitUpdate<TState, TResult>>;

  reset(scope: string, key: string): Promise<void>;

  sweep(): Promise<void>;
}
