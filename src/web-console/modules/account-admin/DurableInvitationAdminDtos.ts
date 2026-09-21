import { projectAdminDelivery, type DurableInvitationDeliveryDto } from './DurableInvitationAdminDelivery.js';
import type { InvitationView } from '../../../invitations/InvitationTypes.js';

export interface DurableInvitationAdminDto {
  readonly invitation: {
    readonly id: string; readonly user_id: string; readonly email: string;
    readonly username: string; readonly display_name: string | null;
    readonly intended_roles: InvitationView['intendedRoles']; readonly state: InvitationView['state'];
    readonly generation: number; readonly generation_state: InvitationView['currentGeneration']['state'];
    readonly issued_at: string; readonly expires_at: string;
  };
  readonly claim_url?: string;
  readonly delivery?: DurableInvitationDeliveryDto;
}

/** Domain objects never go directly to JSON, even on the immediate secret-bearing response. */
export function invitationAdminDto(view: InvitationView, claimUrl?: string): DurableInvitationAdminDto {
  return { invitation: { id: view.id, user_id: view.userId, email: view.emailOriginal,
    username: view.intendedUsername, display_name: view.intendedDisplayName, intended_roles: [...view.intendedRoles],
    state: view.state, generation: view.currentGeneration.generation, generation_state: view.currentGeneration.state,
    issued_at: view.currentGeneration.issuedAt.toISOString(), expires_at: view.currentGeneration.expiresAt.toISOString() },
  ...(claimUrl === undefined ? {} : { claim_url: claimUrl }) };
}

export function projectInvitationAdminDto(value: unknown, includeClaimUrl: boolean): DurableInvitationAdminDto {
  const dto = value as DurableInvitationAdminDto;
  const v = dto.invitation;
  return { invitation: { id: v.id, user_id: v.user_id, email: v.email, username: v.username,
    display_name: v.display_name, intended_roles: [...v.intended_roles], state: v.state,
    generation: v.generation, generation_state: v.generation_state, issued_at: v.issued_at, expires_at: v.expires_at },
  ...(includeClaimUrl && dto.claim_url !== undefined ? { claim_url: dto.claim_url } : {}),
  ...(includeClaimUrl && dto.delivery !== undefined ? { delivery: projectAdminDelivery(dto.delivery) } : {}) };
}
