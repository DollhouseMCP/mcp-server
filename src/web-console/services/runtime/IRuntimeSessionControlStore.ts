import type {
  RuntimeSessionStatus,
  RuntimeSessionTransport,
  RuntimeTerminationAckResult,
  RuntimeTerminationReason,
  RuntimeTerminationRequesterKind,
} from '../../../database/schema/index.js';
import {
  assertUuid,
  cloneDate,
  ConsoleStoreValidationError,
  tupleIncludes,
} from '../../stores/ConsoleStoreValidation.js';
import { validateReplicaId } from '../invalidation/IConsoleSecurityInvalidationStore.js';

export type {
  RuntimeSessionStatus,
  RuntimeSessionTransport,
  RuntimeTerminationAckResult,
  RuntimeTerminationReason,
  RuntimeTerminationRequesterKind,
};

export interface RuntimeClientInfo {
  readonly name?: string;
  readonly version?: string;
}

export interface RuntimeSessionPresence {
  readonly sessionId: string;
  readonly userId: string;
  readonly accountCorrelationId: string;
  readonly replicaId: string;
  readonly transport: RuntimeSessionTransport;
  readonly clientInfo: RuntimeClientInfo | null;
  readonly startedAt: Date;
  readonly lastActiveAt: Date;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly leaseUntil: Date;
  readonly status: RuntimeSessionStatus;
  readonly closedAt: Date | null;
}

export interface RuntimeSessionPresenceInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly accountCorrelationId: string;
  readonly replicaId: string;
  readonly transport: RuntimeSessionTransport;
  readonly clientInfo?: RuntimeClientInfo | null;
  readonly startedAt: Date;
  readonly lastActiveAt: Date;
  readonly requestCount?: number;
  readonly errorCount?: number;
  readonly leaseUntil: Date;
}

export interface RuntimeSessionHeartbeatInput {
  readonly sessionId: string;
  readonly replicaId: string;
  readonly lastActiveAt: Date;
  /**
   * Replica-owned snapshot counters. The store persists the latest snapshot
   * from the owning replica; it does not increment counters server-side.
   */
  readonly requestCount: number;
  readonly errorCount: number;
  readonly leaseUntil: Date;
}

export type RuntimeSessionHeartbeatResult =
  | {
      readonly kind: 'updated';
      readonly presence: RuntimeSessionPresence;
    }
  | {
      readonly kind: 'lost';
      readonly reason: 'missing' | 'replica_mismatch' | 'closing';
    };

export interface RuntimeSessionListQuery {
  readonly limit?: number;
  readonly now?: Date;
}

export interface RuntimeTerminationCommand {
  readonly commandId: string;
  readonly kind: 'terminate_session';
  readonly sessionId: string;
  readonly targetReplicaId: string;
  readonly reason: RuntimeTerminationReason;
  readonly requestedAt: Date;
  readonly requestedBy: {
    readonly kind: RuntimeTerminationRequesterKind;
    readonly userId: string | null;
  };
  readonly invalidationEventId: string | null;
}

export interface RuntimeTerminationCommandInput {
  readonly commandId?: string;
  readonly sessionId: string;
  readonly targetReplicaId: string;
  readonly reason: RuntimeTerminationReason;
  /**
   * Caller-selected provenance timestamp. Route/services should pass their
   * trusted server clock; stores preserve it for deterministic audit/queue
   * tests and do not derive it from client input.
   */
  readonly requestedAt: Date;
  /**
   * Declares who authorized the command. The store validates shape only; route
   * services must enforce that `self` refers to the session owner.
   */
  readonly requestedBy: {
    readonly kind: RuntimeTerminationRequesterKind;
    readonly userId: string | null;
  };
  readonly invalidationEventId?: string | null;
}

export interface RuntimeTerminationAck {
  readonly commandId: string;
  readonly replicaId: string;
  readonly acknowledgedAt: Date;
  readonly result: RuntimeTerminationAckResult;
  readonly errorCode: string | null;
}

