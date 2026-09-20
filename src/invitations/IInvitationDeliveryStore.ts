import type { InvitationManagementAudit } from './IInvitationManagementStore.js';
import type { InvitationStoreMutation } from './IInvitationStore.js';
import type { InvitationDeliveryAttemptView } from './InvitationTypes.js';

export interface InvitationDeliveryReservation extends InvitationDeliveryAttemptView {
  /** Only the transaction that creates this reservation may submit after commit. */
  readonly submissionAuthorized: boolean;
}

export interface InvitationDeliveryMutation extends Pick<InvitationStoreMutation, 'recordDeliveryResult'> {
  reserveDeliveryAttempt(
    invitationId: string, generation: number, provider: string | null, correlationId: string,
  ): Promise<InvitationDeliveryReservation>;
}

/** Internal transactional bookkeeping only; performs no provider/network calls. */
export interface IInvitationDeliveryStore {
  list(invitationId: string): Promise<readonly InvitationDeliveryAttemptView[]>;
  runMutation<T>(
    audit: InvitationManagementAudit,
    operation: (mutation: InvitationDeliveryMutation) => Promise<T>,
  ): Promise<T>;
}
