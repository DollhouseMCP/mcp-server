import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import {
  integrationProviderDescriptors,
  userIntegrations,
} from '../../../src/database/schema/webConsole.js';
import { users } from '../../../src/database/schema/users.js';
import { PostgresUserIntegrationStore } from '../../../src/web-console/stores/PostgresUserIntegrationStore.js';
import { PostgresIntegrationDescriptorStore } from '../../../src/web-console/stores/PostgresIntegrationDescriptorStore.js';
import { IntegrationService } from '../../../src/web-console/modules/integrations/IntegrationService.js';
import { IntegrationProviderRegistry } from '../../../src/web-console/modules/integrations/IntegrationProviderRegistry.js';
import type { ConsoleRequest } from '../../../src/web-console/platform/ConsolePlatformTypes.js';
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
  it('blocks the BYO descriptor store from erasing a bound credential before cleanup', async () => {
    if (!databaseAvailable) return;
    const db = getTestAdminDb();
    const integrationStore = new PostgresUserIntegrationStore(db);
    const descriptorStore = new PostgresIntegrationDescriptorStore(db);
    const userId = randomUUID();
    const descriptorId = randomUUID();
    const provider = 'round5byodelete';
    await db.insert(users).values({ id: userId, username: `round5-byo-${userId}` });
    await db.insert(integrationProviderDescriptors).values({
      id: descriptorId,
      provider,
      ownership: 'byo',
      ownerUserId: userId,
      displayName: 'Round 5 BYO descriptor',
      category: 'Test',
      authStrategy: 'coded',
      apiHosts: ['https://api.example.test'],
    });
    const connected = await integrationStore.connect({
      userId,
      provider,
      integrationDescriptorId: descriptorId,
      externalAccountLabel: 'round-5-byo',
      externalInstallationId: null,
      authorizedPermissions: { scopes: [] },
      accessTokenCiphertext: Buffer.from('encrypted-byo-access-token'),
      refreshTokenCiphertext: null,
      connectedAt: new Date(),
    });

    await expectCredentialDeleteBlocked(
      descriptorStore.delete(descriptorId, userId),
      'integration_descriptor_credential_conflict',
    );
    await expect(db.select().from(userIntegrations).where(eq(userIntegrations.id, connected.id)))
      .resolves.toEqual([
        expect.objectContaining({
          status: 'connected',
          integrationDescriptorId: descriptorId,
          accessTokenCiphertext: Buffer.from('encrypted-byo-access-token'),
        }),
      ]);

    await terminalizeCredential(integrationStore, userId, provider, connected.id);
    await expect(descriptorStore.delete(descriptorId, userId)).resolves.toBe(true);
    await db.delete(users).where(eq(users.id, userId));
  });

  it('blocks curated descriptor deletion while either of two users still has revocable material', async () => {
    if (!databaseAvailable) return;
    const db = getTestAdminDb();
    const integrationStore = new PostgresUserIntegrationStore(db);
    const descriptorStore = new PostgresIntegrationDescriptorStore(db);
    const firstUserId = randomUUID();
    const secondUserId = randomUUID();
    const descriptorId = randomUUID();
    const provider = 'round5curateddelete';
    await db.insert(users).values([
      { id: firstUserId, username: `round5-curated-a-${firstUserId}` },
      { id: secondUserId, username: `round5-curated-b-${secondUserId}` },
    ]);
    await db.insert(integrationProviderDescriptors).values({
      id: descriptorId,
      provider,
      ownership: 'curated',
      ownerUserId: null,
      displayName: 'Round 5 curated descriptor',
      category: 'Test',
      authStrategy: 'coded',
      apiHosts: ['https://api.example.test'],
    });
    const first = await integrationStore.connect({
      userId: firstUserId,
      provider,
      integrationDescriptorId: descriptorId,
      externalAccountLabel: 'round-5-curated-a',
      externalInstallationId: null,
      authorizedPermissions: { scopes: [] },
      accessTokenCiphertext: Buffer.from('encrypted-curated-token-a'),
      refreshTokenCiphertext: null,
      connectedAt: new Date(),
    });
    const second = await integrationStore.connect({
      userId: secondUserId,
      provider,
      integrationDescriptorId: descriptorId,
      externalAccountLabel: 'round-5-curated-b',
      externalInstallationId: null,
      authorizedPermissions: { scopes: [] },
      accessTokenCiphertext: Buffer.from('encrypted-curated-token-b'),
      refreshTokenCiphertext: null,
      connectedAt: new Date(),
    });

    await expectCredentialDeleteBlocked(
      descriptorStore.deleteCurated(provider),
      'integration_descriptor_credential_conflict',
    );
    await expect(db.select().from(userIntegrations)
      .where(eq(userIntegrations.integrationDescriptorId, descriptorId)))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'connected', accessTokenCiphertext: Buffer.from('encrypted-curated-token-a') }),
        expect.objectContaining({ status: 'connected', accessTokenCiphertext: Buffer.from('encrypted-curated-token-b') }),
      ]));

    await terminalizeCredential(integrationStore, firstUserId, provider, first.id);
    await terminalizeCredential(integrationStore, secondUserId, provider, second.id);
    await expect(descriptorStore.deleteCurated(provider)).resolves.toBe(true);
    await db.delete(users).where(eq(users.id, firstUserId));
    await db.delete(users).where(eq(users.id, secondUserId));
  });

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

  it('terminalizes a connected credential after its provider is removed so the account can be deleted', async () => {
    if (!databaseAvailable) return;
    const db = getTestAdminDb();
    const store = new PostgresUserIntegrationStore(db);
    const userId = randomUUID();
    const provider = 'github';
    await db.insert(users).values({
      id: userId,
      username: `cleanup-retired-provider-${userId}`,
    });
    await store.connect({
      userId,
      provider,
      integrationDescriptorId: null,
      externalAccountLabel: 'retired provider account',
      externalInstallationId: null,
      authorizedPermissions: {
        repository_selection: 'unknown',
        permissions: { contents: 'none' },
      },
      accessTokenCiphertext: Buffer.from('encrypted-retired-provider-token'),
      refreshTokenCiphertext: null,
      connectedAt: new Date(),
    });
    const service = new IntegrationService({
      store,
      providers: IntegrationProviderRegistry.empty(),
    });
    const request = {
      params: {},
      query: {},
      body: {},
      headers: {},
      consoleAuthentication: {
        sessionIdHash: Buffer.alloc(32, 7),
        userId,
        authSub: `test-user:${userId}`,
        authzVersion: 1,
        grantedCapabilities: ['console:self'],
        elevation: null,
      },
    } as ConsoleRequest;

    await expect(service.disconnectProvider(request, provider)).resolves.toMatchObject({ status: 503 });
    await expect(store.findCredentialCleanupFailed(userId, provider)).resolves.toMatchObject({
      status: 'cleanup_failed',
      accessTokenCiphertext: Buffer.from('encrypted-retired-provider-token'),
    });
    await expect(store.hasBlockingCredentialMaterial(userId)).resolves.toBe(false);
    await expect(db.delete(users).where(eq(users.id, userId))).resolves.toBeDefined();
    await expect(db.select().from(userIntegrations).where(eq(userIntegrations.userId, userId)))
      .resolves.toEqual([]);
  });

  it('returns the parked cleanup row instead of violating the one-pending-row index', async () => {
    if (!databaseAvailable) return;
    const db = getTestAdminDb();
    const store = new PostgresUserIntegrationStore(db);
    const userId = randomUUID();
    const provider = 'github';
    await db.insert(users).values({
      id: userId,
      username: `cleanup-stacked-${userId}`,
    });
    const connected = await store.connect({
      userId,
      provider,
      integrationDescriptorId: null,
      externalAccountLabel: 'active account',
      externalInstallationId: null,
      authorizedPermissions: {
        repository_selection: 'unknown',
        permissions: { contents: 'none' },
      },
      accessTokenCiphertext: Buffer.from('encrypted-active-token'),
      refreshTokenCiphertext: null,
      connectedAt: new Date(),
    });
    const parked = await store.parkCredentialCleanup({
      userId,
      provider,
      integrationDescriptorId: null,
      descriptorFingerprint: null,
      externalAccountLabel: 'failed relink',
      externalInstallationId: null,
      authorizedPermissions: {
        repository_selection: 'unknown',
        permissions: { contents: 'none' },
      },
      accessTokenCiphertext: Buffer.from('encrypted-parked-token'),
      refreshTokenCiphertext: null,
      connectedAt: new Date(),
      requestedAt: new Date(),
    });

    await expect(store.beginCredentialCleanup({
      userId,
      provider,
      expectedActiveRecordId: connected.id,
      revokedAt: new Date(),
    })).resolves.toMatchObject({ id: parked.id, status: 'cleanup_pending' });
    await expect(store.findByProvider(userId, provider)).resolves.toMatchObject({
      id: connected.id,
      status: 'connected',
    });
    await expect(db.select().from(userIntegrations).where(eq(userIntegrations.userId, userId)))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: connected.id, status: 'connected' }),
        expect.objectContaining({ id: parked.id, status: 'cleanup_pending' }),
      ]));

    await store.abandonCredentialCleanupForUser({ userId });
    await store.beginCredentialCleanup({
      userId,
      provider,
      expectedActiveRecordId: connected.id,
      revokedAt: new Date(),
    });
    await store.abandonCredentialCleanupForUser({ userId });
    await db.delete(users).where(eq(users.id, userId));
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

