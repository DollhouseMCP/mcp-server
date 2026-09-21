import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { normalizeAuthAllowlistValue } from '../auth/embedded-as/allowlistIdentity.js';
import { withSystemContext } from '../database/admin.js';
import { lockAuthMutationResourcesWithTx } from '../database/authMutationPreflight.js';
import { tryLockAuthMutationIdentitiesWithTx } from '../database/authPrincipalLock.js';
import type { DatabaseInstance } from '../database/connection.js';
import { getErrorCode, isSerializationFailure, isUniqueViolation, type DrizzleTx } from '../database/db-utils.js';
import { authAccounts } from '../database/schema/auth.js';
import { accountInvitations as invitations, accountInvitationGenerations as generations, accountInvitationClaimAssertions as claims } from '../database/schema/invitations.js';
import { users } from '../database/schema/users.js';
import { userAdminRoles } from '../database/schema/webConsole.js';
import { capabilitiesForRoles, ROLE_GRANT_CAPABILITIES } from '../web-console/modules/account-admin/AccountAdminRoleAuthority.js';
import { grantConsoleAdminRoleWithTx } from '../web-console/stores/PostgresConsoleAccountAdminStore.js';
import { accountAllowlistDeniesIdentityWithTx, accountAllowlistMatchesIdentityWithTx, addAccountAllowlistEntryWithTx } from '../web-console/stores/PostgresConsoleAccountAllowlistStore.js';
import { appendSecurityInvalidationEventWithTx } from '../web-console/services/invalidation/PostgresConsoleSecurityInvalidationStore.js';
import type { InvitationManagementAudit } from './IInvitationManagementStore.js';
import { lockInvitationActivationCandidateWithTx } from './PostgresInvitationClaimStore.js';
import { appendAudit, assertUuid, copyAudit, databaseTime, requireInvitation } from './InvitationTransactionSupport.js';
import { invitationCredentialMatches } from './InvitationToken.js';
import { InvitationError, type InvitationView } from './InvitationTypes.js';
import type { OnboardingSessionAuthority } from './onboarding/IOnboardingSessionAuthority.js';
import { validateOnboardingSessionRecord } from './onboarding/OnboardingRecords.js';

/** Trusted server result of #2679's OAuth flow bound to #2680's browser session; never public JSON. */
export interface InvitationActivationInput {
  readonly invitationId: string;
  readonly generation: number;
  readonly claimAssertionId: string;
  /** Server-derived browser binding. Copied before awaiting. */
  readonly claimOwnerHash: Buffer;
  /** Hash of the current managed restricted-session cookie, never supplied in JSON. */
  readonly sessionHash: Buffer;
  /** Canonical immutable decimal GitHub subject from its authenticated user endpoint. */
  readonly githubId: string;
  readonly githubLogin: string | null;
  readonly providerEmail: string | null;
  readonly providerEmailVerified: boolean;
  readonly correlationId: string;
}
/** History acknowledgement only: neither status authorizes a normal session. */
export interface InvitationActivationResult {
  readonly status: 'activated' | 'already_activated';
  readonly userId: string;
  readonly invitationId: string;
}

/** Unwired transaction boundary. Audit HMAC material must be resolved before invocation. */
export class PostgresInvitationActivationStore {
  constructor(private readonly db: DatabaseInstance, private readonly sessions: OnboardingSessionAuthority) {}

