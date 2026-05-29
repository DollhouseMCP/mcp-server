import { and, asc, eq, isNull } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { userIntegrations } from '../../database/schema/index.js';
import {
  cloneUserIntegrationRecord,
  type IUserIntegrationStore,
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
