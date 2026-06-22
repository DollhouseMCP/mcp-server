/**
 * Shared helpers for FileConfirmationStore and DatabaseConfirmationStore
 * approval-search paths. Both backends iterate matching CliApprovalRecord
 * entries the same way and build the same ApprovalRef shape, so the
 * filter check and the ref builder live here instead of being duplicated.
 */

import type { CliApprovalRecord } from '../handlers/mcp-aql/GatekeeperTypes.js';
import type { ApprovalRef, ApprovalSearchFilter } from './IConfirmationStore.js';

export function approvalMatches(
  approvalId: string,
  record: CliApprovalRecord,
  filter: ApprovalSearchFilter,
): boolean {
  if (filter.approvalId && filter.approvalId !== approvalId) return false;
  const requestedAt = new Date(record.requestedAt).getTime();
  if (filter.after !== undefined && requestedAt < filter.after) return false;
  if (filter.before !== undefined && requestedAt > filter.before) return false;
  return true;
}

export function toApprovalRef(
  sessionId: string,
  approvalId: string,
  record: CliApprovalRecord,
): ApprovalRef {
  return {
    sessionId,
    approvalId,
    toolName: record.toolName,
    approvedAt: record.approvedAt,
    requestedAt: record.requestedAt,
    digest: record.toolInputDigest ?? {},
  };
}
