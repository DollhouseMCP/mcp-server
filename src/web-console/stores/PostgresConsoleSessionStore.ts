import { and, eq, gt, gte, isNull, lte, or } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { consoleSessions } from '../../database/schema/index.js';
import type {
  ConsoleSessionElevation,
  ConsoleSessionRecord,
  ConsoleSessionTouch,
  IConsoleSessionStore,
} from './IConsoleSessionStore.js';
import {
  cloneConsoleSession,
  validateConsoleSessionRecord,
  validateSessionElevation,
} from './IConsoleSessionStore.js';
import {
  ConsoleStoreConflictError,
  assertHash,
  assertUuid,
  isUniqueViolation,
} from './ConsoleStoreValidation.js';
import type { ConsoleCapability } from '../platform/ConsolePlatformTypes.js';

export class PostgresConsoleSessionStore implements IConsoleSessionStore {
  constructor(private readonly db: DatabaseInstance) {}

  async create(record: ConsoleSessionRecord): Promise<void> {
    validateConsoleSessionRecord(record);
    try {
      await withSystemContext(this.db, tx => tx.insert(consoleSessions).values(toRow(record)));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConsoleStoreConflictError('console session id hash already exists');
      }
      throw error;
    }
  }

  async findActiveByIdHash(idHash: Buffer, at: Date = new Date()): Promise<ConsoleSessionRecord | null> {
    assertHash(idHash, 'idHash');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(consoleSessions).where(and(
        eq(consoleSessions.idHash, idHash),
        isNull(consoleSessions.revokedAt),
        gt(consoleSessions.idleExpiresAt, at),
        gt(consoleSessions.absoluteExpiresAt, at),
      )).limit(1),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async touch(idHash: Buffer, touch: ConsoleSessionTouch, at: Date = new Date()): Promise<boolean> {
    assertHash(idHash, 'idHash');
    if (touch.idleExpiresAt <= touch.lastUsedAt) return false;
    const rows = await withSystemContext(this.db, tx =>
      tx.update(consoleSessions).set({
        lastUsedAt: touch.lastUsedAt,
        idleExpiresAt: touch.idleExpiresAt,
        ...(touch.lastIp === undefined ? {} : { lastIp: touch.lastIp }),
      }).where(and(
        eq(consoleSessions.idHash, idHash),
        isNull(consoleSessions.revokedAt),
        gt(consoleSessions.idleExpiresAt, at),
        gte(consoleSessions.absoluteExpiresAt, touch.idleExpiresAt),
        lte(consoleSessions.lastUsedAt, touch.lastUsedAt),
      )).returning({ idHash: consoleSessions.idHash }),
    );
    return rows.length === 1;
  }

  async setElevation(
    idHash: Buffer,
    elevation: ConsoleSessionElevation,
    at: Date = new Date(),
  ): Promise<boolean> {
    assertHash(idHash, 'idHash');
    const grantedCapabilities = [
      ...new Set<ConsoleCapability>(['console:self', ...elevation.capabilities]),
    ];
    if (elevation.authTime > at) return false;
    validateSessionElevation(elevation, grantedCapabilities, new Date(0));
    const rows = await withSystemContext(this.db, tx =>
      tx.update(consoleSessions).set({
        grantedCapabilities,
        elevatedCapabilities: [...elevation.capabilities],
        elevationExpiresAt: elevation.expiresAt,
        elevationAcr: elevation.acr,
        elevationAmr: [...elevation.amr],
        elevationAuthTime: elevation.authTime,
      }).where(and(
        eq(consoleSessions.idHash, idHash),
        isNull(consoleSessions.revokedAt),
        gt(consoleSessions.idleExpiresAt, at),
        gt(consoleSessions.absoluteExpiresAt, at),
        gte(consoleSessions.absoluteExpiresAt, elevation.expiresAt),
        lte(consoleSessions.createdAt, elevation.authTime),
        or(isNull(consoleSessions.elevationExpiresAt), lte(consoleSessions.elevationExpiresAt, at)),
      )).returning({ idHash: consoleSessions.idHash }),
    );
    return rows.length === 1;
  }

  async clearElevation(idHash: Buffer, at: Date = new Date()): Promise<boolean> {
    assertHash(idHash, 'idHash');
    const rows = await withSystemContext(this.db, tx =>
      tx.update(consoleSessions).set({
        grantedCapabilities: ['console:self'],
        elevatedCapabilities: [],
        elevationExpiresAt: null,
        elevationAcr: null,
        elevationAmr: null,
        elevationAuthTime: null,
      }).where(and(
        eq(consoleSessions.idHash, idHash),
        isNull(consoleSessions.revokedAt),
        gt(consoleSessions.idleExpiresAt, at),
        gt(consoleSessions.absoluteExpiresAt, at),
        gt(consoleSessions.elevationExpiresAt, at),
      )).returning({ idHash: consoleSessions.idHash }),
    );
    return rows.length === 1;
  }

  async revoke(idHash: Buffer, revokedAt: Date = new Date()): Promise<boolean> {
    assertHash(idHash, 'idHash');
    const rows = await withSystemContext(this.db, tx =>
      tx.update(consoleSessions).set({ revokedAt }).where(and(
        eq(consoleSessions.idHash, idHash),
        isNull(consoleSessions.revokedAt),
      )).returning({ idHash: consoleSessions.idHash }),
    );
    return rows.length === 1;
  }

  async revokeForUser(userId: string, revokedAt: Date = new Date()): Promise<number> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.update(consoleSessions).set({ revokedAt }).where(and(
        eq(consoleSessions.userId, userId),
        isNull(consoleSessions.revokedAt),
      )).returning({ idHash: consoleSessions.idHash }),
    );
    return rows.length;
  }

  async sweepExpired(before: Date = new Date()): Promise<number> {
    const rows = await withSystemContext(this.db, tx =>
      tx.delete(consoleSessions).where(lte(consoleSessions.absoluteExpiresAt, before))
        .returning({ idHash: consoleSessions.idHash }),
    );
    return rows.length;
  }
}

