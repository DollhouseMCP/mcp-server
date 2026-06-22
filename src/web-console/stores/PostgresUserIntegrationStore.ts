import { and, asc, eq, isNull } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { userIntegrations } from '../../database/schema/index.js';
import {
  cloneUserIntegrationRecord,
  type IUserIntegrationStore,
  type UserIntegrationConnectInput,
  type UserIntegrationDisconnectInput,
  type UserIntegrationErrorInput,
  type UserIntegrationProvider,
  type UserIntegrationRecord,
  validateUserIntegrationRecord,
} from './IUserIntegrationStore.js';
import { assertUuid } from './ConsoleStoreValidation.js';

export class PostgresUserIntegrationStore implements IUserIntegrationStore {
  constructor(private readonly db: DatabaseInstance) {}

  async listByUser(userId: string): Promise<readonly UserIntegrationRecord[]> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(userIntegrations).where(and(
        eq(userIntegrations.userId, userId),
        isNull(userIntegrations.revokedAt),
      )).orderBy(asc(userIntegrations.provider)).limit(25),
    );
    return rows.map(fromRow);
  }

  async findByProvider(userId: string, provider: UserIntegrationProvider): Promise<UserIntegrationRecord | null> {
    assertUuid(userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.select().from(userIntegrations).where(and(
        eq(userIntegrations.userId, userId),
        eq(userIntegrations.provider, provider),
        isNull(userIntegrations.revokedAt),
      )).limit(1),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async connect(input: UserIntegrationConnectInput): Promise<UserIntegrationRecord> {
    validateConnectInput(input);
    const rows = await withSystemContext(this.db, async tx => {
      await tx.update(userIntegrations).set({
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        status: 'revoked',
        errorReason: null,
        revokedAt: input.connectedAt,
      }).where(and(
        eq(userIntegrations.userId, input.userId),
        eq(userIntegrations.provider, input.provider),
        isNull(userIntegrations.revokedAt),
      ));
      return tx.insert(userIntegrations).values({
        userId: input.userId,
        provider: input.provider,
        externalAccountLabel: input.externalAccountLabel,
        externalInstallationId: input.externalInstallationId,
        authorizedPermissions: input.authorizedPermissions,
        accessTokenCiphertext: input.accessTokenCiphertext,
        refreshTokenCiphertext: input.refreshTokenCiphertext,
        credentialKeyVersion: null,
        status: 'connected',
        errorReason: null,
        connectedAt: input.connectedAt,
        lastSyncAt: null,
        revokedAt: null,
      }).returning();
    });
    if (!rows[0]) throw new Error('PostgreSQL did not return inserted user integration row');
    return fromRow(rows[0]);
  }

  async recordError(input: UserIntegrationErrorInput): Promise<UserIntegrationRecord> {
    assertUuid(input.userId, 'userId');
    const rows = await withSystemContext(this.db, async tx => {
      await tx.update(userIntegrations).set({
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        status: 'revoked',
        errorReason: null,
        revokedAt: input.occurredAt,
      }).where(and(
        eq(userIntegrations.userId, input.userId),
        eq(userIntegrations.provider, input.provider),
        isNull(userIntegrations.revokedAt),
      ));
      return tx.insert(userIntegrations).values({
        userId: input.userId,
        provider: input.provider,
        externalAccountLabel: null,
        externalInstallationId: null,
        authorizedPermissions: {
          repository_selection: 'unknown',
          permissions: { contents: 'none' },
        },
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        credentialKeyVersion: null,
        status: 'error',
        errorReason: input.errorReason,
        connectedAt: null,
        lastSyncAt: null,
        revokedAt: null,
      }).returning();
    });
    if (!rows[0]) throw new Error('PostgreSQL did not return inserted user integration error row');
    return fromRow(rows[0]);
  }

  async disconnect(input: UserIntegrationDisconnectInput): Promise<UserIntegrationRecord | null> {
    assertUuid(input.userId, 'userId');
    const rows = await withSystemContext(this.db, tx =>
      tx.update(userIntegrations).set({
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        status: 'revoked',
        errorReason: null,
        revokedAt: input.revokedAt,
      }).where(and(
        eq(userIntegrations.userId, input.userId),
        eq(userIntegrations.provider, input.provider),
        isNull(userIntegrations.revokedAt),
      )).returning(),
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }
}

function validateConnectInput(input: UserIntegrationConnectInput): void {
  validateUserIntegrationRecord({
    id: '00000000-0000-4000-8000-000000000000',
    userId: input.userId,
    provider: input.provider,
    externalAccountLabel: input.externalAccountLabel,
    externalInstallationId: input.externalInstallationId,
    authorizedPermissions: input.authorizedPermissions,
    accessTokenCiphertext: input.accessTokenCiphertext,
    refreshTokenCiphertext: input.refreshTokenCiphertext,
    credentialKeyVersion: null,
    status: 'connected',
    errorReason: null,
    connectedAt: input.connectedAt,
    lastSyncAt: null,
    revokedAt: null,
  });
}

function fromRow(row: typeof userIntegrations.$inferSelect): UserIntegrationRecord {
  const record: UserIntegrationRecord = {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    externalAccountLabel: row.externalAccountLabel,
    externalInstallationId: row.externalInstallationId,
    authorizedPermissions: asJsonRecord(row.authorizedPermissions),
    accessTokenCiphertext: row.accessTokenCiphertext,
    refreshTokenCiphertext: row.refreshTokenCiphertext,
    credentialKeyVersion: row.credentialKeyVersion,
    status: row.status,
    errorReason: row.errorReason,
    connectedAt: row.connectedAt,
    lastSyncAt: row.lastSyncAt,
    revokedAt: row.revokedAt,
  };
  validateUserIntegrationRecord(record);
  return cloneUserIntegrationRecord(record);
}

function asJsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