  async activate(input: InvitationActivationInput, audit: InvitationManagementAudit): Promise<InvitationActivationResult> {
    const owned = { ...input, claimOwnerHash: Buffer.from(input.claimOwnerHash), sessionHash: Buffer.from(input.sessionHash) };
    try {
      const ownedAudit = copyAudit(audit);
      validateInput(owned);
      if (typeof this.sessions?.lockSessionWithTx !== 'function' || typeof this.sessions.completeEnrollmentWithTx !== 'function') throw new InvitationError('configuration_invalid', 'Transactional onboarding session authority is required');
      return await withSystemContext(this.db, async tx => {
        await lockAuthMutationResourcesWithTx(tx);
        const sub = `github_${owned.githubId}`;
        const identities = [{ kind: 'github_id', normalizedValue: owned.githubId }];
        if (owned.githubLogin) identities.push({ kind: 'github_username', normalizedValue: normalizeAuthAllowlistValue('github_username', owned.githubLogin) });
        if (owned.providerEmail && owned.providerEmailVerified) identities.push({ kind: 'email', normalizedValue: normalizeAuthAllowlistValue('email', owned.providerEmail) });
        await tryLockAuthMutationIdentitiesWithTx(tx, [sub], identities);
        const invitation = await requireInvitation(tx, owned.invitationId);
        if (invitation.state === 'accepted') return completedRetry(tx, owned, invitation, sub);
        const liveSession = await this.sessions.lockSessionWithTx(tx, owned.claimOwnerHash, owned.sessionHash);
        if (!liveSession) throw new InvitationError('invitation_invalid', 'Restricted onboarding session is unavailable');
        validateOnboardingSessionRecord(liveSession);
        // Own mutable authority output before the next await as well as input buffers.
        const session = { ...liveSession, idHash: Buffer.from(liveSession.idHash), ownerHash: Buffer.from(liveSession.ownerHash),
          expiresAt: new Date(liveSession.expiresAt), createdAt: new Date(liveSession.createdAt), emailVerifiedAt: new Date(liveSession.emailVerifiedAt) };
        if (session.revokedAt !== null || session.invitationId !== invitation.id || session.generation !== owned.generation ||
            session.claimAssertionId !== owned.claimAssertionId || session.userId !== invitation.userId ||
            !invitationCredentialMatches(session.ownerHash, owned.claimOwnerHash) || !invitationCredentialMatches(session.idHash, owned.sessionHash)) {
          throw new InvitationError('invitation_invalid', 'Restricted session does not match activation');
        }
        const candidate = await lockInvitationActivationCandidateWithTx(tx, owned);
        if (session.emailVerifiedAt.getTime() !== candidate.claim.emailVerifiedAt.getTime()) throw new InvitationError('invitation_invalid', 'Restricted session claim changed');
        await assertIssuerAuthority(tx, candidate.invitation);
        const values = { githubId: owned.githubId, githubUsername: owned.githubLogin ?? undefined, email: owned.providerEmailVerified ? owned.providerEmail ?? undefined : undefined };
        if (await accountAllowlistDeniesIdentityWithTx(tx, { githubId: owned.githubId }) || await accountAllowlistDeniesIdentityWithTx(tx, values)) {
          throw new InvitationError('invitation_invalid', 'GitHub identity is denied by current sign-in policy');
        }
        await assertIdentityOwnership(tx, owned, invitation, sub);
        // All resource/advisory/candidate locks are held; never extend the persisted expiry.
        const now = await databaseTime(tx);
        if (session.createdAt > now || session.expiresAt <= now || candidate.claim.expiresAt <= now || invitation.currentGeneration.expiresAt <= now) {
          throw new InvitationError('invitation_expired', 'Invitation expired before activation');
        }
        await bindGithubIdentity(tx, owned, invitation.userId, sub, now);
        if (!await accountAllowlistMatchesIdentityWithTx(tx, { githubId: owned.githubId })) {
          await addAccountAllowlistEntryWithTx(tx, { kind: 'github_id', value: owned.githubId, createdByUserId: invitation.inviterUserId, createdAt: now, note: `Invitation ${invitation.id}` });
        }
        const [user] = await tx.select({ authzVersion: users.authzVersion }).from(users).where(eq(users.id, invitation.userId));
        for (const role of invitation.intendedRoles) {
          await grantConsoleAdminRoleWithTx(tx, { userId: invitation.userId, role, grantedByUserId: invitation.inviterUserId, grantedAt: now });
        }
        const [active] = await tx.update(users).set({ activationState: 'active', authzVersion: sql`${users.authzVersion} + 1`, updatedAt: now })
          .where(eq(users.id, invitation.userId)).returning({ authzVersion: users.authzVersion });
        await tx.update(generations).set({ state: 'accepted', acceptedAt: now, version: sql`${generations.version} + 1` })
          .where(and(eq(generations.invitationId, invitation.id), eq(generations.generation, owned.generation)));
        await tx.update(invitations).set({ state: 'accepted', acceptedAt: now, updatedAt: now, correlationId: owned.correlationId, version: sql`${invitations.version} + 1` })
          .where(eq(invitations.id, invitation.id));
        await tx.update(claims).set({ state: 'completed', completedAt: now, version: sql`${claims.version} + 1` }).where(eq(claims.id, owned.claimAssertionId));
        await appendSecurityInvalidationEventWithTx(tx, {
          kind: 'principal_authz_changed', urgency: 'eventual', userId: invitation.userId, authzVersion: active.authzVersion,
          reason: 'invitation_activated', payload: { previousAuthzVersion: user.authzVersion, newAuthzVersion: active.authzVersion },
          createdAt: now, createdByUserId: invitation.inviterUserId,
        });
        await ownedAudit.appendSecurityEvent(tx, {
          eventType: 'invitation.github_identity_linked', actorId: ownedAudit.kind === 'admin' ? ownedAudit.adminContext.actorUserId : invitation.userId,
          targetId: invitation.userId, occurredAt: now.getTime(), metadata: { invitationId: invitation.id, githubSubject: sub, correlationId: owned.correlationId },
        });
        if (ownedAudit.kind === 'admin') {
          await appendAudit(tx, ownedAudit, 'activated', await requireInvitation(tx, invitation.id), owned.correlationId, now);
        } else {
          await ownedAudit.appendSecurityEvent(tx, { eventType: 'invitation.activated', actorId: invitation.userId, targetId: invitation.id, occurredAt: now.getTime(),
            metadata: { invitationId: invitation.id, generation: owned.generation, userId: invitation.userId, correlationId: owned.correlationId } });
        }
        if (!await this.sessions.completeEnrollmentWithTx(tx, owned.claimOwnerHash, owned.sessionHash)) {
          throw new InvitationError('invitation_invalid', 'Restricted onboarding session changed before completion');
        }
        return { status: 'activated', userId: invitation.userId, invitationId: invitation.id };
      });
    } catch (error) {
      if (isSerializationFailure(error) || getErrorCode(error) === '55P03') throw new InvitationError('concurrent_update', 'Activation transaction conflicted');
      if (isUniqueViolation(error)) throw new InvitationError('invitation_conflict', 'Activation identity or role already exists');
      throw error;
    } finally { owned.claimOwnerHash.fill(0); owned.sessionHash.fill(0); }
  }
}

