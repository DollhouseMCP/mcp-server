import type { ConsolePageDto } from '../../platform/ConsolePlatformTypes.js';
import type {
  RuntimeTerminationAckResult,
  RuntimeTerminationReason,
} from '../../services/runtime/IRuntimeSessionControlStore.js';
import type { RuntimeSessionStatus } from '../../../database/schema/index.js';

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
  readonly status: RuntimeSessionStatus;
}

export interface RuntimeSessionAccountDto {
  readonly session_id: string;
  readonly transport: 'streamable-http';
  readonly created_at: string;
  readonly last_active_at: string;
  readonly status: RuntimeSessionStatus;
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

/** Family-B cursor page of the cross-user operational sessions list. */
export type RuntimeSessionOperationalListDto = ConsolePageDto<RuntimeSessionOperationalDto>;

export interface RuntimeTerminationAcceptedDto {
  readonly session_id: string;
  readonly command_id: string;
  readonly target_replica_id: string;
  readonly reason: RuntimeTerminationReason;
  readonly status: 'accepted';
}

/**
 * Completion status of an async termination command. `pending` = no ack row yet
 * (the owning replica has not reported back); otherwise the replica's ack result.
 */
export interface RuntimeTerminationCommandStatusDto {
  readonly command_id: string;
  readonly status: 'pending' | RuntimeTerminationAckResult;
  readonly acknowledged_at: string | null;
  readonly replica_id: string | null;
  readonly error_code: string | null;
}

export interface RuntimeSessionRevokeAllDto {
  readonly user_id: string;
  readonly requested: number;
  readonly commands: readonly RuntimeTerminationAcceptedDto[];
}
