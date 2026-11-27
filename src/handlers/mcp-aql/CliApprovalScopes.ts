import type { CliApprovalScope } from './GatekeeperTypes.js';

interface CliApprovalScopeRecord {
  readonly toolName: string;
  readonly allowedScopes?: readonly CliApprovalScope[];
}

/** Legacy integration prompts must never create a tool-wide grant. */
export function effectiveCliApprovalScopes(record: CliApprovalScopeRecord): readonly CliApprovalScope[] | undefined {
  return record.allowedScopes ?? (record.toolName === 'integration_request' ? ['single', 'input_session'] : undefined);
}

export function requireCliApprovalScope(record: CliApprovalScopeRecord & { requestId: string }, scope: CliApprovalScope) {
  const allowedScopes = effectiveCliApprovalScopes(record);
  const permitted = allowedScopes ?? ['single', 'tool_session'];
  if (!permitted.includes(scope)) {
    throw new Error(
      `Approval request "${record.requestId}" does not permit scope "${scope}". Allowed scopes: ${permitted.join(', ')}.`,
    );
  }
  return allowedScopes;
}
