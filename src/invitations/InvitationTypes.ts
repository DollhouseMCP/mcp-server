import type { ConsoleAdminRole } from '../database/schema/webConsole.js';
import type {
  InvitationClaimState,
  InvitationDeliveryState,
  InvitationGenerationState,
  InvitationState,
} from '../database/schema/invitations.js';

export type InvitationErrorCode =
  | 'invitation_not_found'
  | 'invitation_invalid'
  | 'invitation_expired'
  | 'invitation_revoked'
  | 'invitation_superseded'
  | 'invitation_replayed'
  | 'invitation_conflict'
  | 'claim_owner_mismatch'
  | 'account_not_pending'
  | 'configuration_invalid'
  | 'concurrent_update';

export class InvitationError extends Error {
  constructor(readonly code: InvitationErrorCode, message: string) {
    super(message);
    this.name = 'InvitationError';
  }
}

export interface InvitationGenerationView {
  readonly generation: number;
  readonly state: InvitationGenerationState;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly credentialConsumedAt: Date | null;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly expiredAt: Date | null;
  readonly supersededAt: Date | null;
  readonly version: number;
}

export interface InvitationView {
  readonly id: string;
  readonly userId: string;
  readonly emailOriginal: string;
  readonly emailNormalized: string;
  readonly inviterUserId: string;
  readonly intendedDisplayName: string | null;
  readonly intendedUsername: string;
  readonly intendedRoles: readonly ConsoleAdminRole[];
  readonly state: InvitationState;
  readonly currentGeneration: InvitationGenerationView;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly expiredAt: Date | null;
  readonly correlationId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IssuedInvitation {
  readonly invitation: InvitationView;
  /** Returned exactly once by issue/regenerate; never persisted or audited. */
  readonly credential: string;
}

export interface ClaimAssertionView {
  readonly id: string;
  readonly invitationId: string;
  readonly generation: number;
  readonly userId: string;
  readonly state: InvitationClaimState;
  readonly emailVerifiedAt: Date;
  readonly expiresAt: Date;
  readonly lastExchangedAt: Date;
  readonly version: number;
}

export interface InvitationDeliveryAttemptView {
  readonly id: string;
  readonly invitationId: string;
  readonly generation: number;
  readonly attemptNumber: number;
  readonly state: InvitationDeliveryState;
  readonly provider: string | null;
  readonly providerMessageId: string | null;
  readonly failureClass: string | null;
  readonly sanitizedDetail: Readonly<Record<string, unknown>> | null;
  readonly correlationId: string;
  readonly requestedAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly version: number;
}

/** Transient authorization for the winning reservation call, never persist/replay it. */
export interface InvitationDeliveryReservation extends InvitationDeliveryAttemptView {
  /** Only the transaction that creates this reservation may submit after commit. */
  readonly submissionAuthorized: boolean;
}

export interface IssueInvitationInput {
  readonly username: string;
  readonly displayName: string | null;
  readonly email: string;
  readonly inviterUserId: string;
  readonly intendedRoles: readonly ConsoleAdminRole[];
  readonly ttlHours?: number;
  readonly correlationId: string;
}

export interface RegenerateInvitationInput {
  readonly invitationId: string;
  readonly ttlHours?: number;
  readonly correlationId: string;
}

export interface RevokeInvitationInput {
  readonly invitationId: string;
  readonly correlationId: string;
}

export interface BeginInvitationClaimInput {
  readonly credential: string;
  /** SHA-256 hash of #2680's random browser binding; raw binding stays in a secure cookie. */
  readonly claimOwnerHash: Buffer;
  readonly correlationId: string;
}

export interface ReserveInvitationDeliveryInput {
  readonly invitationId: string;
  readonly generation: number;
  readonly provider: string | null;
  readonly correlationId: string;
}

export interface RecordInvitationDeliveryResultInput {
  readonly attemptId: string;
  readonly state: Extract<InvitationDeliveryState, 'submitted' | 'failed' | 'unknown'>;
  readonly providerMessageId?: string | null;
  readonly failureClass?: string | null;
  readonly sanitizedDetail?: Readonly<Record<string, unknown>> | null;
}

export type InvitationDeliveryResultUpdate = Omit<RecordInvitationDeliveryResultInput, 'attemptId'>;

export interface IInvitationLifecycleService {
  issue(input: IssueInvitationInput): Promise<IssuedInvitation>;
  inspect(invitationId: string): Promise<InvitationView | null>;
  regenerate(input: RegenerateInvitationInput): Promise<IssuedInvitation>;
  revoke(input: RevokeInvitationInput): Promise<InvitationView>;
  beginClaim(input: BeginInvitationClaimInput): Promise<ClaimAssertionView>;
  reserveDeliveryAttempt(input: ReserveInvitationDeliveryInput): Promise<InvitationDeliveryReservation>;
  recordDeliveryResult(input: RecordInvitationDeliveryResultInput): Promise<InvitationDeliveryAttemptView>;
  expireStale(limit: number): Promise<number>;
  cleanupTerminal(before: Date, limit: number): Promise<number>;
}
