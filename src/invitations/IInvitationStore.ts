import type { DrizzleTx } from '../database/db-utils.js';
import type { DurableAuditEvent } from '../security/auditSink.js';
import type { ConsoleAdminAuditEvent } from '../web-console/audit/IAdminAuditWriter.js';
import type {
  ClaimAssertionView,
  InvitationDeliveryAttemptView,
  InvitationDeliveryResultUpdate,
  InvitationView,
} from './InvitationTypes.js';

interface InvitationSecurityAudit {
  appendSecurityEvent(tx: DrizzleTx, event: DurableAuditEvent): Promise<void>;
}

/** Required transaction-scoped audit functions; no production no-op is permitted. */
export type InvitationTransactionAudit =
  | (InvitationSecurityAudit & { readonly kind: 'system' })
  | (InvitationSecurityAudit & {
    readonly kind: 'admin';
    appendAdminEvent(tx: DrizzleTx, event: ConsoleAdminAuditEvent): Promise<void>;
  });

export interface InvitationIssueRecord {
  readonly invitationId: string;
  /** Reserved ID; issue creates the pending user before its invitation in the same transaction. */
  readonly userId: string;
  readonly username: string;
  readonly displayName: string | null;
  readonly emailOriginal: string;
  readonly emailNormalized: string;
  readonly inviterUserId: string;
  readonly intendedRoles: InvitationView['intendedRoles'];
  readonly generation: number;
  /** Transient only: never persist/log or place in idempotency records or delivery outboxes. Copy before awaiting. */
  readonly credentialSecret: Buffer;
  readonly ttlHours: number;
  readonly correlationId: string;
}

export interface InvitationRegenerationRecord {
  readonly invitationId: string;
  /** Transient only: never persist/log or place in idempotency records or delivery outboxes. Copy before awaiting. */
  readonly credentialSecret: Buffer;
  readonly ttlHours: number;
  readonly correlationId: string;
}

export interface InvitationClaimRecord {
  /** Resolve the pending user from this verified invitation, never from caller-supplied account data. */
  readonly invitationId: string;
  readonly generation: number;
  /** Transient only: never persist/log or place in idempotency records or delivery outboxes. Copy before awaiting. */
  readonly credentialSecret: Buffer;
  /** Derived server-side from the managed browser/restricted-session binding, never accepted from request data. Copy before awaiting. */
  readonly claimOwnerHash: Buffer;
  readonly correlationId: string;
}

/**
 * All mutation methods are called inside the single system transaction owned by
 * `runMutation`. Implementations lock normalized email or invitation rows and
 * append security/admin audit before the callback commits.
 */
export interface InvitationStoreMutation {
  issue(input: InvitationIssueRecord): Promise<InvitationView>;
  regenerate(input: InvitationRegenerationRecord): Promise<InvitationView>;
  revoke(invitationId: string, correlationId: string): Promise<InvitationView>;
  beginClaim(input: InvitationClaimRecord): Promise<ClaimAssertionView>;
  reserveDeliveryAttempt(
    invitationId: string,
    generation: number,
    provider: string | null,
    correlationId: string,
  ): Promise<InvitationDeliveryAttemptView>;
  recordDeliveryResult(
    attemptId: string,
    update: InvitationDeliveryResultUpdate,
  ): Promise<InvitationDeliveryAttemptView>;
  expireStale(limit: number): Promise<number>;
  cleanupTerminal(before: Date, limit: number): Promise<number>;
}

export interface LockedInvitationActivationCandidate {
  readonly invitation: InvitationView;
  readonly claim: ClaimAssertionView;
}

export interface IInvitationStore {
  inspect(invitationId: string): Promise<InvitationView | null>;
  runMutation<T>(
    audit: InvitationTransactionAudit,
    operation: (mutation: InvitationStoreMutation) => Promise<T>,
  ): Promise<T>;
  /**
   * #2681 calls this inside its wider transaction, then performs identity,
   * role, account, invitation, claim, and audit writes before one commit.
   * Implementations must lock and validate the current pending generation,
   * pending account, unexpired open claim, and matching owner binding.
   * Owner hashes must originate from the server-managed browser/restricted-session
   * binding, not caller-supplied JSON/query parameters or a normal login assumption.
   * The caller must append transaction-scoped security/admin audit for its writes.
   */
  lockActivationCandidateWithTx(
    tx: DrizzleTx,
    input: {
      readonly invitationId: string;
      readonly generation: number;
      readonly claimAssertionId: string;
      /** Derived server-side from the managed browser/restricted-session binding, never accepted from request data. Copy before awaiting. */
      readonly claimOwnerHash: Buffer;
    },
  ): Promise<LockedInvitationActivationCandidate>;
}
