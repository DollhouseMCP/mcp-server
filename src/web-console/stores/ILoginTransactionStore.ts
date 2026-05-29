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

export interface ConsoleLoginTransaction {
  readonly idHash: Buffer;
  readonly flowKind: ConsoleLoginFlowKind;
  readonly stateHash: Buffer;
  readonly pkceVerifierEnc: Buffer;
  readonly userId: string | null;
  readonly consoleSessionIdHash: Buffer | null;
  readonly requestedCapability: ConsoleCapability | null;
  readonly returnTo: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface ILoginTransactionStore {
  create(transaction: ConsoleLoginTransaction): Promise<void>;
  findByIdHash(idHash: Buffer): Promise<ConsoleLoginTransaction | null>;
  consume(idHash: Buffer, stateHash: Buffer, consumedAt?: Date): Promise<ConsoleLoginTransaction | null>;
  sweepExpired(before?: Date): Promise<number>;
}

export function validateLoginTransaction(transaction: ConsoleLoginTransaction): void {
  assertHash(transaction.idHash, 'idHash');
  assertHash(transaction.stateHash, 'stateHash');
  assertNonEmptyBuffer(transaction.pkceVerifierEnc, 'pkceVerifierEnc');
  if (transaction.expiresAt <= transaction.createdAt
      || transaction.expiresAt.getTime() - transaction.createdAt.getTime() > 10 * 60 * 1000) {
    throw new ConsoleStoreValidationError('login transaction must expire within 10 minutes');
  }
  if (transaction.returnTo !== null
      && (!transaction.returnTo.startsWith('/')
        || transaction.returnTo.startsWith('//')
        || transaction.returnTo.includes('\\'))) {
    throw new ConsoleStoreValidationError('returnTo must be a relative application path');
  }

  if (transaction.flowKind === 'login') {
    if (transaction.userId || transaction.consoleSessionIdHash || transaction.requestedCapability) {
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
    createdAt: new Date(transaction.createdAt.getTime()),
    expiresAt: new Date(transaction.expiresAt.getTime()),
    consumedAt: cloneDate(transaction.consumedAt),
  };
}
