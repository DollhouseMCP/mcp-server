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
