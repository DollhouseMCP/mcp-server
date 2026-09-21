import { and, eq, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { getErrorCode, isSerializationFailure, isUniqueViolation, type DrizzleTx } from '../../database/db-utils.js';
import { authKv } from '../../database/schema/auth.js';
import { assertHash } from '../../web-console/stores/ConsoleStoreValidation.js';
import { InvitationError } from '../InvitationTypes.js';
import type { InvitationClaimRecord } from '../IInvitationStore.js';
import type { InvitationManagementAudit } from '../IInvitationManagementStore.js';
import { createInvitationClaimMutation } from '../PostgresInvitationClaimStore.js';
import { copyAudit } from '../InvitationTransactionSupport.js';
import type { OnboardingSessionAuthority } from './IOnboardingSessionAuthority.js';
import {
  ONBOARDING_OWNER_MAX_AGE_SECONDS, ONBOARDING_SCOPE, ONBOARDING_SESSION_TTL_SECONDS,
  restrictedSessionExpiresAt, validateOnboardingOwnerRecord, validateOnboardingSessionRecord,
  type OnboardingClaimAuthority, type OnboardingOwnerRecord, type OnboardingSessionRecord,
} from './OnboardingRecords.js';

// Neither namespace is an oidc-provider model or normal console session store.
export const ONBOARDING_OWNER_MODEL = 'DollhouseOnboardingOwnerV1';
export const ONBOARDING_SESSION_MODEL = 'DollhouseOnboardingSessionV1';

export interface OnboardingSessionReplacement {
  readonly ownerHash: Buffer;
  readonly sessionHash: Buffer;
  readonly csrfTokenHash: Buffer;
  readonly invitationId: string;
  readonly generation: number;
  readonly claimAssertionId: string;
}

export type OnboardingClaimExchange = Omit<InvitationClaimRecord, 'claimOwnerHash'> & {
  /** Server-derived presented session; absence permits owner-only lost-response recovery. */
  readonly expectedSessionHash?: Buffer;
  readonly ownerHash: Buffer;
  readonly sessionHash: Buffer;
  readonly csrfTokenHash: Buffer;
};

export class OnboardingStoreError extends Error {
  constructor(readonly code: 'unavailable' | 'conflict') {
    super(code === 'unavailable' ? 'Onboarding context is unavailable' : 'Onboarding context changed');
    this.name = 'OnboardingStoreError';
  }
}

/**
 * Internal persistence only. Hashes/references come from managed server cookie
 * orchestration, never request JSON. One session slot per owner bounds all KV
 * reads/deletes by primary key; no scans or generic auth-adapter lookups occur.
 */
export class PostgresOnboardingStore implements OnboardingSessionAuthority {
  constructor(private readonly db: DatabaseInstance, private readonly authority: OnboardingClaimAuthority) {}

  async createOwner(ownerHash: Buffer, csrfTokenHash: Buffer): Promise<OnboardingOwnerRecord> {
    const owner = copyHash(ownerHash);
    const csrf = copyHash(csrfTokenHash);
    return withSystemContext(this.db, async tx => {
      const now = await databaseTime(tx);
      const record: OnboardingOwnerRecord = { ownerHash: owner, csrfTokenHash: csrf, createdAt: now,
        refreshedAt: now, expiresAt: new Date(now.getTime() + ONBOARDING_SESSION_TTL_SECONDS * 1000), revokedAt: null };
      const inserted = await tx.insert(authKv).values(row(ONBOARDING_OWNER_MODEL, owner, record))
        .onConflictDoNothing().returning({ id: authKv.id });
      if (inserted.length !== 1) throw new OnboardingStoreError('conflict');
      return record;
    });
  }

  async findOwner(ownerHash: Buffer): Promise<OnboardingOwnerRecord | null> {
    const owner = copyHash(ownerHash);
    return withSystemContext(this.db, async tx => {
      const record = await readOwner(tx, owner);
      const now = await databaseTime(tx);
      return activeOwner(record, now) ? record : null;
    });
  }

  /**
   * Initial exchange and credential-based resume: claim consumption/audit, owner
   * extension, and restricted session replacement all commit or roll back together.
   * Owner cookie must already exist with its original absolute 168-hour horizon.
   */
  async exchangeClaim(input: OnboardingClaimExchange, audit: InvitationManagementAudit): Promise<OnboardingSessionRecord> {
    const ownedAudit = copyAudit(audit);
    const owned = { ...input, ownerHash: copyHash(input.ownerHash), sessionHash: copyHash(input.sessionHash),
      csrfTokenHash: copyHash(input.csrfTokenHash), credentialSecret: Buffer.from(input.credentialSecret),
      expectedSessionHash: input.expectedSessionHash === undefined ? undefined : copyHash(input.expectedSessionHash) };
    try {
      return await withSystemContext(this.db, async tx => {
        // Retain users -> claim -> owner -> session locks through consumption.
        // A rejected presented session must never become an owner-only resume.
        if (owned.expectedSessionHash) {
          const current = await this.lockSession(tx, owned.ownerHash, owned.expectedSessionHash);
          if (!current || current.invitationId !== owned.invitationId || current.generation !== owned.generation) {
            throw new OnboardingStoreError('unavailable');
          }
        }
        const claim = await createInvitationClaimMutation(tx, ownedAudit).beginClaim({
          invitationId: owned.invitationId, generation: owned.generation, credentialSecret: owned.credentialSecret,
          claimOwnerHash: owned.ownerHash, correlationId: owned.correlationId,
        });
        return this.replaceSessionWithTx(tx, { ownerHash: owned.ownerHash, sessionHash: owned.sessionHash,
          csrfTokenHash: owned.csrfTokenHash, invitationId: claim.invitationId,
          generation: claim.generation, claimAssertionId: claim.id }, owned.expectedSessionHash);
      });
    } catch (error) {
      // Normalize only after the composed transaction has rolled back. A caller
      // may explicitly retry; this store never repeats a credential exchange.
      if (isSerializationFailure(error) || isUniqueViolation(error) || getErrorCode(error) === '55P03') {
        throw new InvitationError('concurrent_update', 'Invitation claim transaction conflicted');
      }
      throw error;
    } finally { owned.credentialSecret.fill(0); owned.expectedSessionHash?.fill(0); }
  }

  /** Already-committed claim resume only; initial consumption uses exchangeClaim. */
  async replaceSession(input: OnboardingSessionReplacement): Promise<OnboardingSessionRecord> {
    const owned = { ...input, ownerHash: copyHash(input.ownerHash), sessionHash: copyHash(input.sessionHash),
      csrfTokenHash: copyHash(input.csrfTokenHash) };
    return withSystemContext(this.db, tx => this.replaceSessionWithTx(tx, owned));
  }

  private async replaceSessionWithTx(tx: DrizzleTx, owned: OnboardingSessionReplacement, expectedSessionHash?: Buffer): Promise<OnboardingSessionRecord> {
    // The authority acquires users -> invitation -> claim, before auth KV locks.
    const candidate = await this.authority.lockActivationCandidateWithTx(tx, {
      invitationId: owned.invitationId, generation: owned.generation,
      claimAssertionId: owned.claimAssertionId, claimOwnerHash: owned.ownerHash,
    });
    const owner = await readOwner(tx, owned.ownerHash);
    const previous = await readSession(tx, owned.ownerHash);
    const now = await databaseTime(tx);
    if (!activeOwner(owner, now)) throw new OnboardingStoreError('unavailable');
    if (expectedSessionHash && (!previous || !equal(previous.idHash, expectedSessionHash) ||
        previous.revokedAt !== null || previous.expiresAt <= now)) throw new OnboardingStoreError('unavailable');
    if (previous && previous.expiresAt > now && previous.revokedAt === null &&
        (previous.invitationId !== owned.invitationId || previous.generation !== owned.generation ||
         previous.claimAssertionId !== owned.claimAssertionId)) throw new OnboardingStoreError('conflict');
    if (previous && (equal(previous.idHash, owned.sessionHash) || equal(previous.csrfTokenHash, owned.csrfTokenHash))) {
      throw new OnboardingStoreError('conflict');
    }
    const expiresAt = new Date(Math.min(owner.createdAt.getTime() + ONBOARDING_OWNER_MAX_AGE_SECONDS * 1000,
      Math.max(owner.expiresAt.getTime(), candidate.invitation.currentGeneration.expiresAt.getTime())));
    const refreshedOwner = { ...owner, refreshedAt: now, expiresAt };
    const record: OnboardingSessionRecord = { idHash: owned.sessionHash, ownerHash: owned.ownerHash,
      csrfTokenHash: owned.csrfTokenHash, userId: candidate.invitation.userId,
      invitationId: candidate.invitation.id, generation: candidate.invitation.currentGeneration.generation,
      claimAssertionId: candidate.claim.id, emailVerifiedAt: candidate.claim.emailVerifiedAt,
      scope: ONBOARDING_SCOPE, createdAt: now,
      expiresAt: restrictedSessionExpiresAt(now, expiresAt, candidate.claim.expiresAt, candidate.invitation.currentGeneration.expiresAt),
      revokedAt: null };
    validateOnboardingOwnerRecord(refreshedOwner);
    validateOnboardingSessionRecord(record);
    await tx.update(authKv).set(rowData(refreshedOwner)).where(key(ONBOARDING_OWNER_MODEL, owned.ownerHash));
    await tx.insert(authKv).values(row(ONBOARDING_SESSION_MODEL, owned.ownerHash, record))
      .onConflictDoUpdate({ target: [authKv.model, authKv.id], set: rowData(record) });
    return record;
  }

  /** Bootstrap after reload: opaque owner cookie + trusted-origin orchestration. */
  async rotateOwnerCsrf(ownerHash: Buffer, csrfTokenHash: Buffer): Promise<OnboardingOwnerRecord> {
    const owner = copyHash(ownerHash);
    const csrf = copyHash(csrfTokenHash);
    return withSystemContext(this.db, async tx => {
      const record = await readOwner(tx, owner);
      if (!activeOwner(record, await databaseTime(tx))) throw new OnboardingStoreError('unavailable');
      if (equal(record.csrfTokenHash, csrf)) throw new OnboardingStoreError('conflict');
      const updated = { ...record, csrfTokenHash: csrf };
      await tx.update(authKv).set(rowData(updated)).where(key(ONBOARDING_OWNER_MODEL, owner));
      return updated;
    });
  }

  /** Bootstrap changes only CSRF; it never extends expiry or rotates the owner. */
  async rotateSessionCsrf(ownerHash: Buffer, sessionHash: Buffer, csrfTokenHash: Buffer): Promise<OnboardingSessionRecord> {
    const owner = copyHash(ownerHash);
    const session = copyHash(sessionHash);
    const csrf = copyHash(csrfTokenHash);
    return withSystemContext(this.db, async tx => {
      const record = await this.lockSession(tx, owner, session);
      if (!record) throw new OnboardingStoreError('unavailable');
      if (equal(record.csrfTokenHash, csrf)) throw new OnboardingStoreError('conflict');
      const updated = { ...record, csrfTokenHash: csrf };
      await tx.update(authKv).set(rowData(updated)).where(key(ONBOARDING_SESSION_MODEL, owner));
      return updated;
    });
  }

  /** Every lookup rechecks current claim/account authority; no auth cache. */
  async findSession(ownerHash: Buffer, sessionHash: Buffer): Promise<OnboardingSessionRecord | null> {
    const owner = copyHash(ownerHash);
    const session = copyHash(sessionHash);
    try {
      return await withSystemContext(this.db, tx => this.lockSession(tx, owner, session));
    } catch (error) {
      if (error instanceof InvitationError) return null;
      throw error; // Database/authority outages fail closed without masking availability errors.
    }
  }

  /**
   * Compose activation in the same transaction as live session validation. Any
   * broader auth resource preflight must precede this call. Locks remain held
   * until the caller commits; this function performs no session/account writes.
   */
  lockSessionWithTx(tx: DrizzleTx, ownerHash: Buffer, sessionHash: Buffer): Promise<OnboardingSessionRecord | null> {
    return this.lockSession(tx, copyHash(ownerHash), copyHash(sessionHash));
  }

  private async lockSession(tx: DrizzleTx, owner: Buffer, session: Buffer): Promise<OnboardingSessionRecord | null> {
    // Unlocked hint resolves server-held references only. Re-read under locks.
    const hint = await readSession(tx, owner, false);
    if (!hint || !equal(hint.idHash, session)) return null;
    const candidate = await this.authority.lockActivationCandidateWithTx(tx, {
      invitationId: hint.invitationId, generation: hint.generation,
      claimAssertionId: hint.claimAssertionId, claimOwnerHash: owner,
    });
    const ownerRecord = await readOwner(tx, owner);
    const record = await readSession(tx, owner);
    const now = await databaseTime(tx);
    if (!activeOwner(ownerRecord, now) || !record || !equal(record.idHash, session) ||
        record.revokedAt !== null || record.createdAt > now || record.expiresAt <= now || record.expiresAt > ownerRecord.expiresAt ||
        record.invitationId !== candidate.invitation.id || record.generation !== candidate.claim.generation ||
        record.claimAssertionId !== candidate.claim.id || record.userId !== candidate.invitation.userId ||
        record.emailVerifiedAt.getTime() !== candidate.claim.emailVerifiedAt.getTime() ||
        record.expiresAt > candidate.claim.expiresAt || record.expiresAt > candidate.invitation.currentGeneration.expiresAt) return null;
    return record;
  }

  /** Does not touch users or claim locks after acquiring the owner lock. */
  async endSession(ownerHash: Buffer, sessionHash: Buffer): Promise<boolean> {
    const owner = copyHash(ownerHash);
    const session = copyHash(sessionHash);
    return withSystemContext(this.db, async tx => {
      await readOwner(tx, owner);
      const record = await readSession(tx, owner);
      if (!record || !equal(record.idHash, session)) return false;
      await tx.delete(authKv).where(key(ONBOARDING_SESSION_MODEL, owner));
      return true;
    });
  }

  /** Explicit loss of resume binding: remove its single session and owner. */
  async endOwner(ownerHash: Buffer): Promise<void> {
    const owner = copyHash(ownerHash);
    await withSystemContext(this.db, async tx => {
      await readOwner(tx, owner);
      await tx.delete(authKv).where(key(ONBOARDING_SESSION_MODEL, owner));
      await tx.delete(authKv).where(key(ONBOARDING_OWNER_MODEL, owner));
    });
  }
}

type RecordValue = OnboardingOwnerRecord | OnboardingSessionRecord;
function key(model: string, owner: Buffer) { return and(eq(authKv.model, model), eq(authKv.id, owner.toString('hex'))); }
function row(model: string, owner: Buffer, record: RecordValue) { return { model, id: owner.toString('hex'), ...rowData(record) }; }
function rowData(record: RecordValue) {
  return { payload: Object.fromEntries(Object.entries(record).map(([name, value]) =>
    [name, Buffer.isBuffer(value) ? value.toString('hex') : value instanceof Date ? value.toISOString() : value])), expiresAt: record.expiresAt };
}
async function readPayload(tx: DrizzleTx, model: string, owner: Buffer, lock = true): Promise<unknown> {
  const query = tx.select().from(authKv).where(key(model, owner)).limit(1);
  const rows = await (lock ? query.for('update') : query);
  const row = rows[0];
  if (!row || !row.expiresAt || !row.payload || typeof row.payload !== 'object' ||
      !('expiresAt' in row.payload) || typeof row.payload.expiresAt !== 'string' ||
      new Date(row.payload.expiresAt).getTime() !== row.expiresAt.getTime()) return null;
  return row.payload;
}
async function readOwner(tx: DrizzleTx, owner: Buffer): Promise<OnboardingOwnerRecord | null> {
  const record = decode(await readPayload(tx, ONBOARDING_OWNER_MODEL, owner)) as OnboardingOwnerRecord | null;
  if (!record) return null;
  try {
    validateOnboardingOwnerRecord(record);
    if (!equal(record.ownerHash, owner) || record.expiresAt.getTime() > record.createdAt.getTime() + ONBOARDING_OWNER_MAX_AGE_SECONDS * 1000) return null;
    return record;
  } catch { return null; }
}
async function readSession(tx: DrizzleTx, owner: Buffer, lock = true): Promise<OnboardingSessionRecord | null> {
  const record = decode(await readPayload(tx, ONBOARDING_SESSION_MODEL, owner, lock)) as OnboardingSessionRecord | null;
  if (!record) return null;
  try {
    validateOnboardingSessionRecord(record);
    return equal(record.ownerHash, owner) ? record : null;
  } catch { return null; }
}
function decode(value: unknown): object | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const hashes = ['ownerHash', 'csrfTokenHash', 'idHash'];
  const dates = ['createdAt', 'refreshedAt', 'expiresAt', 'revokedAt', 'emailVerifiedAt'];
  const output: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(value)) {
    if (hashes.includes(name)) {
      if (typeof field !== 'string' || !/^[a-f0-9]{64}$/.test(field)) return null;
      output[name] = Buffer.from(field, 'hex');
    } else if (dates.includes(name) && field !== null) {
      if (typeof field !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(field)) return null;
      const date = new Date(field);
      if (!Number.isFinite(date.getTime()) || date.toISOString() !== field) return null;
      output[name] = date;
    } else output[name] = field;
  }
  return output;
}
function activeOwner(record: OnboardingOwnerRecord | null, now: Date): record is OnboardingOwnerRecord {
  return record !== null && record.revokedAt === null && record.expiresAt > now && record.createdAt <= now && record.refreshedAt <= now;
}
function equal(left: Buffer, right: Buffer): boolean { return left.length === right.length && timingSafeEqual(left, right); }
function copyHash(value: Buffer): Buffer { assertHash(value, 'onboarding hash'); return Buffer.from(value); }
async function databaseTime(tx: DrizzleTx): Promise<Date> {
  const [row] = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
  return new Date(row.now);
}
