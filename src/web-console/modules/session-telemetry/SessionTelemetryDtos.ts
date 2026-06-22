export type UserActivityLevel = 'debug' | 'info' | 'warn' | 'error';

export interface UserActivityDto {
  readonly ts: string;
  readonly session_id: string;
  readonly level: UserActivityLevel;
  readonly subsystem: string;
  readonly event: string;
  readonly message: string | null;
  readonly correlation_id: string | null;
  readonly stable_error_code: string | null;
}

export interface UserActivityPageDto {
  readonly items: readonly UserActivityDto[];
  readonly page: {
    readonly limit: number;
    readonly cursor: string | null;
    readonly next_cursor: string | null;
  };
}

export type UserMetricKind = 'counter' | 'gauge' | 'histogram';

export interface UserMetricDto {
  readonly name: string;
  readonly kind: UserMetricKind;
  readonly value: number;
  readonly unit: string;
  readonly dimensions: {
    readonly subsystem?: string;
    readonly event?: string;
    readonly status_family?: string;
    readonly error_code?: string;
    readonly transport?: string;
    readonly latency_bucket?: string;
  };
}

export interface UserMetricResponseDto {
  readonly checked_at: string;
  readonly metrics: readonly UserMetricDto[];
}