export interface RuntimeTerminationAckInput {
  readonly commandId: string;
  readonly replicaId: string;
  readonly acknowledgedAt: Date;
  readonly result: RuntimeTerminationAckResult;
  readonly errorCode?: string | null;
}

export interface IRuntimeSessionControlStore {
  registerPresence(input: RuntimeSessionPresenceInput): Promise<RuntimeSessionPresence>;
  heartbeatPresence(input: RuntimeSessionHeartbeatInput): Promise<RuntimeSessionHeartbeatResult>;
  markPresenceClosing(sessionId: string, closedAt: Date): Promise<RuntimeSessionPresence | null>;
  sweepStalePresence(before?: Date): Promise<number>;
  findPresence(sessionId: string, now?: Date): Promise<RuntimeSessionPresence | null>;
  listPresenceByUser(userId: string, query?: RuntimeSessionListQuery): Promise<RuntimeSessionPresence[]>;
  listOperationalPresence(query?: RuntimeSessionListQuery): Promise<RuntimeSessionPresence[]>;
  createTerminationCommand(input: RuntimeTerminationCommandInput): Promise<RuntimeTerminationCommand>;
  listPendingCommandsForReplica(
    replicaId: string,
    query?: RuntimeSessionListQuery,
  ): Promise<RuntimeTerminationCommand[]>;
  acknowledgeCommand(input: RuntimeTerminationAckInput): Promise<boolean>;
  getCommandAck(commandId: string): Promise<RuntimeTerminationAck | null>;
}

const STATUSES = ['active', 'closing'] as const satisfies readonly RuntimeSessionStatus[];
const TERMINATION_REASONS = [
  'user_requested',
  'admin_disabled',
  'admin_terminated',
  'operator_terminated',
  'credential_revoked',
  'idle_expired',
] as const satisfies readonly RuntimeTerminationReason[];
const REQUESTER_KINDS = ['self', 'admin', 'operator', 'system'] as const satisfies readonly RuntimeTerminationRequesterKind[];
const ACK_RESULTS = ['terminated', 'already_absent', 'failed'] as const satisfies readonly RuntimeTerminationAckResult[];

export function validateRuntimeSessionPresenceInput(input: RuntimeSessionPresenceInput): void {
  validateSessionId(input.sessionId);
  assertUuid(input.userId, 'userId');
  assertUuid(input.accountCorrelationId, 'accountCorrelationId');
  validateReplicaId(input.replicaId);
  validateClientInfo(input.clientInfo ?? null);
  validateCounts(input.requestCount ?? 0, input.errorCount ?? 0);
  if (input.lastActiveAt < input.startedAt) {
    throw new ConsoleStoreValidationError('lastActiveAt must be at or after startedAt');
  }
  if (input.leaseUntil <= input.lastActiveAt) {
    throw new ConsoleStoreValidationError('leaseUntil must be after lastActiveAt');
  }
}

export function validateRuntimeSessionHeartbeatInput(input: RuntimeSessionHeartbeatInput): void {
  validateSessionId(input.sessionId);
  validateReplicaId(input.replicaId);
  validateCounts(input.requestCount, input.errorCount);
  if (input.leaseUntil <= input.lastActiveAt) {
    throw new ConsoleStoreValidationError('leaseUntil must be after lastActiveAt');
  }
}

export function validateRuntimeTerminationCommandInput(input: RuntimeTerminationCommandInput): void {
  if (input.commandId !== undefined) assertUuid(input.commandId, 'commandId');
  validateSessionId(input.sessionId);
  validateReplicaId(input.targetReplicaId);
  validateTerminationReason(input.reason);
  validateRequester(input.requestedBy);
  if (input.invalidationEventId !== undefined && input.invalidationEventId !== null) {
    assertUuid(input.invalidationEventId, 'invalidationEventId');
  }
}

