import type { DrizzleTx } from '../database/db-utils.js';
import type { IInvitationStore, InvitationStoreMutation, LockedInvitationActivationCandidate } from './IInvitationStore.js';
import type { InvitationManagementAudit } from './IInvitationManagementStore.js';

export type InvitationClaimMutation = Pick<InvitationStoreMutation, 'beginClaim'>;
export type InvitationActivationCandidateInput = Parameters<IInvitationStore['lockActivationCandidateWithTx']>[1];

/** Claiming proves email credential custody; it does not activate or create a normal session. */
export interface IInvitationClaimStore {
  runMutation<T>(
    audit: InvitationManagementAudit,
    operation: (mutation: InvitationClaimMutation) => Promise<T>,
  ): Promise<T>;
  /** Transaction remains owned by #2681, including activation and its audit writes. */
  lockActivationCandidateWithTx(
    tx: DrizzleTx,
    input: InvitationActivationCandidateInput,
  ): Promise<LockedInvitationActivationCandidate>;
}
