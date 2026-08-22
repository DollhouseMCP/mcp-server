import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import type { DrizzleTx } from '../../database/db-utils.js';
import {
  lockAuthAuthorityMutationsWithTx,
  lockAuthPrincipalsWithTx,
  lockUserLifecycleWithTx,
} from '../../database/authPrincipalLock.js';
import {
  accountFactors,
  authAccounts,
  authSubjectRevocationFences,
  userAdminRoles,
  users,
} from '../../database/schema/index.js';
import { hashAuthSubject } from '../../security/authSubjectRevocation.js';
import {
  collectDeletionIdentity,
  purgeNonCascadeUserIdentity,
  purgeUserScopedData,
} from '../../database/userDataPurge.js';
import {
  CannotUnlinkLastIdentityError,
  WouldOrphanAccountsAdminError,
} from './IConsoleAccountAdminStore.js';
import type {
  ConsoleAdminRole,
  ConsolePrincipalSummary,
  ConsoleRoleAssignment,
  IConsoleAccountAdminStore,
  IdentityLinkFinalizationResult,
  IdentityLinkInput,
  IdentityLinkPreparationResult,
  IdentityMutationResult,
  IdentityUnlinkInput,
  LinkedIdentity,
  PrincipalAuthzVersionBumpInput,
  PrincipalDeletionInput,
  PrincipalDeletionOutcome,
  PrincipalDirectoryPage,
  PrincipalDirectoryQuery,
  PrincipalDisableInput,
  PrincipalEnableInput,
  PrincipalProfileUpdateInput,
  PrincipalStateChange,
  RoleGrantInput,
  RoleRevokeInput,
  UnlinkedIdentityPage,
  UnlinkedIdentityQuery,
} from './IConsoleAccountAdminStore.js';
import {
  assertAdminRole,
  clonePrincipalSummary,
  cloneRoleAssignment,
  validateIdentityLinkInput,
  validateIdentitySub,
  validateIdentityUnlinkInput,
  validatePrincipalDirectoryQuery,
  validateUnlinkedIdentityQuery,
  validatePrincipalDisableInput,
  validatePrincipalEnableInput,
  validatePrincipalAuthzVersionBumpInput,
  validatePrincipalDeletionInput,
  validatePrincipalProfileUpdateInput,
  validateRoleGrantInput,
  validateRoleRevokeInput,
} from './IConsoleAccountAdminStore.js';
import {
  ConsoleStoreConflictError,
  assertUuid,
  isForeignKeyViolation,
  isUniqueViolation,
} from './ConsoleStoreValidation.js';

type PrincipalRow = Record<string, unknown> & {
  user_id: string;
  primary_sub: string | null;
  username: string;
  display_name: string | null;
  email: string | null;
  email_verified: boolean | null;
  auth_methods: string[] | null;
  roles: string[] | null;
  disabled_at: Date | string | null;
  created_at: Date | string;
  last_login_at: number | string | null;
  admin_factor_enrolled: boolean;
  account_correlation_id: string;
  authz_version: number | string;
};

export class PostgresConsoleAccountAdminStore implements IConsoleAccountAdminStore {
  constructor(private readonly db: DatabaseInstance) {}

  async listPrincipals(query: PrincipalDirectoryQuery = {}): Promise<PrincipalDirectoryPage> {
    validatePrincipalDirectoryQuery(query);
    const limit = query.limit ?? 100;
    const rows: PrincipalRow[] = await withSystemContext(this.db, tx => tx.execute(sql`
      SELECT
        u.id AS user_id,
        primary_account.sub AS primary_sub,
        u.username,
        COALESCE(u.display_name, primary_account.display_name) AS display_name,
        COALESCE(u.email, primary_account.email) AS email,
        COALESCE(primary_account.email_verified, false) AS email_verified,
        COALESCE(identity_summary.auth_methods, ARRAY[]::TEXT[]) AS auth_methods,
        COALESCE(role_summary.roles, ARRAY[]::TEXT[]) AS roles,
        u.disabled_at,
        u.created_at,
        identity_summary.last_login_at,
        EXISTS (
          SELECT 1 FROM account_factors af
          WHERE af.user_id = u.id AND af.factor_type = 'totp' AND af.disabled_at IS NULL
        ) AS admin_factor_enrolled,
        u.account_correlation_id,
        u.authz_version
      FROM users u
      LEFT JOIN LATERAL (
        SELECT aa.sub, aa.display_name, aa.email, aa.email_verified
        FROM auth_accounts aa
        WHERE aa.user_id = u.id
        ORDER BY aa.created_at ASC, aa.sub ASC
        LIMIT 1
      ) primary_account ON true
      LEFT JOIN LATERAL (
        SELECT
          ARRAY_AGG(DISTINCT aa.provider ORDER BY aa.provider) AS auth_methods,
          MAX(aa.last_auth_at) AS last_login_at
        FROM auth_accounts aa
        WHERE aa.user_id = u.id
      ) identity_summary ON true
      LEFT JOIN LATERAL (
        SELECT ARRAY_AGG(uar.role ORDER BY uar.role) AS roles
        FROM user_admin_roles uar
        WHERE uar.user_id = u.id AND uar.revoked_at IS NULL
      ) role_summary ON true
      WHERE u.deleted_at IS NULL
        ${buildPrincipalDirectoryFilters(query)}
      ORDER BY u.created_at ASC, u.id ASC
      LIMIT ${limit + 1}
    `));
    const items = rows.slice(0, limit).map(row => fromPrincipalRow(row));
    const last = items.at(-1);
    const nextCursor = rows.length > limit && last
      ? { createdAt: last.createdAt, userId: last.userId }
      : null;
    return { items, nextCursor };
  }

