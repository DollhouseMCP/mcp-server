import type { InvitationDeliveryService } from '../../../invitations/InvitationDeliveryService.js';
import type { InvitationManagementAudit } from '../../../invitations/IInvitationManagementStore.js';
import type { IssuedInvitation } from '../../../invitations/InvitationTypes.js';

export type DurableInvitationDeliveryState = 'not_attempted' | 'submitting' | 'submitted' | 'failed' | 'unknown';
export interface DurableInvitationDeliveryDto {
  readonly status: 'manual_fallback' | 'recorded' | 'existing_attempt' | 'uncertain' | 'unavailable';
  readonly state: DurableInvitationDeliveryState;
  readonly reason?: 'not_configured';
  readonly last_known_state?: DurableInvitationDeliveryState;
}
const unavailable = (): DurableInvitationDeliveryDto => ({ status: 'unavailable', state: 'unknown' });

/** Immediate server-owned issuance only. Never retry or let delivery erase the committed one-time response. */
export async function deliverAdminInvitation(
  service: Pick<InvitationDeliveryService, 'deliver'> | null | undefined,
  issued: IssuedInvitation, correlationId: string, audit: InvitationManagementAudit,
): Promise<DurableInvitationDeliveryDto> {
  if (!service) return { status: 'manual_fallback', state: 'not_attempted', reason: 'not_configured' };
  try {
    const result = await service.deliver(issued, correlationId, audit);
    if (result?.status === 'manual_fallback' && result.reason === 'not_configured') {
      return { status: 'manual_fallback', state: 'not_attempted', reason: 'not_configured' };
    }
    if (result?.status === 'uncertain') {
      return { status: 'uncertain', state: 'unknown', last_known_state: safeState(result.lastKnownAttempt?.state) };
    }
    if (result?.status === 'recorded' || result?.status === 'existing_attempt') {
      return { status: result.status, state: safeState(result.attempt?.state) };
    }
    return unavailable();
  } catch { return unavailable(); } // No raw adapter/SMTP error, credential, or provider metadata is returned/logged.
}

/** Copy only fixed enums, including when the module privacy projector is applied. */
export function projectAdminDelivery(value: DurableInvitationDeliveryDto): DurableInvitationDeliveryDto {
  if (value.status === 'manual_fallback' && value.reason === 'not_configured') {
    return { status: 'manual_fallback', state: 'not_attempted', reason: 'not_configured' };
  }
  if (value.status === 'uncertain') return { status: 'uncertain', state: 'unknown', last_known_state: safeState(value.last_known_state) };
  if (value.status === 'recorded' || value.status === 'existing_attempt') return { status: value.status, state: safeState(value.state) };
  return unavailable();
}
function safeState(value: unknown): DurableInvitationDeliveryState {
  return value === 'not_attempted' || value === 'submitting' || value === 'submitted' || value === 'failed' ? value : 'unknown';
}