async function expectCredentialDeleteBlocked(
  operation: Promise<unknown>,
  expectedCode = '55006',
): Promise<void> {
  try {
    await operation;
    throw new Error('expected integration credential deletion guard to reject the delete');
  } catch (error) {
    expect(databaseErrorCode(error)).toBe(expectedCode);
  }
}

function databaseErrorCode(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined;
  const directCode = Reflect.get(error, 'code');
  if (directCode !== undefined) return directCode;
  const cause = Reflect.get(error, 'cause');
  return cause && typeof cause === 'object' ? Reflect.get(cause, 'code') : undefined;
}

async function terminalizeCredential(
  store: PostgresUserIntegrationStore,
  userId: string,
  provider: Parameters<PostgresUserIntegrationStore['beginCredentialCleanup']>[0]['provider'],
  recordId: string,
): Promise<void> {
  const pending = await store.beginCredentialCleanup({
    userId,
    provider,
    expectedActiveRecordId: recordId,
    revokedAt: new Date(),
  });
  if (!pending) throw new Error('credential did not enter cleanup_pending');
  const leaseId = randomUUID();
  await store.claimCredentialCleanup({
    userId,
    provider,
    cleanupRecordId: pending.id,
    leaseId,
    attemptedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  await expect(store.failCredentialCleanup({
    userId,
    provider,
    cleanupRecordId: pending.id,
    leaseId,
  })).resolves.toMatchObject({ status: 'cleanup_failed' });
}
