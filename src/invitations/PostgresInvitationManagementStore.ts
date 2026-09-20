import { normalizeAuthAllowlistValue } from '../auth/embedded-as/allowlistIdentity.js';
import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { withSystemContext } from '../database/admin.js';
import type { DatabaseInstance } from '../database/connection.js';
import { isSerializationFailure, isUniqueViolation, type DrizzleTx } from '../database/db-utils.js';
import {
  accountInvitations as invitations,
  accountInvitationGenerations as generations,
  accountInvitationIntendedRoles as roles,
  accountInvitationClaimAssertions as claims,
} from '../database/schema/invitations.js';
import { users } from '../database/schema/users.js';
import { CONSOLE_ADMIN_AUDIT_ROLES, validateConsoleAdminAuditEvent } from '../web-console/audit/IAdminAuditWriter.js';
import type { InvitationIssueRecord, InvitationRegenerationRecord } from './IInvitationStore.js';
import type {
  IInvitationManagementStore, InvitationManagementAudit, InvitationManagementMutation,
} from './IInvitationManagementStore.js';
import { MAX_INVITATION_TTL_HOURS, MIN_INVITATION_TTL_HOURS } from './InvitationConfig.js';
import { normalizeInvitationEmail } from './InvitationEmail.js';
import { hashInvitationCredential, INVITATION_SECRET_BYTES, MAX_INVITATION_GENERATION } from './InvitationToken.js';
import { InvitationError, type InvitationView } from './InvitationTypes.js';

/** Internal, privileged storage only. Live routes must enforce pending-account denial first. */
export class PostgresInvitationManagementStore implements IInvitationManagementStore {
  constructor(private readonly db: DatabaseInstance) {}

  async inspect(invitationId: string): Promise<InvitationView | null> {
    assertUuid(invitationId);
    return withSystemContext(this.db, tx => readInvitation(tx, invitationId));
  }

  async runMutation<T>(
    audit: InvitationManagementAudit,
    operation: (mutation: InvitationManagementMutation) => Promise<T>,
  ): Promise<T> {
    const ownedAudit = copyAudit(audit);
    try {
      return await withSystemContext(this.db, tx => operation(createInvitationManagementMutation(tx, ownedAudit)));
    } catch (error) {
      if (isUniqueViolation(error)) throw new InvitationError('invitation_conflict', 'Invitation account or credential already exists');
      if (isSerializationFailure(error)) throw new InvitationError('concurrent_update', 'Invitation transaction conflicted');
      throw error;
    }
  }
}

/**
 * Composable transaction-owned seam. The caller owns commit/rollback and must not
 * retain this mutation object after its transaction ends. No hidden retry mints
 * a replacement credential. Later claim/delivery modules must lock users before
 * invitation rows, matching this module's lock order.
 */
export function createInvitationManagementMutation(
  tx: DrizzleTx,
  audit: InvitationManagementAudit,
): InvitationManagementMutation {
  const ownedAudit = copyAudit(audit);
  return {
    issue: input => issue(tx, ownedAudit, input),
    regenerate: input => regenerate(tx, ownedAudit, input),
    revoke: (invitationId, correlationId) => revoke(tx, ownedAudit, invitationId, correlationId),
  };
}

