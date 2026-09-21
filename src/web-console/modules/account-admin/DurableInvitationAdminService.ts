import type { InvitationDeliveryService } from '../../../invitations/InvitationDeliveryService.js';
import { deliverAdminInvitation } from './DurableInvitationAdminDelivery.js';
import type { IRateLimitStore } from '../../../auth/embedded-as/storage/IRateLimitStore.js';
import type { IInvitationManagementStore } from '../../../invitations/IInvitationManagementStore.js';
import { InvitationManagementService } from '../../../invitations/InvitationManagementService.js';
import { buildInvitationClaimLink, invitationPublicOrigin } from '../../../invitations/InvitationClaimLink.js';
import { MIN_INVITATION_TTL_HOURS, MAX_INVITATION_TTL_HOURS } from '../../../invitations/InvitationConfig.js';
import { InvitationError } from '../../../invitations/InvitationTypes.js';
import type { IAdminAuditWriter } from '../../audit/IAdminAuditWriter.js';
import { buildConsoleAdminAuditEvent } from '../../middleware/ConsoleAdminAudit.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import { requireConsoleRequestContext } from '../../platform/ConsoleRequestContext.js';
import type { ConsoleHandlerResult, ConsoleRequest, ConsoleRouteDefinition } from '../../platform/ConsolePlatformTypes.js';
import { assertAdminRole, type ConsoleAdminRole } from '../../stores/IConsoleAccountAdminStore.js';
import { assertUuid } from '../../stores/ConsoleStoreValidation.js';
import { rolesActorMayNotManage } from './AccountAdminRoleAuthority.js';
import type { DurableInvitationAdminAuditFactory } from './DurableInvitationAdminAudit.js';
import { invitationAdminDto } from './DurableInvitationAdminDtos.js';

export type InvitationAdminAction = 'issue' | 'inspect' | 'inspect_account' | 'regenerate' | 'revoke';
export interface DurableInvitationAdminOptions {
  readonly store: IInvitationManagementStore;
  readonly auditFactory: DurableInvitationAdminAuditFactory;
  readonly auditWriter: IAdminAuditWriter;
  readonly rateLimits: IRateLimitStore;
  readonly publicBaseUrl: string;
  readonly delivery?: Pick<InvitationDeliveryService, 'deliver'> | null;
}
class RequestFailure extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }

/** Request-scoped authorization and immediate delivery composition; no ordinary session issuance. */
export class DurableInvitationAdminService {
  private readonly origin: string;
  constructor(private readonly options: DurableInvitationAdminOptions) {
    this.origin = invitationPublicOrigin(options.publicBaseUrl);
    if (!options.rateLimits?.update) throw new Error('Invitation admission is required');
  }

  async execute(action: InvitationAdminAction, req: ConsoleRequest, route: ConsoleRouteDefinition): Promise<ConsoleHandlerResult> {
    let result: ConsoleHandlerResult;
    try { result = await this.perform(action, req, route); }
    catch (error) {
      const failure = error instanceof RequestFailure ? error : error instanceof InvitationError
        ? new RequestFailure(error.code === 'invitation_invalid' ? 400 : error.code === 'invitation_not_found' ? 404 :
          error.code === 'configuration_invalid' || error.code === 'concurrent_update' ? 503 : 409, error.code)
        : new RequestFailure(503, 'service_unavailable');
      result = { status: failure.status, body: { code: failure.code, title: 'Invitation request unavailable',
        detail: 'The invitation request could not be completed.' } };
    }
    // Successful mutations already appended both audits inside the store transaction.
    if (action === 'inspect' || action === 'inspect_account' || result.status >= 400) {
      try {
        await this.options.auditWriter.write(buildConsoleAdminAuditEvent(route, route.auditOperation!, req,
          result.status < 400 ? 'approved' : result.status >= 500 ? 'failed' : 'rejected',
          result.status < 400 ? null : (result.body as { code: string }).code, new Date()));
      } catch { throw new Error('Invitation administrative audit unavailable'); }
    }
    return { ...result, headers: { 'Cache-Control': 'no-store' } };
  }