function toRow(record: ConsoleSessionRecord): typeof consoleSessions.$inferInsert {
  return {
    idHash: record.idHash,
    userId: record.userId,
    authSub: record.authSub,
    csrfTokenHash: record.csrfTokenHash,
    grantedCapabilities: [...record.grantedCapabilities],
    elevatedCapabilities: record.elevation ? [...record.elevation.capabilities] : [],
    elevationExpiresAt: record.elevation?.expiresAt ?? null,
    elevationAcr: record.elevation?.acr ?? null,
    elevationAmr: record.elevation ? [...record.elevation.amr] : null,
    elevationAuthTime: record.elevation?.authTime ?? null,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    idleExpiresAt: record.idleExpiresAt,
    absoluteExpiresAt: record.absoluteExpiresAt,
    revokedAt: record.revokedAt,
    lastIp: record.lastIp,
    userAgent: record.userAgent,
  };
}

function fromRow(row: typeof consoleSessions.$inferSelect): ConsoleSessionRecord {
  const elevated = row.elevatedCapabilities as ConsoleCapability[];
  const record: ConsoleSessionRecord = {
    idHash: row.idHash,
    userId: row.userId,
    authSub: row.authSub,
    csrfTokenHash: row.csrfTokenHash,
    grantedCapabilities: row.grantedCapabilities as ConsoleCapability[],
    elevation: elevated.length > 0 && row.elevationExpiresAt && row.elevationAcr
      && row.elevationAmr && row.elevationAuthTime ? {
        capabilities: elevated,
        expiresAt: row.elevationExpiresAt,
        acr: row.elevationAcr,
        amr: row.elevationAmr,
        authTime: row.elevationAuthTime,
      } : null,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    idleExpiresAt: row.idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    revokedAt: row.revokedAt,
    lastIp: row.lastIp,
    userAgent: row.userAgent,
  };
  validateConsoleSessionRecord(record);
  return cloneConsoleSession(record);
}
