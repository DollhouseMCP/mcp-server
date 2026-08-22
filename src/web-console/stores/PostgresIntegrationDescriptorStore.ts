import { and, asc, desc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import {
  consoleLoginTransactions,
  integrationCuratedProviderState,
  integrationProviderDescriptors,
  userIntegrations,
} from '../../database/schema/index.js';
import {
  cloneIntegrationDescriptorRecord,
  CuratedIntegrationSeedConflictError,
  decodeDescriptorPageCursor,
  encodeDescriptorPageCursor,
  resolveDescriptorPageLimit,
  type IIntegrationDescriptorStore,
  type CuratedIntegrationDeploymentState,
  type CuratedIntegrationSeedDirective,
  type CuratedIntegrationSeedResult,
  type IntegrationDescriptorCreateInput,
  type IntegrationDescriptorPage,
  type IntegrationDescriptorPageRequest,
  type IntegrationDescriptorRecord,
  type IntegrationDescriptorUpsertOptions,
  integrationDescriptorMutationKey,
  isRetainedSeedCredentialRefresh,
  isCleanupRevocationEndpointRepair,
  type IntegrationOAuthDescriptor,
  type IntegrationStaticApiKeyDescriptor,
  validateIntegrationDescriptorInput,
  validateIntegrationDescriptorRecord,
  IntegrationDescriptorMutationBusyError,
  IntegrationDescriptorRevisionConflictError,
} from './IIntegrationDescriptorStore.js';
import { assertUserIntegrationProvider, type UserIntegrationProvider } from './IUserIntegrationStore.js';
import { assertUuid, ConsoleStoreConflictError } from './ConsoleStoreValidation.js';
import { integrationDescriptorRoutingFingerprint } from '../modules/integrations/IntegrationDescriptorRoutingFingerprint.js';

export class PostgresIntegrationDescriptorStore implements IIntegrationDescriptorStore {
  constructor(private readonly db: DatabaseInstance) {}

  async listVisible(userId: string): Promise<readonly IntegrationDescriptorRecord[]> {
    const all: IntegrationDescriptorRecord[] = [];
    let cursor: string | null = null;
    do {
      const page: IntegrationDescriptorPage = await this.listVisiblePage(userId, { cursor });
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  }

  async listVisiblePage(
    userId: string,
    page: IntegrationDescriptorPageRequest = {},
  ): Promise<IntegrationDescriptorPage> {
    assertUuid(userId, 'userId');
    const limit = resolveDescriptorPageLimit(page.limit);
    const cursor = page.cursor ? decodeDescriptorPageCursor(page.cursor) : null;
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(integrationProviderDescriptors).where(cursor
        ? and(descriptorVisibility(userId), or(
          gt(integrationProviderDescriptors.provider, cursor.provider),
          and(
            eq(integrationProviderDescriptors.provider, cursor.provider),
            gt(integrationProviderDescriptors.id, cursor.id),
          ),
        ))
        : descriptorVisibility(userId))
        .orderBy(asc(integrationProviderDescriptors.provider), asc(integrationProviderDescriptors.id))
        .limit(limit + 1),
    );
    const items = rows.slice(0, limit).map(fromDescriptorRow);
    const lastItem = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && lastItem ? encodeDescriptorPageCursor(lastItem) : null,
    };
  }

  async findVisibleByProvider(
    userId: string,
    provider: UserIntegrationProvider,
  ): Promise<IntegrationDescriptorRecord | null> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(integrationProviderDescriptors).where(and(
        eq(integrationProviderDescriptors.provider, provider),
        descriptorVisibility(userId),
      ))
        // Curated strictly wins over a same-id BYO descriptor ('byo' < 'curated'
        // lexically, so descending order puts curated first) — deterministic
        // resolution prevents a BYO descriptor shadowing a curated provider.
        .orderBy(desc(integrationProviderDescriptors.ownership))
        .limit(1),
    );
    return rows[0] ? fromDescriptorRow(rows[0]) : null;
  }

  async findCuratedByProvider(
    provider: UserIntegrationProvider,
  ): Promise<IntegrationDescriptorRecord | null> {
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(integrationProviderDescriptors).where(and(
        eq(integrationProviderDescriptors.provider, provider),
        eq(integrationProviderDescriptors.ownership, 'curated'),
        isNull(integrationProviderDescriptors.ownerUserId),
      )).limit(1),
    );
    return rows[0] ? fromDescriptorRow(rows[0]) : null;
  }

  async findById(id: string, userId: string): Promise<IntegrationDescriptorRecord | null> {
    assertUuid(id, 'id');
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(integrationProviderDescriptors).where(and(
        eq(integrationProviderDescriptors.id, id),
        eq(integrationProviderDescriptors.ownership, 'byo'),
        eq(integrationProviderDescriptors.ownerUserId, userId),
      )).limit(1),
    );
    return rows[0] ? fromDescriptorRow(rows[0]) : null;
  }

  async delete(id: string, ownerUserId: string): Promise<boolean> {
    assertUuid(id, 'id');
    assertUuid(ownerUserId, 'ownerUserId');
    const rows = await withSystemContext(this.db, async tx => {
      const identityRows = await tx.select({
        provider: integrationProviderDescriptors.provider,
      }).from(integrationProviderDescriptors).where(and(
        eq(integrationProviderDescriptors.id, id),
        eq(integrationProviderDescriptors.ownership, 'byo'),
        eq(integrationProviderDescriptors.ownerUserId, ownerUserId),
      )).limit(1);
      const identity = identityRows[0];
      if (!identity) return [];
      assertUserIntegrationProvider(identity.provider);
      await lockDescriptorMutationWithTx(tx, {
        provider: identity.provider,
        ownership: 'byo',
        ownerUserId,
      });
      const existing = await tx.select({ id: integrationProviderDescriptors.id })
        .from(integrationProviderDescriptors).where(and(
          eq(integrationProviderDescriptors.id, id),
          eq(integrationProviderDescriptors.ownership, 'byo'),
          eq(integrationProviderDescriptors.ownerUserId, ownerUserId),
        )).for('update').limit(1);
      if (!existing[0]) return [];
      await invalidateDescriptorBindingsWithTx(tx, id, new Date());
      return tx.delete(integrationProviderDescriptors).where(and(
        eq(integrationProviderDescriptors.id, id),
        eq(integrationProviderDescriptors.ownership, 'byo'),
        eq(integrationProviderDescriptors.ownerUserId, ownerUserId),
      )).returning({ id: integrationProviderDescriptors.id });
    });
    return rows.length > 0;
  }

  async deleteCurated(provider: UserIntegrationProvider): Promise<boolean> {
    const rows = await withSystemContext(this.db, async tx => {
      await lockDescriptorMutationWithTx(tx, {
        provider,
        ownership: 'curated',
        ownerUserId: null,
      });
      const existing = await tx.select({ id: integrationProviderDescriptors.id })
        .from(integrationProviderDescriptors).where(and(
          eq(integrationProviderDescriptors.provider, provider),
          eq(integrationProviderDescriptors.ownership, 'curated'),
          isNull(integrationProviderDescriptors.ownerUserId),
        )).for('update').limit(1);
      if (!existing[0]) return [];
      await invalidateDescriptorBindingsWithTx(tx, existing[0].id, new Date());
      return tx.delete(integrationProviderDescriptors).where(and(
        eq(integrationProviderDescriptors.provider, provider),
        eq(integrationProviderDescriptors.ownership, 'curated'),
        isNull(integrationProviderDescriptors.ownerUserId),
      )).returning({ id: integrationProviderDescriptors.id });
    });
    return rows.length > 0;
  }

  async reconcileCuratedSeed(
    directive: CuratedIntegrationSeedDirective,
  ): Promise<CuratedIntegrationSeedResult> {
    validateCuratedSeedDirective(directive);
    return withSystemContext(this.db, async tx => {
      // The state and descriptor rows may not exist yet, so the canonical
      // identity lock closes first-seed/first-insert races across every writer.
      await lockDescriptorMutationWithTx(tx, directive.enabled
        ? directive.descriptor
        : { provider: directive.provider, ownership: 'curated', ownerUserId: null });
      const stateRows = await tx.select().from(integrationCuratedProviderState).where(
        eq(integrationCuratedProviderState.provider, directive.provider),
      ).for('update').limit(1);
      const descriptorRows = await tx.select().from(integrationProviderDescriptors).where(and(
        eq(integrationProviderDescriptors.provider, directive.provider),
        eq(integrationProviderDescriptors.ownership, 'curated'),
        isNull(integrationProviderDescriptors.ownerUserId),
      )).for('update').limit(1);
      const currentState = stateRows[0] ? fromDeploymentStateRow(stateRows[0]) : null;
      const transition = curatedSeedTransition(currentState, directive);
      const existing = descriptorRows[0] ? fromDescriptorRow(descriptorRows[0]) : null;
      if (transition === 'retain') {
        return {
          applied: false,
          enabled: currentState?.enabled ?? true,
          seedRevision: currentState?.seedRevision ?? existing?.curatedSeedRevision ?? null,
          descriptor: currentState?.enabled === false ? null : existing,
        };
      }
      if (!directive.enabled) {
        await fenceDescriptorCallbacksWithTx(tx, existing?.id ?? null);
        await persistDeploymentStateWithTx(tx, currentState, {
          provider: directive.provider,
          seedRevision: directive.seedRevision,
          enabled: false,
          updatedAt: directive.updatedAt,
        });
        return {
          applied: transition === 'apply',
          enabled: false,
          seedRevision: directive.seedRevision,
          descriptor: null,
        };
      }
      const rows = await upsertDescriptorWithTx(
        tx,
        directive.descriptor,
        directive.upsertOptions ?? {},
        descriptorRows,
      );
      if (!rows[0]) throw new Error('PostgreSQL did not return integration descriptor row');
      if (directive.seedRevision !== null) {
        await persistDeploymentStateWithTx(tx, currentState, {
          provider: directive.provider,
          seedRevision: directive.seedRevision,
          enabled: true,
          updatedAt: directive.updatedAt,
        });
      }
      return {
        applied: transition === 'apply',
        enabled: true,
        seedRevision: directive.seedRevision,
        descriptor: fromDescriptorRow(rows[0]),
      };
    });
  }

  async upsert(
    input: IntegrationDescriptorCreateInput,
    options: IntegrationDescriptorUpsertOptions = {},
  ): Promise<IntegrationDescriptorRecord> {
    validateIntegrationDescriptorInput(input);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const rows = await this.upsertOnce(input, options);
        if (!rows[0]) throw new Error('PostgreSQL did not return integration descriptor row');
        return fromDescriptorRow(rows[0]);
      } catch (error) {
        if (attempt === 0 && isUniqueViolation(error)) continue;
        throw error;
      }
    }
    throw new Error('integration descriptor unique-race retry exhausted');
  }

  private async upsertOnce(
    input: IntegrationDescriptorCreateInput,
    options: IntegrationDescriptorUpsertOptions,
  ): Promise<(typeof integrationProviderDescriptors.$inferSelect)[]> {
    return withSystemContext(this.db, async tx => {
      await lockDescriptorMutationWithTx(tx, input);
      return upsertDescriptorWithTx(tx, input, options);
    });
  }
}

