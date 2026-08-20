import { and, asc, desc, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import type { DrizzleTx } from '../../database/db-utils.js';
import {
  lockAuthAllowlistIdentitiesWithTx,
  lockAuthPrincipalsWithTx,
  type AuthAllowlistLockIdentity,
} from '../../database/authPrincipalLock.js';
import { accountAllowlistEntries } from '../../database/schema/index.js';
import { authIdentityEvents, authKv } from '../../database/schema/auth.js';
import type { AllowlistMatchValues } from '../../auth/embedded-as/storage/IAuthStorageLayer.js';
import { upsertAuthAccountWithTx } from '../../auth/embedded-as/storage/PostgresAuthStorageLayer.js';
import type {
  AtomicAccountProvisioningInput,
  AllowlistGateResult,
} from '../../auth/embedded-as/allowlistGate.js';
import { logger } from '../../utils/logger.js';
import {
  ConsoleStoreConflictError,
  isUniqueViolation,
} from './ConsoleStoreValidation.js';
import type {
  AllowlistAddInput,
  AllowlistRemoveInput,
  AllowlistUpdateInput,
  ConsoleAccountAllowlistEntry,
  IConsoleAccountAllowlistStore,
} from './IConsoleAccountAllowlistStore.js';
import {
  normalizeAllowlistDisplayValue,
  normalizeAllowlistValue,
  validateAllowlistAddInput,
  validateAllowlistRemoveInput,
  validateAllowlistUpdateInput,
} from './IConsoleAccountAllowlistStore.js';

export class PostgresConsoleAccountAllowlistStore implements IConsoleAccountAllowlistStore {
  constructor(private readonly db: DatabaseInstance) {}

  async assertIdentityMigrationReviewed(): Promise<void> {
    const rows = await withSystemContext(this.db, tx => tx.execute(sql`
      SELECT "entry_id" AS "entryId"
      FROM "account_allowlist_identity_migration_reviews"
      WHERE "reviewed_at" IS NULL
      LIMIT 1
    `)) as unknown as Array<{ readonly entryId: string }>;
    if (rows.length > 0) {
      throw new Error(
        'Sign-in allowlist authority cutover refused: legacy account allowlist identities require operator review.',
      );
    }
  }

  async listActive(): Promise<ConsoleAccountAllowlistEntry[]> {
    return withSystemContext(this.db, tx => listActiveAccountAllowlistEntriesWithTx(tx));
  }

  async hasActiveEntries(): Promise<boolean> {
    return withSystemContext(this.db, tx => hasActiveAccountAllowlistEntriesWithTx(tx));
  }

  async matchesIdentity(values: AllowlistMatchValues): Promise<boolean> {
    return withSystemContext(this.db, tx => accountAllowlistMatchesIdentityWithTx(tx, values));
  }

  async deniesIdentity(values: AllowlistMatchValues): Promise<boolean> {
    return withSystemContext(this.db, tx => accountAllowlistDeniesIdentityWithTx(tx, values));
  }

  async provisionAccountIfAllowed(
    input: AtomicAccountProvisioningInput,
  ): Promise<AllowlistGateResult> {
    return withSystemContext(this.db, async tx => {
      await lockAuthPrincipalsWithTx(tx, [input.identity.sub]);
      await lockAuthAllowlistIdentitiesWithTx(tx, allowlistLockIdentities({
        email: input.identity.email,
        githubUsername: input.identity.githubUsername,
        githubId: input.identity.githubId,
      }));
      const bootstrapRows = await tx.select({ payload: authKv.payload }).from(authKv)
        .where(and(eq(authKv.model, 'AuthBootstrap'), eq(authKv.id, 'state')))
        .limit(1)
        .for('update');
      const bootstrap = bootstrapRows[0]?.payload;
      const bootstrapRecord = bootstrap && typeof bootstrap === 'object' && !Array.isArray(bootstrap)
        ? bootstrap as Record<string, unknown>
        : null;
      const isBootstrapAdmin = Boolean(
        bootstrapRecord?.completed === true
        && bootstrapRecord.adminSub === input.identity.sub
        && bootstrapRecord.adminMethod === input.identity.method,
      );

      const values: AllowlistMatchValues = {
        email: input.identity.email,
        githubUsername: input.identity.githubUsername,
        githubId: input.identity.githubId,
      };
      const decision = isBootstrapAdmin
        ? { matched: false, denied: false }
        : await accountAllowlistIdentityDecisionWithTx(tx, values, true);
      const hasAnyEntries = isBootstrapAdmin || decision.matched || decision.denied || input.required
        ? true
        : await hasActiveAccountAllowlistEntriesWithTx(tx);

      if (isBootstrapAdmin || (!decision.denied && (
        decision.matched || (!input.required && !hasAnyEntries)
      ))) {
        await upsertAuthAccountWithTx(tx, input.account);
        if (input.successAuditEvent) {
          const event = input.successAuditEvent;
          await tx.insert(authIdentityEvents).values({
            type: event.type,
            sub: event.sub ?? null,
            provider: event.provider ?? null,
            externalSub: event.externalSub ?? null,
            details: event.details ?? null,
            timestamp: event.timestamp,
          });
        }
        return { allowed: true };
      }

      await recordAllowlistDenialWithTx(tx, input);
      return {
        allowed: false,
        reason: input.required
          ? 'Sign-in allowlist is required and this identity is not on it.'
          : 'This identity is not on the sign-in allowlist.',
      };
    });
  }

  async findActive(id: string): Promise<ConsoleAccountAllowlistEntry | null> {
    return withSystemContext(this.db, tx => findActiveAccountAllowlistEntryWithTx(tx, id));
  }

  async add(input: AllowlistAddInput): Promise<ConsoleAccountAllowlistEntry> {
    return withSystemContext(this.db, tx => addAccountAllowlistEntryWithTx(tx, input));
  }

  async update(input: AllowlistUpdateInput): Promise<ConsoleAccountAllowlistEntry | null> {
    return withSystemContext(this.db, tx => updateAccountAllowlistEntryWithTx(tx, input));
  }

  async remove(input: AllowlistRemoveInput): Promise<ConsoleAccountAllowlistEntry | null> {
    return withSystemContext(this.db, tx => removeAccountAllowlistEntryWithTx(tx, input));
  }
}

export async function accountAllowlistDeniesIdentityWithTx(
  tx: DrizzleTx,
  values: AllowlistMatchValues,
): Promise<boolean> {
  return (await accountAllowlistIdentityDecisionWithTx(tx, values)).denied;
}

export async function listActiveAccountAllowlistEntriesWithTx(
  tx: DrizzleTx,
): Promise<ConsoleAccountAllowlistEntry[]> {
  const rows = await tx.select().from(accountAllowlistEntries)
    .where(isNull(accountAllowlistEntries.revokedAt))
    .orderBy(asc(accountAllowlistEntries.createdAt));
  return rows.map(fromAllowlistRow);
}

export async function hasActiveAccountAllowlistEntriesWithTx(tx: DrizzleTx): Promise<boolean> {
  const rows = await tx.select({ id: accountAllowlistEntries.id }).from(accountAllowlistEntries)
    .where(isNull(accountAllowlistEntries.revokedAt))
    .limit(1);
  return rows.length > 0;
}

export async function accountAllowlistMatchesIdentityWithTx(
  tx: DrizzleTx,
  values: AllowlistMatchValues,
  lockMatch = false,
): Promise<boolean> {
  return (await latestActiveIdentityGrantWithTx(tx, values, lockMatch)) !== null;
}

async function accountAllowlistIdentityDecisionWithTx(
  tx: DrizzleTx,
  values: AllowlistMatchValues,
  lockRows = false,
): Promise<{ readonly matched: boolean; readonly denied: boolean }> {
  const activeAuthorityOrder = await latestActiveIdentityGrantWithTx(tx, values, lockRows);
  const tombstoneAuthorityOrder = await latestIdentityTombstoneWithTx(tx, values, lockRows);
  return {
    matched: activeAuthorityOrder !== null,
    denied: tombstoneAuthorityOrder !== null
      && (activeAuthorityOrder === null || tombstoneAuthorityOrder >= activeAuthorityOrder),
  };
}

async function latestActiveIdentityGrantWithTx(
  tx: DrizzleTx,
  values: AllowlistMatchValues,
  lockRow = false,
): Promise<number | null> {
  const predicates = allowlistIdentityPredicates(values);
  if (predicates.length === 0) return null;
  const query = tx.select({ authorityOrder: accountAllowlistEntries.authorityOrder }).from(accountAllowlistEntries)
    .where(and(isNull(accountAllowlistEntries.revokedAt), or(...predicates)))
    .orderBy(desc(accountAllowlistEntries.authorityOrder))
    .limit(1);
  const rows = lockRow ? await query.for('update') : await query;
  return rows[0]?.authorityOrder ?? null;
}

async function latestIdentityTombstoneWithTx(
  tx: DrizzleTx,
  values: AllowlistMatchValues,
  lockRow = false,
): Promise<number | null> {
  const predicates = allowlistIdentityPredicates(values);
  if (predicates.length === 0) return null;
  const query = tx.select({ authorityOrder: accountAllowlistEntries.authorityOrder }).from(accountAllowlistEntries)
    .where(and(isNotNull(accountAllowlistEntries.revokedAt), or(...predicates)))
    .orderBy(desc(accountAllowlistEntries.authorityOrder))
    .limit(1);
  const rows = lockRow ? await query.for('update') : await query;
  return rows[0]?.authorityOrder ?? null;
}

function allowlistIdentityPredicates(values: AllowlistMatchValues): SQL[] {
  const predicates: SQL[] = [];
  if (values.email) {
    const pred = activeAllowlistValuePredicate('email', values.email);
    if (pred) predicates.push(pred);
  }
  if (values.githubUsername) {
    const pred = activeAllowlistValuePredicate('github_username', values.githubUsername);
    if (pred) predicates.push(pred);
  }
  if (values.githubId) {
    const pred = activeAllowlistValuePredicate('github_id', values.githubId);
    if (pred) predicates.push(pred);
  }
  return predicates;
}

async function recordAllowlistDenialWithTx(
  tx: DrizzleTx,
  input: AtomicAccountProvisioningInput,
): Promise<void> {
  const details: Record<string, unknown> = { method: input.identity.method };
  if (input.identity.email !== undefined) details.email = input.identity.email;
  if (input.identity.githubUsername !== undefined) details.githubUsername = input.identity.githubUsername;
  try {
    await tx.transaction(async savepoint => {
      await savepoint.insert(authIdentityEvents).values({
        type: 'auth.allowlist_denied',
        sub: input.identity.sub,
        provider: input.identity.provider ?? null,
        externalSub: input.identity.externalSub ?? null,
        details,
        timestamp: Date.now(),
      });
    });
  } catch (error) {
    logger.warn('[allowlistGate] audit event emit failed', {
      error: error instanceof Error ? error.message : String(error),
      method: input.identity.method,
      sub: input.identity.sub,
    });
  }
}

export async function findActiveAccountAllowlistEntryWithTx(
  tx: DrizzleTx,
  id: string,
): Promise<ConsoleAccountAllowlistEntry | null> {
  const rows = await tx.select().from(accountAllowlistEntries)
    .where(and(eq(accountAllowlistEntries.id, id), isNull(accountAllowlistEntries.revokedAt)))
    .limit(1);
  return rows[0] ? fromAllowlistRow(rows[0]) : null;
}

function activeAllowlistValuePredicate(
  kind: ConsoleAccountAllowlistEntry['kind'],
  value: string,
): SQL | undefined {
  return and(
    eq(accountAllowlistEntries.kind, kind),
    eq(accountAllowlistEntries.normalizedValue, normalizeAllowlistValue(kind, value)),
  );
}

export async function addAccountAllowlistEntryWithTx(
  tx: DrizzleTx,
  input: AllowlistAddInput,
): Promise<ConsoleAccountAllowlistEntry> {
  validateAllowlistAddInput(input);
  const normalizedValue = normalizeAllowlistValue(input.kind, input.value);
  await lockAuthAllowlistIdentitiesWithTx(tx, [{ kind: input.kind, normalizedValue }]);
  try {
    const rows = await tx.insert(accountAllowlistEntries).values({
      kind: input.kind,
      normalizedValue,
      displayValue: normalizeAllowlistDisplayValue(input.value),
      note: input.note ?? null,
      createdByUserId: input.createdByUserId,
      createdAt: input.createdAt,
    }).returning();
    return fromAllowlistRow(rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConsoleStoreConflictError('active allowlist entry already exists');
    }
    throw error;
  }
}

export async function updateAccountAllowlistEntryWithTx(
  tx: DrizzleTx,
  input: AllowlistUpdateInput,
): Promise<ConsoleAccountAllowlistEntry | null> {
  validateAllowlistUpdateInput(input);
  if (input.note === undefined) return findActiveAccountAllowlistEntryWithTx(tx, input.id);
  const rows = await tx.update(accountAllowlistEntries)
    .set({ note: input.note })
    .where(and(eq(accountAllowlistEntries.id, input.id), isNull(accountAllowlistEntries.revokedAt)))
    .returning();
  return rows[0] ? fromAllowlistRow(rows[0]) : null;
}

export async function removeAccountAllowlistEntryWithTx(
  tx: DrizzleTx,
  input: AllowlistRemoveInput,
): Promise<ConsoleAccountAllowlistEntry | null> {
  validateAllowlistRemoveInput(input);
  const existing = await tx.select({
    kind: accountAllowlistEntries.kind,
    normalizedValue: accountAllowlistEntries.normalizedValue,
  }).from(accountAllowlistEntries)
    .where(and(eq(accountAllowlistEntries.id, input.id), isNull(accountAllowlistEntries.revokedAt)))
    .limit(1);
  if (!existing[0]) return null;
  await lockAuthAllowlistIdentitiesWithTx(tx, [existing[0]]);
  const rows = await tx.update(accountAllowlistEntries)
    .set({
      revokedByUserId: input.revokedByUserId,
      revokedAt: input.revokedAt,
      authorityOrder: sql`nextval('account_allowlist_authority_order_seq')`,
    })
    .where(and(eq(accountAllowlistEntries.id, input.id), isNull(accountAllowlistEntries.revokedAt)))
    .returning();
  return rows[0] ? fromAllowlistRow(rows[0]) : null;
}

function allowlistLockIdentities(values: AllowlistMatchValues): AuthAllowlistLockIdentity[] {
  const identities: AuthAllowlistLockIdentity[] = [];
  const add = (
    kind: ConsoleAccountAllowlistEntry['kind'],
    value: string | undefined,
  ): void => {
    if (!value) return;
    const normalizedValue = normalizeAllowlistValue(kind, value);
    if (normalizedValue) identities.push({ kind, normalizedValue });
  };
  add('email', values.email);
  add('github_username', values.githubUsername);
  add('github_id', values.githubId);
  return identities;
}

function fromAllowlistRow(row: typeof accountAllowlistEntries.$inferSelect): ConsoleAccountAllowlistEntry {
  return {
    id: row.id,
    kind: row.kind,
    normalizedValue: row.normalizedValue,
    displayValue: row.displayValue,
    note: row.note,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    revokedByUserId: row.revokedByUserId,
    revokedAt: row.revokedAt,
  };
}
