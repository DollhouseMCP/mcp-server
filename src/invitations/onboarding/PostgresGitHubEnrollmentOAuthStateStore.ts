import { and, eq, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import type { DrizzleTx } from '../../database/db-utils.js';
import { authKv } from '../../database/schema/auth.js';
import { assertHash, assertUuid } from '../../web-console/stores/ConsoleStoreValidation.js';
import { MAX_INVITATION_GENERATION } from '../InvitationToken.js';
import type { OnboardingSessionAuthority } from './IOnboardingSessionAuthority.js';
import {
  GITHUB_ENROLLMENT_PURPOSE, GITHUB_ENROLLMENT_STATE_TTL_SECONDS,
  type GitHubEnrollmentStateRecord, type GitHubEnrollmentStateStore, validateGitHubEnrollmentCallbackUri,
} from './GitHubEnrollmentOAuthState.js';

export const GITHUB_ENROLLMENT_STATE_MODEL = 'DollhouseGithubEnrollmentStateV1';

/** One hash-only OAuth state slot per restricted onboarding owner. */
export class PostgresGitHubEnrollmentOAuthStateStore implements GitHubEnrollmentStateStore {
  constructor(private readonly db: DatabaseInstance, private readonly authority: OnboardingSessionAuthority) {}

  async replace(input: Pick<GitHubEnrollmentStateRecord, 'stateHash' | 'ownerHash' | 'sessionHash' | 'callbackUri'>): Promise<GitHubEnrollmentStateRecord> {
    const owned = copyInput(input);
    return withSystemContext(this.db, async tx => {
      const session = await this.authority.lockSessionWithTx(tx, owned.ownerHash, owned.sessionHash);
      if (!session) throw new Error('GitHub enrollment state is unavailable');
      const now = await databaseTime(tx);
      const expiresAt = new Date(Math.min(now.getTime() + GITHUB_ENROLLMENT_STATE_TTL_SECONDS * 1000, session.expiresAt.getTime()));
      if (expiresAt <= now) throw new Error('GitHub enrollment state is unavailable');
      const record: GitHubEnrollmentStateRecord = {
        ...owned, userId: session.userId, invitationId: session.invitationId, generation: session.generation,
        claimAssertionId: session.claimAssertionId, purpose: GITHUB_ENROLLMENT_PURPOSE, createdAt: now, expiresAt,
      };
      validateRecord(record);
      await tx.insert(authKv).values(row(record)).onConflictDoUpdate({
        target: [authKv.model, authKv.id], set: rowData(record),
      });
      return record;
    });
  }

  async consume(input: Pick<GitHubEnrollmentStateRecord, 'stateHash' | 'ownerHash' | 'sessionHash' | 'callbackUri'>): Promise<GitHubEnrollmentStateRecord | null> {
    const owned = copyInput(input);
    return withSystemContext(this.db, async tx => {
      const session = await this.authority.lockSessionWithTx(tx, owned.ownerHash, owned.sessionHash);
      if (!session) return null;
      const record = await readRecord(tx, owned.ownerHash);
      const now = await databaseTime(tx);
      if (!record || record.expiresAt <= now || record.createdAt > now
          || !equal(record.stateHash, owned.stateHash) || !equal(record.ownerHash, owned.ownerHash)
          || !equal(record.sessionHash, owned.sessionHash) || record.callbackUri !== owned.callbackUri
          || record.userId !== session.userId || record.invitationId !== session.invitationId
          || record.generation !== session.generation || record.claimAssertionId !== session.claimAssertionId) return null;
      await tx.delete(authKv).where(key(owned.ownerHash));
      return record;
    });
  }
}

function copyInput(input: Pick<GitHubEnrollmentStateRecord, 'stateHash' | 'ownerHash' | 'sessionHash' | 'callbackUri'>) {
  assertHash(input.stateHash, 'stateHash');
  assertHash(input.ownerHash, 'ownerHash');
  assertHash(input.sessionHash, 'sessionHash');
  return { stateHash: Buffer.from(input.stateHash), ownerHash: Buffer.from(input.ownerHash),
    sessionHash: Buffer.from(input.sessionHash), callbackUri: validateGitHubEnrollmentCallbackUri(input.callbackUri) };
}

function key(ownerHash: Buffer) {
  return and(eq(authKv.model, GITHUB_ENROLLMENT_STATE_MODEL), eq(authKv.id, ownerHash.toString('hex')));
}

function row(record: GitHubEnrollmentStateRecord) {
  return { model: GITHUB_ENROLLMENT_STATE_MODEL, id: record.ownerHash.toString('hex'), ...rowData(record) };
}

function rowData(record: GitHubEnrollmentStateRecord) {
  return { payload: {
    stateHash: record.stateHash.toString('hex'), ownerHash: record.ownerHash.toString('hex'),
    sessionHash: record.sessionHash.toString('hex'), userId: record.userId, invitationId: record.invitationId,
    generation: record.generation, claimAssertionId: record.claimAssertionId, purpose: record.purpose,
    callbackUri: record.callbackUri, createdAt: record.createdAt.toISOString(), expiresAt: record.expiresAt.toISOString(),
  }, expiresAt: record.expiresAt };
}

async function readRecord(tx: DrizzleTx, ownerHash: Buffer): Promise<GitHubEnrollmentStateRecord | null> {
  const [stored] = await tx.select({ payload: authKv.payload, expiresAt: authKv.expiresAt })
    .from(authKv).where(key(ownerHash)).limit(1).for('update');
  if (!stored?.payload || typeof stored.payload !== 'object' || !stored.expiresAt) return null;
  const value = stored.payload as Record<string, unknown>;
  try {
    const keys = ['stateHash', 'ownerHash', 'sessionHash', 'userId', 'invitationId', 'generation',
      'claimAssertionId', 'purpose', 'callbackUri', 'createdAt', 'expiresAt'];
    if (Object.keys(value).length !== keys.length || Object.keys(value).some(name => !keys.includes(name))) return null;
    const record: GitHubEnrollmentStateRecord = {
      stateHash: decodeHash(value.stateHash), ownerHash: decodeHash(value.ownerHash), sessionHash: decodeHash(value.sessionHash),
      userId: value.userId as string, invitationId: value.invitationId as string, generation: value.generation as number,
      claimAssertionId: value.claimAssertionId as string, purpose: value.purpose as typeof GITHUB_ENROLLMENT_PURPOSE,
      callbackUri: value.callbackUri as string, createdAt: decodeDate(value.createdAt), expiresAt: decodeDate(value.expiresAt),
    };
    validateRecord(record);
    return record.expiresAt.getTime() === stored.expiresAt.getTime() ? record : null;
  } catch { return null; }
}

function validateRecord(record: GitHubEnrollmentStateRecord): void {
  if (record.purpose !== GITHUB_ENROLLMENT_PURPOSE
      || validateGitHubEnrollmentCallbackUri(record.callbackUri) !== record.callbackUri
      || !Number.isInteger(record.generation) || record.generation < 1 || record.generation > MAX_INVITATION_GENERATION) {
    throw new Error('Invalid GitHub enrollment state');
  }
  for (const hash of [record.stateHash, record.ownerHash, record.sessionHash]) assertHash(hash, 'OAuth state hash');
  for (const id of [record.userId, record.invitationId, record.claimAssertionId]) assertUuid(id, 'OAuth state id');
  if (!Number.isFinite(record.createdAt.getTime()) || !Number.isFinite(record.expiresAt.getTime())
      || record.expiresAt <= record.createdAt
      || record.expiresAt.getTime() - record.createdAt.getTime() > GITHUB_ENROLLMENT_STATE_TTL_SECONDS * 1000) {
    throw new Error('Invalid GitHub enrollment state');
  }
}

function decodeHash(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid hash');
  return Buffer.from(value, 'hex');
}
function decodeDate(value: unknown): Date {
  if (typeof value !== 'string') throw new Error('Invalid date');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error('Invalid date');
  return date;
}
function equal(left: Buffer, right: Buffer): boolean { return left.length === right.length && timingSafeEqual(left, right); }
async function databaseTime(tx: DrizzleTx): Promise<Date> {
  const [result] = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
  return new Date(result.now);
}