  private async perform(action: InvitationAdminAction, req: ConsoleRequest, route: ConsoleRouteDefinition): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const correlationId = requireConsoleRequestContext(req).correlationId;
    if (Object.keys(req.query).length) throw new RequestFailure(400, 'invalid_request');
    if (action !== 'inspect' && action !== 'inspect_account') await this.admit(actor.userId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowed = action === 'issue' ? ['username', 'display_name', 'email', 'intended_roles', 'ttl_hours'] :
      action === 'regenerate' ? ['ttl_hours'] : [];
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) invalid();
    if (body.ttl_hours !== undefined && (!Number.isInteger(body.ttl_hours) || Number(body.ttl_hours) < MIN_INVITATION_TTL_HOURS || Number(body.ttl_hours) > MAX_INVITATION_TTL_HOURS)) invalid();
    const ttlHours = body.ttl_hours as number | undefined;
    const id = action === 'issue' ? null : req.params[action === 'inspect_account' ? 'user_id' : 'invitation_id'];
    if (id !== null) { if (typeof id !== 'string') invalid(); try { assertUuid(id, 'invitation_id'); } catch { invalid(); } }
    const existing = id === null ? null : action === 'inspect_account'
      ? await this.options.store.inspectForUser(id as string) : await this.options.store.inspect(id as string);
    if (id !== null && !existing) throw new RequestFailure(404, 'invitation_not_found');
    let roles: ConsoleAdminRole[] = existing ? [...existing.intendedRoles] : [];
    if (action === 'issue') {
      for (const key of ['username', 'email']) if (typeof body[key] !== 'string' || (body[key] as string).length > 254) invalid();
      if (body.display_name !== null && (typeof body.display_name !== 'string' || body.display_name.length > 256)) invalid();
      if (!Array.isArray(body.intended_roles) || body.intended_roles.length > 5) invalid();
      try { roles = body.intended_roles.map(role => { assertAdminRole(role, 'intended_roles'); return role; }); } catch { return invalid(); }
      if (new Set(roles).size !== roles.length) invalid();
    }
    if (rolesActorMayNotManage(req, roles).length) throw new RequestFailure(403, 'insufficient_role_authority');
    if (action === 'inspect' || action === 'inspect_account') return { status: 200, body: invitationAdminDto(existing!) };
    const audit = await this.options.auditFactory(req, route);
    const service = new InvitationManagementService(this.options.store, audit);
    if (action === 'revoke') return { status: 200, body: invitationAdminDto(await service.revoke({ invitationId: id as string, correlationId })) };
    const issued = action === 'issue' ? await service.issue({ username: body.username as string,
      displayName: body.display_name as string | null, email: body.email as string, intendedRoles: roles,
      inviterUserId: actor.userId, correlationId, ttlHours }) : await service.regenerate({ invitationId: id as string, correlationId, ttlHours });
    // Snapshot the committed manual-copy response before immediate delivery. A
    // submission/reservation failure must never discard it or trigger a resend.
    const bodyResult = invitationAdminDto(issued.invitation, buildInvitationClaimLink(this.origin, issued.credential));
    const delivery = await deliverAdminInvitation(this.options.delivery, issued, correlationId, audit);
    return { status: action === 'issue' ? 201 : 200, body: { ...bodyResult, delivery } };
  }

  private async admit(userId: string): Promise<void> {
    const now = Date.now();
    const until = (Math.floor(now / 60000) + 1) * 60000;
    for (const [key, limit] of [[`actor:${userId}`, 20], ['deployment', 100]] as const) {
      const admission = await this.options.rateLimits.update<{ until: number; count: number }, boolean>('durable_invitation_admin', key, previous => {
        const count = previous?.until === until ? previous.count : 0;
        return { state: { until, count: count + 1 }, result: count < limit };
      }, { expiresAt: until });
      if (admission.result !== true) throw new RequestFailure(429, 'rate_limited');
    }
  }
}

function invalid(): never { throw new RequestFailure(400, 'invalid_request'); }
