export type SessionExecutionStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface SessionExecutionSummaryDto {
  readonly goal_id: string;
  readonly session_id: string;
  readonly agent_name: string;
  readonly status: SessionExecutionStatus;
  readonly progress: number | null;
  readonly started_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly current_step: string | null;
  readonly stable_error_code: string | null;
}

export interface SessionExecutionDetailDto extends SessionExecutionSummaryDto {
  readonly output: readonly SessionExecutionOutputDto[];
}

export interface SessionExecutionOutputDto {
  readonly kind: 'progress' | 'result' | 'error';
  readonly message: string;
  readonly occurred_at: string;
}

export interface SessionExecutionListDto {
  readonly executions: readonly SessionExecutionSummaryDto[];
}

export interface GatekeeperConfirmationDto {
  readonly operation: string;
  readonly element_type: string | null;
  readonly scope: 'once' | 'session';
  readonly confirmed_at: string;
  readonly use_count: number;
}

export interface GatekeeperPendingApprovalDto {
  readonly approval_id: string;
  readonly tool_name: string;
  readonly risk_level: string;
  readonly risk_score: number;
  readonly irreversible: boolean;
  readonly reason: string;
  readonly policy_source: string | null;
  readonly requested_at: string;
  readonly expires_at: string;
}

export interface SessionGatekeeperDto {
  readonly session_id: string;
  readonly permission_prompt_active: boolean;
  readonly confirmation_count: number;
  readonly pending_approval_count: number;
  readonly retained_approval_count: number;
  readonly client: {
    readonly name: string | null;
    readonly version: string | null;
  } | null;
  readonly confirmations: readonly GatekeeperConfirmationDto[];
  readonly pending_approvals: readonly GatekeeperPendingApprovalDto[];
}
