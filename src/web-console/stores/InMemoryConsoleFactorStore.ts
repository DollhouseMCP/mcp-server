import {
  ConsoleStoreConflictError,
  assertHash,
  assertUuid,
  buffersEqual,
  cloneBuffer,
} from './ConsoleStoreValidation.js';
import { InMemoryTransactionGate } from '../../utils/InMemoryTransactionGate.js';
import type {
  ConsoleFactorStatus,
  ConsoleTotpFactorRecord,
  IConsoleFactorStore,
} from './IConsoleFactorStore.js';

const TOTP_REPLAY_STEP_MS = 30_000;
import {
  cloneFactorStatus,
  cloneTotpFactorRecord,
  validateBackupCodeHashes,
  validateTotpFactorRecord,
} from './IConsoleFactorStore.js';

interface BackupCodeRecord {
  readonly factorId: string;
  readonly codeHash: Buffer;
  readonly createdAt: Date;
  readonly usedAt: Date | null;
}

export class InMemoryConsoleFactorStore implements IConsoleFactorStore {
  private readonly factors = new Map<string, ConsoleTotpFactorRecord>();
  private readonly backupCodes = new Map<string, BackupCodeRecord[]>();
  private transactionGate: InMemoryTransactionGate | null = null;

  attachTransactionGate(gate: InMemoryTransactionGate): InMemoryTransactionGate {
    this.transactionGate ??= gate;
    return this.transactionGate;
  }

  createTransactionSnapshot(): unknown {
    return {
      factors: [...this.factors.entries()].map(([id, factor]) => [id, cloneTotpFactorRecord(factor)] as const),
      backupCodes: [...this.backupCodes.entries()].map(([id, codes]) => [
        id,
        codes.map(cloneBackupCodeRecord),
      ] as const),
    };
  }

  restoreTransactionSnapshot(snapshot: unknown): void {
    const state = snapshot as {
      factors: readonly (readonly [string, ConsoleTotpFactorRecord])[];
      backupCodes: readonly (readonly [string, readonly BackupCodeRecord[]])[];
    };
    this.factors.clear();
    this.backupCodes.clear();
    for (const [id, factor] of state.factors) this.factors.set(id, cloneTotpFactorRecord(factor));
    for (const [id, codes] of state.backupCodes) this.backupCodes.set(id, codes.map(cloneBackupCodeRecord));
  }

