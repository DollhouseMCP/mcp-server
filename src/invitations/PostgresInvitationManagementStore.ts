import { normalizeAuthAllowlistValue } from '../auth/embedded-as/allowlistIdentity.js';
import { and, eq, sql } from 'drizzle-orm';
import { withSystemContext } from '../database/admin.js';
import type { DatabaseInstance } from '../database/connection.js';
import { getErrorCode, isSerializationFailure, isUniqueViolation, type DrizzleTx } from '../database/db-utils.js';
import {
  accountInvitations as invitations,
  accountInvitationGenerations as generations,
  accountInvitationIntendedRoles as roles,
  accountInvitationClaimAssertions as claims,
} from '../database/schema/invitations.js';
import { authAccounts } from '../database/schema/auth.js';
import { users } from '../database/schema/users.js';
import { CONSOLE_ADMIN_AUDIT_ROLES } from '../web-console/audit/IAdminAuditWriter.js';
import { normalizeLocalDisplayName, normalizeLocalUsername } from '../web-console/ui/account-username.js';
import type { InvitationIssueRecord, InvitationRegenerationRecord } from './IInvitationStore.js';
import type {
  IInvitationManagementStore, InvitationManagementAudit, InvitationManagementMutation,
} from './IInvitationManagementStore.js';
import { MAX_INVITATION_TTL_HOURS, MIN_INVITATION_TTL_HOURS } from './InvitationConfig.js';
import { normalizeInvitationEmail } from './InvitationEmail.js';
import { hashInvitationCredential, INVITATION_SECRET_BYTES, MAX_INVITATION_GENERATION } from './InvitationToken.js';
import { InvitationError, type InvitationView } from './InvitationTypes.js';
import { lockAdminAudit, lockAccounts, lockInvitation, databaseTime, readInvitation, requireInvitation, appendAudit, copyAudit, assertUuid } from './InvitationTransactionSupport.js';

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
      if (isSerializationFailure(error) || getErrorCode(error) === '55P03') throw new InvitationError('concurrent_update', 'Invitation transaction conflicted');
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
    await lockAdminAudit(tx, audit);
    // Use the same NFC/trim/case rules as issuance, including older stored email
    // encodings. SQL lower/btrim alone diverges for Unicode case and whitespace.
    // Credential provisioning participates in the users gate. An unlinked
    // legacy subject must not become a cohort user through username fallback.
    const identities = await tx.select({ sub: authAccounts.sub }).from(authAccounts)
      .where(eq(authAccounts.sub, owned.username)).limit(1);
    if (identities.length) throw new InvitationError('invitation_conflict', 'Invitation account already exists');
    const accounts = await tx.select({ id: users.id, email: users.email, username: users.username }).from(users);
    if (accounts.some(account => account.id === owned.userId ||
        normalizeLegacyUsernameForComparison(account.username) === owned.username ||
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
    await lockAdminAudit(tx, audit);
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
  const view = await lockInvitation(tx, invitationId, true);
  if (view.state === 'revoked' && view.currentGeneration.state === 'revoked') return view;
  await lockAdminAudit(tx, audit);
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
  let username: string;
  let displayName: string | null;
  try {
    username = normalizeLocalUsername(input.username);
    displayName = input.displayName === null ? null : normalizeLocalDisplayName(input.displayName);
  } catch {
    throw new InvitationError('invitation_invalid', 'Invalid invitation account context');
  }
  if (email !== input.emailNormalized || input.generation !== 1 ||
      username !== input.username || displayName !== input.displayName ||
      input.intendedRoles.some(role => !(CONSOLE_ADMIN_AUDIT_ROLES as readonly string[]).includes(role)) ||
      new Set(input.intendedRoles).size !== input.intendedRoles.length) {
    throw new InvitationError('invitation_invalid', 'Invalid invitation account context');
  }
}

/** Preserve compatibility with stored usernames that predate the current syntax. */
function normalizeLegacyUsernameForComparison(value: string): string {
  return value.normalize('NFC').trim().toLowerCase().normalize('NFC');
}
