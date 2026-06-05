import type { ConsoleCapability } from '../platform/ConsolePlatformTypes.js';
import {
  ConsoleStoreValidationError,
  assertCapability,
  assertHash,
  assertUuid,
  cloneBuffer,
  cloneDate,
} from './ConsoleStoreValidation.js';

export interface ConsoleSessionElevation {
  readonly capabilities: readonly ConsoleCapability[];
  readonly expiresAt: Date;
  readonly acr: string;
  readonly amr: readonly string[];
  readonly authTime: Date;
}

export interface ConsoleSessionRecord {
  readonly idHash: Buffer;
  readonly userId: string;
  readonly authSub: string;
  readonly csrfTokenHash: Buffer;
  readonly grantedCapabilities: readonly ConsoleCapability[];
  readonly elevation: ConsoleSessionElevation | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
  readonly lastIp: string | null;
  readonly userAgent: string | null;
}

export interface ConsoleSessionTouch {
  readonly lastUsedAt: Date;
  readonly idleExpiresAt: Date;
  readonly lastIp?: string | null;
}

export interface IConsoleSessionStore {
  create(record: ConsoleSessionRecord): Promise<void>;
  findActiveByIdHash(idHash: Buffer, at?: Date): Promise<ConsoleSessionRecord | null>;
  /**
   * Lists active browser console sessions for a single owner. Callers must
   * treat the returned page as bounded by `limit`, not as an exhaustive audit.
   */
  listActiveForUser(userId: string, at?: Date, limit?: number): Promise<ConsoleSessionRecord[]>;
  touch(idHash: Buffer, touch: ConsoleSessionTouch, at?: Date): Promise<boolean>;
  setElevation(idHash: Buffer, elevation: ConsoleSessionElevation, at?: Date): Promise<boolean>;
  clearElevation(idHash: Buffer, at?: Date): Promise<boolean>;
  /**
   * Clears active administrative elevations for every live browser console
   * session owned by `userId`. Security invalidation processors use this for
   * factor and elevation revocation fan-out.
   */
  clearElevationsForUser(userId: string, at?: Date): Promise<number>;
  /**
   * Revokes a session by hash after the caller has already selected the
   * correct authority/ownership context. Admin and logout flows use this.
   */
  revoke(idHash: Buffer, revokedAt?: Date): Promise<boolean>;
  /**
   * Revokes a browser session only when the hash belongs to `userId`.
   * Self-service routes use this composite predicate for defense in depth.
   */
  revokeForUserSession(userId: string, idHash: Buffer, revokedAt?: Date): Promise<boolean>;
  /**
   * Revokes every browser console session for a user. Incident/admin flows use
   * this when the current browser session must not be preserved.
   */
  revokeForUser(userId: string, revokedAt?: Date): Promise<number>;
  /**
   * Revokes every browser console session for a user except one server-derived
   * session hash. Self-service "log out other sessions" uses this.
   */
  revokeForUserExcept(userId: string, exceptIdHash: Buffer, revokedAt?: Date): Promise<number>;
  sweepExpired(before?: Date): Promise<number>;
}

export function validateConsoleSessionRecord(record: ConsoleSessionRecord): void {
  assertHash(record.idHash, 'idHash');
  assertHash(record.csrfTokenHash, 'csrfTokenHash');
  assertUuid(record.userId, 'userId');
  if (record.authSub.trim() === '') {
    throw new ConsoleStoreValidationError('authSub must not be empty');
  }
  validateCapabilities(record.grantedCapabilities, 'grantedCapabilities');
  if (!record.grantedCapabilities.includes('console:self')) {
    throw new ConsoleStoreValidationError('grantedCapabilities must include console:self');
  }
  if (record.createdAt > record.lastUsedAt
      || record.lastUsedAt > record.idleExpiresAt
      || record.idleExpiresAt > record.absoluteExpiresAt) {
    throw new ConsoleStoreValidationError('session lifecycle timestamps are inconsistent');
  }

  const adminGrants = record.grantedCapabilities.filter(capability => capability !== 'console:self');
  if (record.elevation) {
    validateSessionElevation(record.elevation, record.grantedCapabilities, record.createdAt);
    if (record.elevation.expiresAt > record.absoluteExpiresAt) {
      throw new ConsoleStoreValidationError('elevation cannot outlive its console session');
    }
  } else if (adminGrants.length > 0) {
    throw new ConsoleStoreValidationError('admin capabilities require an elevation record');
  }
}

export function validateSessionElevation(
  elevation: ConsoleSessionElevation,
  grantedCapabilities: readonly ConsoleCapability[],
  after: Date,
): void {
  if (elevation.capabilities.length === 0) {
    throw new ConsoleStoreValidationError('elevation must contain an administrative capability');
  }
  validateCapabilities(elevation.capabilities, 'elevation.capabilities');
  for (const capability of elevation.capabilities) {
    if (capability === 'console:self' || !grantedCapabilities.includes(capability)) {
      throw new ConsoleStoreValidationError('elevated capabilities must be granted administrative capabilities');
    }
  }
  if (elevation.acr.trim() === '' || !elevation.amr.includes('otp')) {
    throw new ConsoleStoreValidationError('v1 elevation must include ACR and otp AMR');
  }
  if (elevation.authTime < after || elevation.expiresAt <= elevation.authTime) {
    throw new ConsoleStoreValidationError('elevation timestamps are inconsistent');
  }
}

export function cloneConsoleSession(record: ConsoleSessionRecord): ConsoleSessionRecord {
  return {
    ...record,
    idHash: cloneBuffer(record.idHash),
    csrfTokenHash: cloneBuffer(record.csrfTokenHash),
    grantedCapabilities: [...record.grantedCapabilities],
    elevation: record.elevation ? {
      ...record.elevation,
      capabilities: [...record.elevation.capabilities],
      expiresAt: new Date(record.elevation.expiresAt),
      authTime: new Date(record.elevation.authTime),
      amr: [...record.elevation.amr],
    } : null,
    createdAt: new Date(record.createdAt),
    lastUsedAt: new Date(record.lastUsedAt),
    idleExpiresAt: new Date(record.idleExpiresAt),
    absoluteExpiresAt: new Date(record.absoluteExpiresAt),
    revokedAt: cloneDate(record.revokedAt),
  };
}

function validateCapabilities(capabilities: readonly string[], name: string): void {
  if (new Set(capabilities).size !== capabilities.length) {
    throw new ConsoleStoreValidationError(`${name} must not contain duplicates`);
  }
  capabilities.forEach(capability => assertCapability(capability, name));
}