  async createTotpFactor(record: ConsoleTotpFactorRecord, backupCodeHashes: readonly Buffer[]): Promise<void> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validateTotpFactorRecord(record);
      validateBackupCodeHashes(backupCodeHashes);
      if (this.factors.has(record.factorId)) {
        throw new ConsoleStoreConflictError('console factor id already exists');
      }
      if (!record.disabledAt && this.findActiveTotp(record.userId)) {
        throw new ConsoleStoreConflictError('active TOTP factor already exists for user');
      }
      this.factors.set(record.factorId, cloneTotpFactorRecord(record));
      this.backupCodes.set(record.factorId, backupCodeHashes.map(codeHash => ({
        factorId: record.factorId,
        codeHash: cloneBuffer(codeHash),
        createdAt: new Date(record.enrolledAt),
        usedAt: null,
      })));
    });
  }

  async getTotpStatus(userId: string): Promise<ConsoleFactorStatus> {
    return this.runRead(async () => {
      await Promise.resolve();
      assertUuid(userId, 'userId');
      const active = this.findActiveTotp(userId);
      if (active) {
        return cloneFactorStatus({
          enrolled: true,
          factorType: 'totp',
          enrolledAt: active.enrolledAt,
          disabledAt: null,
          lastUsedAt: active.lastUsedAt,
          backupCodesRemaining: this.countUnusedBackupCodes(active.factorId),
        });
      }
      const disabled = this.findLatestDisabledTotp(userId);
      if (!disabled) {
        return cloneFactorStatus({
          enrolled: false,
          factorType: null,
          enrolledAt: null,
          disabledAt: null,
          lastUsedAt: null,
          backupCodesRemaining: 0,
        });
      }
      return cloneFactorStatus({
        enrolled: false,
        factorType: 'totp',
        enrolledAt: disabled.enrolledAt,
        disabledAt: disabled.disabledAt,
        lastUsedAt: disabled.lastUsedAt,
        backupCodesRemaining: 0,
      });
    });
  }

  async getActiveTotpFactorForAs(userId: string): Promise<ConsoleTotpFactorRecord | null> {
    return this.runRead(async () => {
      await Promise.resolve();
      assertUuid(userId, 'userId');
      const active = this.findActiveTotp(userId);
      return active ? cloneTotpFactorRecord(active) : null;
    });
  }

  async markTotpUsed(userId: string, factorId: string, usedAt: Date = new Date()): Promise<boolean> {
    return this.runMutation(async () => {
      await Promise.resolve();
      assertUuid(userId, 'userId');
      assertUuid(factorId, 'factorId');
      const factor = this.factors.get(factorId);
      const stepStart = new Date(Math.floor(usedAt.getTime() / TOTP_REPLAY_STEP_MS) * TOTP_REPLAY_STEP_MS);
      if (factor?.userId !== userId || factor.disabledAt || usedAt < factor.enrolledAt
        || (factor.lastUsedAt !== null && factor.lastUsedAt >= stepStart)) return false;
      this.factors.set(factorId, cloneTotpFactorRecord({ ...factor, lastUsedAt: usedAt }));
      return true;
    });
  }

  async consumeBackupCode(
    userId: string,
    factorId: string,
    codeHash: Buffer,
    usedAt: Date = new Date(),
  ): Promise<boolean> {
    return this.runMutation(async () => {
      await Promise.resolve();
      assertUuid(userId, 'userId');
      assertUuid(factorId, 'factorId');
      assertHash(codeHash, 'codeHash');
      const factor = this.factors.get(factorId);
      if (factor?.userId !== userId || factor.disabledAt || usedAt < factor.enrolledAt) return false;
      const codes = this.backupCodes.get(factorId) ?? [];
      const index = codes.findIndex(code => !code.usedAt && buffersEqual(code.codeHash, codeHash));
      if (index < 0) return false;
      const updated = [...codes];
      updated[index] = {
        ...updated[index],
        usedAt,
      };
      this.backupCodes.set(factorId, updated);
      return true;
    });
  }

  async disableActiveTotpWithBackupCode(
    userId: string,
    factorId: string,
    codeHash: Buffer,
    disabledAt: Date = new Date(),
  ): Promise<boolean> {
    return this.runMutation(async () => {
      await Promise.resolve();
      assertUuid(userId, 'userId');
      assertUuid(factorId, 'factorId');
      assertHash(codeHash, 'codeHash');
      const factor = this.factors.get(factorId);
      if (factor?.userId !== userId || factor.disabledAt || disabledAt < factor.enrolledAt) return false;
      const codes = this.backupCodes.get(factorId) ?? [];
      const index = codes.findIndex(code => !code.usedAt && code.createdAt <= disabledAt
        && buffersEqual(code.codeHash, codeHash));
      if (index < 0) return false;
      const updatedCodes = [...codes];
      updatedCodes[index] = { ...updatedCodes[index], usedAt: disabledAt };
      this.backupCodes.set(factorId, updatedCodes);
      this.factors.set(factorId, cloneTotpFactorRecord({ ...factor, disabledAt }));
      return true;
    });
  }

  async disableActiveTotp(userId: string, disabledAt: Date = new Date()): Promise<boolean> {
    return this.runMutation(async () => {
      await Promise.resolve();
      assertUuid(userId, 'userId');
      const active = this.findActiveTotp(userId);
      if (!active || disabledAt < active.enrolledAt) return false;
      this.factors.set(active.factorId, cloneTotpFactorRecord({ ...active, disabledAt }));
      return true;
    });
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate?.runMutation(operation) ?? operation();
  }

  private runRead<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate?.runRead(operation) ?? operation();
  }

  private findActiveTotp(userId: string): ConsoleTotpFactorRecord | null {
    for (const factor of this.factors.values()) {
      if (factor.userId === userId && !factor.disabledAt) {
        return factor;
      }
    }
    return null;
  }

  private findLatestDisabledTotp(userId: string): ConsoleTotpFactorRecord | null {
    let latest: ConsoleTotpFactorRecord | null = null;
    for (const factor of this.factors.values()) {
      if (factor.userId !== userId || !factor.disabledAt) continue;
      if (!latest?.disabledAt || factor.disabledAt > latest.disabledAt) {
        latest = factor;
      }
    }
    return latest;
  }

  private countUnusedBackupCodes(factorId: string): number {
    return (this.backupCodes.get(factorId) ?? []).filter(code => !code.usedAt).length;
  }
}

function cloneBackupCodeRecord(record: BackupCodeRecord): BackupCodeRecord {
  return {
    ...record,
    codeHash: cloneBuffer(record.codeHash),
    createdAt: new Date(record.createdAt),
    usedAt: record.usedAt ? new Date(record.usedAt) : null,
  };
}
