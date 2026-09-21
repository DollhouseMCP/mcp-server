import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { normalizeAuthAllowlistValue } from '../auth/embedded-as/allowlistIdentity.js';
import { withSystemContext } from '../database/admin.js';
import type { DatabaseInstance } from '../database/connection.js';
import { getErrorCode, isSerializationFailure, isUniqueViolation, type DrizzleTx } from '../database/db-utils.js';
import { accountInvitationClaimAssertions as claims, accountInvitationGenerations as generations, accountInvitations as invitations } from '../database/schema/invitations.js';
import { users } from '../database/schema/users.js';
import type { InvitationClaimRecord, LockedInvitationActivationCandidate } from './IInvitationStore.js';
import type { IInvitationClaimStore, InvitationActivationCandidateInput, InvitationClaimMutation } from './IInvitationClaimStore.js';
import type { InvitationManagementAudit } from './IInvitationManagementStore.js';
import { hashInvitationCredential, invitationCredentialMatches, INVITATION_DIGEST_BYTES, INVITATION_SECRET_BYTES, MAX_INVITATION_GENERATION } from './InvitationToken.js';
import { appendAudit, assertUuid, copyAudit, databaseTime, lockAdminAudit, lockInvitation } from './InvitationTransactionSupport.js';
import { InvitationError, type ClaimAssertionView, type InvitationView } from './InvitationTypes.js';

/** Internal store. A server-established browser binding is required at the caller boundary. */
export class PostgresInvitationClaimStore implements IInvitationClaimStore {
  constructor(private readonly db: DatabaseInstance) {}

  async runMutation<T>(audit: InvitationManagementAudit, operation: (mutation: InvitationClaimMutation) => Promise<T>): Promise<T> {
    const ownedAudit = copyAudit(audit);
    try {
      return await withSystemContext(this.db, tx => operation(createInvitationClaimMutation(tx, ownedAudit)));
    } catch (error) {
      if (isSerializationFailure(error) || isUniqueViolation(error) || getErrorCode(error) === '55P03') {
        throw new InvitationError('concurrent_update', 'Invitation claim transaction conflicted');
      }
      throw error;
    }
  }

  lockActivationCandidateWithTx(tx: DrizzleTx, input: InvitationActivationCandidateInput): Promise<LockedInvitationActivationCandidate> {
    return lockInvitationActivationCandidateWithTx(tx, input);
  }
}

/** Compose with management/delivery in a single caller-owned transaction. */
export function createInvitationClaimMutation(tx: DrizzleTx, audit: InvitationManagementAudit): InvitationClaimMutation {
  const ownedAudit = copyAudit(audit);
  return { beginClaim: input => beginClaim(tx, ownedAudit, input) };
}

async function beginClaim(tx: DrizzleTx, audit: InvitationManagementAudit, input: InvitationClaimRecord): Promise<ClaimAssertionView> {
  const owned = { ...input, credentialSecret: Buffer.from(input.credentialSecret), claimOwnerHash: Buffer.from(input.claimOwnerHash) };
  try {
    validateBinding(owned.invitationId, owned.generation, owned.claimOwnerHash);
    assertUuid(owned.correlationId);
    if (owned.credentialSecret.length !== INVITATION_SECRET_BYTES) throw new InvitationError('invitation_invalid', 'Invalid invitation credential');
    await rejectInvalidCredentialBeforeLock(tx, owned);
    const invitation = await lockClaimableInvitation(tx, owned.invitationId, owned.generation);
    await lockAdminAudit(tx, audit);
    const [generation] = await tx.select().from(generations).where(and(
      eq(generations.invitationId, invitation.id), eq(generations.generation, owned.generation),
    )).for('update');
    const presented = hashInvitationCredential({ invitationId: invitation.id, generation: owned.generation, secret: owned.credentialSecret }, invitation.emailNormalized, generation.expiresAt);
    if (!invitationCredentialMatches(generation.credentialHash, presented)) {
      throw new InvitationError('invitation_invalid', 'Invalid invitation credential');
    }
    const [claim] = await tx.select().from(claims).where(and(
      eq(claims.invitationId, invitation.id), eq(claims.generation, owned.generation),
    )).for('update');
    const now = await databaseTime(tx);
    assertUnexpired(invitation.currentGeneration.expiresAt, now);
    if (generation.credentialConsumedAt !== null) {
      if (!claim) throw new InvitationError('invitation_invalid', 'Invitation claim is unavailable');
      validateClaim(claim, invitation, now);
      if (!invitationCredentialMatches(claim.claimOwnerHash, owned.claimOwnerHash)) {
        throw new InvitationError('invitation_replayed', 'Invitation was claimed by another browser');
      }
      const [resumed] = await tx.update(claims).set({ lastExchangedAt: now, version: sql`${claims.version} + 1` })
        .where(eq(claims.id, claim.id)).returning();
      await appendAudit(tx, audit, 'claim_resumed', invitation, owned.correlationId, now);
      return claimView(resumed);
    }
    if (claim) throw new InvitationError('invitation_invalid', 'Invitation claim state is inconsistent');
    const [created] = await tx.insert(claims).values({
      id: randomUUID(), invitationId: invitation.id, generation: owned.generation, userId: invitation.userId,
      claimOwnerHash: owned.claimOwnerHash, emailVerifiedAt: now, createdAt: now,
      lastExchangedAt: now, expiresAt: generation.expiresAt,
    }).returning();
    await tx.update(generations).set({ credentialConsumedAt: now, version: sql`${generations.version} + 1` })
      .where(and(eq(generations.invitationId, invitation.id), eq(generations.generation, owned.generation)));
    await appendAudit(tx, audit, 'claimed', invitation, owned.correlationId, now);
    return claimView(created);
  } finally {
    owned.credentialSecret.fill(0);
    owned.claimOwnerHash.fill(0);
  }
}