async function assertIssuerAuthority(tx: DrizzleTx, invitation: InvitationView): Promise<void> {
  const [issuer] = await tx.select().from(users).where(eq(users.id, invitation.inviterUserId));
  const roles = await tx.select({ role: userAdminRoles.role }).from(userAdminRoles).where(and(eq(userAdminRoles.userId, invitation.inviterUserId), isNull(userAdminRoles.revokedAt)));
  const capabilities = capabilitiesForRoles(roles.map(row => row.role));
  if (!issuer || issuer.activationState !== 'active' || issuer.disabledAt || issuer.deletedAt || !capabilities.includes('console:admin:accounts') ||
      invitation.intendedRoles.some(role => ROLE_GRANT_CAPABILITIES[role].some(capability => !capabilities.includes(capability)))) {
    throw new InvitationError('invitation_invalid', 'Invitation issuer is no longer authorized');
  }
}

async function assertIdentityOwnership(tx: DrizzleTx, input: InvitationActivationInput, invitation: InvitationView, sub: string): Promise<void> {
  // The existing resolver falls back to users.username === sub for unlinked
  // identities. Preserve that canonical owner, including unavailable accounts.
  const [legacyOwner] = await tx.select({ id: users.id }).from(users).where(eq(users.username, sub));
  if (legacyOwner && legacyOwner.id !== invitation.userId) throw new InvitationError('invitation_conflict', 'GitHub subject already has a canonical account');
  const existing = await tx.select().from(authAccounts).where(or(
    and(eq(authAccounts.provider, 'github'), eq(authAccounts.externalSub, input.githubId)), eq(authAccounts.sub, sub), eq(authAccounts.userId, invitation.userId),
  ));
  if (existing.some(row => row.provider !== 'github' || row.externalSub !== input.githubId || row.sub !== sub || (row.userId !== null && row.userId !== invitation.userId))) {
    throw new InvitationError('invitation_conflict', 'GitHub identity cannot be linked to this invitation');
  }
  const granted = await tx.select({ id: userAdminRoles.id }).from(userAdminRoles).where(and(eq(userAdminRoles.userId, invitation.userId), isNull(userAdminRoles.revokedAt))).limit(1);
  if (granted.length) throw new InvitationError('invitation_conflict', 'Pending account already has role assignments');
}

