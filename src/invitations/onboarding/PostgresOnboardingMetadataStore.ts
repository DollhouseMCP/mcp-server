import { timingSafeEqual } from 'node:crypto';
import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { assertHash } from '../../web-console/stores/ConsoleStoreValidation.js';
import { databaseTime, requireInvitation } from '../InvitationTransactionSupport.js';
import { InvitationError, type InvitationView } from '../InvitationTypes.js';
import type { OnboardingSessionAuthority } from './IOnboardingSessionAuthority.js';
import { validateOnboardingSessionRecord } from './OnboardingRecords.js';

/** Private browser metadata after inbox proof; no account or credential identifiers. */
export interface OnboardingInvitationMetadata {
  readonly state: 'claimed';
  readonly account: { readonly username: string; readonly displayName: string | null; readonly verifiedEmail: string };
  readonly intendedRoles: InvitationView['intendedRoles'];
  readonly emailVerifiedAt: string;
  readonly invitationExpiresAt: string;
  readonly sessionExpiresAt: string;
  readonly serverTime: string;
}

/** Unregistered read boundary. Inputs are server-derived cookie hashes, never public JSON. */
export class PostgresOnboardingMetadataStore {
  constructor(private readonly db: DatabaseInstance, private readonly sessions: Pick<OnboardingSessionAuthority, 'lockSessionWithTx'>) {}

  async read(ownerHash: Buffer, sessionHash: Buffer): Promise<OnboardingInvitationMetadata | null> {
    assertHash(ownerHash, 'ownerHash');
    assertHash(sessionHash, 'sessionHash');
    const owner = Buffer.from(ownerHash);
    const sessionId = Buffer.from(sessionHash);
    try {
      return await withSystemContext(this.db, async tx => {
        // Authority holds users -> invitation -> claim -> owner/session locks
        // through this projection, so revocation/deletion cannot race the read.
        const liveSession = await this.sessions.lockSessionWithTx(tx, owner, sessionId);
        if (!liveSession) return null;
        validateOnboardingSessionRecord(liveSession);
        if (!timingSafeEqual(liveSession.ownerHash, owner) || !timingSafeEqual(liveSession.idHash, sessionId)) return null;
        const session = { ...liveSession, createdAt: new Date(liveSession.createdAt),
          expiresAt: new Date(liveSession.expiresAt), emailVerifiedAt: new Date(liveSession.emailVerifiedAt) };
        const invitation = await requireInvitation(tx, session.invitationId);
        const now = await databaseTime(tx);
        if (session.revokedAt !== null || session.createdAt > now || session.expiresAt <= now ||
          invitation.userId !== session.userId || invitation.state !== 'pending' ||
          invitation.currentGeneration.state !== 'pending' || invitation.currentGeneration.generation !== session.generation ||
          invitation.currentGeneration.expiresAt <= now) return null;
        // Explicit projection: never spread domain records into browser output.
        return {
          state: 'claimed',
          account: { username: invitation.intendedUsername, displayName: invitation.intendedDisplayName,
            verifiedEmail: invitation.emailOriginal },
          intendedRoles: [...invitation.intendedRoles], emailVerifiedAt: session.emailVerifiedAt.toISOString(),
          invitationExpiresAt: invitation.currentGeneration.expiresAt.toISOString(),
          sessionExpiresAt: session.expiresAt.toISOString(), serverTime: now.toISOString(),
        };
      });
    } catch (error) {
      if (error instanceof InvitationError && !['configuration_invalid', 'concurrent_update'].includes(error.code)) return null;
      throw error; // Availability failures must not become successful metadata reads.
    } finally { owner.fill(0); sessionId.fill(0); }
  }
}