/** Cheap rejection only; the existing locked path revalidates every fact before mutation. */
async function rejectInvalidCredentialBeforeLock(tx: DrizzleTx, input: InvitationClaimRecord): Promise<void> {
  const [credential] = await tx.select({ email: invitations.emailNormalized, expiresAt: generations.expiresAt, hash: generations.credentialHash })
    .from(generations).innerJoin(invitations, eq(invitations.id, generations.invitationId))
    .where(and(eq(generations.invitationId, input.invitationId), eq(generations.generation, input.generation))).limit(1);
  if (!credential || !invitationCredentialMatches(credential.hash, hashInvitationCredential({
    invitationId: input.invitationId, generation: input.generation, secret: input.credentialSecret,
  }, credential.email, credential.expiresAt))) {
    throw new InvitationError('invitation_invalid', 'Invalid invitation credential');
  }
}

/**
 * No commit, identity linking, role application, activation or audit occurs here.
 * #2681 performs those writes in this SAME transaction before committing. The
 * binding hash must be derived from its managed restricted-session cookie, never
 * taken directly from JSON/query parameters. A normal account session is not a
 * prerequisite. Caller-owned input is snapshotted before the first await.
 */
export async function lockInvitationActivationCandidateWithTx(tx: DrizzleTx, input: InvitationActivationCandidateInput): Promise<LockedInvitationActivationCandidate> {
  const owned = { ...input, claimOwnerHash: Buffer.from(input.claimOwnerHash) };
  try {
    validateBinding(owned.invitationId, owned.generation, owned.claimOwnerHash);
    assertUuid(owned.claimAssertionId);
    const invitation = await lockClaimableInvitation(tx, owned.invitationId, owned.generation);
    const [claim] = await tx.select().from(claims).where(eq(claims.id, owned.claimAssertionId)).for('update');
    const now = await databaseTime(tx);
    assertUnexpired(invitation.currentGeneration.expiresAt, now);
    if (!claim || claim.invitationId !== invitation.id || claim.generation !== owned.generation ||
        invitation.currentGeneration.credentialConsumedAt === null) {
      throw new InvitationError('invitation_invalid', 'Invitation claim does not match activation candidate');
    }
    validateClaim(claim, invitation, now);
    if (!invitationCredentialMatches(claim.claimOwnerHash, owned.claimOwnerHash)) {
      throw new InvitationError('claim_owner_mismatch', 'Invitation claim does not belong to this browser');
    }
    return { invitation, claim: claimView(claim) };
  } finally {
    owned.claimOwnerHash.fill(0);
  }
}

async function lockClaimableInvitation(tx: DrizzleTx, invitationId: string, generation: number): Promise<InvitationView> {
  const invitation = await lockInvitation(tx, invitationId);
  if (invitation.currentGeneration.generation !== generation) throw new InvitationError('invitation_superseded', 'Invitation generation is not current');
  if (invitation.state === 'revoked') throw new InvitationError('invitation_revoked', 'Invitation is revoked');
  if (invitation.state === 'expired') throw new InvitationError('invitation_expired', 'Invitation is expired');
  if (invitation.state !== 'pending' || invitation.currentGeneration.state !== 'pending') {
    throw new InvitationError('invitation_invalid', 'Invitation is not pending');
  }
  const [user] = await tx.select({ email: users.email, username: users.username }).from(users).where(eq(users.id, invitation.userId));
  if (!user?.email || normalizeAuthAllowlistValue('email', user.email) !== invitation.emailNormalized ||
      user.username !== invitation.intendedUsername) {
    throw new InvitationError('invitation_invalid', 'Invitation account identity changed');
  }
  return invitation;
}

function validateClaim(claim: typeof claims.$inferSelect, invitation: InvitationView, now: Date): void {
  if (claim.userId !== invitation.userId || claim.state !== 'open') {
    throw new InvitationError('invitation_invalid', 'Invitation claim is not open');
  }
  assertUnexpired(claim.expiresAt, now);
  if (claim.expiresAt.getTime() > invitation.currentGeneration.expiresAt.getTime()) {
    throw new InvitationError('invitation_invalid', 'Invitation claim lifetime is inconsistent');
  }
}

function assertUnexpired(expiresAt: Date, now: Date): void {
  if (expiresAt.getTime() <= now.getTime()) throw new InvitationError('invitation_expired', 'Invitation is expired');
}

function validateBinding(invitationId: string, generation: number, ownerHash: Buffer): void {
  assertUuid(invitationId);
  if (!Number.isInteger(generation) || generation < 1 || generation > MAX_INVITATION_GENERATION || ownerHash.length !== INVITATION_DIGEST_BYTES) {
    throw new InvitationError('invitation_invalid', 'Invalid invitation claim context');
  }
}

function claimView(claim: typeof claims.$inferSelect): ClaimAssertionView {
  return {
    id: claim.id, invitationId: claim.invitationId, generation: claim.generation, userId: claim.userId,
    state: claim.state, emailVerifiedAt: claim.emailVerifiedAt, expiresAt: claim.expiresAt,
    lastExchangedAt: claim.lastExchangedAt, version: claim.version,
  };
}
