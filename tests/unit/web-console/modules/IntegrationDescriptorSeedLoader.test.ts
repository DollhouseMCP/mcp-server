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
import { IntegrationDescriptorMutationBusyError } from '../../../../src/web-console/stores/IIntegrationDescriptorStore.js';

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
  it('keeps the newer shared descriptor when a stale or legacy replica starts later', async () => {
    const initialDir = await seedDirWith({
      'examplecorp.json': {
        ...OAUTH_SEED,
        revision: 1,
        apiHosts: ['initial.examplecorp.test'],
      },
    });
    const currentDir = await seedDirWith({
      'examplecorp.json': {
        ...OAUTH_SEED,
        revision: 2,
        apiHosts: ['current.examplecorp.test'],
      },
    });
    const staleDir = await seedDirWith({
      'examplecorp.json': {
        ...OAUTH_SEED,
        revision: 1,
        apiHosts: ['stale.examplecorp.test'],
      },
    });
    const legacyDir = await seedDirWith({
      'examplecorp.json': {
        ...OAUTH_SEED,
        apiHosts: ['legacy.examplecorp.test'],
      },
    });
    const store = new InMemoryIntegrationDescriptorStore();
    const encryption = newEncryption();
    const configuredCredentials = credentials({
      examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' },
    });

    await new IntegrationDescriptorSeedLoader(
      initialDir,
      store,
      encryption,
      configuredCredentials,
      loaderOptions(),
    ).loadSeeds();
    await new IntegrationDescriptorSeedLoader(
      currentDir,
      store,
      encryption,
      configuredCredentials,
      loaderOptions(),
    ).loadSeeds();
    await new IntegrationDescriptorSeedLoader(
      staleDir,
      store,
      encryption,
      configuredCredentials,
      loaderOptions(),
    ).loadSeeds();
    await new IntegrationDescriptorSeedLoader(
      legacyDir,
      store,
      encryption,
      configuredCredentials,
      loaderOptions(),
    ).loadSeeds();

    await expect(store.findCuratedByProvider('examplecorp')).resolves.toMatchObject({
      curatedSeedRevision: 2,
      apiHosts: ['current.examplecorp.test'],
    });
    expect(SecurityMonitor.getRecentEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'IntegrationDescriptorSeedLoader.processSeedFile',
        details: expect.stringContaining('retained newer revision'),
      }),
    ]));
  });

  it('retains a newer static descriptor without invoking OAuth credential refresh rules', async () => {
    const currentDir = await seedDirWith({
      'examplekey.json': { ...STATIC_SEED, revision: 2, displayName: 'Current Key' },
    });
    const staleDir = await seedDirWith({
      'examplekey.json': { ...STATIC_SEED, revision: 1, displayName: 'Stale Key' },
    });
    const store = new InMemoryIntegrationDescriptorStore();

    await new IntegrationDescriptorSeedLoader(
      currentDir,
      store,
      newEncryption(),
      credentials({}),
      loaderOptions(),
    ).loadSeeds();
    const staleResult = await new IntegrationDescriptorSeedLoader(
      staleDir,
      store,
      newEncryption(),
      credentials({}),
      loaderOptions(),
    ).loadSeeds();

    expect(staleResult).toMatchObject({ loaded: 1, failed: 0 });
    await expect(store.findCuratedByProvider('examplekey')).resolves.toMatchObject({
      curatedSeedRevision: 2,
      displayName: 'Current Key',
    });
  });

  it('rejects deployment OAuth credential changes from a stale seed revision', async () => {
    const currentDir = await seedDirWith({
      'examplecorp.json': {
        ...OAUTH_SEED,
        revision: 2,
        displayName: 'Current Example Corp',
        apiHosts: ['current.examplecorp.test'],
      },
    });
    const staleDir = await seedDirWith({
      'examplecorp.json': {
        ...OAUTH_SEED,
        revision: 1,
        displayName: 'Stale Example Corp',
        apiHosts: ['stale.examplecorp.test'],
      },
    });
    const store = new InMemoryIntegrationDescriptorStore();
    const encryption = newEncryption();

    const original = (await new IntegrationDescriptorSeedLoader(
      currentDir,
      store,
      encryption,
      credentials({
        examplecorp: { clientId: 'current-client-id', clientSecret: 'current-secret' },
      }),
      loaderOptions(),
    ).loadSeeds()).descriptors[0];
    if (!original?.clientSecretCiphertext) throw new Error('expected original encrypted client secret');

    const staleResult = await new IntegrationDescriptorSeedLoader(
      staleDir,
      store,
      encryption,
      credentials({
        examplecorp: { clientId: 'rotated-client-id', clientSecret: 'rotated-secret' },
      }),
      loaderOptions(),
    ).loadSeeds();
    expect(staleResult).toMatchObject({ loaded: 0, failed: 1 });

    const retained = await store.findCuratedByProvider('examplecorp');
    expect(retained).toMatchObject({
      id: original.id,
      curatedSeedRevision: 2,
      displayName: 'Current Example Corp',
      apiHosts: ['current.examplecorp.test'],
      oauth: expect.objectContaining({ clientId: 'current-client-id' }),
    });
    expect(retained?.clientSecretRevision).toBe(original.clientSecretRevision);
    if (!retained?.clientSecretCiphertext) throw new Error('expected retained encrypted client secret');
    const plaintext = encryption.decrypt(
      retained.clientSecretCiphertext,
      integrationDescriptorClientSecretContext({ provider: 'examplecorp', ownerUserId: null }),
    );
    expect(plaintext.toString('utf8')).toBe('current-secret');
  });

  it('accepts deployment OAuth credential changes with a newer explicit seed revision', async () => {
    const store = new InMemoryIntegrationDescriptorStore();
    const encryption = newEncryption();
    const revisionTwo = await seedDirWith({
      'examplecorp.json': { ...OAUTH_SEED, revision: 2 },
    });
    const revisionThree = await seedDirWith({
      'examplecorp.json': { ...OAUTH_SEED, revision: 3 },
    });
    await new IntegrationDescriptorSeedLoader(
      revisionTwo,
      store,
      encryption,
      credentials({ examplecorp: { clientId: 'client-v2', clientSecret: 'secret-v2' } }),
      loaderOptions(),
    ).loadSeeds();

    const result = await new IntegrationDescriptorSeedLoader(
      revisionThree,
      store,
      encryption,
      credentials({ examplecorp: { clientId: 'client-v3', clientSecret: 'secret-v3' } }),
      loaderOptions(),
    ).loadSeeds();

    expect(result).toMatchObject({ loaded: 1, failed: 0 });
    expect(result.descriptors[0]).toMatchObject({
      curatedSeedRevision: 3,
      oauth: expect.objectContaining({ clientId: 'client-v3' }),
    });
  });

  it('does not let the retained-revision credential option bypass seed field protection', async () => {
    const dir = await seedDirWith({
      'examplecorp.json': { ...OAUTH_SEED, revision: 2 },
    });
    const store = new InMemoryIntegrationDescriptorStore();
    const record = (await new IntegrationDescriptorSeedLoader(
      dir,
      store,
      newEncryption(),
      credentials({
        examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' },
      }),
      loaderOptions(),
    ).loadSeeds()).descriptors[0];
    if (!record) throw new Error('expected seeded descriptor');

    await expect(store.upsert({
      ...record,
      displayName: 'Revision bypass attempt',
      updatedAt: new Date(FIXED_NOW.getTime() + 1_000),
    }, {
      refreshDeploymentCredentialsAtRetainedSeedRevision: true,
    })).rejects.toThrow('deployment OAuth credentials only');

    await expect(store.findCuratedByProvider('examplecorp')).resolves.toMatchObject({
      displayName: OAUTH_SEED.displayName,
      curatedSeedRevision: 2,
    });
  });

  it('keeps unversioned seed files backwards compatible before the first explicit revision', async () => {
    const firstDir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const secondDir = await seedDirWith({
      'examplecorp.json': { ...OAUTH_SEED, apiHosts: ['updated.examplecorp.test'] },
    });
    const store = new InMemoryIntegrationDescriptorStore();
    const encryption = newEncryption();
    const configuredCredentials = credentials({
      examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' },
    });

    await new IntegrationDescriptorSeedLoader(
      firstDir, store, encryption, configuredCredentials, loaderOptions(),
    ).loadSeeds();
    await new IntegrationDescriptorSeedLoader(
      secondDir, store, encryption, configuredCredentials, loaderOptions(),
    ).loadSeeds();

    await expect(store.findCuratedByProvider('examplecorp')).resolves.toMatchObject({
      curatedSeedRevision: null,
      apiHosts: ['updated.examplecorp.test'],
    });
  });

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
    expect(record.clientSecretRevision).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

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

  it('preserves curated OAuth ciphertext when startup credentials are unchanged', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const encryption = newEncryption();
    const configuredCredentials = credentials({
      examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' },
    });
    const firstLoader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      configuredCredentials,
      loaderOptions(),
    );

    const first = (await firstLoader.loadSeeds()).descriptors[0];
    if (!first?.clientSecretCiphertext) throw new Error('expected first encrypted client secret');
    store.set({ ...first, credentialKeyVersion: 'preserved-key-version' });

    const secondLoader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      configuredCredentials,
      loaderOptions(),
    );
    const second = (await secondLoader.loadSeeds()).descriptors[0];

    expect(second?.clientSecretCiphertext).toEqual(first.clientSecretCiphertext);
    expect(second?.clientSecretRevision).toBe(first.clientSecretRevision);
    expect(second?.credentialKeyVersion).toBe('preserved-key-version');
  });

  it('preserves the logical revision when only the opaque HMAC key rotates', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const encryption = newEncryption();
    const configuredCredentials = credentials({
      examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' },
    });
    const first = (await new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      configuredCredentials,
      loaderOptions(),
    ).loadSeeds()).descriptors[0];
    if (!first?.clientSecretCiphertext) throw new Error('expected first encrypted client secret');

    const rotatedHasher = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 20));
    const second = (await new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      configuredCredentials,
      {
        ...loaderOptions(),
        secretRevisionHasher: rotatedHasher,
      },
    ).loadSeeds()).descriptors[0];

    expect(second?.clientSecretCiphertext).toEqual(first.clientSecretCiphertext);
    expect(second?.clientSecretRevision).toBe(first.clientSecretRevision);

    const changed = (await new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      credentials({
        examplecorp: { clientId: 'deployment-client-id', clientSecret: 'rotated-secret' },
      }),
      {
        ...loaderOptions(),
        secretRevisionHasher: rotatedHasher,
      },
    ).loadSeeds()).descriptors[0];
    expect(changed?.clientSecretRevision).not.toBe(second?.clientSecretRevision);
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
        examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' },
      }),
      loaderOptions(),
    );
    const first = (await firstLoader.loadSeeds()).descriptors[0];
    if (!first?.clientSecretCiphertext) throw new Error('expected first encrypted client secret');

    const rotatedLoader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      credentials({
        examplecorp: { clientId: 'deployment-client-id', clientSecret: 'rotated-secret' },
      }),
      loaderOptions(),
    );
    const rotated = (await rotatedLoader.loadSeeds()).descriptors[0];
    if (!rotated?.clientSecretCiphertext) throw new Error('expected rotated encrypted client secret');

    expect(rotated.clientSecretCiphertext).not.toEqual(first.clientSecretCiphertext);
    expect(rotated.clientSecretRevision).not.toBe(first.clientSecretRevision);
    const plaintext = encryption.decrypt(
      rotated.clientSecretCiphertext,
      integrationDescriptorClientSecretContext({ provider: 'examplecorp', ownerUserId: null }),
    );
    expect(plaintext.toString('utf8')).toBe('rotated-secret');
  });

  it('starts a logical revision when a legacy descriptor secret changes', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const encryption = newEncryption();
    const first = (await new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      credentials({
        examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' },
      }),
      loaderOptions(),
    ).loadSeeds()).descriptors[0];
    if (!first?.clientSecretCiphertext) throw new Error('expected first encrypted client secret');
    store.set({ ...first, clientSecretRevision: null });

    const rotated = (await new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      credentials({
        examplecorp: { clientId: 'deployment-client-id', clientSecret: 'rotated-secret' },
      }),
      loaderOptions(),
    ).loadSeeds()).descriptors[0];

    expect(rotated?.clientSecretRevision).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('initializes a proven-equal legacy revision without requesting binding invalidation', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const encryption = newEncryption();
    const configuredCredentials = credentials({
      examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' },
    });
    const first = (await new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      configuredCredentials,
      loaderOptions(),
    ).loadSeeds()).descriptors[0];
    if (!first) throw new Error('expected first descriptor');
    store.set({ ...first, clientSecretRevision: null });
    const reconcile = jest.spyOn(store, 'reconcileCuratedSeed');

    await new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      configuredCredentials,
      loaderOptions(),
    ).loadSeeds();

    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      descriptor: expect.objectContaining({ clientSecretRevision: expect.any(String) }),
      upsertOptions: { initializeClientSecretRevision: true },
    }));
  });

  it('rewraps unreadable curated OAuth ciphertext without rotating its logical revision', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const configuredCredentials = credentials({
      examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' },
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
    const first = (await firstLoader.loadSeeds()).descriptors[0];
    if (!first?.clientSecretCiphertext) throw new Error('expected first encrypted client secret');

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
    const replacement = (await replacementLoader.loadSeeds()).descriptors[0];
    if (!replacement?.clientSecretCiphertext) throw new Error('expected replacement encrypted client secret');

    expect(replacement.clientSecretCiphertext).not.toEqual(first.clientSecretCiphertext);
    expect(replacement.clientSecretRevision).toBe(first.clientSecretRevision);
    const plaintext = replacementEncryption.decrypt(
      replacement.clientSecretCiphertext,
      integrationDescriptorClientSecretContext({ provider: 'examplecorp', ownerUserId: null }),
    );
    expect(plaintext.toString('utf8')).toBe('deployment-secret');
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
    const first = (await new IntegrationDescriptorSeedLoader(
      dir,
      store,
      oldEncryption,
      credentials({
        examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' },
      }),
      loaderOptions(),
    ).loadSeeds()).descriptors[0];
    if (!first) throw new Error('expected first descriptor');

    const replacement = (await new IntegrationDescriptorSeedLoader(
      dir,
      store,
      new AeadSecretEncryptionService({
        keyId: 'replacement-key',
        key: Buffer.alloc(32, 8),
      }),
      credentials({
        examplecorp: { clientId: 'deployment-client-id', clientSecret: 'rotated-secret' },
      }),
      loaderOptions(),
    ).loadSeeds()).descriptors[0];

    expect(replacement?.clientSecretRevision).not.toBe(first.clientSecretRevision);
  });

  it('conservatively initializes a legacy revision while rewrapping unreadable ciphertext', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const configuredCredentials = credentials({
      examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' },
    });
    const oldEncryption = new AeadSecretEncryptionService({
      keyId: 'old-key',
      key: Buffer.alloc(32, 7),
    });
    const first = (await new IntegrationDescriptorSeedLoader(
      dir,
      store,
      oldEncryption,
      configuredCredentials,
      loaderOptions(),
    ).loadSeeds()).descriptors[0];
    if (!first?.clientSecretCiphertext) throw new Error('expected first encrypted client secret');
    store.set({ ...first, clientSecretRevision: null });

    const replacementEncryption = new AeadSecretEncryptionService({
      keyId: 'replacement-key',
      key: Buffer.alloc(32, 8),
    });
    const replacement = (await new IntegrationDescriptorSeedLoader(
      dir,
      store,
      replacementEncryption,
      configuredCredentials,
      loaderOptions(),
    ).loadSeeds()).descriptors[0];

    expect(replacement?.clientSecretRevision).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(replacement?.clientSecretCiphertext).not.toEqual(first.clientSecretCiphertext);
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

  it('preserves shared curated state when credentials are unavailable on this replica', async () => {
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
    const configuredResult = await configured.loadSeeds();
    const curated = configuredResult.descriptors[0];
    if (!curated) throw new Error('expected configured curated descriptor');
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
    await expect(disabled.loadSeeds()).resolves.toMatchObject({ loaded: 0, skipped: 1, failed: 0 });
    await expect(store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({ id: curated.id });
    await expect(integrationStore.findByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({
      integrationDescriptorId: curated.id,
      status: 'connected',
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

  it('preserves both BYO credentials and the shared curated descriptor when local credentials are absent', async () => {
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
      credentials({ examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' } }),
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
    await expect(store.findCuratedByProvider('examplecorp')).resolves.not.toBeNull();
    await expect(store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).resolves.not.toBeNull();
    await expect(integrationStore.findByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({
      integrationDescriptorId: byo.id,
      status: 'connected',
      accessTokenCiphertext: Buffer.from('encrypted-byo-key'),
    });
  });

  it('does not revoke curated credentials when this replica lacks deployment credentials', async () => {
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
    const configuredResult = await configured.loadSeeds();
    const curated = configuredResult.descriptors[0];
    if (!curated) throw new Error('expected configured curated descriptor');
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

    await expect(disabled.loadSeeds()).resolves.toMatchObject({ loaded: 0, skipped: 1, failed: 0 });
    await expect(store.findCuratedByProvider('examplecorp')).resolves.not.toBeNull();
    await expect(store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({
      ownership: 'curated',
    });
    await expect(integrationStore.findByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({
      integrationDescriptorId: curated.id,
      status: 'connected',
    });
  });

  it('does not attempt shared descriptor deletion when local credentials are absent', async () => {
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
    const configuredResult = await configured.loadSeeds();
    const curated = configuredResult.descriptors[0];
    if (!curated) throw new Error('expected configured curated descriptor');
    await connectExampleCorp(integrationStore, {
      descriptorId: curated.id,
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

    await expect(disabled.loadSeeds()).resolves.toMatchObject({ loaded: 0, skipped: 1, failed: 0 });
    expect(store.deleteCurated).not.toHaveBeenCalled();
    await expect(store.findCuratedByProvider('examplecorp')).resolves.not.toBeNull();
    await expect(integrationStore.findByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({
      integrationDescriptorId: curated.id,
      status: 'connected',
    });
    expect(SecurityMonitor.getRecentEvents()).toContainEqual(expect.objectContaining({
      source: 'IntegrationDescriptorSeedLoader.processSeedFile',
      details: 'Curated integration unavailable on this replica for provider examplecorp',
    }));
    expect(SecurityMonitor.getRecentEvents()).not.toContainEqual(expect.objectContaining({
      source: 'IntegrationDescriptorSeedLoader.loadSeeds',
    }));
  });

  it('globally disables only through a newer explicit seed while preserving descriptor and user credentials', async () => {
    const enabledDir = await seedDirWith({
      'examplecorp.json': { ...OAUTH_SEED, revision: 1 },
    });
    const disabledDir = await seedDirWith({
      'examplecorp.json': { provider: 'examplecorp', revision: 2, enabled: false },
    });
    const store = new InMemoryIntegrationDescriptorStore();
    const integrationStore = new InMemoryUserIntegrationStore();
    const encryption = newEncryption();
    const configured = new IntegrationDescriptorSeedLoader(
      enabledDir,
      store,
      encryption,
      credentials({ examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' } }),
      loaderOptions(integrationStore),
    );
    const descriptor = (await configured.loadSeeds()).descriptors[0];
    if (!descriptor) throw new Error('expected configured descriptor');
    await connectExampleCorp(integrationStore, {
      descriptorId: descriptor.id,
      accountLabel: 'preserved-user',
      scopes: ['read'],
      accessToken: 'encrypted-access',
      refreshToken: 'encrypted-refresh',
    });

    const disabled = await new IntegrationDescriptorSeedLoader(
      disabledDir,
      store,
      encryption,
      credentials({}),
      loaderOptions(integrationStore),
    ).loadSeeds();

    expect(disabled).toMatchObject({ loaded: 0, skipped: 1, failed: 0 });
    await expect(store.findCuratedByProvider('examplecorp')).resolves.toMatchObject({ id: descriptor.id });
    await expect(store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).resolves.toBeNull();
    await expect(integrationStore.findByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({
      integrationDescriptorId: descriptor.id,
      status: 'connected',
      accessTokenCiphertext: Buffer.from('encrypted-access'),
      refreshTokenCiphertext: Buffer.from('encrypted-refresh'),
    });
  });

  it('rejects same-revision re-enable, ignores stale re-enable, and accepts a newer configured revision', async () => {
    const store = new InMemoryIntegrationDescriptorStore();
    const integrationStore = new InMemoryUserIntegrationStore();
    const encryption = newEncryption();
    const configuredCredentials = credentials({
      examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' },
    });
    const revisionOne = await seedDirWith({
      'examplecorp.json': { ...OAUTH_SEED, revision: 1 },
    });
    const revisionTwoDisabled = await seedDirWith({
      'examplecorp.json': { provider: 'examplecorp', revision: 2, enabled: false },
    });
    const revisionTwoEnabled = await seedDirWith({
      'examplecorp.json': { ...OAUTH_SEED, revision: 2, enabled: true },
    });
    const staleEnabled = await seedDirWith({
      'examplecorp.json': { ...OAUTH_SEED, revision: 1, enabled: true },
    });
    const revisionThreeEnabled = await seedDirWith({
      'examplecorp.json': { ...OAUTH_SEED, revision: 3, enabled: true },
    });
    const first = (await new IntegrationDescriptorSeedLoader(
      revisionOne, store, encryption, configuredCredentials, loaderOptions(integrationStore),
    ).loadSeeds()).descriptors[0];
    if (!first) throw new Error('expected configured descriptor');
    await connectExampleCorp(integrationStore, {
      descriptorId: first.id,
      accountLabel: 'preserved-user',
      scopes: ['read'],
      accessToken: 'encrypted-access',
    });
    await new IntegrationDescriptorSeedLoader(
      revisionTwoDisabled, store, encryption, credentials({}), loaderOptions(integrationStore),
    ).loadSeeds();

    await expect(new IntegrationDescriptorSeedLoader(
      revisionTwoEnabled, store, encryption, configuredCredentials, loaderOptions(integrationStore),
    ).loadSeeds()).resolves.toMatchObject({ loaded: 0, failed: 1 });
    await expect(new IntegrationDescriptorSeedLoader(
      staleEnabled, store, encryption, configuredCredentials, loaderOptions(integrationStore),
    ).loadSeeds()).resolves.toMatchObject({ loaded: 0, skipped: 1, failed: 0 });
    await expect(store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).resolves.toBeNull();

    await expect(new IntegrationDescriptorSeedLoader(
      revisionThreeEnabled, store, encryption, configuredCredentials, loaderOptions(integrationStore),
    ).loadSeeds()).resolves.toMatchObject({ loaded: 1, failed: 0 });
    await expect(store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({
      id: first.id,
      curatedSeedRevision: 3,
    });
    await expect(integrationStore.findByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({
      integrationDescriptorId: first.id,
      status: 'connected',
      accessTokenCiphertext: Buffer.from('encrypted-access'),
    });
  });

  it('persists a disabled tombstone before a descriptor and prevents stale replica resurrection', async () => {
    const store = new InMemoryIntegrationDescriptorStore();
    const encryption = newEncryption();
    const disabled = await seedDirWith({
      'examplecorp.json': { provider: 'examplecorp', revision: 5, enabled: false },
    });
    const stale = await seedDirWith({
      'examplecorp.json': { ...OAUTH_SEED, revision: 4, enabled: true },
    });
    const current = await seedDirWith({
      'examplecorp.json': { ...OAUTH_SEED, revision: 6, enabled: true },
    });
    const configuredCredentials = credentials({
      examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' },
    });

    await new IntegrationDescriptorSeedLoader(
      disabled, store, encryption, credentials({}), loaderOptions(),
    ).loadSeeds();
    await expect(new IntegrationDescriptorSeedLoader(
      stale, store, encryption, configuredCredentials, loaderOptions(),
    ).loadSeeds()).resolves.toMatchObject({ loaded: 0, skipped: 1, failed: 0 });
    await expect(store.findCuratedByProvider('examplecorp')).resolves.toBeNull();

    await expect(new IntegrationDescriptorSeedLoader(
      current, store, encryption, configuredCredentials, loaderOptions(),
    ).loadSeeds()).resolves.toMatchObject({ loaded: 1, failed: 0 });
    await expect(store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).resolves.toMatchObject({
      curatedSeedRevision: 6,
    });
  });

  it('serializes racing replica revisions so the highest disable wins', async () => {
    const store = new InMemoryIntegrationDescriptorStore();
    const encryption = newEncryption();
    const configuredCredentials = credentials({
      examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' },
    });
    const revisionOne = await seedDirWith({
      'examplecorp.json': { ...OAUTH_SEED, revision: 1 },
    });
    const revisionTwo = await seedDirWith({
      'examplecorp.json': { ...OAUTH_SEED, revision: 2 },
    });
    const revisionThreeDisabled = await seedDirWith({
      'examplecorp.json': { provider: 'examplecorp', revision: 3, enabled: false },
    });
    await new IntegrationDescriptorSeedLoader(
      revisionOne, store, encryption, configuredCredentials, loaderOptions(),
    ).loadSeeds();

    await Promise.all([
      new IntegrationDescriptorSeedLoader(
        revisionTwo, store, encryption, configuredCredentials, loaderOptions(),
      ).loadSeeds(),
      new IntegrationDescriptorSeedLoader(
        revisionThreeDisabled, store, encryption, credentials({}), loaderOptions(),
      ).loadSeeds(),
    ]);

    await expect(store.findCuratedByProvider('examplecorp')).resolves.not.toBeNull();
    await expect(store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).resolves.toBeNull();
  });

  it('rejects an unversioned explicit disable seed', async () => {
    const dir = await seedDirWith({
      'examplecorp.json': { provider: 'examplecorp', enabled: false },
    });
    const loader = new IntegrationDescriptorSeedLoader(
      dir,
      new InMemoryIntegrationDescriptorStore(),
      newEncryption(),
      credentials({}),
      loaderOptions(),
    );

    await expect(loader.loadSeeds()).resolves.toMatchObject({ loaded: 0, skipped: 0, failed: 1 });
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

  it('fails a seed after bounded busy retries instead of reporting stale state as loaded', async () => {
    const dir = await seedDirWith({ 'examplekey.json': STATIC_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const reconcile = jest.spyOn(store, 'reconcileCuratedSeed').mockRejectedValue(
      new IntegrationDescriptorMutationBusyError(),
    );
    const loader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      newEncryption(),
      credentials({}),
      loaderOptions(),
    );

    await expect(loader.loadSeeds()).resolves.toMatchObject({
      loaded: 0,
      skipped: 0,
      failed: 1,
      descriptors: [],
    });
    expect(reconcile).toHaveBeenCalledTimes(4);
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
