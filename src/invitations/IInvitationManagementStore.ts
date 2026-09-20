import type { ConsoleAdminAuditEvent } from '../web-console/audit/IAdminAuditWriter.js';
import type { InvitationStoreMutation, InvitationTransactionAudit } from './IInvitationStore.js';
import type { InvitationView } from './InvitationTypes.js';

/** Actor context must come from the authenticated administrator, never request JSON. */
export type InvitationAdminAuditContext = Pick<ConsoleAdminAuditEvent,
  'actorUserId' | 'actorSub' | 'actorRole' | 'actorCapabilityRole' |
  'actorConsoleSessionHash' | 'capability' | 'elevationAcr' | 'elevationAmr' |
  'elevationAuthTime' | 'endpoint' | 'clientIp' | 'userAgent'>;

export type InvitationManagementAudit =
  | Extract<InvitationTransactionAudit, { kind: 'system' }>
  | (Extract<InvitationTransactionAudit, { kind: 'admin' }> & {
    readonly adminContext: InvitationAdminAuditContext;
  });

export type InvitationManagementMutation = Pick<InvitationStoreMutation,
  'issue' | 'regenerate' | 'revoke'>;

/** Deliberately partial lifecycle: no claim, activation, delivery or cleanup implementation. */
export interface IInvitationManagementStore {
  inspect(invitationId: string): Promise<InvitationView | null>;
  runMutation<T>(
    audit: InvitationManagementAudit,
    operation: (mutation: InvitationManagementMutation) => Promise<T>,
  ): Promise<T>;
}
