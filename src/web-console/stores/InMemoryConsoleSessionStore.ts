import {
  ConsoleStoreConflictError,
  assertHash,
  assertUuid,
  hashKey,
} from './ConsoleStoreValidation.js';
import type {
  ConsoleSessionElevation,
  ConsoleSessionRecord,
  ConsoleSessionTouch,
  IConsoleSessionStore,
} from './IConsoleSessionStore.js';
import type { ConsoleCapability } from '../platform/ConsolePlatformTypes.js';
import {
  cloneConsoleSession,
  validateConsoleSessionRecord,
  validateSessionElevation,
} from './IConsoleSessionStore.js';

export class InMemoryConsoleSessionStore implements IConsoleSessionStore {
  private readonly sessions = new Map<string, ConsoleSessionRecord>();

  async create(record: ConsoleSessionRecord): Promise<void> {
    await Promise.resolve();
    validateConsoleSessionRecord(record);
    const key = hashKey(record.idHash);
    if (this.sessions.has(key)) {
      throw new ConsoleStoreConflictError('console session id hash already exists');
    }
    this.sessions.set(key, cloneConsoleSession(record));
  }

  async findActiveByIdHash(idHash: Buffer, at: Date = new Date()): Promise<ConsoleSessionRecord | null> {
    await Promise.resolve();
    assertHash(idHash, 'idHash');
    const record = this.sessions.get(hashKey(idHash));
    if (!record || !isActive(record, at)) {
      return null;
    }
    return cloneConsoleSession(record);
  }

  async touch(idHash: Buffer, touch: ConsoleSessionTouch, at: Date = new Date()): Promise<boolean> {
    const record = await this.findActiveByIdHash(idHash, at);
    if (!record || touch.lastUsedAt < record.lastUsedAt
        || touch.idleExpiresAt <= touch.lastUsedAt
        || touch.idleExpiresAt > record.absoluteExpiresAt) {
      return false;
    }
    this.sessions.set(hashKey(idHash), cloneConsoleSession({
      ...record,
      lastUsedAt: touch.lastUsedAt,
      idleExpiresAt: touch.idleExpiresAt,
      lastIp: touch.lastIp === undefined ? record.lastIp : touch.lastIp,
    }));
    return true;
  }

  async setElevation(
    idHash: Buffer,
    elevation: ConsoleSessionElevation,
    at: Date = new Date(),
  ): Promise<boolean> {
    const record = await this.findActiveByIdHash(idHash, at);
    if (!record) return false;
    if (record.elevation && record.elevation.expiresAt > at) return false;
    if (elevation.authTime > at) return false;
    const grantedCapabilities = [
      ...new Set<ConsoleCapability>(['console:self', ...elevation.capabilities]),
    ];
    if (elevation.expiresAt > record.absoluteExpiresAt) return false;
    validateSessionElevation(elevation, grantedCapabilities, record.createdAt);
    const updated = { ...record, grantedCapabilities, elevation };
    validateConsoleSessionRecord(updated);
    this.sessions.set(hashKey(idHash), cloneConsoleSession(updated));
    return true;
  }

  async clearElevation(idHash: Buffer, at: Date = new Date()): Promise<boolean> {
    const record = await this.findActiveByIdHash(idHash, at);
    if (!record?.elevation) return false;
    const updated = {
      ...record,
      grantedCapabilities: record.grantedCapabilities.filter(capability => capability === 'console:self'),
      elevation: null,
    };
    validateConsoleSessionRecord(updated);
    this.sessions.set(hashKey(idHash), cloneConsoleSession(updated));
    return true;
  }

  async revoke(idHash: Buffer, revokedAt: Date = new Date()): Promise<boolean> {
    await Promise.resolve();
    assertHash(idHash, 'idHash');
    const key = hashKey(idHash);
    const record = this.sessions.get(key);
    if (!record || record.revokedAt) return false;
    this.sessions.set(key, cloneConsoleSession({ ...record, revokedAt }));
    return true;
  }

  async revokeForUser(userId: string, revokedAt: Date = new Date()): Promise<number> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    let revoked = 0;
    for (const [key, record] of this.sessions) {
      if (record.userId === userId && !record.revokedAt) {
        this.sessions.set(key, cloneConsoleSession({ ...record, revokedAt }));
        revoked += 1;
      }
    }
    return revoked;
  }

  async sweepExpired(before: Date = new Date()): Promise<number> {
    await Promise.resolve();
    let deleted = 0;
    for (const [key, record] of this.sessions) {
      if (record.absoluteExpiresAt <= before) {
        this.sessions.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}

function isActive(record: ConsoleSessionRecord, at: Date): boolean {
  return !record.revokedAt && record.idleExpiresAt > at && record.absoluteExpiresAt > at;
}
