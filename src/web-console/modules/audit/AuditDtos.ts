import type {
  AdminAuditIntegrityStatus,
  ConsoleAdminActorRole,
  ConsoleAdminAuditRedactedRecord,
  ConsoleAdminAuditResult,
} from '../../audit/index.js';
import type { ConsoleCapability } from '../../platform/ConsolePlatformTypes.js';

export interface AuditPageDto<T> {
  readonly items: readonly T[];
  readonly page: {
    readonly limit: number;
    readonly cursor: string | null;
    readonly next_cursor: string | null;
  };
}

export interface AdminAuditEventDto {
  readonly id: string;
  readonly sequence_id: number;
  readonly occurred_at: string;
  readonly actor_user_id: string;
  readonly actor_sub: string;
  readonly actor_role: ConsoleAdminActorRole | null;
  readonly actor_capability_role: ConsoleAdminActorRole;
  readonly actor_console_session_hash: string;
  readonly capability: ConsoleCapability;
  readonly elevation_acr: string | null;
  readonly elevation_amr: readonly string[];
  readonly elevation_auth_time: number | null;
  readonly correlation_id: string;
  readonly endpoint: string;
  readonly operation: string;
  readonly resource_kind: string | null;
  readonly resource_id: string | null;
  readonly target_user_id: string | null;
  readonly args_redacted: ConsoleAdminAuditRedactedRecord;
  readonly result: ConsoleAdminAuditResult;
  readonly error_code: string | null;
  readonly result_detail_redacted: ConsoleAdminAuditRedactedRecord | null;
  readonly client_ip: string | null;
  readonly user_agent: string | null;
  readonly chain_key_id: string;
  readonly chain_prev: string | null;
  readonly chain_hmac: string;
  readonly integrity: {
    readonly status: AdminAuditIntegrityStatus;
    readonly reason: string | null;
  };
}

export interface ApprovalAuditEventDto {
  readonly id: string;
  readonly occurred_at: string;
  readonly account_correlation_id: string;
  readonly session_id: string;
  readonly tool_name: string;
  readonly operation: string | null;
  readonly result: string;
  readonly decision_source: string | null;
  readonly correlation_id: string | null;
  readonly integrity: {
    readonly status: 'verified' | 'not_available';
    readonly chain_key_id: string | null;
    readonly chain_prev: string | null;
    readonly chain_hmac: string | null;
  };
}

export interface AuthenticationAuditEventDto {
  readonly id: string;
  readonly occurred_at: string;
  readonly event: string;
  readonly actor_user_id: string | null;
  readonly actor_sub: string | null;
  readonly capability: ConsoleCapability | null;
  readonly elevation_acr: string | null;
  readonly elevation_amr: readonly string[];
  readonly result: string;
  readonly error_code: string | null;
  readonly correlation_id: string | null;
  readonly client_ip: string | null;
  readonly user_agent: string | null;
}
