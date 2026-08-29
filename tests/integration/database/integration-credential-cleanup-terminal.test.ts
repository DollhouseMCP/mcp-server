import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import {
  integrationProviderDescriptors,
  userIntegrations,
} from '../../../src/database/schema/webConsole.js';
import { users } from '../../../src/database/schema/users.js';
import { PostgresUserIntegrationStore } from '../../../src/web-console/stores/PostgresUserIntegrationStore.js';
import {
  closeTestDb,
  getTestAdminDb,
  isDatabaseAvailable,
} from './test-db-helpers.js';

let databaseAvailable = false;

beforeAll(async () => {
  databaseAvailable = await isDatabaseAvailable();
  if (!databaseAvailable && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') {
    throw new Error('PostgreSQL cleanup-terminal proof is required but the test database is unavailable.');
  }
});

afterAll(async () => {
  if (databaseAvailable) await closeTestDb();
});

describe('migration 0052 terminal integration credential cleanup', () => {
  it('blocks pending account deletion but permits explicit terminal cleanup deletion', async () => {
    if (!databaseAvailable) return;
    const db = getTestAdminDb();
    const store = new PostgresUserIntegrationStore(db);
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      username: `cleanup-account-${userId}`,
    });
    const connected = await store.connect({
      userId,
      provider: 'github',
      integrationDescriptorId: null,
      externalAccountLabel: 'round-3-account',
      externalInstallationId: null,
      authorizedPermissions: {
        repository_selection: 'unknown',
        permissions: { contents: 'none' },
      },
      accessTokenCiphertext: Buffer.from('encrypted-access-token'),
      refreshTokenCiphertext: null,
      connectedAt: new Date(),
    });
    const pending = await store.beginCredentialCleanup({
      userId,
      provider: 'github',
      expectedActiveRecordId: connected.id,
      revokedAt: new Date(),
    });

    await expectCredentialDeleteBlocked(db.delete(users).where(eq(users.id, userId)));
    const leaseId = randomUUID();
    await store.claimCredentialCleanup({
      userId,
      provider: 'github',
      cleanupRecordId: pending?.id ?? '',
      leaseId,
      attemptedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await expect(store.failCredentialCleanup({
      userId,
      provider: 'github',
      cleanupRecordId: pending?.id ?? '',
      leaseId,
    })).resolves.toMatchObject({
      status: 'cleanup_failed',
      accessTokenCiphertext: Buffer.from('encrypted-access-token'),
    });
    await expect(store.hasAnyCredentialMaterial(userId)).resolves.toBe(true);
    await expect(store.hasBlockingCredentialMaterial(userId)).resolves.toBe(false);
    await expect(db.delete(users).where(eq(users.id, userId))).resolves.toBeDefined();
    await expect(db.select().from(userIntegrations).where(eq(userIntegrations.userId, userId)))
      .resolves.toEqual([]);
  });

  it('blocks pending descriptor deletion but retains terminal ciphertext after the descriptor is removed', async () => {
    if (!databaseAvailable) return;
    const db = getTestAdminDb();
    const store = new PostgresUserIntegrationStore(db);
    const userId = randomUUID();
    const descriptorId = randomUUID();
    await db.insert(users).values({
      id: userId,
      username: `cleanup-descriptor-${userId}`,
    });
    await db.insert(integrationProviderDescriptors).values({
      id: descriptorId,
      provider: 'round3descriptor',
      ownership: 'byo',
      ownerUserId: userId,
      displayName: 'Round 3 descriptor',
      category: 'Test',
      authStrategy: 'coded',
      apiHosts: ['https://api.example.test'],
    });
    const connected = await store.connect({
      userId,
      provider: 'round3descriptor',
      integrationDescriptorId: descriptorId,
      externalAccountLabel: 'round-3-descriptor',
      externalInstallationId: null,
      authorizedPermissions: { scopes: [] },
      accessTokenCiphertext: Buffer.from('encrypted-access-token'),
      refreshTokenCiphertext: null,
      connectedAt: new Date(),
    });
    const pending = await store.beginCredentialCleanup({
      userId,
      provider: 'round3descriptor',
      expectedActiveRecordId: connected.id,
      revokedAt: new Date(),
    });

    await expectCredentialDeleteBlocked(db.delete(integrationProviderDescriptors)
      .where(eq(integrationProviderDescriptors.id, descriptorId)));
    const leaseId = randomUUID();
    await store.claimCredentialCleanup({
      userId,
      provider: 'round3descriptor',
      cleanupRecordId: pending?.id ?? '',
      leaseId,
      attemptedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await expect(store.failCredentialCleanup({
      userId,
      provider: 'round3descriptor',
      cleanupRecordId: pending?.id ?? '',
      leaseId,
    })).resolves.toMatchObject({ status: 'cleanup_failed' });
    await expect(store.hasBlockingCredentialMaterialByDescriptor(descriptorId)).resolves.toBe(false);
    await expect(db.delete(integrationProviderDescriptors)
      .where(eq(integrationProviderDescriptors.id, descriptorId)))
      .resolves.toBeDefined();
    await expect(db.select().from(userIntegrations).where(eq(userIntegrations.userId, userId)))
      .resolves.toEqual([
        expect.objectContaining({
          status: 'cleanup_failed',
          integrationDescriptorId: null,
          accessTokenCiphertext: Buffer.from('encrypted-access-token'),
        }),
      ]);
    await db.delete(users).where(eq(users.id, userId));
  });
});

async function expectCredentialDeleteBlocked(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
    throw new Error('expected integration credential deletion guard to reject the delete');
  } catch (error) {
    expect(databaseErrorCode(error)).toBe('55006');
  }
}

function databaseErrorCode(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined;
  const directCode = Reflect.get(error, 'code');
  if (directCode !== undefined) return directCode;
  const cause = Reflect.get(error, 'cause');
  return cause && typeof cause === 'object' ? Reflect.get(cause, 'code') : undefined;
}
