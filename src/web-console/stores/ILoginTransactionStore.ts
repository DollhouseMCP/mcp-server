import type { ConsoleCapability } from '../platform/ConsolePlatformTypes.js';
import {
  ConsoleStoreValidationError,
  assertCapability,
  assertHash,
  assertNonEmptyBuffer,
  assertUuid,
  cloneBuffer,
  cloneDate,
} from './ConsoleStoreValidation.js';

export type ConsoleLoginFlowKind = 'login' | 'step_up' | 'integration_link';

/** Maximum time a one-time-consumed callback may remain in flight before cleanup. */
export const CONSUMED_TRANSACTION_COMPLETION_LEASE_MS = 5 * 60 * 1000;

export interface ConsoleLoginTransaction {
  readonly idHash: Buffer;
  readonly flowKind: ConsoleLoginFlowKind;
  readonly stateHash: Buffer;
  readonly pkceVerifierEnc: Buffer;
  readonly userId: string | null;
  readonly consoleSessionIdHash: Buffer | null;
  readonly requestedCapability: ConsoleCapability | null;
  /** Descriptor that initiated an integration flow; null for coded providers. */
  readonly integrationDescriptorId?: string | null;
  /** Routing-sensitive descriptor digest captured when the flow began. */
  readonly integrationDescriptorFingerprint?: string | null;
  readonly returnTo: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface ILoginTransactionStore {
  create(transaction: ConsoleLoginTransaction): Promise<void>;
  findByIdHash(idHash: Buffer): Promise<ConsoleLoginTransaction | null>;
  consume(idHash: Buffer, stateHash: Buffer, consumedAt?: Date): Promise<ConsoleLoginTransaction | null>;
  /** Mark an already-consumed transaction complete while retaining replay diagnostics. */
  completeConsumed(idHash: Buffer): Promise<boolean>;
  sweepExpired(before?: Date): Promise<number>;
}

export function validateLoginTransaction(transaction: ConsoleLoginTransaction): void {
  assertHash(transaction.idHash, 'idHash');
  assertHash(transaction.stateHash, 'stateHash');
  assertNonEmptyBuffer(transaction.pkceVerifierEnc, 'pkceVerifierEnc');
  if (transaction.consumedAt) {
    if (transaction.consumedAt < transaction.createdAt
        || transaction.consumedAt.getTime() - transaction.createdAt.getTime() > 10 * 60 * 1000
        || transaction.expiresAt < transaction.consumedAt
        || transaction.expiresAt.getTime() - transaction.consumedAt.getTime()
          > CONSUMED_TRANSACTION_COMPLETION_LEASE_MS) {
      throw new ConsoleStoreValidationError('consumed login transaction has an invalid completion lease');
    }
  } else if (transaction.expiresAt <= transaction.createdAt
      || transaction.expiresAt.getTime() - transaction.createdAt.getTime() > 10 * 60 * 1000) {
    throw new ConsoleStoreValidationError('login transaction must expire within 10 minutes');
  }
  if (transaction.returnTo !== null
      && (!transaction.returnTo.startsWith('/')
        || transaction.returnTo.startsWith('//')
        || transaction.returnTo.includes('\\'))) {
    throw new ConsoleStoreValidationError('returnTo must be a relative application path');
  }
  if (transaction.integrationDescriptorId) {
    assertUuid(transaction.integrationDescriptorId, 'integrationDescriptorId');
    if (!/^[a-f0-9]{64}$/.test(transaction.integrationDescriptorFingerprint ?? '')) {
      throw new ConsoleStoreValidationError(
        'integrationDescriptorFingerprint must be a lowercase 256-bit hex fingerprint for descriptor-bound transactions',
      );
    }
  } else if (transaction.integrationDescriptorFingerprint) {
    throw new ConsoleStoreValidationError(
      'integrationDescriptorFingerprint requires integrationDescriptorId',
    );
  }

  if (transaction.flowKind === 'login') {
    if (transaction.userId || transaction.consoleSessionIdHash || transaction.requestedCapability
        || transaction.integrationDescriptorId || transaction.integrationDescriptorFingerprint) {
      throw new ConsoleStoreValidationError('login transaction cannot be bound to an existing principal or session');
    }
    return;
  }

  if (!transaction.userId || !transaction.consoleSessionIdHash) {
    throw new ConsoleStoreValidationError(`${transaction.flowKind} transaction requires principal and session binding`);
  }
  assertUuid(transaction.userId, 'userId');
  assertHash(transaction.consoleSessionIdHash, 'consoleSessionIdHash');
  if (transaction.flowKind === 'step_up') {
    if (!transaction.requestedCapability || transaction.requestedCapability === 'console:self') {
      throw new ConsoleStoreValidationError('step_up transaction requires an administrative capability');
    }
    assertCapability(transaction.requestedCapability, 'requestedCapability');
  } else if (transaction.requestedCapability) {
    throw new ConsoleStoreValidationError('integration_link transaction cannot request an administrative capability');
  }
}

export function cloneLoginTransaction(transaction: ConsoleLoginTransaction): ConsoleLoginTransaction {
  return {
    ...transaction,
    idHash: cloneBuffer(transaction.idHash),
    stateHash: cloneBuffer(transaction.stateHash),
    pkceVerifierEnc: cloneBuffer(transaction.pkceVerifierEnc),
    consoleSessionIdHash: transaction.consoleSessionIdHash
      ? cloneBuffer(transaction.consoleSessionIdHash)
      : null,
    createdAt: new Date(transaction.createdAt),
    expiresAt: new Date(transaction.expiresAt),
    consumedAt: cloneDate(transaction.consumedAt),
  };
}