  async findPrincipal(userId: string): Promise<ConsolePrincipalSummary | null> {
    assertUuid(userId, 'userId');
    const directRows: PrincipalRow[] = await withSystemContext(this.db, tx => tx.execute(sql`
      ${principalProjectionSql(sql`u.id = ${userId}`)}
      LIMIT 1
    `));
    return directRows[0] ? fromPrincipalRow(directRows[0]) : null;
  }

  async findPrincipalByAccountCorrelationId(accountCorrelationId: string): Promise<ConsolePrincipalSummary | null> {
    assertUuid(accountCorrelationId, 'accountCorrelationId');
    const rows: PrincipalRow[] = await withSystemContext(this.db, tx => tx.execute(sql`
      ${principalProjectionSql(sql`u.account_correlation_id = ${accountCorrelationId}`)}
      LIMIT 1
    `));
    return rows[0] ? fromPrincipalRow(rows[0]) : null;
  }

  async listActiveRoles(userId: string): Promise<ConsoleAdminRole[]> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select({ role: userAdminRoles.role }).from(userAdminRoles)
        .where(and(eq(userAdminRoles.userId, userId), isNull(userAdminRoles.revokedAt))),
    );
    return rows.map(row => {
      assertAdminRole(row.role, 'role');
      return row.role;
    }).sort((a, b) => a.localeCompare(b));
  }

  async grantRole(input: RoleGrantInput): Promise<ConsoleRoleAssignment> {
    return withSystemContext(this.db, tx => grantConsoleAdminRoleWithTx(tx, input));
  }

  async revokeRole(input: RoleRevokeInput): Promise<ConsoleRoleAssignment | null> {
    return withSystemContext(this.db, tx => revokeConsoleAdminRoleWithTx(tx, input));
  }

  async countEnabledAccountsAdmins(): Promise<number> {
    const rows: (Record<string, unknown> & { count: number | string })[] = await withSystemContext(this.db, tx =>
      tx.execute(sql`
        SELECT COUNT(DISTINCT u.id) AS count
        FROM users u
        JOIN user_admin_roles r ON r.user_id = u.id AND r.revoked_at IS NULL
        WHERE u.disabled_at IS NULL AND u.deleted_at IS NULL
          AND r.role IN ('admin', 'account_admin')
      `),
    );
    return Number(rows[0]?.count ?? 0);
  }

  async disablePrincipal(input: PrincipalDisableInput): Promise<PrincipalStateChange | null> {
    return withSystemContext(this.db, tx => disableConsolePrincipalWithTx(tx, input));
  }

  async enablePrincipal(input: PrincipalEnableInput): Promise<PrincipalStateChange | null> {
    return withSystemContext(this.db, tx => enableConsolePrincipalWithTx(tx, input));
  }

  async bumpPrincipalAuthzVersion(input: PrincipalAuthzVersionBumpInput): Promise<PrincipalStateChange | null> {
    return withSystemContext(this.db, tx => bumpConsolePrincipalAuthzVersionWithTx(tx, input));
  }

  async deletePrincipal(input: PrincipalDeletionInput): Promise<PrincipalDeletionOutcome | null> {
    return withSystemContext(this.db, tx => deleteConsolePrincipalWithTx(tx, input));
  }

  async listLinkedIdentities(userId: string): Promise<LinkedIdentity[]> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select(IDENTITY_COLUMNS).from(authAccounts)
        .where(eq(authAccounts.userId, userId))
        .orderBy(authAccounts.createdAt, authAccounts.sub));
    return rows.map(toLinkedIdentity);
  }

  async findIdentityBySub(sub: string): Promise<LinkedIdentity | null> {
    validateIdentitySub(sub);
    const rows = await withSystemContext(this.db, tx =>
      tx.select(IDENTITY_COLUMNS).from(authAccounts).where(eq(authAccounts.sub, sub)).limit(1));
    return rows[0] ? toLinkedIdentity(rows[0]) : null;
  }

  async isIdentityRevocationFenced(sub: string): Promise<boolean> {
    validateIdentitySub(sub);
    const rows = await withSystemContext(this.db, tx => tx
      .select({ subjectHash: authSubjectRevocationFences.subjectHash })
      .from(authSubjectRevocationFences)
      .where(eq(authSubjectRevocationFences.subjectHash, hashAuthSubject(sub)))
      .limit(1));
    return rows.length > 0;
  }

  async listUnlinkedIdentities(query: UnlinkedIdentityQuery = {}): Promise<UnlinkedIdentityPage> {
    validateUnlinkedIdentityQuery(query);
    const limit = query.limit ?? 100;
    const conditions: SQL[] = [isNull(authAccounts.userId)];
    if (query.after) {
      conditions.push(sql`(${authAccounts.createdAt}, ${authAccounts.sub}) > (${query.after.createdAt}::timestamptz, ${query.after.sub})`);
    }
    const rows = await withSystemContext(this.db, tx =>
      tx.select(IDENTITY_COLUMNS).from(authAccounts)
        .where(and(...conditions))
        .orderBy(authAccounts.createdAt, authAccounts.sub)
        .limit(limit + 1));
    const items = rows.slice(0, limit).map(toLinkedIdentity);
    const last = items.at(-1);
    const nextCursor = rows.length > limit && last
      ? { createdAt: last.createdAt, sub: last.sub }
      : null;
    return { items, nextCursor };
  }

  async linkIdentity(input: IdentityLinkInput): Promise<IdentityLinkPreparationResult> {
    return withSystemContext(this.db, tx => linkConsoleIdentityWithTx(tx, input));
  }

  async finalizeIdentityLink(input: IdentityLinkInput): Promise<IdentityLinkFinalizationResult> {
    return withSystemContext(this.db, tx => finalizeConsoleIdentityLinkWithTx(tx, input));
  }

  async unlinkIdentity(input: IdentityUnlinkInput): Promise<IdentityMutationResult | null> {
    return withSystemContext(this.db, tx => unlinkConsoleIdentityWithTx(tx, input));
  }

  async updatePrincipalProfile(input: PrincipalProfileUpdateInput): Promise<ConsolePrincipalSummary | null> {
    validatePrincipalProfileUpdateInput(input);
    const rows: PrincipalRow[] = await withSystemContext(this.db, async tx => {
      await lockAccountAdminMutationsWithTx(tx);
      const updated = await tx.update(users)
        .set({
          displayName: input.displayName,
          updatedAt: input.updatedAt,
        })
        .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
        .returning({ id: users.id });
      if (updated.length === 0) return [];
      const condition = sql`u.id = ${input.userId}`;
      return tx.execute(sql`${principalProjectionSql(condition)} LIMIT 1`);
    });
    return rows[0] ? fromPrincipalRow(rows[0]) : null;
  }

}

