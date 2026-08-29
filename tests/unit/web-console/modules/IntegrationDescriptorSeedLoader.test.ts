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
import { HmacConsoleOpaqueValueService } from '../../../../src/web-console/security/ConsoleOpaqueValues.js';
import { AeadSecretEncryptionService } from '../../../../src/web-console/security/SecretEncryption.js';
import { InMemoryIntegrationDescriptorStore } from '../../../../src/web-console/stores/InMemoryIntegrationDescriptorStore.js';
import { InMemoryUserIntegrationStore } from '../../../../src/web-console/stores/InMemoryUserIntegrationStore.js';

const DEPLOYMENT_CLIENT_ID = 'deployment-client-id';
const DEPLOYMENT_SECRET = 'deployment-secret';
const MISSING_CIPHERTEXT_ERROR = 'expected first encrypted client secret';
const ROTATED_SECRET = 'rotated-secret';
const EXPECTED_FIRST_DESCRIPTOR = 'expected first descriptor';

const VISIBLE_USER = '11111111-1111-4111-8111-111111111111';
const FIXED_NOW = new Date('2026-06-24T00:00:00.000Z');
const secretRevisionHasher = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 19));

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
  return { now: () => FIXED_NOW, integrationStore, secretRevisionHasher };
}

function requireRuntimeValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
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
    readonly descriptorId: string;
    readonly accountLabel: string;
    readonly scopes: readonly string[];
    readonly accessToken: string;
    readonly refreshToken?: string | null;
  },
) {
  return integrationStore.connect({
    userId: VISIBLE_USER,
    provider: 'examplecorp',
    integrationDescriptorId: input.descriptorId,
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
      credentials({ examplecorp: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: DEPLOYMENT_SECRET } }),
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
    expect(record.oauth?.clientId).toBe(DEPLOYMENT_CLIENT_ID);
    expect(record.clientSecretRevision).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // The stored ciphertext must decrypt under the curated client-secret context.
    const plaintext = encryption.decrypt(
      record.clientSecretCiphertext,
      integrationDescriptorClientSecretContext({ provider: 'examplecorp', ownerUserId: null }),
    );
    expect(plaintext.toString('utf8')).toBe(DEPLOYMENT_SECRET);
    expect(SecurityMonitor.getRecentEvents()).toContainEqual(expect.objectContaining({
      source: 'IntegrationDescriptorSeedLoader.processSeedFile',
      details: expect.stringContaining('loaded for provider examplecorp'),
    }));
  });

  it('preserves curated OAuth ciphertext when startup credentials are unchanged', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const encryption = newEncryption();
    const configuredCredentials = credentials({
      examplecorp: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: DEPLOYMENT_SECRET },
    });
    const firstLoader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      configuredCredentials,
      loaderOptions(),
    );

    const first = requireRuntimeValue(
      (await firstLoader.loadSeeds()).descriptors[0],
      EXPECTED_FIRST_DESCRIPTOR,
    );
    if (!first.clientSecretCiphertext) throw new Error(MISSING_CIPHERTEXT_ERROR);
    store.set({ ...first, credentialKeyVersion: 'preserved-key-version' });

    const secondLoader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      configuredCredentials,
      loaderOptions(),
    );
    const second = requireRuntimeValue(
      (await secondLoader.loadSeeds()).descriptors[0],
      'expected second descriptor',
    );

    expect(second.clientSecretCiphertext).toEqual(first.clientSecretCiphertext);
    expect(second.clientSecretRevision).toBe(first.clientSecretRevision);
    expect(second.credentialKeyVersion).toBe('preserved-key-version');
  });

  it('preserves the logical revision when only the opaque HMAC key rotates', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const encryption = newEncryption();
    const configuredCredentials = credentials({
      examplecorp: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: DEPLOYMENT_SECRET },
    });
    const first = requireRuntimeValue(
      (await new IntegrationDescriptorSeedLoader(
        dir,
        store,
        encryption,
        configuredCredentials,
        loaderOptions(),
      ).loadSeeds()).descriptors[0],
      EXPECTED_FIRST_DESCRIPTOR,
    );
    if (!first.clientSecretCiphertext) throw new Error(MISSING_CIPHERTEXT_ERROR);

    const rotatedHasher = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 20));
    const second = requireRuntimeValue(
      (await new IntegrationDescriptorSeedLoader(
        dir,
        store,
        encryption,
        configuredCredentials,
        {
          ...loaderOptions(),
          secretRevisionHasher: rotatedHasher,
        },
      ).loadSeeds()).descriptors[0],
      'expected second descriptor',
    );

    expect(second.clientSecretCiphertext).toEqual(first.clientSecretCiphertext);
    expect(second.clientSecretRevision).toBe(first.clientSecretRevision);

    const changed = requireRuntimeValue(
      (await new IntegrationDescriptorSeedLoader(
        dir,
        store,
        encryption,
        credentials({
          examplecorp: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: ROTATED_SECRET },
        }),
        {
          ...loaderOptions(),
          secretRevisionHasher: rotatedHasher,
        },
      ).loadSeeds()).descriptors[0],
      'expected changed descriptor',
    );
    expect(changed.clientSecretRevision).not.toBe(second.clientSecretRevision);
  });

  it('rotates curated OAuth ciphertext when the configured secret changes', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const encryption = newEncryption();
    const firstLoader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      credentials({
        examplecorp: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: DEPLOYMENT_SECRET },
      }),
      loaderOptions(),
    );
    const first = requireRuntimeValue(
      (await firstLoader.loadSeeds()).descriptors[0],
      EXPECTED_FIRST_DESCRIPTOR,
    );
    if (!first.clientSecretCiphertext) throw new Error(MISSING_CIPHERTEXT_ERROR);

    const rotatedLoader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      credentials({
        examplecorp: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: ROTATED_SECRET },
      }),
      loaderOptions(),
    );
    const rotated = requireRuntimeValue(
      (await rotatedLoader.loadSeeds()).descriptors[0],
      'expected rotated descriptor',
    );
    if (!rotated.clientSecretCiphertext) throw new Error('expected rotated encrypted client secret');

    expect(rotated.clientSecretCiphertext).not.toEqual(first.clientSecretCiphertext);
    expect(rotated.clientSecretRevision).not.toBe(first.clientSecretRevision);
    const plaintext = encryption.decrypt(
      rotated.clientSecretCiphertext,
      integrationDescriptorClientSecretContext({ provider: 'examplecorp', ownerUserId: null }),
    );
    expect(plaintext.toString('utf8')).toBe(ROTATED_SECRET);
  });

  it('starts a logical revision when a legacy descriptor secret changes', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const encryption = newEncryption();
    const first = requireRuntimeValue(
      (await new IntegrationDescriptorSeedLoader(
        dir,
        store,
        encryption,
        credentials({
          examplecorp: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: DEPLOYMENT_SECRET },
        }),
        loaderOptions(),
      ).loadSeeds()).descriptors[0],
      EXPECTED_FIRST_DESCRIPTOR,
    );
    if (!first.clientSecretCiphertext) throw new Error(MISSING_CIPHERTEXT_ERROR);
    store.set({ ...first, clientSecretRevision: null });

    const rotated = requireRuntimeValue(
      (await new IntegrationDescriptorSeedLoader(
        dir,
        store,
        encryption,
        credentials({
          examplecorp: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: ROTATED_SECRET },
        }),
        loaderOptions(),
      ).loadSeeds()).descriptors[0],
      'expected rotated descriptor',
    );

    expect(rotated.clientSecretRevision).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('initializes a proven-equal legacy revision without requesting binding invalidation', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const encryption = newEncryption();
    const configuredCredentials = credentials({
      examplecorp: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: DEPLOYMENT_SECRET },
    });
    const first = requireRuntimeValue(
      (await new IntegrationDescriptorSeedLoader(
        dir,
        store,
        encryption,
        configuredCredentials,
        loaderOptions(),
      ).loadSeeds()).descriptors[0],
      EXPECTED_FIRST_DESCRIPTOR,
    );
    store.set({ ...first, clientSecretRevision: null });
    const upsert = jest.spyOn(store, 'upsert');

    await new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      configuredCredentials,
      loaderOptions(),
    ).loadSeeds();

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecretRevision: expect.any(String) }),
      { initializeClientSecretRevision: true },
    );
  });

  it('rewraps unreadable curated OAuth ciphertext without rotating its logical revision', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const configuredCredentials = credentials({
      examplecorp: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: DEPLOYMENT_SECRET },
    });
    const oldEncryption = new AeadSecretEncryptionService({
      keyId: 'old-key',
      key: Buffer.alloc(32, 7),
    });
    const firstLoader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      oldEncryption,
      configuredCredentials,
      loaderOptions(),
    );
    const first = requireRuntimeValue(
      (await firstLoader.loadSeeds()).descriptors[0],
      EXPECTED_FIRST_DESCRIPTOR,
    );
    if (!first.clientSecretCiphertext) throw new Error(MISSING_CIPHERTEXT_ERROR);

    const replacementEncryption = new AeadSecretEncryptionService({
      keyId: 'replacement-key',
      key: Buffer.alloc(32, 8),
    });
    const replacementLoader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      replacementEncryption,
      configuredCredentials,
      loaderOptions(),
    );
    const replacement = requireRuntimeValue(
      (await replacementLoader.loadSeeds()).descriptors[0],
      'expected replacement descriptor',
    );
    if (!replacement.clientSecretCiphertext) throw new Error('expected replacement encrypted client secret');

    expect(replacement.clientSecretCiphertext).not.toEqual(first.clientSecretCiphertext);
    expect(replacement.clientSecretRevision).toBe(first.clientSecretRevision);
    const plaintext = replacementEncryption.decrypt(
      replacement.clientSecretCiphertext,
      integrationDescriptorClientSecretContext({ provider: 'examplecorp', ownerUserId: null }),
    );
    expect(plaintext.toString('utf8')).toBe(DEPLOYMENT_SECRET);
    expect(SecurityMonitor.getRecentEvents()).toContainEqual(expect.objectContaining({
      source: 'IntegrationDescriptorSeedLoader.resolveClientSecret',
      details: expect.stringContaining('rewrapped for provider examplecorp'),
    }));
  });

  it('rotates the logical revision when the secret changes after its old envelope key is retired', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const oldEncryption = new AeadSecretEncryptionService({
      keyId: 'old-key',
      key: Buffer.alloc(32, 7),
    });
    const first = requireRuntimeValue(
      (await new IntegrationDescriptorSeedLoader(
        dir,
        store,
        oldEncryption,
        credentials({
          examplecorp: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: DEPLOYMENT_SECRET },
        }),
        loaderOptions(),
      ).loadSeeds()).descriptors[0],
      EXPECTED_FIRST_DESCRIPTOR,
    );

    const replacement = requireRuntimeValue(
      (await new IntegrationDescriptorSeedLoader(
        dir,
        store,
        new AeadSecretEncryptionService({
          keyId: 'replacement-key',
          key: Buffer.alloc(32, 8),
        }),
        credentials({
          examplecorp: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: ROTATED_SECRET },
        }),
        loaderOptions(),
      ).loadSeeds()).descriptors[0],
      'expected replacement descriptor',
    );

    expect(replacement.clientSecretRevision).not.toBe(first.clientSecretRevision);
  });

  it('conservatively initializes a legacy revision while rewrapping unreadable ciphertext', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const configuredCredentials = credentials({
      examplecorp: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: DEPLOYMENT_SECRET },
    });
    const oldEncryption = new AeadSecretEncryptionService({
      keyId: 'old-key',
      key: Buffer.alloc(32, 7),
    });
    const first = requireRuntimeValue(
      (await new IntegrationDescriptorSeedLoader(
        dir,
        store,
        oldEncryption,
        configuredCredentials,
        loaderOptions(),
      ).loadSeeds()).descriptors[0],
      EXPECTED_FIRST_DESCRIPTOR,
    );
    if (!first.clientSecretCiphertext) throw new Error(MISSING_CIPHERTEXT_ERROR);
    store.set({ ...first, clientSecretRevision: null });

    const replacementEncryption = new AeadSecretEncryptionService({
      keyId: 'replacement-key',
      key: Buffer.alloc(32, 8),
    });
    const replacement = requireRuntimeValue(
      (await new IntegrationDescriptorSeedLoader(
        dir,
        store,
        replacementEncryption,
        configuredCredentials,
        loaderOptions(),
      ).loadSeeds()).descriptors[0],
      'expected replacement descriptor',
    );

    expect(replacement.clientSecretRevision).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(replacement.clientSecretCiphertext).not.toEqual(first.clientSecretCiphertext);
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

  it('retains a curated descriptor and its revocable credentials when deployment credentials are withdrawn', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const integrationStore = new InMemoryUserIntegrationStore();
    const encryption = newEncryption();
    const configured = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      credentials({ examplecorp: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: DEPLOYMENT_SECRET } }),
      loaderOptions(integrationStore),
    );
    const configuredResult = await configured.loadSeeds();
    const curated = requireRuntimeValue(
      configuredResult.descriptors[0],
      'expected configured curated descriptor',
    );
    await expect(store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).resolves.not.toBeNull();
    await integrationStore.connect({
      userId: VISIBLE_USER,
      provider: 'examplecorp',
      integrationDescriptorId: curated.id,
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
    await expect(disabled.loadSeeds()).resolves.toMatchObject({ loaded: 0, skipped: 0, failed: 1 });
    await expect(store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({
      id: curated.id,
      ownership: 'curated',
    });
    await expect(integrationStore.findByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({
      status: 'connected',
      accessTokenCiphertext: Buffer.from('encrypted-access'),
    });
  });

  it('does not revoke a same-provider BYO integration when no curated descriptor exists', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const integrationStore = new InMemoryUserIntegrationStore();
    const byo = await store.upsert(byoExampleCorpDescriptor('api.examplecorp.test'));
    await connectExampleCorp(integrationStore, {
      descriptorId: byo.id,
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

  it('preserves same-provider BYO credentials when withdrawing a curated descriptor', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const integrationStore = new InMemoryUserIntegrationStore();
    const encryption = newEncryption();
    const byo = await store.upsert(byoExampleCorpDescriptor('byo.examplecorp.test'));
    await connectExampleCorp(integrationStore, {
      descriptorId: byo.id,
      accountLabel: 'user-owned',
      scopes: [],
      accessToken: 'encrypted-byo-key',
    });

    const configured = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      credentials({ examplecorp: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: DEPLOYMENT_SECRET } }),
      loaderOptions(integrationStore),
    );
    await configured.loadSeeds();

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
      id: byo.id,
      ownership: 'byo',
    });
    await expect(integrationStore.findByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({
      integrationDescriptorId: byo.id,
      status: 'connected',
      accessTokenCiphertext: Buffer.from('encrypted-byo-key'),
    });
  });

  it('does not reveal a same-provider BYO route by discarding curated credentials', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const integrationStore = new InMemoryUserIntegrationStore();
    const encryption = newEncryption();
    const configured = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      credentials({ examplecorp: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: DEPLOYMENT_SECRET } }),
      loaderOptions(integrationStore),
    );
    const configuredResult = await configured.loadSeeds();
    const curated = requireRuntimeValue(
      configuredResult.descriptors[0],
      'expected configured curated descriptor',
    );
    await store.upsert(byoExampleCorpDescriptor('byo.examplecorp.test'));
    await connectExampleCorp(integrationStore, {
      descriptorId: curated.id,
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

    await expect(disabled.loadSeeds()).resolves.toMatchObject({ loaded: 0, skipped: 0, failed: 1 });
    await expect(store.findCuratedByProvider('examplecorp')).resolves.toMatchObject({ id: curated.id });
    await expect(store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({
      ownership: 'curated',
      id: curated.id,
    });
    await expect(integrationStore.findByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({
      status: 'connected',
      accessTokenCiphertext: Buffer.from('encrypted-curated-access'),
      refreshTokenCiphertext: Buffer.from('encrypted-curated-refresh'),
    });
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
      credentials({ examplecorp: { clientId: DEPLOYMENT_CLIENT_ID, clientSecret: DEPLOYMENT_SECRET } }),
      loaderOptions(integrationStore),
    );
    const configuredResult = await configured.loadSeeds();
    expect(configuredResult.descriptors[0]).toBeDefined();
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
