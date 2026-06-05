export type ConsoleApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'cancelled_session_terminated';

export type ConsoleApprovalScope = 'once' | 'session';

export interface SessionApprovalDto {
  readonly approval_id: string;
  readonly session_id: string;
  readonly status: ConsoleApprovalStatus;
  readonly tool_name: string;
  readonly tool_input_digest: Record<string, unknown>;
  readonly tool_input_detail: Record<string, unknown> | null;
  readonly risk_level: string;
  readonly risk_score: number;
  readonly irreversible: boolean;
  readonly reason: string;
  readonly policy_source: string | null;
  readonly scope: ConsoleApprovalScope;
  readonly requested_at: string;
  readonly expires_at: string;
  readonly decided_at: string | null;
}

export interface SessionApprovalListDto {
  readonly approvals: readonly SessionApprovalDto[];
}