/** Escape LIKE metacharacters so user input is matched literally (prefix search uses `... ESCAPE '\'`). */
function escapeLikePrefix(term: string): string {
  return term.replaceAll(/[\\%_]/g, match => `\\${match}`);
}

/**
 * Compose the optional users-directory predicates (sub / search / role / enabled / keyset cursor)
 * as trailing `AND …` fragments appended after the base `WHERE u.deleted_at IS NULL`.
 */
function buildPrincipalDirectoryFilters(query: PrincipalDirectoryQuery): SQL {
  const parts: SQL[] = [];
  if (query.sub) {
    parts.push(sql`AND EXISTS (SELECT 1 FROM auth_accounts aa WHERE aa.user_id = u.id AND aa.sub = ${query.sub})`);
  }
  if (query.search) {
    const prefix = `${escapeLikePrefix(query.search)}%`;
    parts.push(sql`AND (
      lower(u.username) LIKE lower(${prefix}) ESCAPE '\\'
      OR lower(COALESCE(u.email, primary_account.email, '')) LIKE lower(${prefix}) ESCAPE '\\'
      OR lower(COALESCE(u.display_name, primary_account.display_name, '')) LIKE lower(${prefix}) ESCAPE '\\'
    )`);
  }
  if (query.role) {
    parts.push(sql`AND EXISTS (SELECT 1 FROM user_admin_roles uar WHERE uar.user_id = u.id AND uar.revoked_at IS NULL AND uar.role = ${query.role})`);
  }
  if (query.enabled !== undefined) {
    parts.push(query.enabled ? sql`AND u.disabled_at IS NULL` : sql`AND u.disabled_at IS NOT NULL`);
  }
  if (query.after) {
    parts.push(sql`AND (u.created_at, u.id) > (${query.after.createdAt}::timestamptz, ${query.after.userId}::uuid)`);
  }
  return parts.length > 0 ? sql.join(parts, sql` `) : sql``;
}

export async function grantConsoleAdminRoleWithTx(
  tx: DrizzleTx,
  input: RoleGrantInput,
): Promise<ConsoleRoleAssignment> {
  validateRoleGrantInput(input);
  if (!await findConsolePrincipalForUpdateWithTx(tx, input.userId)) {
    throw new ConsoleStoreConflictError('user principal is not active');
  }
  try {
    const granted = await tx.insert(userAdminRoles).values({
      userId: input.userId,
      role: input.role,
      grantedAt: input.grantedAt,
      grantedByUserId: input.grantedByUserId,
    }).returning();
    await tx.update(users).set({
      authzVersion: sql`${users.authzVersion} + 1`,
      authzChangedAt: sql`statement_timestamp()`,
      updatedAt: input.grantedAt,
    }).where(eq(users.id, input.userId));
    return fromRoleRow(granted[0]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConsoleStoreConflictError('administrative role is already active for principal');
    }
    throw error;
  }
}

export async function revokeConsoleAdminRoleWithTx(
  tx: DrizzleTx,
  input: RoleRevokeInput,
): Promise<ConsoleRoleAssignment | null> {
  validateRoleRevokeInput(input);
  if (!await findConsolePrincipalForUpdateWithTx(tx, input.userId)) return null;
  const rows = await revokeConsoleAdminRoleRowsWithTx(tx, input);
  if (!rows[0]) return null;
  return isRoleMutationRow(rows[0]) ? fromRoleMutationRow(rows[0]) : fromRoleRow(rows[0]);
}

