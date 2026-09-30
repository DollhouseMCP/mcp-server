import type { CliApprovalScope } from './GatekeeperTypes.js';

/** Legacy integration prompts must never create a tool-wide grant. */
export function effectiveCliApprovalScopes(record: {
  readonly toolName: string;
  readonly allowedScopes?: readonly CliApprovalScope[];
}): readonly CliApprovalScope[] | undefined {
  return record.allowedScopes ?? (record.toolName === 'integration_request' ? ['single', 'input_session'] : undefined);
}
