import {
  ConsoleStoreConflictError,
  assertUuid,
} from './ConsoleStoreValidation.js';
import type {
  ConsoleFactorStatus,
  ConsoleTotpFactorRecord,
  IConsoleFactorStore,
} from './IConsoleFactorStore.js';
import {
  cloneFactorStatus,
  cloneTotpFactorRecord,
  validateTotpFactorRecord,
} from './IConsoleFactorStore.js';

export class InMemoryConsoleFactorStore implements IConsoleFactorStore {
  private readonly factors = new Map<string, ConsoleTotpFactorRecord>();

  async createTotpFactor(record: ConsoleTotpFactorRecord): Promise<void> {
    await Promise.resolve();
    validateTotpFactorRecord(record);
    if (this.factors.has(record.factorId)) {
      throw new ConsoleStoreConflictError('console factor id already exists');
    }
    if (!record.disabledAt && this.findActiveTotp(record.userId)) {
      throw new ConsoleStoreConflictError('active TOTP factor already exists for user');
    }
    this.factors.set(record.factorId, cloneTotpFactorRecord(record));
  }

  async getTotpStatus(userId: string): Promise<ConsoleFactorStatus> {
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
      });
    }
    return cloneFactorStatus({
      enrolled: false,
      factorType: 'totp',
      enrolledAt: disabled.enrolledAt,
      disabledAt: disabled.disabledAt,
      lastUsedAt: disabled.lastUsedAt,
    });
  }

  async getActiveTotpFactorForAs(userId: string): Promise<ConsoleTotpFactorRecord | null> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    const active = this.findActiveTotp(userId);
    return active ? cloneTotpFactorRecord(active) : null;
  }

  async markTotpUsed(userId: string, factorId: string, usedAt: Date = new Date()): Promise<boolean> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    assertUuid(factorId, 'factorId');
    const factor = this.factors.get(factorId);
    if (factor?.userId !== userId || factor.disabledAt || usedAt < factor.enrolledAt) return false;
    this.factors.set(factorId, cloneTotpFactorRecord({ ...factor, lastUsedAt: usedAt }));
    return true;
  }

  async disableActiveTotp(userId: string, disabledAt: Date = new Date()): Promise<boolean> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    const active = this.findActiveTotp(userId);
    if (!active || disabledAt < active.enrolledAt) return false;
    this.factors.set(active.factorId, cloneTotpFactorRecord({ ...active, disabledAt }));
    return true;
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
}
