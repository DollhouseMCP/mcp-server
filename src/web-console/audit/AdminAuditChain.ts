import { createHmac, timingSafeEqual } from 'node:crypto';

import type { AuditHmacKeyMaterial } from '../../security/auditHmacKey.js';
import type { ConsoleAdminAuditEvent } from './IAdminAuditWriter.js';

export type AdminAuditIntegrityStatus = 'verified' | 'failed' | 'not_available';

export interface AdminAuditChainVerification {
  readonly status: AdminAuditIntegrityStatus;
  readonly reason: string | null;
}

export interface AdminAuditChainMaterial extends ConsoleAdminAuditEvent {
  readonly chainKeyId: string;
  readonly chainPrev: Buffer | null;
  readonly chainHmac: Buffer;
  readonly sequenceId?: number;
}

export function computeAdminAuditChainHmac(
  event: ConsoleAdminAuditEvent,
  key: Buffer,
  chainPrev: Buffer | null,
): Buffer {
  const canonical = JSON.stringify({
    occurredAt: event.occurredAt.toISOString(),
    actorUserId: event.actorUserId,
    actorSub: event.actorSub,
    actorRole: event.actorRole,
    actorCapabilityRole: event.actorCapabilityRole,
    actorConsoleSessionHash: event.actorConsoleSessionHash.toString('hex'),
    capability: event.capability,
    elevationAcr: event.elevationAcr,
    elevationAmr: [...event.elevationAmr],
    elevationAuthTime: event.elevationAuthTime ? event.elevationAuthTime.toISOString() : null,
    endpoint: event.endpoint,
    operation: event.operation,
    resourceKind: event.resourceKind,
    resourceId: event.resourceId,
    targetUserId: event.targetUserId,
    argsRedacted: event.argsRedacted,
    result: event.result,
    errorCode: event.errorCode,
    resultDetailRedacted: event.resultDetailRedacted,
    correlationId: event.correlationId,
    clientIp: event.clientIp,
    userAgent: event.userAgent,
    chainPrev: chainPrev ? chainPrev.toString('hex') : null,
  });
  return createHmac('sha256', key).update(canonical).digest();
}

export function verifyAdminAuditRow(
  row: AdminAuditChainMaterial,
  keyMaterial: AuditHmacKeyMaterial | null,
  expectedPrevious?: Buffer | null,
  expectedPreviousSequenceId?: number | null,
): AdminAuditChainVerification {
  if (row.chainHmac.length !== 32) {
    return { status: 'failed', reason: 'invalid_chain_hmac_length' };
  }
  if (row.chainPrev && row.chainPrev.length !== 32) {
    return { status: 'failed', reason: 'invalid_chain_prev_length' };
  }
  if (expectedPrevious !== undefined && !buffersEqual(row.chainPrev, expectedPrevious)) {
    return { status: 'failed', reason: 'chain_prev_mismatch' };
  }
  if (
    expectedPreviousSequenceId !== undefined &&
    expectedPreviousSequenceId !== null &&
    row.sequenceId !== undefined &&
    row.sequenceId !== expectedPreviousSequenceId + 1
  ) {
    return { status: 'failed', reason: 'sequence_gap' };
  }
  if (keyMaterial?.keyId !== row.chainKeyId) {
    return { status: 'not_available', reason: 'verification_key_unavailable' };
  }
  const expected = computeAdminAuditChainHmac(row, keyMaterial.key, row.chainPrev);
  if (!timingSafeEqual(expected, row.chainHmac)) {
    return { status: 'failed', reason: 'chain_hmac_mismatch' };
  }
  return { status: 'verified', reason: null };
}

function buffersEqual(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}
