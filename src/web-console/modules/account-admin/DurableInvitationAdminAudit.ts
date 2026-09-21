import { appendSecurityAuditEventWithTx } from '../../../security/auditSink.js';
import type { InvitationManagementAudit } from '../../../invitations/IInvitationManagementStore.js';
import { buildConsoleAdminAuditEvent } from '../../middleware/ConsoleAdminAudit.js';
import { appendConsoleAdminAuditEventWithTx, type AdminAuditHmacKeyResolver } from '../../audit/PostgresAdminAuditWriter.js';
import type { ConsoleRequest, ConsoleRouteDefinition } from '../../platform/ConsolePlatformTypes.js';

export type DurableInvitationAdminAuditFactory = (
  req: ConsoleRequest, route: ConsoleRouteDefinition,
) => Promise<Extract<InvitationManagementAudit, { kind: 'admin' }>>;

/** Resolve key material before the invitation transaction acquires any locks. */
export function createDurableInvitationAdminAuditFactory(keys: AdminAuditHmacKeyResolver): DurableInvitationAdminAuditFactory {
  return async (req, route) => {
    const context = buildConsoleAdminAuditEvent(route, route.auditOperation!, req, 'approved', null, new Date());
    const key = await keys.resolve();
    return { kind: 'admin', adminContext: context, appendSecurityEvent: appendSecurityAuditEventWithTx,
      appendAdminEvent: (tx, event) => appendConsoleAdminAuditEventWithTx(tx, event, { resolve: async () => key }) };
  };
}
