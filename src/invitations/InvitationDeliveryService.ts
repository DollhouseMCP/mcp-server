import type { TransactionalEmailSender, EmailSubmissionResult } from '../auth/embedded-as/methods/TransactionalEmailSender.js';
import type { IInvitationDeliveryStore } from './IInvitationDeliveryStore.js';
import type { InvitationManagementAudit } from './IInvitationManagementStore.js';
import { copyAudit } from './InvitationTransactionSupport.js';
import { renderInvitationEmail, type InvitationEmailAccess } from './InvitationEmailTemplate.js';
import { parseInvitationToken } from './InvitationToken.js';
import { sanitizeDeliveryResult } from './InvitationDeliveryMetadata.js';
import { InvitationError, type IssuedInvitation, type InvitationDeliveryAttemptView, type InvitationDeliveryResultUpdate, type InvitationDeliveryReservation } from './InvitationTypes.js';

type AttemptReference = Pick<InvitationDeliveryAttemptView, 'id' | 'invitationId' | 'generation' | 'version' | 'state'>;
export type InvitationDeliveryOutcome =
  | { readonly status: 'manual_fallback'; readonly reason: 'not_configured'; readonly invitationId: string; readonly generation: number }
  | { readonly status: 'existing_attempt' | 'recorded'; readonly attempt: AttemptReference }
  | { readonly status: 'uncertain'; readonly lastKnownAttempt: AttemptReference };

export interface InvitationDeliveryServiceOptions {
  readonly publicBaseUrl: string;
  readonly supportEmail: string;
  readonly describeRole: (role: IssuedInvitation['invitation']['intendedRoles'][number]) => InvitationEmailAccess;
}

/**
 * Internal immediate issue/regenerate delivery only; never deserialize an
 * IssuedInvitation from browser JSON. Caller owns authorization/rate limits and
 * its one-time manual-copy response. No raw credential enters an outcome/ledger.
 */
export class InvitationDeliveryService {
  private readonly options: InvitationDeliveryServiceOptions;
  constructor(
    private readonly store: IInvitationDeliveryStore,
    private readonly sender: TransactionalEmailSender | null,
    options: InvitationDeliveryServiceOptions,
  ) { this.options = { ...options }; }

  async deliver(issued: IssuedInvitation, correlationId: string, audit: InvitationManagementAudit): Promise<InvitationDeliveryOutcome> {
    // Snapshot all mutable input before awaiting the reservation; the secret and
    // rendered body live only in this call. Strings cannot be reliably zeroized.
    const invitationId = issued.invitation.id;
    const generation = issued.invitation.currentGeneration.generation;
    const credential = issued.credential;
    const to = issued.invitation.emailOriginal;
    const recipientName = issued.invitation.intendedDisplayName;
    const roles = [...issued.invitation.intendedRoles];
    const issuedAt = new Date(issued.invitation.currentGeneration.issuedAt);
    const expiresAt = new Date(issued.invitation.currentGeneration.expiresAt);
    const ownedAudit = copyAudit(audit);
    let message: ReturnType<typeof renderInvitationEmail>;
    try {
      const parsed = parseInvitationToken(credential);
      try {
        if (parsed.invitationId !== invitationId || parsed.generation !== generation) throw new Error('Credential context mismatch');
      } finally { parsed.secret.fill(0); }
      if (!this.sender) return { status: 'manual_fallback', reason: 'not_configured', invitationId, generation };
      message = renderInvitationEmail({ publicBaseUrl: this.options.publicBaseUrl, supportEmail: this.options.supportEmail,
        credential, recipientName, intendedAccess: roles.map(this.options.describeRole), issuedAt, expiresAt });
    } catch { throw new InvitationError('invitation_invalid', 'Invalid invitation email request'); }

    let reservation: InvitationDeliveryReservation;
    try {
      reservation = await this.store.runMutation(ownedAudit, mutation =>
        mutation.reserveDeliveryAttempt(invitationId, generation, 'smtp', correlationId));
    } catch (error) {
      throw new InvitationError(error instanceof InvitationError ? error.code : 'concurrent_update', 'Invitation delivery reservation is unavailable');
    }
    // Never expose/replay this transient authorization bit in a generic result.
    if (!reservation.submissionAuthorized) return { status: 'existing_attempt', attempt: reference(reservation) };

    let update: InvitationDeliveryResultUpdate;
    try {
      update = ledgerResult(await this.sender.sendTransactionalEmail({ to, ...message }), credential);
    } catch {
      // A thrown call or malformed provider result cannot prove non-acceptance.
      update = { state: 'unknown', failureClass: 'unknown' };
    }
    try {
      const recorded = await this.store.runMutation(ownedAudit, mutation => mutation.recordDeliveryResult(reservation.id, update));
      return { status: 'recorded', attempt: reference(recorded) };
    } catch {
      // Submission may have succeeded, and the result commit may itself be
      // ambiguous. Keep the last known reservation; never re-submit or invent
      // failed. Operators recover by inspecting history/explicit regeneration.
      return { status: 'uncertain', lastKnownAttempt: reference(reservation) };
    }
  }
}

function reference(attempt: InvitationDeliveryAttemptView): AttemptReference {
  return { id: attempt.id, invitationId: attempt.invitationId, generation: attempt.generation, version: attempt.version, state: attempt.state };
}

function ledgerResult(result: EmailSubmissionResult, credential: string): InvitationDeliveryResultUpdate {
  if (result?.state === 'submitted') {
    // Even a malformed adapter must not echo the known credential or its secret
    // into a superficially valid opaque provider ID.
    if (typeof result.providerMessageId === 'string' && result.providerMessageId.includes(credential.split('.')[3])) {
      return { state: 'unknown', failureClass: 'unknown' };
    }
    return sanitizeDeliveryResult({ state: 'submitted', providerMessageId: result.providerMessageId,
      sanitizedDetail: { providerAccepted: true } });
  }
  if (result?.state === 'failed') {
    const classes = { authentication: 'authentication', tls: 'configuration', connection: 'not_sent', rejected: 'not_sent' } as const;
    if (Object.hasOwn(classes, result.failureClass)) {
      return { state: 'failed', failureClass: classes[result.failureClass], sanitizedDetail: { providerAccepted: false } };
    }
  }
  return { state: 'unknown', failureClass: 'unknown' };
}
