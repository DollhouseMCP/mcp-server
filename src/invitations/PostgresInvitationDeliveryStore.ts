import { isDeepStrictEqual } from 'node:util';
import { and, desc, eq, sql } from 'drizzle-orm';

import { withSystemContext } from '../database/admin.js';
import type { DatabaseInstance } from '../database/connection.js';
import { getErrorCode, isSerializationFailure, isUniqueViolation, type DrizzleTx } from '../database/db-utils.js';
import {
  accountInvitations as invitations,
  accountInvitationDeliveryAttempts as attempts,
} from '../database/schema/invitations.js';
import { users } from '../database/schema/users.js';
import { validateConsoleAdminAuditEvent } from '../web-console/audit/IAdminAuditWriter.js';
import type { InvitationManagementAudit } from './IInvitationManagementStore.js';
import type { IInvitationDeliveryStore, InvitationDeliveryMutation, InvitationDeliveryReservation } from './IInvitationDeliveryStore.js';
import { sanitizeDeliveryResult, validateDeliveryProvider } from './InvitationDeliveryMetadata.js';
import {
  assertUuid, copyAudit, databaseTime, lockAccounts, lockInvitation, lockAdminAudit, requireInvitation,
} from './InvitationTransactionSupport.js';
import {
  InvitationError, type InvitationDeliveryAttemptView, type InvitationDeliveryResultUpdate, type InvitationView,
} from './InvitationTypes.js';

/** No email is sent here. Callers must commit a reservation before submitting. */
export class PostgresInvitationDeliveryStore implements IInvitationDeliveryStore {
  constructor(private readonly db: DatabaseInstance) {}

  async list(invitationId: string): Promise<readonly InvitationDeliveryAttemptView[]> {
    assertUuid(invitationId);
    return withSystemContext(this.db, async tx => {
      const rows = await tx.select().from(attempts).where(eq(attempts.invitationId, invitationId))
        .orderBy(desc(attempts.generation), desc(attempts.attemptNumber));
      return rows.map(deliveryView);
    });
  }

  async runMutation<T>(
    audit: InvitationManagementAudit,
    operation: (mutation: InvitationDeliveryMutation) => Promise<T>,
  ): Promise<T> {
    const ownedAudit = copyAudit(audit);
    try {
      return await withSystemContext(this.db, tx => operation(createInvitationDeliveryMutation(tx, ownedAudit)));
    } catch (error) {
      if (isSerializationFailure(error) || isUniqueViolation(error) || getErrorCode(error) === '55P03') {
        throw new InvitationError('concurrent_update', 'Invitation delivery transaction conflicted');
      }
      throw error;
    }
  }
}

export function createInvitationDeliveryMutation(tx: DrizzleTx, audit: InvitationManagementAudit): InvitationDeliveryMutation {
  const ownedAudit = copyAudit(audit);
  return {
    reserveDeliveryAttempt: (invitationId, generation, provider, correlationId) =>
      reserve(tx, ownedAudit, invitationId, generation, provider, correlationId),
    recordDeliveryResult: (attemptId, update) => recordResult(tx, ownedAudit, attemptId, update),
  };
}

async function reserve(
  tx: DrizzleTx, audit: InvitationManagementAudit,
  invitationId: string, generation: number, provider: string | null, correlationId: string,
): Promise<InvitationDeliveryReservation> {
  assertUuid(invitationId);
  assertUuid(correlationId);
  validateDeliveryProvider(provider);
  if (!Number.isInteger(generation) || generation < 1 || generation > 2_147_483_647) invalid('Invalid invitation generation');
  // Same lock order as issue/regenerate/revoke, including their users table lock.
  const invitation = await lockInvitation(tx, invitationId);
  await lockAdminAudit(tx, audit);
  if (invitation.currentGeneration.generation !== generation) {
    throw new InvitationError('invitation_superseded', 'Invitation generation is no longer current');
  }
  if (invitation.state !== 'pending' || invitation.currentGeneration.state !== 'pending') invalid('Invitation is not pending');
  const now = await databaseTime(tx);
  if (invitation.currentGeneration.expiresAt <= now) throw new InvitationError('invitation_expired', 'Invitation expired');

  const previous = await tx.select().from(attempts).where(and(
    eq(attempts.invitationId, invitationId), eq(attempts.generation, generation),
  )).orderBy(desc(attempts.attemptNumber));
  const replay = previous.find(attempt => attempt.correlationId === correlationId);
  if (replay) {
    if (replay.provider !== provider) conflict();
    return { ...deliveryView(replay), submissionAuthorized: false };
  }
  const latest = previous[0];
  // A reservation whose outcome is not known must never result in another send.
  // Successful submission also needs an explicit regeneration for a new send.
  if (latest && latest.state !== 'failed' && latest.state !== 'not_attempted') conflict();
  if (latest?.attemptNumber === 2_147_483_647) invalid('Invitation attempt limit reached');
  const [row] = await tx.insert(attempts).values({
    invitationId, generation, attemptNumber: (latest?.attemptNumber ?? 0) + 1,
    state: 'submitting', provider, correlationId,
    requestedAt: now, startedAt: now, completedAt: null,
  }).returning();
  const attempt = deliveryView(row);
  await appendDeliveryAudit(tx, audit, 'reserved', invitation, attempt, now);
  return { ...attempt, submissionAuthorized: true };
}

