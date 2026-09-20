import type { InvitationManagementAudit } from './IInvitationManagementStore.js';
import type { InvitationStoreMutation } from './IInvitationStore.js';
import type { InvitationDeliveryAttemptView } from './InvitationTypes.js';

export type { InvitationDeliveryReservation } from './InvitationTypes.js';

export type InvitationDeliveryMutation = Pick<InvitationStoreMutation,
  'reserveDeliveryAttempt' | 'recordDeliveryResult'>;

/** Internal transactional bookkeeping only; performs no provider/network calls. */
export interface IInvitationDeliveryStore {
  list(invitationId: string): Promise<readonly InvitationDeliveryAttemptView[]>;
  runMutation<T>(
    audit: InvitationManagementAudit,
    operation: (mutation: InvitationDeliveryMutation) => Promise<T>,
  ): Promise<T>;
}