type SystemTransaction = Parameters<Parameters<DatabaseInstance['transaction']>[0]>[0];

async function lockDescriptorMutationWithTx(
  tx: SystemTransaction,
  identity: Pick<IntegrationDescriptorCreateInput, 'provider' | 'ownership' | 'ownerUserId'>,
): Promise<void> {
  const key = integrationDescriptorMutationKey(identity);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

async function upsertDescriptorWithTx(
  tx: SystemTransaction,
  input: IntegrationDescriptorCreateInput,
  options: IntegrationDescriptorUpsertOptions,
  lockedRows?: (typeof integrationProviderDescriptors.$inferSelect)[],
): Promise<(typeof integrationProviderDescriptors.$inferSelect)[]> {
  const existing = lockedRows ?? await tx.select().from(integrationProviderDescriptors)
    .where(descriptorIdentity(input)).for('update').limit(1);
  if (!existing[0]) {
    if (options.expectedUpdatedAt) {
      throw new IntegrationDescriptorRevisionConflictError();
    }
    return tx.insert(integrationProviderDescriptors)
      .values(toDescriptorValues(input, input.createdAt)).returning();
  }
  const current = fromDescriptorRow(existing[0]);
  if (options.expectedUpdatedAt
      && current.updatedAt.getTime() !== options.expectedUpdatedAt.getTime()) {
    throw new IntegrationDescriptorRevisionConflictError();
  }
  const nextUpdatedAt = new Date(Math.max(
    input.updatedAt.getTime(),
    current.updatedAt.getTime() + 1,
  ));
  const nextInput: IntegrationDescriptorCreateInput = {
    ...input,
    updatedAt: nextUpdatedAt,
  };
  if (preservesNewerCuratedSeed(current, input)) {
    if (!options.refreshDeploymentCredentialsAtRetainedSeedRevision) return existing;
    if (!isRetainedSeedCredentialRefresh(current, input)) {
      throw new ConsoleStoreConflictError(
        'retained seed revision may rewrap unchanged deployment OAuth credentials only',
      );
    }
  }
  const proposed: IntegrationDescriptorRecord = {
    ...current,
    provider: input.provider,
    ownership: input.ownership,
    ownerUserId: input.ownerUserId,
    displayName: input.displayName,
    category: input.category,
    authStrategy: input.authStrategy,
    apiHosts: [...input.apiHosts],
    oauth: input.oauth ?? null,
    staticApiKey: input.staticApiKey ?? null,
    clientSecretCiphertext: input.clientSecretCiphertext ?? null,
    clientSecretRevision: input.clientSecretRevision ?? null,
    credentialKeyVersion: input.credentialKeyVersion ?? null,
    curatedSeedRevision: input.curatedSeedRevision ?? null,
    operationPromotion: input.operationPromotion ?? {},
    updatedAt: nextUpdatedAt,
  };
  const currentFingerprint = integrationDescriptorRoutingFingerprint(current);
  const proposedFingerprint = integrationDescriptorRoutingFingerprint(proposed);
  const initializesOnlyRevision = options.initializeClientSecretRevision === true
    && current.clientSecretRevision === null
    && proposed.clientSecretRevision !== null
    && currentFingerprint === integrationDescriptorRoutingFingerprint({
      ...proposed,
      clientSecretRevision: null,
    });
  if (currentFingerprint !== proposedFingerprint && !initializesOnlyRevision) {
    if (isCleanupRevocationEndpointRepair(current, proposed)) {
      await fenceDescriptorCallbacksWithTx(tx, existing[0].id);
      await assertDescriptorCredentialsCleanupOnlyWithTx(tx, existing[0].id);
    } else {
      await invalidateDescriptorBindingsWithTx(tx, existing[0].id, nextUpdatedAt);
    }
  }
  return tx.update(integrationProviderDescriptors)
    .set(toDescriptorValues(nextInput, existing[0].createdAt))
    .where(eq(integrationProviderDescriptors.id, existing[0].id))
    .returning();
}

async function invalidateDescriptorBindingsWithTx(
  tx: SystemTransaction,
  descriptorId: string,
  revokedAt: Date,
): Promise<void> {
  // The descriptor row is already locked FOR UPDATE by every caller. Remove
  // callbacks first, then clear credentials, so callback persistence can use
  // the same descriptor -> transaction -> credential lock order without a
  // deadlock or a stale credential write after rotation.
  await fenceDescriptorCallbacksWithTx(tx, descriptorId);
  await assertDescriptorCredentiallessWithTx(tx, descriptorId);
  await tx.update(userIntegrations).set({
    accessTokenCiphertext: null,
    refreshTokenCiphertext: null,
    refreshLeaseId: null,
    refreshLeaseExpiresAt: null,
    refreshFence: sql`${userIntegrations.refreshFence} + 1`,
    status: 'revoked',
    errorReason: null,
    revokedAt,
  }).where(and(
    eq(userIntegrations.integrationDescriptorId, descriptorId),
    isNull(userIntegrations.revokedAt),
  ));
}

async function assertDescriptorCredentiallessWithTx(
  tx: SystemTransaction,
  descriptorId: string,
): Promise<void> {
  const credentialBindings = await tx.select({ id: userIntegrations.id })
    .from(userIntegrations).where(and(
      eq(userIntegrations.integrationDescriptorId, descriptorId),
      or(
        isNotNull(userIntegrations.accessTokenCiphertext),
        isNotNull(userIntegrations.refreshTokenCiphertext),
      ),
    )).for('update').limit(1);
  if (credentialBindings.length > 0) {
    throw new IntegrationDescriptorMutationBusyError();
  }
}

async function assertDescriptorCredentialsCleanupOnlyWithTx(
  tx: SystemTransaction,
  descriptorId: string,
): Promise<void> {
  const executableBindings = await tx.select({ id: userIntegrations.id })
    .from(userIntegrations).where(and(
      eq(userIntegrations.integrationDescriptorId, descriptorId),
      or(
        isNotNull(userIntegrations.accessTokenCiphertext),
        isNotNull(userIntegrations.refreshTokenCiphertext),
      ),
      or(
        isNull(userIntegrations.revokedAt),
        sql`${userIntegrations.status} <> 'cleanup_pending'`,
      ),
    )).for('update').limit(1);
  if (executableBindings.length > 0) throw new IntegrationDescriptorMutationBusyError();
}

async function fenceDescriptorCallbacksWithTx(
  tx: SystemTransaction,
  descriptorId: string | null,
): Promise<void> {
  if (!descriptorId) return;
  const activeCallbacks = await tx.select({
    consumedAt: consoleLoginTransactions.consumedAt,
  }).from(consoleLoginTransactions).where(and(
    eq(consoleLoginTransactions.integrationDescriptorId, descriptorId),
    gt(consoleLoginTransactions.expiresAt, sql`statement_timestamp()`),
  )).for('update');
  if (activeCallbacks.some(callback => callback.consumedAt !== null)) {
    throw new IntegrationDescriptorMutationBusyError();
  }
  await tx.delete(consoleLoginTransactions).where(
    eq(consoleLoginTransactions.integrationDescriptorId, descriptorId),
  );
}

function descriptorVisibility(userId: string) {
  return or(
    and(
      eq(integrationProviderDescriptors.ownership, 'curated'),
      sql`NOT EXISTS (
        SELECT 1
        FROM ${integrationCuratedProviderState}
        WHERE ${integrationCuratedProviderState.provider} = ${integrationProviderDescriptors.provider}
          AND ${integrationCuratedProviderState.enabled} = FALSE
      )`,
    ),
    eq(integrationProviderDescriptors.ownerUserId, userId),
  );
}

async function persistDeploymentStateWithTx(
  tx: SystemTransaction,
  current: CuratedIntegrationDeploymentState | null,
  next: CuratedIntegrationDeploymentState,
): Promise<void> {
  if (current) {
    await tx.update(integrationCuratedProviderState).set({
      seedRevision: next.seedRevision,
      enabled: next.enabled,
      updatedAt: next.updatedAt,
    }).where(eq(integrationCuratedProviderState.provider, next.provider));
    return;
  }
  await tx.insert(integrationCuratedProviderState).values({
    provider: next.provider,
    seedRevision: next.seedRevision,
    enabled: next.enabled,
    updatedAt: next.updatedAt,
  });
}

function fromDeploymentStateRow(
  row: typeof integrationCuratedProviderState.$inferSelect,
): CuratedIntegrationDeploymentState {
  return {
    provider: row.provider as UserIntegrationProvider,
    seedRevision: row.seedRevision,
    enabled: row.enabled,
    updatedAt: row.updatedAt,
  };
}

function validateCuratedSeedDirective(directive: CuratedIntegrationSeedDirective): void {
  assertUserIntegrationProvider(directive.provider);
  const revision = directive.seedRevision;
  if (revision !== null && (!Number.isSafeInteger(revision) || revision < 1 || revision > 2_147_483_647)) {
    throw new CuratedIntegrationSeedConflictError('curated seed revision is invalid');
  }
  if (!directive.enabled) {
    if (revision === null) throw new CuratedIntegrationSeedConflictError('disabled curated seed requires a revision');
    return;
  }
  validateIntegrationDescriptorInput(directive.descriptor);
  const descriptorRevision = directive.descriptor.curatedSeedRevision ?? null;
  if (directive.descriptor.ownership !== 'curated'
      || directive.descriptor.ownerUserId !== null
      || directive.descriptor.provider !== directive.provider
      || (revision !== null && descriptorRevision !== null && descriptorRevision < revision)) {
    throw new CuratedIntegrationSeedConflictError('curated seed directive does not match its descriptor');
  }
}

function curatedSeedTransition(
  current: CuratedIntegrationDeploymentState | null,
  directive: CuratedIntegrationSeedDirective,
): 'apply' | 'same' | 'retain' {
  if (!current) return 'apply';
  const revision = directive.seedRevision;
  if (revision === null || revision < current.seedRevision) return 'retain';
  if (revision === current.seedRevision) {
    if (directive.enabled !== current.enabled) {
      throw new CuratedIntegrationSeedConflictError(
        'curated seed cannot change enabled state without a newer revision',
      );
    }
    return 'same';
  }
  return 'apply';
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return candidate.code === '23505' || isUniqueViolation(candidate.cause);
}

function descriptorIdentity(input: IntegrationDescriptorCreateInput) {
  if (input.ownership === 'curated') {
    return and(
      eq(integrationProviderDescriptors.provider, input.provider),
      eq(integrationProviderDescriptors.ownership, 'curated'),
      isNull(integrationProviderDescriptors.ownerUserId),
    );
  }
  if (!input.ownerUserId) throw new Error('validated BYO descriptor missing ownerUserId');
  return and(
    eq(integrationProviderDescriptors.provider, input.provider),
    eq(integrationProviderDescriptors.ownership, 'byo'),
    eq(integrationProviderDescriptors.ownerUserId, input.ownerUserId),
  );
}

function toDescriptorValues(input: IntegrationDescriptorCreateInput, createdAt: Date) {
  return {
    provider: input.provider,
    ownership: input.ownership,
    ownerUserId: input.ownerUserId,
    displayName: input.displayName,
    category: input.category,
    authStrategy: input.authStrategy,
    apiHosts: [...input.apiHosts],
    oauth: input.oauth ? cloneJsonValue(input.oauth) : null,
    staticApiKey: input.staticApiKey ? cloneJsonValue(input.staticApiKey) : null,
    clientSecretCiphertext: input.clientSecretCiphertext ? Buffer.from(input.clientSecretCiphertext) : null,
    clientSecretRevision: input.clientSecretRevision ?? null,
    credentialKeyVersion: input.credentialKeyVersion ?? null,
    curatedSeedRevision: input.curatedSeedRevision ?? null,
    operationPromotion: cloneJsonValue(input.operationPromotion ?? {}),
    createdAt,
    updatedAt: input.updatedAt,
  };
}

export function fromDescriptorRow(row: typeof integrationProviderDescriptors.$inferSelect): IntegrationDescriptorRecord {
  const record: IntegrationDescriptorRecord = {
    id: row.id,
    provider: row.provider as UserIntegrationProvider,
    ownership: row.ownership,
    ownerUserId: row.ownerUserId,
    displayName: row.displayName,
    category: row.category,
    authStrategy: row.authStrategy,
    apiHosts: Array.isArray(row.apiHosts) ? row.apiHosts.filter((item): item is string => typeof item === 'string') : [],
    oauth: asNullableOAuth(row.oauth),
    staticApiKey: asNullableStaticApiKey(row.staticApiKey),
    clientSecretCiphertext: row.clientSecretCiphertext,
    clientSecretRevision: row.clientSecretRevision,
    credentialKeyVersion: row.credentialKeyVersion,
    curatedSeedRevision: row.curatedSeedRevision,
    operationPromotion: asJsonRecord(row.operationPromotion),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  validateIntegrationDescriptorRecord(record);
  return cloneIntegrationDescriptorRecord(record);
}

function preservesNewerCuratedSeed(
  existing: IntegrationDescriptorRecord,
  input: IntegrationDescriptorCreateInput,
): boolean {
  const currentRevision = existing.curatedSeedRevision ?? null;
  if (existing.ownership !== 'curated' || currentRevision === null) return false;
  const proposedRevision = input.curatedSeedRevision ?? null;
  return proposedRevision === null || proposedRevision <= currentRevision;
}

function asNullableOAuth(value: unknown): IntegrationOAuthDescriptor | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as IntegrationOAuthDescriptor
    : null;
}

function asNullableStaticApiKey(value: unknown): IntegrationStaticApiKeyDescriptor | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as IntegrationStaticApiKeyDescriptor
    : null;
}

function asJsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cloneJsonValue(value: unknown): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>;
}