export async function disableConsolePrincipalWithTx(
  tx: DrizzleTx,
  input: PrincipalDisableInput,
): Promise<PrincipalStateChange | null> {
  validatePrincipalDisableInput(input);
  await lockAccountAdminMutationsWithTx(tx);
  await lockUserLifecycleWithTx(tx, input.userId);
  await lockLinkedAuthSubjectsForUserWithTx(tx, input.userId);
  // Raw `tx.execute(sql`...`)` over postgres-js does not serialize JS Date
  // params — pass ISO strings cast to timestamptz instead.
  const rows: PrincipalStateChangeRow[] = await tx.execute(sql`
    WITH target_principal AS (
      SELECT u.id,
             EXISTS (
               SELECT 1
               FROM user_admin_roles r
               WHERE r.user_id = u.id
                 AND r.revoked_at IS NULL
                 AND r.role IN ('admin', 'account_admin')
             ) AS is_account_admin
      FROM users u
      WHERE u.id = ${input.userId}
        AND u.deleted_at IS NULL
        AND u.disabled_at IS NULL
      FOR UPDATE
    ),
    live_account_admins AS (
      SELECT u.id
      FROM users u
      WHERE u.disabled_at IS NULL
        AND u.deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM user_admin_roles r
          WHERE r.user_id = u.id
            AND r.revoked_at IS NULL
            AND r.role IN ('admin', 'account_admin')
        )
      FOR UPDATE OF u
    )
    UPDATE users
    SET disabled_at = ${input.disabledAt.toISOString()}::timestamptz,
        authz_version = authz_version + 1,
        authz_changed_at = statement_timestamp(),
        updated_at = ${input.disabledAt.toISOString()}::timestamptz
    WHERE id = ${input.userId}
      AND EXISTS (
        SELECT 1
        FROM target_principal
        WHERE NOT target_principal.is_account_admin
           OR (SELECT COUNT(*) FROM live_account_admins) > 1
      )
    RETURNING id AS "userId", authz_version AS "authzVersion", disabled_at AS "disabledAt"
  `);
  return rows[0] ? {
    userId: rows[0].userId,
    authzVersion: Number(rows[0].authzVersion),
    disabledAt: toDate(rows[0].disabledAt),
    changedAt: new Date(input.disabledAt),
  } : null;
}

export async function enableConsolePrincipalWithTx(
  tx: DrizzleTx,
  input: PrincipalEnableInput,
): Promise<PrincipalStateChange | null> {
  validatePrincipalEnableInput(input);
  await lockAccountAdminMutationsWithTx(tx);
  await lockUserLifecycleWithTx(tx, input.userId);
  await lockLinkedAuthSubjectsForUserWithTx(tx, input.userId);
  const rows = await tx.update(users).set({
    disabledAt: null,
    authzVersion: sql`${users.authzVersion} + 1`,
    authzChangedAt: sql`statement_timestamp()`,
    updatedAt: input.enabledAt,
  }).where(and(
    eq(users.id, input.userId),
    sql`${users.disabledAt} IS NOT NULL`,
    isNull(users.deletedAt),
  ))
    .returning({
      userId: users.id,
      authzVersion: users.authzVersion,
      disabledAt: users.disabledAt,
    });
  return rows[0] ? {
    userId: rows[0].userId,
    authzVersion: rows[0].authzVersion,
    disabledAt: null,
    changedAt: new Date(input.enabledAt),
  } : null;
}

export async function bumpConsolePrincipalAuthzVersionWithTx(
  tx: DrizzleTx,
  input: PrincipalAuthzVersionBumpInput,
): Promise<PrincipalStateChange | null> {
  validatePrincipalAuthzVersionBumpInput(input);
  await lockAccountAdminMutationsWithTx(tx);
  await lockLinkedAuthSubjectsForUserWithTx(tx, input.userId);
  const rows = await tx.update(users).set({
    authzVersion: sql`${users.authzVersion} + 1`,
    authzChangedAt: sql`statement_timestamp()`,
    updatedAt: input.bumpedAt,
  }).where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
    .returning({
      userId: users.id,
      authzVersion: users.authzVersion,
      disabledAt: users.disabledAt,
    });
  return rows[0] ? {
    userId: rows[0].userId,
    authzVersion: rows[0].authzVersion,
    disabledAt: rows[0].disabledAt ? toDate(rows[0].disabledAt) : null,
    changedAt: new Date(input.bumpedAt),
  } : null;
}