async function issue(tx: DrizzleTx, audit: InvitationManagementAudit, input: InvitationIssueRecord): Promise<InvitationView> {
  // Snapshot before the first await: readonly types do not protect buffers/arrays at runtime.
  const owned = { ...input, intendedRoles: [...input.intendedRoles], credentialSecret: Buffer.from(input.credentialSecret) };
  try {
    validateIssue(owned);
    await lockAccounts(tx);
    // Use the same NFC/trim/case rules as issuance, including older stored email
    // encodings. SQL lower/btrim alone diverges for Unicode case and whitespace.
    const accounts = await tx.select({ id: users.id, email: users.email, username: users.username }).from(users);
    if (accounts.some(account => account.id === owned.userId ||
        account.username.toLowerCase() === owned.username.toLowerCase() ||
        (account.email !== null && normalizeAuthAllowlistValue('email', account.email) === owned.emailNormalized))) {
      throw new InvitationError('invitation_conflict', 'Invitation account already exists');
    }
    if (audit.kind === 'admin' && audit.adminContext.actorUserId !== owned.inviterUserId) {
      throw new InvitationError('invitation_invalid', 'Invitation issuer does not match audit actor');
    }
    const [inviter] = await tx.select({ id: users.id }).from(users).where(and(
      eq(users.id, owned.inviterUserId), eq(users.activationState, 'active'),
      sql`${users.disabledAt} IS NULL AND ${users.deletedAt} IS NULL`,
    ));
    if (!inviter) throw new InvitationError('invitation_invalid', 'Invitation issuer is unavailable');
    const now = await databaseTime(tx);
    await tx.insert(users).values({
      id: owned.userId, username: owned.username, displayName: owned.displayName,
      email: owned.emailNormalized, activationState: 'pending_activation', createdAt: now, updatedAt: now,
    });
    await tx.insert(invitations).values({
      id: owned.invitationId, userId: owned.userId, emailOriginal: owned.emailOriginal,
      emailNormalized: owned.emailNormalized, inviterUserId: owned.inviterUserId,
      intendedDisplayName: owned.displayName, intendedUsername: owned.username,
      currentGeneration: 1, correlationId: owned.correlationId, createdAt: now, updatedAt: now,
    });
    if (owned.intendedRoles.length) await tx.insert(roles).values(
      owned.intendedRoles.map(role => ({ invitationId: owned.invitationId, role })),
    );
    await insertGeneration(tx, owned.invitationId, 1, owned.emailNormalized, owned.credentialSecret, owned.ttlHours, now);
    const view = await requireInvitation(tx, owned.invitationId);
    await appendAudit(tx, audit, 'issued', view, owned.correlationId, now);
    return view;
  } finally {
    owned.credentialSecret.fill(0);
  }
}

async function regenerate(tx: DrizzleTx, audit: InvitationManagementAudit, input: InvitationRegenerationRecord): Promise<InvitationView> {
  const owned = { ...input, credentialSecret: Buffer.from(input.credentialSecret) };
  try {
    assertUuid(owned.invitationId);
    assertUuid(owned.correlationId);
    validateCredential(owned.credentialSecret, owned.ttlHours);
    const view = await lockInvitation(tx, owned.invitationId);
    assertMutable(view);
    if (view.currentGeneration.generation >= MAX_INVITATION_GENERATION) {
      throw new InvitationError('invitation_invalid', 'Invitation generation limit reached');
    }
    const now = await databaseTime(tx);
    await tx.update(generations).set({
      state: 'superseded', supersededAt: now, expiredAt: null, version: sql`${generations.version} + 1`,
    }).where(currentGenerationWhere(view));
    await revokeOpenClaims(tx, view.id, now);
    const generation = view.currentGeneration.generation + 1;
    await insertGeneration(tx, view.id, generation, view.emailNormalized, owned.credentialSecret, owned.ttlHours, now);
    await tx.update(invitations).set({
      state: 'pending', currentGeneration: generation, expiredAt: null, updatedAt: now,
      correlationId: owned.correlationId, version: sql`${invitations.version} + 1`,
    }).where(eq(invitations.id, view.id));
    const result = await requireInvitation(tx, view.id);
    await appendAudit(tx, audit, 'regenerated', result, owned.correlationId, now);
    return result;
  } finally {
    owned.credentialSecret.fill(0);
  }
}

async function revoke(tx: DrizzleTx, audit: InvitationManagementAudit, invitationId: string, correlationId: string): Promise<InvitationView> {
  assertUuid(invitationId);
  assertUuid(correlationId);
  const view = await lockInvitation(tx, invitationId);
  if (view.state === 'revoked' && view.currentGeneration.state === 'revoked') return view;
  assertMutable(view);
  const now = await databaseTime(tx);
  await tx.update(generations).set({
    state: 'revoked', revokedAt: now, expiredAt: null, version: sql`${generations.version} + 1`,
  }).where(currentGenerationWhere(view));
  await revokeOpenClaims(tx, view.id, now);
  await tx.update(invitations).set({
    state: 'revoked', revokedAt: now, expiredAt: null, updatedAt: now,
    correlationId, version: sql`${invitations.version} + 1`,
  }).where(eq(invitations.id, view.id));
  const result = await requireInvitation(tx, view.id);
  await appendAudit(tx, audit, 'revoked', result, correlationId, now);
  return result;
}

async function lockAccounts(tx: DrizzleTx): Promise<void> {
  // Existing account writers do not share an invitation advisory-lock namespace,
  // and users.email has no canonical unique constraint. This short, coarse lock
  // closes insert/update phantom races with those writers. EXCLUSIVE also conflicts
  // with SELECT FOR UPDATE's ROW SHARE, avoiding a row-lock/table-upgrade deadlock.
  // Narrow only once all
  // account writers share a canonical uniqueness/locking protocol.
  await tx.execute(sql`LOCK TABLE users IN EXCLUSIVE MODE`);
}

