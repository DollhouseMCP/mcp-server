import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import {
  IntegrationDescriptorSeedLoader,
  type IntegrationDescriptorSeedCredentialResolver,
} from '../../../../src/web-console/modules/integrations/IntegrationDescriptorSeedLoader.js';
import { integrationDescriptorClientSecretContext } from '../../../../src/web-console/modules/integrations/IntegrationSecretContext.js';
import { AeadSecretEncryptionService } from '../../../../src/web-console/security/SecretEncryption.js';
import { InMemoryIntegrationDescriptorStore } from '../../../../src/web-console/stores/InMemoryIntegrationDescriptorStore.js';
import { InMemoryUserIntegrationStore } from '../../../../src/web-console/stores/InMemoryUserIntegrationStore.js';

const VISIBLE_USER = '11111111-1111-4111-8111-111111111111';
const FIXED_NOW = new Date('2026-06-24T00:00:00.000Z');

const OAUTH_SEED = {
  provider: 'examplecorp',
  displayName: 'Example Corp',
  category: 'Productivity',
  authStrategy: 'oauth2_authorization_code',
  apiHosts: ['api.examplecorp.test'],
  oauth: {
    authorizationUrl: 'https://auth.examplecorp.test/authorize',
    tokenUrl: 'https://auth.examplecorp.test/token',
    scopes: ['read'],
    pkce: 'required',
    refresh: 'rotating',
    tokenExchange: { clientAuth: 'body' },
    accountLabel: { field: 'email' },
  },
};

const STATIC_SEED = {
  provider: 'examplekey',
  displayName: 'Example Key',
  category: 'Data',
  authStrategy: 'static_api_key',
  apiHosts: ['api.examplekey.test'],
  staticApiKey: { injection: { location: 'header', name: 'X-Api-Key', valuePrefix: null } },
};

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function seedDirWith(files: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'int-descriptor-seed-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const body = typeof content === 'string' ? content : JSON.stringify(content);
    await fs.writeFile(path.join(dir, name), body, 'utf8');
  }
  return dir;
}

function newEncryption(): AeadSecretEncryptionService {
  return new AeadSecretEncryptionService({ keyId: 'test-key', key: Buffer.alloc(32, 7) });
}

const credentials = (
  map: Record<string, { clientId: string | null; clientSecret: string | null }>,
): IntegrationDescriptorSeedCredentialResolver =>
  provider => map[provider] ?? { clientId: null, clientSecret: null };

function loaderOptions(integrationStore = new InMemoryUserIntegrationStore()) {
  return { now: () => FIXED_NOW, integrationStore };
}