export async function deleteConsolePrincipalWithTx(
  tx: DrizzleTx,
  input: PrincipalDeletionInput,
): Promise<PrincipalDeletionOutcome | null> {
  validatePrincipalDeletionInput(input);
  await lockAccountAdminMutationsWithTx(tx);
  await lockUserLifecycleWithTx(tx, input.userId);
  await lockLinkedAuthSubjectsForUserWithTx(tx, input.userId);
  const liveAccountAdmins: Array<{ id: string }> = await tx.execute(sql`
    SELECT u.id
    FROM users u
    WHERE u.disabled_at IS NULL
      AND u.deleted_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM user_admin_roles r
        WHERE r.user_id = u.id
          AND r.revoked_at IS NULL
          AND r.role IN ('admin', 'account_admin')
      )
    ORDER BY u.id
    FOR UPDATE OF u
  `);
  if (liveAccountAdmins.length <= 1 && liveAccountAdmins.some(admin => admin.id === input.userId)) {
    throw new WouldOrphanAccountsAdminError();
  }
  const existing = await tx.select({ id: users.id, email: users.email }).from(users)
    .where(and(eq(users.id, input.userId), isNull(users.deletedAt))).limit(1).for('update');
  if (existing.length === 0) return null;

  // Everything below runs in the caller's single `withSystemContext` transaction, so any thrown
  // error (the FK violation on the hard delete, or any other DB failure) rolls back every delete
  // here atomically — there is no partially-erased intermediate state.

  // Capture the account's federated identity BEFORE deleting auth_accounts, then purge the
  // non-FK identity/credential tables (auth_kv OIDC grants/tokens, auth_identity_events, and the
  // auth_allowlist pre-approval) that no cascade reaches. Runs on BOTH paths — a hard delete
  // does not reach these either.
  const accounts = await tx.select({
    sub: authAccounts.sub,
    provider: authAccounts.provider,
    externalSub: authAccounts.externalSub,
    email: authAccounts.email,
    rawProfile: authAccounts.rawProfile,
  }).from(authAccounts).where(eq(authAccounts.userId, input.userId));
  if (accounts.length > 0) {
    await tx.insert(authSubjectRevocationFences).values(accounts.map(account => ({
      subjectHash: hashAuthSubject(account.sub),
      revokedAt: input.deletedAt,
      reason: 'account_deleted' as const,
    }))).onConflictDoUpdate({
      target: authSubjectRevocationFences.subjectHash,
      set: { revokedAt: input.deletedAt, reason: 'account_deleted' },
    });
  }
  const identityPurge = await purgeNonCascadeUserIdentity(
    tx,
    collectDeletionIdentity(existing[0]?.email ?? null, accounts),
    input.deletedByUserId,
    // The request timestamp can substantially predate this transaction because
    // remote grant and runtime revocation happen first. Tombstone precedence
    // must reflect when deletion actually reaches its serialized DB phase.
    new Date(),
  );

  // Detach the account's own identity/credential/role surface first, so the
  // login stops working on either branch and so these rows don't themselves
  // block a hard delete (auth_accounts.user_id is SET NULL, but we remove the
  // login records entirely; factors + own role rows would otherwise cascade).
  await tx.delete(authAccounts).where(eq(authAccounts.userId, input.userId));
  await tx.delete(accountFactors).where(eq(accountFactors.userId, input.userId));
  await tx.delete(userAdminRoles).where(eq(userAdminRoles.userId, input.userId));
  const scopedPurge = await purgeUserScopedData(tx, input.userId);

  // Attempt the true delete inside a savepoint. A RESTRICT reference from the
  // tamper-evident audit chain (or a role this user granted to someone else)
  // raises 23503; we roll back just the DELETE and anonymize-tombstone instead.
  try {
    await tx.transaction(async sp => {
      await sp.delete(users).where(eq(users.id, input.userId));
    });
    return {
      userId: input.userId,
      outcome: 'deleted',
      authzVersion: null,
      browserSessionsRevoked: scopedPurge.browserSessionsRevoked,
      oauthGrantFamiliesRevoked: identityPurge.oauthGrantFamiliesRevoked,
      runtimeTerminationTargets: scopedPurge.runtimeTerminationTargets,
    };
  } catch (error) {
    if (!isForeignKeyViolation(error)) throw error;
    // Anonymize-tombstone: the users row is kept, so ON DELETE CASCADE never fires. Replay the
    // cascade explicitly so no personal data survives under the tombstone; only the retained
    // RESTRICT-anchored audit chain (and this user's actions on others) remain.
    const rows = await tx.update(users).set({
      // Username is NOT NULL + unique; the id guarantees a unique tombstone.
      username: `deleted-${input.userId}`,
      email: null,
      displayName: null,
      externalId: null,
      disabledAt: input.deletedAt,
      deletedAt: input.deletedAt,
      authzVersion: sql`${users.authzVersion} + 1`,
      authzChangedAt: sql`statement_timestamp()`,
      updatedAt: input.deletedAt,
    }).where(eq(users.id, input.userId)).returning({ authzVersion: users.authzVersion });
    return {
      userId: input.userId,
      outcome: 'anonymized',
      authzVersion: rows[0] ? Number(rows[0].authzVersion) : null,
      browserSessionsRevoked: scopedPurge.browserSessionsRevoked,
      oauthGrantFamiliesRevoked: identityPurge.oauthGrantFamiliesRevoked,
      runtimeTerminationTargets: scopedPurge.runtimeTerminationTargets,
    };
  }
}