async function bindGithubIdentity(tx: DrizzleTx, input: InvitationActivationInput, userId: string, sub: string, now: Date): Promise<void> {
  // Ownership was checked under EXCLUSIVE auth_accounts; never COALESCE another owner.
  await tx.insert(authAccounts).values({
    provider: 'github', externalSub: input.githubId, sub, userId, email: input.providerEmail,
    emailVerified: input.providerEmail !== null && input.providerEmailVerified, displayName: input.githubLogin,
    rawProfile: input.githubLogin ? { githubUsername: input.githubLogin } : null, lastAuthAt: now.getTime(), createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({ target: [authAccounts.provider, authAccounts.externalSub], set: {
    userId, email: input.providerEmail, emailVerified: input.providerEmail !== null && input.providerEmailVerified,
    displayName: input.githubLogin, rawProfile: input.githubLogin ? { githubUsername: input.githubLogin } : null, lastAuthAt: now.getTime(), updatedAt: now,
  } });
}

async function completedRetry(tx: DrizzleTx, input: InvitationActivationInput, invitation: InvitationView, sub: string): Promise<InvitationActivationResult> {
  const [user] = await tx.select().from(users).where(eq(users.id, invitation.userId));
  const [claim] = await tx.select().from(claims).where(eq(claims.id, input.claimAssertionId));
  const [identity] = await tx.select().from(authAccounts).where(and(eq(authAccounts.provider, 'github'), eq(authAccounts.externalSub, input.githubId), eq(authAccounts.sub, sub)));
  if (!user || user.activationState !== 'active' || user.disabledAt || user.deletedAt || identity?.userId !== user.id ||
      invitation.currentGeneration.generation !== input.generation || invitation.currentGeneration.state !== 'accepted' ||
      !claim || claim.state !== 'completed' || claim.invitationId !== invitation.id || claim.generation !== input.generation || claim.userId !== user.id) {
    throw new InvitationError('invitation_invalid', 'Completed activation does not match this account and identity');
  }
  if (!invitationCredentialMatches(claim.claimOwnerHash, input.claimOwnerHash)) throw new InvitationError('claim_owner_mismatch', 'Completed activation belongs to another browser');
  // Historical completion remains acknowledged after invitation expiry, without
  // granting roles again, refreshing authority or issuing any session.
  return { status: 'already_activated', userId: user.id, invitationId: invitation.id };
}

function validateInput(input: InvitationActivationInput): void {
  for (const id of [input.invitationId, input.claimAssertionId, input.correlationId]) assertUuid(id);
  if (!/^[1-9]\d{0,254}$/.test(input.githubId) || input.claimOwnerHash.length !== 32 || input.sessionHash.length !== 32 ||
      !Number.isInteger(input.generation) || input.generation < 1 || input.generation > 2_147_483_647 ||
      typeof input.providerEmailVerified !== 'boolean' ||
      [input.providerEmail, input.githubLogin].some(value => value !== null && (value.trim() === '' || value.length > 255))) {
    throw new InvitationError('invitation_invalid', 'Invalid verified GitHub activation context');
  }
}