function byoExampleCorpDescriptor(apiHost: string) {
  return {
    provider: 'examplecorp',
    ownership: 'byo' as const,
    ownerUserId: VISIBLE_USER,
    displayName: 'User-owned Example Corp',
    category: 'Productivity',
    authStrategy: 'static_api_key' as const,
    apiHosts: [apiHost],
    staticApiKey: {
      injection: { location: 'header' as const, name: 'X-Api-Key', valuePrefix: null },
    },
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}

function connectExampleCorp(
  integrationStore: InMemoryUserIntegrationStore,
  input: {
    readonly accountLabel: string;
    readonly scopes: readonly string[];
    readonly accessToken: string;
    readonly refreshToken?: string | null;
  },
) {
  return integrationStore.connect({
    userId: VISIBLE_USER,
    provider: 'examplecorp',
    externalAccountLabel: input.accountLabel,
    externalInstallationId: null,
    authorizedPermissions: { scopes: input.scopes },
    accessTokenCiphertext: Buffer.from(input.accessToken),
    refreshTokenCiphertext: input.refreshToken ? Buffer.from(input.refreshToken) : null,
    connectedAt: FIXED_NOW,
  });
}

describe('IntegrationDescriptorSeedLoader', () => {
  it('loads a curated OAuth descriptor, injecting clientId and encrypting the client secret', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const encryption = newEncryption();
    const loader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      credentials({ examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' } }),
      loaderOptions(),
    );

    const result = await loader.loadSeeds();
    expect(result.loaded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.descriptors).toHaveLength(1);

    const record = await store.findVisibleByProvider(VISIBLE_USER, 'examplecorp');
    if (!record?.clientSecretCiphertext) {
      throw new Error('expected a curated descriptor with an encrypted client secret');
    }
    expect(record.ownership).toBe('curated');
    expect(record.ownerUserId).toBeNull();
    expect(record.oauth?.clientId).toBe('deployment-client-id');

    // The stored ciphertext must decrypt under the curated client-secret context.
    const plaintext = encryption.decrypt(
      record.clientSecretCiphertext,
      integrationDescriptorClientSecretContext({ provider: 'examplecorp', ownerUserId: null }),
    );
    expect(plaintext.toString('utf8')).toBe('deployment-secret');
    expect(SecurityMonitor.getRecentEvents()).toContainEqual(expect.objectContaining({
      source: 'IntegrationDescriptorSeedLoader.processSeedFile',
      details: expect.stringContaining('loaded for provider examplecorp'),
    }));
  });

  it('skips a curated OAuth descriptor when deployment credentials are not configured', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const loader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      newEncryption(),
      credentials({}),
      loaderOptions(),
    );

    const result = await loader.loadSeeds();
    expect(result.loaded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.descriptors).toHaveLength(0);
    expect(await store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).toBeNull();
  });

  it('removes a previously persisted curated OAuth descriptor when credentials are withdrawn', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const integrationStore = new InMemoryUserIntegrationStore();
    const encryption = newEncryption();
    const configured = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      credentials({ examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' } }),
      loaderOptions(integrationStore),
    );
    await configured.loadSeeds();
    await expect(store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).resolves.not.toBeNull();
    await integrationStore.connect({
      userId: VISIBLE_USER,
      provider: 'examplecorp',
      externalAccountLabel: 'visible-user',
      externalInstallationId: null,
      authorizedPermissions: { scopes: ['read'] },
      accessTokenCiphertext: Buffer.from('encrypted-access'),
      refreshTokenCiphertext: Buffer.from('encrypted-refresh'),
      connectedAt: FIXED_NOW,
    });

    const disabled = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      credentials({}),
      loaderOptions(integrationStore),
    );
    await expect(disabled.loadSeeds()).resolves.toMatchObject({ loaded: 0, skipped: 1, failed: 0 });
    await expect(store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).resolves.toBeNull();
    await expect(integrationStore.findByProvider(VISIBLE_USER, 'examplecorp')).resolves.toBeNull();
  });

  it('does not revoke a same-provider BYO integration when no curated descriptor exists', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const integrationStore = new InMemoryUserIntegrationStore();
    await store.upsert(byoExampleCorpDescriptor('api.examplecorp.test'));
    await connectExampleCorp(integrationStore, {
      accountLabel: 'user-owned',
      scopes: [],
      accessToken: 'encrypted-byo-key',
    });

    const loader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      newEncryption(),
      credentials({}),
      loaderOptions(integrationStore),
    );

    await expect(loader.loadSeeds()).resolves.toMatchObject({ loaded: 0, skipped: 1, failed: 0 });
    await expect(store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({
      ownership: 'byo',
      ownerUserId: VISIBLE_USER,
    });
    await expect(integrationStore.findByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({
      status: 'connected',
      accessTokenCiphertext: Buffer.from('encrypted-byo-key'),
    });
  });

  it('revokes credentials before a same-provider BYO route is revealed', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const integrationStore = new InMemoryUserIntegrationStore();
    const encryption = newEncryption();
    const configured = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      credentials({ examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' } }),
      loaderOptions(integrationStore),
    );
    await configured.loadSeeds();
    await store.upsert(byoExampleCorpDescriptor('byo.examplecorp.test'));
    await connectExampleCorp(integrationStore, {
      accountLabel: 'curated-route-user',
      scopes: ['read'],
      accessToken: 'encrypted-curated-access',
      refreshToken: 'encrypted-curated-refresh',
    });

    const disabled = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      credentials({}),
      loaderOptions(integrationStore),
    );

    await expect(disabled.loadSeeds()).resolves.toMatchObject({ loaded: 0, skipped: 1, failed: 0 });
    await expect(store.findCuratedByProvider('examplecorp')).resolves.toBeNull();
    await expect(store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({
      ownership: 'byo',
      apiHosts: ['byo.examplecorp.test'],
    });
    await expect(integrationStore.findByProvider(VISIBLE_USER, 'examplecorp')).resolves.toBeNull();
  });

  it('reports a failure when the curated descriptor disappears during withdrawal', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const integrationStore = new InMemoryUserIntegrationStore();
    const encryption = newEncryption();
    const configured = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      credentials({ examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' } }),
      loaderOptions(integrationStore),
    );
    await configured.loadSeeds();
    await connectExampleCorp(integrationStore, {
      accountLabel: 'curated-route-user',
      scopes: ['read'],
      accessToken: 'encrypted-curated-access',
      refreshToken: 'encrypted-curated-refresh',
    });

    const deleteCurated = store.deleteCurated.bind(store);
    jest.spyOn(store, 'deleteCurated').mockImplementation(async provider => {
      await deleteCurated(provider);
      return false;
    });
    const disabled = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      credentials({}),
      loaderOptions(integrationStore),
    );

    await expect(disabled.loadSeeds()).resolves.toMatchObject({ loaded: 0, skipped: 0, failed: 1 });
    await expect(store.findCuratedByProvider('examplecorp')).resolves.toBeNull();
    await expect(integrationStore.findByProvider(VISIBLE_USER, 'examplecorp')).resolves.toBeNull();
    expect(SecurityMonitor.getRecentEvents()).toContainEqual(expect.objectContaining({
      source: 'IntegrationDescriptorSeedLoader.loadSeeds',
      details: 'Integration descriptor seed rejected for provider examplecorp',
    }));
  });

  it('loads a curated static-API-key descriptor without deployment credentials', async () => {
    const dir = await seedDirWith({ 'examplekey.json': STATIC_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const loader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      newEncryption(),
      credentials({}),
      loaderOptions(),
    );

    const result = await loader.loadSeeds();
    expect(result.loaded).toBe(1);
    expect(result.failed).toBe(0);

    const record = await store.findVisibleByProvider(VISIBLE_USER, 'examplekey');
    expect(record?.authStrategy).toBe('static_api_key');
    expect(record?.staticApiKey?.injection.name).toBe('X-Api-Key');
    expect(record?.clientSecretCiphertext).toBeNull();
  });

  it('canonicalizes curated API hosts before persistence', async () => {
    const dir = await seedDirWith({
      'examplekey.json': {
        ...STATIC_SEED,
        apiHosts: ['API.ExampleKey.Test.', 'api.examplekey.test'],
      },
    });
    const store = new InMemoryIntegrationDescriptorStore();
    const loader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      newEncryption(),
      credentials({}),
      loaderOptions(),
    );

    const result = await loader.loadSeeds();

    expect(result).toMatchObject({ loaded: 1, failed: 0 });
    const record = await store.findVisibleByProvider(VISIBLE_USER, 'examplekey');
    expect(record?.apiHosts).toEqual(['api.examplekey.test']);
  });

  it('fails a curated seed instead of silently dropping non-string host entries', async () => {
    const dir = await seedDirWith({
      'examplekey.json': {
        ...STATIC_SEED,
        apiHosts: [42, 'api.examplekey.test'],
      },
    });
    const store = new InMemoryIntegrationDescriptorStore();
    const loader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      newEncryption(),
      credentials({}),
      loaderOptions(),
    );

    const result = await loader.loadSeeds();

    expect(result).toMatchObject({ loaded: 0, failed: 1 });
    expect(await store.findVisibleByProvider(VISIBLE_USER, 'examplekey')).toBeNull();
  });

  it('skips the reserved github provider id', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    const dir = await seedDirWith({ 'github.json': { ...OAUTH_SEED, provider: 'github' } });
    const store = new InMemoryIntegrationDescriptorStore();
    const loader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      newEncryption(),
      credentials({ github: { clientId: 'x', clientSecret: 'y' } }),
      loaderOptions(),
    );

    const result = await loader.loadSeeds();
    expect(result.loaded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await store.findVisibleByProvider(VISIBLE_USER, 'github')).toBeNull();
    expect(SecurityMonitor.getRecentEvents()).toContainEqual(expect.objectContaining({
      source: 'IntegrationDescriptorSeedLoader.processSeedFile',
      details: 'Integration descriptor seed denied_reserved for provider github',
    }));
  });

  it('records a per-file failure for invalid content without throwing', async () => {
    const dir = await seedDirWith({
      'broken.json': '{ not valid json',
      'badshape.json': { provider: 'examplecorp', authStrategy: 'oauth2_authorization_code', apiHosts: [] },
    });
    const store = new InMemoryIntegrationDescriptorStore();
    const loader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      newEncryption(),
      credentials({ examplecorp: { clientId: 'id', clientSecret: 'secret' } }),
      loaderOptions(),
    );

    const result = await loader.loadSeeds();
    expect(result.loaded).toBe(0);
    expect(result.failed).toBe(2);
    expect(await store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).toBeNull();
  });

  it('is a no-op when the seed directory does not exist', async () => {
    const store = new InMemoryIntegrationDescriptorStore();
    const loader = new IntegrationDescriptorSeedLoader(
      path.join(os.tmpdir(), 'int-descriptor-seed-does-not-exist-xyz'),
      store,
      newEncryption(),
      credentials({}),
      loaderOptions(),
    );

    const result = await loader.loadSeeds();
    expect(result.loaded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.descriptors).toHaveLength(0);
  });
});