export async function linkConsoleIdentityWithTx(
  tx: DrizzleTx,
  input: IdentityLinkInput,
): Promise<IdentityLinkPreparationResult> {
  validateIdentityLinkInput(input);
  if (!await findConsolePrincipalForUpdateWithTx(tx, input.userId)) {
    return { outcome: 'not_found', sub: input.sub, linkedUserId: null };
  }
  await lockAuthPrincipalsWithTx(tx, [input.sub]);
  const existingRows = await tx.select({ sub: authAccounts.sub, userId: authAccounts.userId })
    .from(authAccounts)
    .where(eq(authAccounts.sub, input.sub))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) return { outcome: 'not_found', sub: input.sub, linkedUserId: null };
  const fencedRows = await tx.select({ reason: authSubjectRevocationFences.reason })
    .from(authSubjectRevocationFences)
    .where(eq(authSubjectRevocationFences.subjectHash, hashAuthSubject(input.sub)))
    .limit(1);
  const fenceReason = fencedRows[0]?.reason ?? null;
  if (fenceReason === 'account_deleted') {
    return { outcome: 'subject_deleted', sub: existing.sub, linkedUserId: existing.userId };
  }
  if (existing.userId !== null) {
    if (existing.userId !== input.userId) {
      return { outcome: 'linked_elsewhere', sub: existing.sub, linkedUserId: existing.userId };
    }
    return {
      outcome: fenceReason === 'identity_unlinked' ? 'provisional' : 'already_linked',
      sub: existing.sub,
      linkedUserId: existing.userId,
    };
  }
  const rows = await tx.update(authAccounts)
    .set({ userId: input.userId, updatedAt: input.linkedAt })
    .where(and(eq(authAccounts.sub, input.sub), isNull(authAccounts.userId)))
    .returning({ sub: authAccounts.sub, userId: authAccounts.userId });
  if (rows[0]) {
    // Linking remains provisional until MCP runtime cleanup has succeeded. Keep
    // an account-deletion fence intact; otherwise materialize a resumable
    // identity-unlinked fence before making the account association visible.
    await tx.insert(authSubjectRevocationFences).values({
      subjectHash: hashAuthSubject(input.sub),
      revokedAt: input.linkedAt,
      reason: 'identity_unlinked',
    }).onConflictDoNothing();
    await tx.update(users).set({
      authzVersion: sql`${users.authzVersion} + 1`,
      authzChangedAt: sql`statement_timestamp()`,
      updatedAt: input.linkedAt,
    }).where(eq(users.id, input.userId));
  }
  return rows[0]
    ? { outcome: 'provisional', sub: rows[0].sub, linkedUserId: rows[0].userId }
    : { outcome: 'linked_elsewhere', sub: existing.sub, linkedUserId: existing.userId };
}

export async function finalizeConsoleIdentityLinkWithTx(
  tx: DrizzleTx,
  input: IdentityLinkInput,
): Promise<IdentityLinkFinalizationResult> {
  validateIdentityLinkInput(input);
  if (!await findConsolePrincipalForUpdateWithTx(tx, input.userId)) {
    return { outcome: 'not_found', sub: input.sub, linkedUserId: null };
  }
  await lockAuthPrincipalsWithTx(tx, [input.sub]);
  const identities = await tx.select({ sub: authAccounts.sub, userId: authAccounts.userId })
    .from(authAccounts)
    .where(and(eq(authAccounts.sub, input.sub), eq(authAccounts.userId, input.userId)))
    .limit(1);
  const identity = identities[0];
  if (!identity) return { outcome: 'not_found', sub: input.sub, linkedUserId: null };
  const fencedRows = await tx.select({ reason: authSubjectRevocationFences.reason })
    .from(authSubjectRevocationFences)
    .where(eq(authSubjectRevocationFences.subjectHash, hashAuthSubject(input.sub)))
    .limit(1);
  const fenceReason = fencedRows[0]?.reason ?? null;
  if (fenceReason === 'account_deleted') {
    return { outcome: 'subject_deleted', sub: identity.sub, linkedUserId: identity.userId };
  }
  if (fenceReason === null) {
    return { outcome: 'already_finalized', sub: identity.sub, linkedUserId: identity.userId };
  }
  const cleared = await tx.delete(authSubjectRevocationFences)
    .where(and(
      eq(authSubjectRevocationFences.subjectHash, hashAuthSubject(input.sub)),
      eq(authSubjectRevocationFences.reason, 'identity_unlinked'),
    ))
    .returning({ subjectHash: authSubjectRevocationFences.subjectHash });
  if (!cleared[0]) {
    return { outcome: 'not_found', sub: identity.sub, linkedUserId: identity.userId };
  }
  await tx.update(users).set({
    authzVersion: sql`${users.authzVersion} + 1`,
    authzChangedAt: sql`statement_timestamp()`,
    updatedAt: input.linkedAt,
  }).where(eq(users.id, input.userId));
  return { outcome: 'finalized', sub: identity.sub, linkedUserId: identity.userId };
}

export async function unlinkConsoleIdentityWithTx(
  tx: DrizzleTx,
  input: IdentityUnlinkInput,
): Promise<IdentityMutationResult | null> {
  validateIdentityUnlinkInput(input);
  if (!await findConsolePrincipalForUpdateWithTx(tx, input.userId)) return null;
  await lockAuthPrincipalsWithTx(tx, [input.sub]);
  const linkedIdentities: Array<{ sub: string }> = await tx.execute(sql`
    SELECT sub
    FROM auth_accounts
    WHERE user_id = ${input.userId}
    ORDER BY sub
    FOR UPDATE
  `);
  if (!linkedIdentities.some(identity => identity.sub === input.sub)) return null;
  if (linkedIdentities.length <= 1) throw new CannotUnlinkLastIdentityError();
  const rows = await tx.update(authAccounts)
    .set({ userId: null, updatedAt: input.unlinkedAt })
    .where(and(eq(authAccounts.sub, input.sub), eq(authAccounts.userId, input.userId)))
    .returning({ sub: authAccounts.sub, userId: authAccounts.userId });
  if (rows[0]) {
    await tx.insert(authSubjectRevocationFences).values({
      subjectHash: hashAuthSubject(input.sub),
      revokedAt: input.unlinkedAt,
      reason: 'identity_unlinked',
    }).onConflictDoUpdate({
      target: authSubjectRevocationFences.subjectHash,
      set: { revokedAt: input.unlinkedAt, reason: 'identity_unlinked' },
    });
    await tx.update(users).set({
      authzVersion: sql`${users.authzVersion} + 1`,
      authzChangedAt: sql`statement_timestamp()`,
      updatedAt: input.unlinkedAt,
    }).where(eq(users.id, input.userId));
  }
  return rows[0] ? { sub: rows[0].sub, linkedUserId: rows[0].userId } : null;
}

