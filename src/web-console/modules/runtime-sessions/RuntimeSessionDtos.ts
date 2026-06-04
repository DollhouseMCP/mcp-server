import type { RuntimeTerminationReason } from '../../services/runtime/IRuntimeSessionControlStore.js';

export interface RuntimeSessionSelfDto {
  readonly session_id: string;
  readonly transport: 'streamable-http';
  readonly client_info: {
    readonly name?: string;
    readonly version?: string;
  } | null;
  readonly created_at: string;
  readonly last_active_at: string;
  readonly request_count: number;
  readonly error_count: number;
  readonly status: 'active';
}

export interface RuntimeSessionAccountDto {
  readonly session_id: string;
  readonly transport: 'streamable-http';
  readonly created_at: string;
  readonly last_active_at: string;
  readonly status: 'active';
}

export interface RuntimeSessionOperationalDto extends RuntimeSessionAccountDto {
  readonly account_correlation_id: string;
  readonly replica_id: string;
  readonly request_count: number;
  readonly error_count: number;
  readonly lease_until: string;
  readonly client_info: {
    readonly name?: string;
    readonly version?: string;
  } | null;
}

export interface RuntimeTerminationAcceptedDto {
  readonly session_id: string;
  readonly command_id: string;
  readonly target_replica_id: string;
  readonly reason: RuntimeTerminationReason;
  readonly status: 'accepted';
}

export interface RuntimeSessionRevokeAllDto {
  readonly user_id: string;
  readonly requested: number;
  readonly commands: readonly RuntimeTerminationAcceptedDto[];
}
