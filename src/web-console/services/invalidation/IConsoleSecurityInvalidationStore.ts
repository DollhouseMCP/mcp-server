import type {
  ConsoleSecurityInvalidationKind,
  ConsoleSecurityInvalidationUrgency,
} from '../../../database/schema/index.js';
import {
  assertHash,
  assertUuid,
  cloneBuffer,
  cloneDate,
  ConsoleStoreValidationError,
} from '../../stores/ConsoleStoreValidation.js';

export type {
  ConsoleSecurityInvalidationKind,
  ConsoleSecurityInvalidationUrgency,
};

export interface SecurityInvalidationEvent {
  readonly sequenceId: number;
  readonly eventId: string;
  readonly kind: ConsoleSecurityInvalidationKind;
  readonly urgency: ConsoleSecurityInvalidationUrgency;
  readonly userId: string | null;
  readonly consoleSessionIdHash: Buffer | null;
  readonly authzVersion: number | null;
  readonly reason: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly createdByUserId: string | null;
}

export interface SecurityInvalidationEventInput {
  readonly kind: ConsoleSecurityInvalidationKind;
  readonly urgency: ConsoleSecurityInvalidationUrgency;
  readonly userId: string | null;
  readonly consoleSessionIdHash?: Buffer | null;
  readonly authzVersion?: number | null;
  readonly reason: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly createdByUserId?: string | null;
}

export interface ReplicaLease {
  readonly replicaId: string;
  readonly leaseUntil: Date;
  readonly renewedAt: Date;
}

export interface IConsoleSecurityInvalidationStore {
  appendEvent(input: SecurityInvalidationEventInput): Promise<SecurityInvalidationEvent>;
  listEventsAfter(sequenceId: number, limit?: number): Promise<SecurityInvalidationEvent[]>;
  getReplicaCursor(replicaId: string): Promise<number>;
  recordReplicaCursor(replicaId: string, sequenceId: number, updatedAt?: Date): Promise<void>;
  acquireReplicaLease(input: ReplicaLease): Promise<void>;
  listLiveReplicaIds(at?: Date): Promise<string[]>;
  acknowledgeEvent(eventId: string, replicaId: string, acknowledgedAt?: Date): Promise<void>;
  listAcknowledgedReplicaIds(eventId: string): Promise<string[]>;
}

const EVENT_KINDS = [
  'principal_disabled',
  'principal_reenabled',
  'principal_authz_changed',
  'principal_credentials_revoked',
  'admin_factor_disabled',
  'console_session_revoked',
  'console_elevation_revoked',
  'runtime_sessions_terminated',
] as const satisfies readonly ConsoleSecurityInvalidationKind[];

const URGENCIES = ['eventual', 'acknowledged'] as const satisfies readonly ConsoleSecurityInvalidationUrgency[];
const MAX_PAYLOAD_BYTES = 4096;

const ALLOWED_PAYLOAD_KEYS = {
  principal_disabled: ['revokedSessions', 'revokedCredentials', 'terminatedRuntimeSessions'],
  principal_reenabled: [],
  principal_authz_changed: ['previousAuthzVersion', 'newAuthzVersion'],
  principal_credentials_revoked: ['revokedGrants', 'authzVersionBumped'],
  admin_factor_disabled: ['clearedElevations', 'proofMethod'],
  console_session_revoked: ['sessionRevoked'],
  console_elevation_revoked: ['clearedElevations', 'revokedCapabilities'],
  runtime_sessions_terminated: ['terminatedRuntimeSessions'],
} as const satisfies Record<ConsoleSecurityInvalidationKind, readonly string[]>;

export function validateSecurityInvalidationEventInput(input: SecurityInvalidationEventInput): void {
  if (!EVENT_KINDS.includes(input.kind)) {
    throw new ConsoleStoreValidationError(`unknown security invalidation kind '${input.kind}'`);
  }
  if (!URGENCIES.includes(input.urgency)) {
    throw new ConsoleStoreValidationError(`unknown security invalidation urgency '${input.urgency}'`);
  }
  if (input.userId === null && input.kind !== 'console_session_revoked') {
    throw new ConsoleStoreValidationError('userId is required for principal-scoped invalidation events');
  }
  if (input.userId !== null) assertUuid(input.userId, 'userId');
  if (input.consoleSessionIdHash) assertHash(input.consoleSessionIdHash, 'consoleSessionIdHash');
  if (input.authzVersion !== undefined && input.authzVersion !== null
      && (!Number.isInteger(input.authzVersion) || input.authzVersion < 1)) {
    throw new ConsoleStoreValidationError('authzVersion must be a positive integer when provided');
  }
  if (input.reason.trim() === '' || input.reason.length > 200) {
    throw new ConsoleStoreValidationError('reason must be non-empty and at most 200 characters');
  }
  if (input.createdByUserId !== undefined && input.createdByUserId !== null) {
    assertUuid(input.createdByUserId, 'createdByUserId');
  }
  validatePayload(input.kind, input.payload ?? {});
}

export function validateReplicaLease(input: ReplicaLease): void {
  validateReplicaId(input.replicaId);
  if (input.leaseUntil <= input.renewedAt) {
    throw new ConsoleStoreValidationError('replica leaseUntil must be after renewedAt');
  }
}

export function validateReplicaId(replicaId: string): void {
  if (replicaId.trim() === '' || replicaId.length > 128) {
    throw new ConsoleStoreValidationError('replicaId must be non-empty and at most 128 characters');
  }
}

export function validateSequenceId(sequenceId: number): void {
  if (!Number.isInteger(sequenceId) || sequenceId < 0) {
    throw new ConsoleStoreValidationError('sequenceId must be a non-negative integer');
  }
}

export function validateEventId(eventId: string): void {
  assertUuid(eventId, 'eventId');
}

export function cloneSecurityInvalidationEvent(
  event: SecurityInvalidationEvent,
): SecurityInvalidationEvent {
  return {
    ...event,
    consoleSessionIdHash: event.consoleSessionIdHash ? cloneBuffer(event.consoleSessionIdHash) : null,
    payload: { ...event.payload },
    createdAt: new Date(event.createdAt),
    createdByUserId: event.createdByUserId,
  };
}

export function cloneReplicaLease(lease: ReplicaLease): ReplicaLease {
  return {
    replicaId: lease.replicaId,
    leaseUntil: new Date(lease.leaseUntil),
    renewedAt: new Date(lease.renewedAt),
  };
}

export function cloneNullableDate(date: Date | null): Date | null {
  return cloneDate(date);
}

function validatePayload(
  kind: ConsoleSecurityInvalidationKind,
  payload: Readonly<Record<string, unknown>>,
): void {
  const keys = Object.keys(payload);
  const allowed: readonly string[] = ALLOWED_PAYLOAD_KEYS[kind];
  const unexpected = keys.find(key => !allowed.includes(key));
  if (unexpected) {
    throw new ConsoleStoreValidationError(`payload key '${unexpected}' is not allowed for ${kind}`);
  }
  const encoded = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (encoded > MAX_PAYLOAD_BYTES) {
    throw new ConsoleStoreValidationError(`payload must be at most ${MAX_PAYLOAD_BYTES} bytes`);
  }
}