async function recordResult(
  tx: DrizzleTx, audit: InvitationManagementAudit, attemptId: string, update: InvitationDeliveryResultUpdate,
): Promise<InvitationDeliveryAttemptView> {
  assertUuid(attemptId);
  const owned = sanitizeDeliveryResult(update);
  // Locate without locking, then acquire users → invitation → attempt locks.
  const [location] = await tx.select({ invitationId: attempts.invitationId }).from(attempts).where(eq(attempts.id, attemptId));
  if (!location) throw new InvitationError('invitation_not_found', 'Invitation delivery attempt not found');
  await lockAccounts(tx);
  await lockAdminAudit(tx, audit);
  await tx.select({ id: invitations.id }).from(invitations).where(eq(invitations.id, location.invitationId)).for('update');
  const invitation = await requireInvitation(tx, location.invitationId);
  // Deletion scrubs retained invitation/delivery metadata. The users table lock
  // serializes this read with deletion so late provider results cannot restore it.
  const [user] = await tx.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, invitation.userId));
  if (!user || user.deletedAt) invalid('Invitation account is unavailable');
  const [current] = await tx.select().from(attempts).where(eq(attempts.id, attemptId)).for('update');
  if (!current) throw new InvitationError('invitation_not_found', 'Invitation delivery attempt not found');
  if (current.state !== 'submitting') {
    if (current.state === owned.state && current.failureClass === owned.failureClass &&
      current.providerMessageId === owned.providerMessageId && isDeepStrictEqual(current.sanitizedDetail, owned.sanitizedDetail)) {
      return deliveryView(current);
    }
    conflict();
  }
  const now = await databaseTime(tx);
  const [row] = await tx.update(attempts).set({
    ...owned, completedAt: now, version: sql`${attempts.version} + 1`,
  }).where(eq(attempts.id, attemptId)).returning();
  const attempt = deliveryView(row);
  // Late results remain evidence for their original generation. They cannot
  // re-open the invitation or change account activation/current generation.
  await appendDeliveryAudit(tx, audit, owned.state, invitation, attempt, now);
  return attempt;
}

function deliveryView(row: typeof attempts.$inferSelect): InvitationDeliveryAttemptView {
  return { ...row, sanitizedDetail: row.sanitizedDetail as Readonly<Record<string, unknown>> | null };
}

async function appendDeliveryAudit(
  tx: DrizzleTx, audit: InvitationManagementAudit, operation: string,
  invitation: InvitationView, attempt: InvitationDeliveryAttemptView, now: Date,
): Promise<void> {
  const metadata = {
    invitationId: invitation.id, userId: invitation.userId, generation: attempt.generation,
    attemptId: attempt.id, attemptNumber: attempt.attemptNumber, state: attempt.state,
    correlationId: attempt.correlationId,
  };
  await audit.appendSecurityEvent(tx, {
    eventType: `invitation.delivery.${operation}`, targetId: invitation.id, occurredAt: now.getTime(), metadata,
    ...(audit.kind === 'admin' ? { actorId: audit.adminContext.actorUserId } : {}),
  });
  if (audit.kind === 'admin') {
    const event = {
      ...audit.adminContext, occurredAt: now, correlationId: attempt.correlationId,
      operation: `invitation.delivery.${operation}`, resourceKind: 'account_invitation',
      resourceId: invitation.id, targetUserId: invitation.userId, argsRedacted: metadata,
      result: 'approved' as const, errorCode: null, resultDetailRedacted: null,
    };
    validateConsoleAdminAuditEvent(event);
    await audit.appendAdminEvent(tx, event);
  }
}

function invalid(message: string): never {
  throw new InvitationError('invitation_invalid', message);
}

function conflict(): never {
  throw new InvitationError('invitation_conflict', 'Invitation delivery attempt cannot be retried or changed');
}