export async function findConsolePrincipalForUpdateWithTx(
  tx: DrizzleTx,
  userId: string,
): Promise<ConsolePrincipalSummary | null> {
  assertUuid(userId, 'userId');
  await lockAccountAdminMutationsWithTx(tx);
  // Acquire the lifecycle lock before the users-row lock. Normal user writes
  // take lifecycle first and may then acquire an FK key lock on users; keeping
  // the same order prevents a deletion/write deadlock.
  await lockUserLifecycleWithTx(tx, userId);
  const locked = await tx.select({ id: users.id }).from(users).where(and(
    eq(users.id, userId),
    isNull(users.deletedAt),
  )).for('update').limit(1);
  if (!locked[0]) return null;
  const rows: PrincipalRow[] = await tx.execute(sql`
    ${principalProjectionSql(sql`u.id = ${userId}`)}
    LIMIT 1
  `);
  return rows[0] ? fromPrincipalRow(rows[0]) : null;
}

export async function listConsoleLinkedIdentitiesWithTx(
  tx: DrizzleTx,
  userId: string,
): Promise<LinkedIdentity[]> {
  assertUuid(userId, 'userId');
  const rows = await tx.select(IDENTITY_COLUMNS).from(authAccounts)
    .where(eq(authAccounts.userId, userId))
    .orderBy(authAccounts.createdAt, authAccounts.sub);
  return rows.map(toLinkedIdentity);
}

async function lockAccountAdminMutationsWithTx(tx: DrizzleTx): Promise<void> {
  await lockAuthAuthorityMutationsWithTx(tx);
}

async function lockLinkedAuthSubjectsForUserWithTx(tx: DrizzleTx, userId: string): Promise<void> {
  const linked = await tx.select({ sub: authAccounts.sub }).from(authAccounts)
    .where(eq(authAccounts.userId, userId));
  await lockAuthPrincipalsWithTx(tx, linked.map(account => account.sub));
}

const IDENTITY_COLUMNS = {
  sub: authAccounts.sub,
  provider: authAccounts.provider,
  externalSub: authAccounts.externalSub,
  email: authAccounts.email,
  emailVerified: authAccounts.emailVerified,
  displayName: authAccounts.displayName,
  userId: authAccounts.userId,
  createdAt: authAccounts.createdAt,
  lastAuthAt: authAccounts.lastAuthAt,
} as const;

type IdentityColumnRow = {
  sub: string;
  provider: string;
  externalSub: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  userId: string | null;
  createdAt: Date;
  lastAuthAt: number | null;
};

function toLinkedIdentity(row: IdentityColumnRow): LinkedIdentity {
  return {
    sub: row.sub,
    provider: row.provider,
    externalSub: row.externalSub,
    email: row.email,
    emailVerified: row.emailVerified,
    displayName: row.displayName,
    linkedUserId: row.userId,
    createdAt: new Date(row.createdAt),
    lastAuthAt: row.lastAuthAt === null ? null : new Date(Number(row.lastAuthAt)),
  };
}

async function revokeConsoleAdminRoleRowsWithTx(
  tx: DrizzleTx,
  input: RoleRevokeInput,
): Promise<(typeof userAdminRoles.$inferSelect | RoleMutationRow)[]> {
  if (isAccountsAdminRole(input.role)) {
    const revokedRows: RoleMutationRow[] = await tx.execute(sql`
      WITH live_account_admins AS (
        SELECT u.id
        FROM users u
        WHERE u.disabled_at IS NULL
          AND u.deleted_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM user_admin_roles r
            WHERE r.user_id = u.id
              AND r.revoked_at IS NULL
              AND r.role IN ('admin', 'account_admin')
          )
        FOR UPDATE OF u
      ),
      revoked_role AS (
        UPDATE user_admin_roles
        SET revoked_at = ${input.revokedAt.toISOString()}::timestamptz,
            revoked_by_user_id = ${input.revokedByUserId}
        WHERE user_id = ${input.userId}
          AND role = ${input.role}
          AND revoked_at IS NULL
          AND (
            (SELECT COUNT(*) FROM live_account_admins) > 1
            OR EXISTS (
              SELECT 1
              FROM user_admin_roles sibling
              WHERE sibling.user_id = ${input.userId}
                AND sibling.revoked_at IS NULL
                AND sibling.role IN ('admin', 'account_admin')
                AND sibling.role <> ${input.role}
            )
          )
        RETURNING id, user_id, role, granted_at, granted_by_user_id, revoked_at, revoked_by_user_id
      )
      UPDATE users
      SET authz_version = authz_version + 1,
          authz_changed_at = statement_timestamp(),
          updated_at = ${input.revokedAt.toISOString()}::timestamptz
      WHERE id = ${input.userId}
        AND EXISTS (SELECT 1 FROM revoked_role)
      RETURNING (
        SELECT jsonb_build_object(
          'id', revoked_role.id,
          'userId', revoked_role.user_id,
          'role', revoked_role.role,
          'grantedAt', revoked_role.granted_at,
          'grantedByUserId', revoked_role.granted_by_user_id,
          'revokedAt', revoked_role.revoked_at,
          'revokedByUserId', revoked_role.revoked_by_user_id
        )
        FROM revoked_role
      ) AS role
    `);
    return revokedRows;
  }
  const revoked = await tx.update(userAdminRoles).set({
    revokedAt: input.revokedAt,
    revokedByUserId: input.revokedByUserId,
  }).where(and(
    eq(userAdminRoles.userId, input.userId),
    eq(userAdminRoles.role, input.role),
    isNull(userAdminRoles.revokedAt),
  )).returning();
  if (revoked[0]) {
    await tx.update(users).set({
      authzVersion: sql`${users.authzVersion} + 1`,
      authzChangedAt: sql`statement_timestamp()`,
      updatedAt: input.revokedAt,
    }).where(eq(users.id, input.userId));
  }
  return revoked;
}

