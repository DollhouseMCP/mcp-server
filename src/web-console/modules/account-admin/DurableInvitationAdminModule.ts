import type { ConsoleModuleDescriptor, ConsoleRouteDefinition } from '../../platform/ConsolePlatformTypes.js';
import { DurableInvitationAdminService, type DurableInvitationAdminOptions, type InvitationAdminAction } from './DurableInvitationAdminService.js';
import { projectInvitationAdminDto } from './DurableInvitationAdminDtos.js';

/** Unregistered: callers must use the secured console assembler; no live mount or UI is added. */
export function createDurableInvitationAdminModule(options: DurableInvitationAdminOptions): ConsoleModuleDescriptor {
  const service = new DurableInvitationAdminService(options);
  const actions: InvitationAdminAction[] = ['issue', 'inspect', 'inspect_account', 'regenerate', 'revoke'];
  return { id: 'durable_invitation_admin', apiVersion: 'v1', capabilities: ['console:admin:accounts'],
    auditOperations: actions.map(action => ({ id: `invitation.admin.${action}` })),
    routes: actions.map(action => {
      const secret = action === 'issue' || action === 'regenerate';
      const route: ConsoleRouteDefinition = {
        method: action === 'inspect' || action === 'inspect_account' ? 'GET' : 'POST',
        path: action === 'inspect_account' ? '/api/v1/admin/accounts/users/:user_id/invitation' : '/api/v1/admin/accounts/invitations' + (action === 'issue' ? '' : '/:invitation_id') +
          (action === 'regenerate' || action === 'revoke' ? `/${action}` : ''),
        audience: 'admin', requiredCapability: 'console:admin:accounts', elevation: 'admin_30m', privacyClass: 'account_metadata',
        // Never persist the one-time link, even if a caller supplies Idempotency-Key.
        idempotency: 'not_applicable', auditExecution: 'handler_transaction', auditOperation: `invitation.admin.${action}`,
        privacyProjector: value => projectInvitationAdminDto(value, secret),
        handler: req => service.execute(action, req, route),
      };
      return route;
    }) };
}
