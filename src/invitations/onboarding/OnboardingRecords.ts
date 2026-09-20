import type { IInvitationStore } from '../IInvitationStore.js';
import { MAX_INVITATION_TTL_HOURS } from '../InvitationConfig.js';
import { MAX_INVITATION_GENERATION } from '../InvitationToken.js';
import { assertHash, assertUuid } from '../../web-console/stores/ConsoleStoreValidation.js';

export const ONBOARDING_SESSION_TTL_SECONDS = 15 * 60;
export const ONBOARDING_OWNER_MAX_AGE_SECONDS = MAX_INVITATION_TTL_HOURS * 60 * 60;
export const ONBOARDING_SCOPE = 'onboarding:github-enrollment';

/** Stored by owner hash before a claim can accept this browser's binding. */
export interface OnboardingOwnerRecord {
  readonly ownerHash: Buffer;
  readonly csrfTokenHash: Buffer;
  readonly createdAt: Date;
  readonly refreshedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

/** Hash-only session references, distinct from ConsoleSessionRecord/AuthClaims. */
export interface OnboardingSessionRecord {
  readonly idHash: Buffer;
  readonly ownerHash: Buffer;
  readonly csrfTokenHash: Buffer;
  readonly userId: string;
  readonly invitationId: string;
  readonly generation: number;
  readonly claimAssertionId: string;
  readonly emailVerifiedAt: Date;
  readonly scope: typeof ONBOARDING_SCOPE;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

/**
 * Required authority for every future session issuance/lookup, in its caller's
 * transaction. References and owner hash MUST come from managed server records,
 * never browser JSON. Validate current pending user/generation/open claim,
 * owner binding, verified email and expiry before granting onboarding access.
 */
export type OnboardingClaimAuthority = Pick<IInvitationStore, 'lockActivationCandidateWithTx'>;

/** Shape/lifetime validation only; this does not authenticate or authorize. */
export function validateOnboardingOwnerRecord(record: OnboardingOwnerRecord): void {
  assertOnlyKeys(record, ['ownerHash', 'csrfTokenHash', 'createdAt', 'refreshedAt', 'expiresAt', 'revokedAt']);
  assertHash(record.ownerHash, 'ownerHash');
  assertHash(record.csrfTokenHash, 'csrfTokenHash');
  assertDate(record.createdAt);
  assertDate(record.refreshedAt);
  assertWindow(record.refreshedAt, record.expiresAt, ONBOARDING_OWNER_MAX_AGE_SECONDS);
  if (record.refreshedAt < record.createdAt) invalid();
  assertRevocation(record.revokedAt, record.createdAt);
}

/** Shape/lifetime validation only; live claim/account validation is mandatory. */
export function validateOnboardingSessionRecord(record: OnboardingSessionRecord): void {
  assertOnlyKeys(record, ['idHash', 'ownerHash', 'csrfTokenHash', 'userId', 'invitationId', 'generation',
    'claimAssertionId', 'emailVerifiedAt', 'scope', 'createdAt', 'expiresAt', 'revokedAt']);
  for (const hash of [record.idHash, record.ownerHash, record.csrfTokenHash]) assertHash(hash, 'onboarding hash');
  for (const id of [record.userId, record.invitationId, record.claimAssertionId]) assertUuid(id, 'onboarding id');
  if (record.scope !== ONBOARDING_SCOPE || !Number.isInteger(record.generation)
    || record.generation < 1 || record.generation > MAX_INVITATION_GENERATION) invalid();
  assertDate(record.emailVerifiedAt);
  assertWindow(record.createdAt, record.expiresAt, ONBOARDING_SESSION_TTL_SECONDS);
  if (record.emailVerifiedAt > record.createdAt) invalid();
  assertRevocation(record.revokedAt, record.createdAt);
}

/** Called only after live authority checks; never extends invitation/claim expiry. */
export function restrictedSessionExpiresAt(now: Date, ownerExpiresAt: Date, claimExpiresAt: Date, invitationExpiresAt: Date): Date {
  for (const value of [now, ownerExpiresAt, claimExpiresAt, invitationExpiresAt]) assertDate(value);
  const expiresAt = new Date(Math.min(now.getTime() + ONBOARDING_SESSION_TTL_SECONDS * 1000,
    ownerExpiresAt.getTime(), claimExpiresAt.getTime(), invitationExpiresAt.getTime()));
  if (expiresAt <= now) invalid();
  return expiresAt;
}

function assertWindow(start: Date, end: Date, maximumSeconds: number): void {
  assertDate(start);
  assertDate(end);
  const lifetime = end.getTime() - start.getTime();
  if (lifetime <= 0 || lifetime > maximumSeconds * 1000) invalid();
}

function assertRevocation(revokedAt: Date | null, createdAt: Date): void {
  if (revokedAt === null) return;
  assertDate(revokedAt);
  if (revokedAt < createdAt) invalid();
}

function assertDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid();
}

function assertOnlyKeys(value: object, keys: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
}

function invalid(): never {
  throw new Error('Invalid restricted onboarding record');
}
