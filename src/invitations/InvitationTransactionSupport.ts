import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import type { DrizzleTx } from '../database/db-utils.js';
import { accountInvitations as invitations, accountInvitationGenerations as generations } from '../database/schema/invitations.js';
import { users } from '../database/schema/users.js';
import { validateConsoleAdminAuditEvent } from '../web-console/audit/IAdminAuditWriter.js';
import type { InvitationManagementAudit } from './IInvitationManagementStore.js';
import { InvitationError, type InvitationView } from './InvitationTypes.js';

/** Internal shared transaction primitives; callers own transaction, authorization and audit. */
export async function lockAccounts(tx: DrizzleTx): Promise<void> {
  // Existing account writers do not share an invitation advisory-lock namespace,
  // and users.email has no canonical unique constraint. This short, coarse lock
  // closes insert/update phantom races with those writers. EXCLUSIVE also conflicts
  // with SELECT FOR UPDATE's ROW SHARE, avoiding a row-lock/table-upgrade deadlock.
  // Narrow only once all
  // account writers share a canonical uniqueness/locking protocol.
  await tx.execute(sql`LOCK TABLE users IN EXCLUSIVE MODE`);
}

export async function lockInvitation(tx: DrizzleTx, invitationId: string, allowRevoked = false): Promise<InvitationView> {
  await lockAccounts(tx);
  const [row] = await tx.select({ id: invitations.id }).from(invitations)
    .where(eq(invitations.id, invitationId)).for('update');
  if (!row) throw new InvitationError('invitation_not_found', 'Invitation not found');
  const view = await requireInvitation(tx, invitationId);
  // Revoke retries acknowledge terminal state without changing an unavailable account.
  if (allowRevoked && view.state === 'revoked' && view.currentGeneration.state === 'revoked') return view;
  const [user] = await tx.select().from(users).where(eq(users.id, view.userId)).for('update');
  if (!user || user.activationState !== 'pending_activation') {
    throw new InvitationError('account_not_pending', 'Invitation account is not pending');
  }
  if (user.disabledAt || user.deletedAt) throw new InvitationError('invitation_invalid', 'Invitation account is unavailable');
  return view;
}

export async function databaseTime(tx: DrizzleTx): Promise<Date> {
  // clock_timestamp is read AFTER locks: transaction_timestamp can precede a long lock wait.
  const rows = await tx.execute(sql`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`);
  return new Date(rows[0].now as string | Date);
}

export async function readInvitation(tx: DrizzleTx, invitationId: string): Promise<InvitationView | null> {
  const { credentialHash: _hash, invitationId: _id, ...generationColumns } = getTableColumns(generations);
  const [row] = await tx.select({
    invitation: invitations, generation: generationColumns,
    intendedRoles: sql<InvitationView['intendedRoles']>`COALESCE((
      SELECT jsonb_agg(role ORDER BY role) FROM account_invitation_intended_roles
      WHERE invitation_id = ${invitations.id}
    ), '[]'::jsonb)`,
  }).from(invitations).innerJoin(generations, and(
    eq(generations.invitationId, invitations.id), eq(generations.generation, invitations.currentGeneration),
  )).where(eq(invitations.id, invitationId));
  if (!row) return null;
  return { ...row.invitation, currentGeneration: row.generation, intendedRoles: row.intendedRoles };
}

export async function requireInvitation(tx: DrizzleTx, invitationId: string): Promise<InvitationView> {
  const view = await readInvitation(tx, invitationId);
  if (!view) throw new InvitationError('invitation_invalid', 'Invitation generation is unavailable');
  return view;
}

export async function appendAudit(tx: DrizzleTx, audit: InvitationManagementAudit, operation: string, view: InvitationView, correlationId: string, now: Date): Promise<void> {
  const metadata = { invitationId: view.id, generation: view.currentGeneration.generation, userId: view.userId, correlationId };
  await audit.appendSecurityEvent(tx, {
    eventType: `invitation.${operation}`, targetId: view.id, occurredAt: now.getTime(),
    ...(audit.kind === 'admin' ? { actorId: audit.adminContext.actorUserId } : {}), metadata,
  });
  if (audit.kind === 'admin') {
    const event = {
      ...audit.adminContext, occurredAt: now, correlationId, operation: `invitation.${operation}`,
      resourceKind: 'account_invitation', resourceId: view.id, targetUserId: view.userId,
      argsRedacted: metadata, result: 'approved' as const, errorCode: null, resultDetailRedacted: null,
    };
    validateConsoleAdminAuditEvent(event);
    await audit.appendAdminEvent(tx, event);
  }
}

export function copyAudit(audit: InvitationManagementAudit): InvitationManagementAudit {
  if (!audit || typeof audit.appendSecurityEvent !== 'function' || !['admin', 'system'].includes(audit.kind)) {
    throw new InvitationError('configuration_invalid', 'Transaction-scoped invitation audit is required');
  }
  const appendSecurityEvent = audit.appendSecurityEvent.bind(audit);
  if (audit.kind === 'system') return { kind: 'system', appendSecurityEvent };
  if (typeof audit.appendAdminEvent !== 'function' || !audit.adminContext) {
    throw new InvitationError('configuration_invalid', 'Transaction-scoped administrator audit is required');
  }
  return {
    kind: 'admin', appendSecurityEvent, appendAdminEvent: audit.appendAdminEvent.bind(audit),
    adminContext: {
      ...audit.adminContext, actorConsoleSessionHash: Buffer.from(audit.adminContext.actorConsoleSessionHash),
      elevationAmr: [...audit.adminContext.elevationAmr],
      elevationAuthTime: audit.adminContext.elevationAuthTime ? new Date(audit.adminContext.elevationAuthTime) : null,
    },
  };
}

export function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new InvitationError('invitation_invalid', 'Invitation identifiers must be UUIDs');
  }
}

export async function lockAdminAudit(tx: DrizzleTx, audit: InvitationManagementAudit): Promise<void> {
  if (audit.kind !== 'admin') return;
  // Ordinary audit writers own the chain head before checking users FKs. Never
  // wait on them while holding users EXCLUSIVE. A table preflight also covers
  // the initial INSERT/unique check when the chain head does not exist yet.
  // NOWAIT failure aborts the DB transaction, including every previously held lock.
  await tx.execute(sql`LOCK TABLE admin_audit_chain_heads IN EXCLUSIVE MODE NOWAIT`);
}
