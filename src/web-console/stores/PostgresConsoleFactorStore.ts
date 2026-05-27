import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  lte,
} from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { accountFactors } from '../../database/schema/index.js';
import {
  ConsoleStoreConflictError,
  ConsoleStoreValidationError,
  assertUuid,
  isUniqueViolation,
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

export class PostgresConsoleFactorStore implements IConsoleFactorStore {
  constructor(private readonly db: DatabaseInstance) {}

  async createTotpFactor(record: ConsoleTotpFactorRecord): Promise<void> {
    validateTotpFactorRecord(record);
    try {
      await withSystemContext(this.db, tx => tx.insert(accountFactors).values(toRow(record)));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConsoleStoreConflictError('active TOTP factor already exists for user');
      }
      throw error;
    }
  }

  async getTotpStatus(userId: string): Promise<ConsoleFactorStatus> {
    assertUuid(userId, 'userId');
    const activeRows = await withSystemContext(this.db, tx =>
      tx.select({
        factorType: accountFactors.factorType,
        enrolledAt: accountFactors.enrolledAt,
        disabledAt: accountFactors.disabledAt,
        lastUsedAt: accountFactors.lastUsedAt,
      }).from(accountFactors).where(and(
        eq(accountFactors.userId, userId),
        eq(accountFactors.factorType, 'totp'),
        isNull(accountFactors.disabledAt),
      )).limit(1),
    );
    if (activeRows[0]) {
      return cloneFactorStatus({
        enrolled: true,
        factorType: 'totp',
        enrolledAt: activeRows[0].enrolledAt,
        disabledAt: null,
        lastUsedAt: activeRows[0].lastUsedAt,
      });
    }

    const disabledRows = await withSystemContext(this.db, tx =>
      tx.select({
        factorType: accountFactors.factorType,
        enrolledAt: accountFactors.enrolledAt,
        disabledAt: accountFactors.disabledAt,
        lastUsedAt: accountFactors.lastUsedAt,
      }).from(accountFactors).where(and(
        eq(accountFactors.userId, userId),
        eq(accountFactors.factorType, 'totp'),
        isNotNull(accountFactors.disabledAt),
      )).orderBy(desc(accountFactors.disabledAt)).limit(1),
    );
    if (disabledRows.length === 0) {
      return cloneFactorStatus({
        enrolled: false,
        factorType: null,
        enrolledAt: null,
        disabledAt: null,
        lastUsedAt: null,
      });
    }
    const disabled = disabledRows[0];
    return cloneFactorStatus({
      enrolled: false,
      factorType: 'totp',
      enrolledAt: disabled.enrolledAt,
      disabledAt: disabled.disabledAt,
      lastUsedAt: disabled.lastUsedAt,
    });
  }

  async getActiveTotpFactorForAs(userId: string): Promise<ConsoleTotpFactorRecord | null> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(accountFactors).where(and(
        eq(accountFactors.userId, userId),
        eq(accountFactors.factorType, 'totp'),
        isNull(accountFactors.disabledAt),
      )).limit(1),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async markTotpUsed(userId: string, factorId: string, usedAt: Date = new Date()): Promise<boolean> {
    assertUuid(userId, 'userId');
    assertUuid(factorId, 'factorId');
    const rows = await withSystemContext(this.db, tx =>
      tx.update(accountFactors).set({ lastUsedAt: usedAt }).where(and(
        eq(accountFactors.userId, userId),
        eq(accountFactors.factorId, factorId),
        eq(accountFactors.factorType, 'totp'),
        isNull(accountFactors.disabledAt),
        lte(accountFactors.enrolledAt, usedAt),
      )).returning({ factorId: accountFactors.factorId }),
    );
    return rows.length === 1;
  }

  async disableActiveTotp(userId: string, disabledAt: Date = new Date()): Promise<boolean> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.update(accountFactors).set({ disabledAt }).where(and(
        eq(accountFactors.userId, userId),
        eq(accountFactors.factorType, 'totp'),
        isNull(accountFactors.disabledAt),
        lte(accountFactors.enrolledAt, disabledAt),
      )).returning({ factorId: accountFactors.factorId }),
    );
    return rows.length === 1;
  }
}

function toRow(record: ConsoleTotpFactorRecord): typeof accountFactors.$inferInsert {
  return {
    userId: record.userId,
    factorId: record.factorId,
    factorType: record.factorType,
    secretCiphertext: record.secretCiphertext,
    backupCodeHashes: [...record.backupCodeHashes],
    enrolledAt: record.enrolledAt,
    disabledAt: record.disabledAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function fromRow(row: typeof accountFactors.$inferSelect): ConsoleTotpFactorRecord {
  if (!row.secretCiphertext) {
    throw new ConsoleStoreValidationError('unexpected NULL ciphertext for active TOTP factor row');
  }
  const record: ConsoleTotpFactorRecord = {
    userId: row.userId,
    factorId: row.factorId,
    factorType: row.factorType,
    secretCiphertext: row.secretCiphertext,
    backupCodeHashes: row.backupCodeHashes,
    enrolledAt: row.enrolledAt,
    disabledAt: row.disabledAt,
    lastUsedAt: row.lastUsedAt,
  };
  validateTotpFactorRecord(record);
  return cloneTotpFactorRecord(record);
}
