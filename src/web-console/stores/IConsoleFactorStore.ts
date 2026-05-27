import {
  assertHash,
  assertNonEmptyBuffer,
  assertUuid,
  cloneBuffer,
  cloneDate,
  ConsoleStoreValidationError,
} from './ConsoleStoreValidation.js';

export type ConsoleFactorType = 'totp';

export interface ConsoleTotpFactorRecord {
  readonly userId: string;
  readonly factorId: string;
  readonly factorType: 'totp';
  readonly secretCiphertext: Buffer;
  readonly backupCodeHashes: readonly Buffer[];
  readonly enrolledAt: Date;
  readonly disabledAt: Date | null;
  readonly lastUsedAt: Date | null;
}

export interface ConsoleFactorStatus {
  readonly enrolled: boolean;
  readonly factorType: ConsoleFactorType | null;
  readonly enrolledAt: Date | null;
  readonly disabledAt: Date | null;
  readonly lastUsedAt: Date | null;
}

export interface IConsoleFactorStore {
  createTotpFactor(record: ConsoleTotpFactorRecord): Promise<void>;
  getTotpStatus(userId: string): Promise<ConsoleFactorStatus>;
  getActiveTotpFactorForAs(userId: string): Promise<ConsoleTotpFactorRecord | null>;
  markTotpUsed(userId: string, factorId: string, usedAt?: Date): Promise<boolean>;
  // Callers that disable a factor must also revoke active admin elevations for the principal.
  disableActiveTotp(userId: string, disabledAt?: Date): Promise<boolean>;
}

export function validateTotpFactorRecord(record: ConsoleTotpFactorRecord): void {
  assertUuid(record.userId, 'userId');
  assertUuid(record.factorId, 'factorId');
  assertNonEmptyBuffer(record.secretCiphertext, 'secretCiphertext');
  for (const backupCodeHash of record.backupCodeHashes) {
    assertHash(backupCodeHash, 'backupCodeHash');
  }
  if (record.disabledAt && record.disabledAt < record.enrolledAt) {
    throw new ConsoleStoreValidationError('factor disabledAt cannot precede enrolledAt');
  }
  if (record.lastUsedAt && record.lastUsedAt < record.enrolledAt) {
    throw new ConsoleStoreValidationError('factor lastUsedAt cannot precede enrolledAt');
  }
}

export function cloneTotpFactorRecord(record: ConsoleTotpFactorRecord): ConsoleTotpFactorRecord {
  return {
    userId: record.userId,
    factorId: record.factorId,
    factorType: record.factorType,
    secretCiphertext: cloneBuffer(record.secretCiphertext),
    backupCodeHashes: record.backupCodeHashes.map(cloneBuffer),
    enrolledAt: new Date(record.enrolledAt.getTime()),
    disabledAt: cloneDate(record.disabledAt),
    lastUsedAt: cloneDate(record.lastUsedAt),
  };
}

export function cloneFactorStatus(status: ConsoleFactorStatus): ConsoleFactorStatus {
  return {
    enrolled: status.enrolled,
    factorType: status.factorType,
    enrolledAt: cloneDate(status.enrolledAt),
    disabledAt: cloneDate(status.disabledAt),
    lastUsedAt: cloneDate(status.lastUsedAt),
  };
}