async function lockInvitation(tx: DrizzleTx, invitationId: string): Promise<InvitationView> {
  await lockAccounts(tx);
  const [row] = await tx.select({ id: invitations.id }).from(invitations)
    .where(eq(invitations.id, invitationId)).for('update');
  if (!row) throw new InvitationError('invitation_not_found', 'Invitation not found');
  const view = await requireInvitation(tx, invitationId);
  const [user] = await tx.select().from(users).where(eq(users.id, view.userId)).for('update');
  if (!user || user.activationState !== 'pending_activation') {
    throw new InvitationError('account_not_pending', 'Invitation account is not pending');
  }
  if (user.disabledAt || user.deletedAt) throw new InvitationError('invitation_invalid', 'Invitation account is unavailable');
  return view;
}

function assertMutable(view: InvitationView): void {
  if (view.state === 'revoked') throw new InvitationError('invitation_revoked', 'Invitation is revoked');
  if (!['pending', 'expired'].includes(view.state) || view.currentGeneration.state !== view.state) {
    throw new InvitationError('invitation_invalid', 'Invitation state does not permit this operation');
  }
}

function currentGenerationWhere(view: InvitationView) {
  return and(eq(generations.invitationId, view.id), eq(generations.generation, view.currentGeneration.generation));
}

async function revokeOpenClaims(tx: DrizzleTx, invitationId: string, now: Date): Promise<void> {
  await tx.update(claims).set({ state: 'revoked', revokedAt: now, version: sql`${claims.version} + 1` })
    .where(and(eq(claims.invitationId, invitationId), eq(claims.state, 'open')));
}

async function insertGeneration(tx: DrizzleTx, invitationId: string, generation: number, email: string, secret: Buffer, ttlHours: number, now: Date): Promise<void> {
  const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000);
  await tx.insert(generations).values({
    invitationId, generation, issuedAt: now, expiresAt,
    credentialHash: hashInvitationCredential({ invitationId, generation, secret }, email, expiresAt),
  });
}

async function databaseTime(tx: DrizzleTx): Promise<Date> {
  // clock_timestamp is read AFTER locks: transaction_timestamp can precede a long lock wait.
  const rows = await tx.execute(sql`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`);
  return new Date(rows[0].now as string | Date);
}

async function readInvitation(tx: DrizzleTx, invitationId: string): Promise<InvitationView | null> {
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

async function requireInvitation(tx: DrizzleTx, invitationId: string): Promise<InvitationView> {
  const view = await readInvitation(tx, invitationId);
  if (!view) throw new InvitationError('invitation_invalid', 'Invitation generation is unavailable');
  return view;
}

async function appendAudit(tx: DrizzleTx, audit: InvitationManagementAudit, operation: string, view: InvitationView, correlationId: string, now: Date): Promise<void> {
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

function copyAudit(audit: InvitationManagementAudit): InvitationManagementAudit {
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

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new InvitationError('invitation_invalid', 'Invitation identifiers must be UUIDs');
  }
}

function validateCredential(secret: Buffer, ttlHours: number): void {
  if (secret.length !== INVITATION_SECRET_BYTES) throw new InvitationError('invitation_invalid', 'Invalid invitation credential');
  if (!Number.isInteger(ttlHours) || ttlHours < MIN_INVITATION_TTL_HOURS || ttlHours > MAX_INVITATION_TTL_HOURS) {
    throw new InvitationError('configuration_invalid', 'Invalid invitation TTL');
  }
}

function validateIssue(input: InvitationIssueRecord): void {
  for (const id of [input.invitationId, input.userId, input.inviterUserId, input.correlationId]) assertUuid(id);
  validateCredential(input.credentialSecret, input.ttlHours);
  let email: string;
  try { email = normalizeInvitationEmail(input.emailOriginal); } catch {
    throw new InvitationError('invitation_invalid', 'Invalid invitation email');
  }
  if (email !== input.emailNormalized || input.generation !== 1 ||
      !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(input.username) ||
      (input.displayName !== null && (input.displayName.trim() === '' || input.displayName.length > 255)) ||
      input.intendedRoles.some(role => !(CONSOLE_ADMIN_AUDIT_ROLES as readonly string[]).includes(role)) ||
      new Set(input.intendedRoles).size !== input.intendedRoles.length) {
    throw new InvitationError('invitation_invalid', 'Invalid invitation account context');
  }
}