function principalProjectionSql(whereClause: ReturnType<typeof sql>) {
  return sql`
    SELECT
      u.id AS user_id,
      primary_account.sub AS primary_sub,
      u.username,
      COALESCE(u.display_name, primary_account.display_name) AS display_name,
      COALESCE(u.email, primary_account.email) AS email,
      COALESCE(primary_account.email_verified, false) AS email_verified,
      COALESCE(identity_summary.auth_methods, ARRAY[]::TEXT[]) AS auth_methods,
      COALESCE(role_summary.roles, ARRAY[]::TEXT[]) AS roles,
      u.disabled_at,
      u.created_at,
      identity_summary.last_login_at,
      EXISTS (
        SELECT 1 FROM account_factors af
        WHERE af.user_id = u.id AND af.factor_type = 'totp' AND af.disabled_at IS NULL
      ) AS admin_factor_enrolled,
      u.account_correlation_id,
      u.authz_version
    FROM users u
    LEFT JOIN LATERAL (
      SELECT aa.sub, aa.display_name, aa.email, aa.email_verified
      FROM auth_accounts aa
      WHERE aa.user_id = u.id
      ORDER BY aa.created_at ASC, aa.sub ASC
      LIMIT 1
    ) primary_account ON true
    LEFT JOIN LATERAL (
      SELECT
        ARRAY_AGG(DISTINCT aa.provider ORDER BY aa.provider) AS auth_methods,
        MAX(aa.last_auth_at) AS last_login_at
      FROM auth_accounts aa
      WHERE aa.user_id = u.id
    ) identity_summary ON true
    LEFT JOIN LATERAL (
      SELECT ARRAY_AGG(uar.role ORDER BY uar.role) AS roles
      FROM user_admin_roles uar
      WHERE uar.user_id = u.id AND uar.revoked_at IS NULL
    ) role_summary ON true
    WHERE u.deleted_at IS NULL AND (${whereClause})
  `;
}

type PrincipalStateChangeRow = Record<string, unknown> & {
  userId: string;
  authzVersion: number | string;
  disabledAt: Date | string | null;
};

type RoleMutationRow = Record<string, unknown> & {
  role: {
    id: string;
    userId: string;
    role: ConsoleAdminRole;
    grantedAt: Date | string;
    grantedByUserId: string | null;
    revokedAt: Date | string | null;
    revokedByUserId: string | null;
  } | null;
};

function fromRoleRow(row: typeof userAdminRoles.$inferSelect): ConsoleRoleAssignment {
  return cloneRoleAssignment({
    id: row.id,
    userId: row.userId,
    role: row.role,
    grantedAt: row.grantedAt,
    grantedByUserId: row.grantedByUserId,
    revokedAt: row.revokedAt,
    revokedByUserId: row.revokedByUserId,
  });
}

function fromRoleMutationRow(row: RoleMutationRow): ConsoleRoleAssignment | null {
  if (!row.role) return null;
  return cloneRoleAssignment({
    id: row.role.id,
    userId: row.role.userId,
    role: row.role.role,
    grantedAt: requireDate(row.role.grantedAt, 'grantedAt'),
    grantedByUserId: row.role.grantedByUserId,
    revokedAt: toDate(row.role.revokedAt),
    revokedByUserId: row.role.revokedByUserId,
  });
}

function isRoleMutationRow(row: unknown): row is RoleMutationRow {
  return !!row && typeof row === 'object' && 'role' in row
    && (row as { role?: unknown }).role !== null
    && typeof (row as { role?: unknown }).role === 'object';
}

function isAccountsAdminRole(role: ConsoleAdminRole): boolean {
  return role === 'admin' || role === 'account_admin';
}

function fromPrincipalRow(row: PrincipalRow): ConsolePrincipalSummary {
  const roles = (row.roles ?? []).map(role => {
    assertAdminRole(role, 'roles');
    return role;
  });
  return clonePrincipalSummary({
    userId: row.user_id,
    primarySub: row.primary_sub,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    emailVerified: row.email_verified ?? false,
    authMethods: row.auth_methods ?? [],
    roles,
    disabledAt: toDate(row.disabled_at),
    createdAt: requireDate(row.created_at, 'created_at'),
    lastLoginAt: lastLoginDate(row.last_login_at),
    adminFactorEnrolled: row.admin_factor_enrolled,
    accountCorrelationId: row.account_correlation_id,
    authzVersion: Number(row.authz_version),
  });
}

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return new Date(value);
}

function requireDate(value: Date | string, name: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} is not a valid timestamp`);
  return date;
}

function lastLoginDate(value: number | string | null): Date | null {
  if (value === null) return null;
  const millis = Number(value);
  return Number.isFinite(millis) ? new Date(millis) : null;
}