export function validateRuntimeTerminationAckInput(input: RuntimeTerminationAckInput): void {
  assertUuid(input.commandId, 'commandId');
  validateReplicaId(input.replicaId);
  validateAckResult(input.result);
  if (input.result === 'failed') {
    if (!input.errorCode || input.errorCode.trim() === '' || input.errorCode.length > 100) {
      throw new ConsoleStoreValidationError('errorCode is required and at most 100 characters for failed acknowledgements');
    }
  } else if (input.errorCode !== undefined && input.errorCode !== null) {
    throw new ConsoleStoreValidationError('errorCode is only allowed for failed acknowledgements');
  }
}

export function validateRuntimeListQuery(query: RuntimeSessionListQuery = {}): Required<RuntimeSessionListQuery> {
  const limit = query.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new ConsoleStoreValidationError('runtime session list limit must be between 1 and 500');
  }
  return {
    limit,
    now: query.now ?? new Date(),
  };
}

export function validateSessionId(sessionId: string): void {
  if (sessionId.trim() === '' || sessionId.length > 200) {
    throw new ConsoleStoreValidationError('sessionId must be non-empty and at most 200 characters');
  }
}

export function cloneRuntimeSessionPresence(presence: RuntimeSessionPresence): RuntimeSessionPresence {
  return {
    ...presence,
    clientInfo: presence.clientInfo ? { ...presence.clientInfo } : null,
    startedAt: new Date(presence.startedAt),
    lastActiveAt: new Date(presence.lastActiveAt),
    leaseUntil: new Date(presence.leaseUntil),
    closedAt: cloneDate(presence.closedAt),
  };
}

export function cloneRuntimeTerminationCommand(command: RuntimeTerminationCommand): RuntimeTerminationCommand {
  return {
    ...command,
    requestedAt: new Date(command.requestedAt),
    requestedBy: { ...command.requestedBy },
  };
}

export function cloneRuntimeTerminationAck(ack: RuntimeTerminationAck): RuntimeTerminationAck {
  return {
    ...ack,
    acknowledgedAt: new Date(ack.acknowledgedAt),
  };
}

function validateClientInfo(clientInfo: RuntimeClientInfo | null): void {
  if (!clientInfo) return;
  for (const [name, value] of [['clientInfo.name', clientInfo.name], ['clientInfo.version', clientInfo.version]] as const) {
    if (value !== undefined && (value.trim() === '' || value.length > 100)) {
      throw new ConsoleStoreValidationError(`${name} must be non-empty and at most 100 characters when provided`);
    }
  }
}

function validateCounts(requestCount: number, errorCount: number): void {
  if (!Number.isInteger(requestCount) || requestCount < 0) {
    throw new ConsoleStoreValidationError('requestCount must be a non-negative integer');
  }
  if (!Number.isInteger(errorCount) || errorCount < 0) {
    throw new ConsoleStoreValidationError('errorCount must be a non-negative integer');
  }
}

function validateTerminationReason(reason: RuntimeTerminationReason): void {
  if (!tupleIncludes(TERMINATION_REASONS, reason)) {
    throw new ConsoleStoreValidationError(`unknown runtime termination reason '${reason}'`);
  }
}

function validateRequester(requestedBy: RuntimeTerminationCommandInput['requestedBy']): void {
  if (!tupleIncludes(REQUESTER_KINDS, requestedBy.kind)) {
    throw new ConsoleStoreValidationError(`unknown runtime termination requester kind '${requestedBy.kind}'`);
  }
  if (requestedBy.kind === 'system') {
    if (requestedBy.userId !== null) throw new ConsoleStoreValidationError('system requester must not include userId');
    return;
  }
  if (!requestedBy.userId) throw new ConsoleStoreValidationError('non-system requester requires userId');
  assertUuid(requestedBy.userId, 'requestedBy.userId');
}

function validateAckResult(result: RuntimeTerminationAckResult): void {
  if (!tupleIncludes(ACK_RESULTS, result)) {
    throw new ConsoleStoreValidationError(`unknown runtime termination acknowledgement result '${result}'`);
  }
}

export function isRuntimeSessionStatus(value: string): value is RuntimeSessionStatus {
  return tupleIncludes(STATUSES, value);
}

export function isRuntimeTerminationReason(value: string): value is RuntimeTerminationReason {
  return tupleIncludes(TERMINATION_REASONS, value);
}
