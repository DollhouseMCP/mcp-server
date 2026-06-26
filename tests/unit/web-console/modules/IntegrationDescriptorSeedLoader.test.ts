import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  IntegrationDescriptorSeedLoader,
  type IntegrationDescriptorSeedCredentialResolver,
} from '../../../../src/web-console/modules/integrations/IntegrationDescriptorSeedLoader.js';
import { integrationDescriptorClientSecretContext } from '../../../../src/web-console/modules/integrations/IntegrationSecretContext.js';
import { AeadSecretEncryptionService } from '../../../../src/web-console/security/SecretEncryption.js';
import { InMemoryIntegrationDescriptorStore } from '../../../../src/web-console/stores/InMemoryIntegrationDescriptorStore.js';

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

describe('IntegrationDescriptorSeedLoader', () => {
  it('loads a curated OAuth descriptor, injecting clientId and encrypting the client secret', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const encryption = newEncryption();
    const loader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      encryption,
      credentials({ examplecorp: { clientId: 'deployment-client-id', clientSecret: 'deployment-secret' } }),
      { now: () => FIXED_NOW },
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
  });

  it('skips a curated OAuth descriptor when deployment credentials are not configured', async () => {
    const dir = await seedDirWith({ 'examplecorp.json': OAUTH_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const loader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      newEncryption(),
      credentials({}),
      { now: () => FIXED_NOW },
    );

    const result = await loader.loadSeeds();
    expect(result.loaded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.descriptors).toHaveLength(0);
    expect(await store.findVisibleByProvider(VISIBLE_USER, 'examplecorp')).toBeNull();
  });

  it('loads a curated static-API-key descriptor without deployment credentials', async () => {
    const dir = await seedDirWith({ 'examplekey.json': STATIC_SEED });
    const store = new InMemoryIntegrationDescriptorStore();
    const loader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      newEncryption(),
      credentials({}),
      { now: () => FIXED_NOW },
    );

    const result = await loader.loadSeeds();
    expect(result.loaded).toBe(1);
    expect(result.failed).toBe(0);

    const record = await store.findVisibleByProvider(VISIBLE_USER, 'examplekey');
    expect(record?.authStrategy).toBe('static_api_key');
    expect(record?.staticApiKey?.injection.name).toBe('X-Api-Key');
    expect(record?.clientSecretCiphertext).toBeNull();
  });

  it('skips the reserved github provider id', async () => {
    const dir = await seedDirWith({ 'github.json': { ...OAUTH_SEED, provider: 'github' } });
    const store = new InMemoryIntegrationDescriptorStore();
    const loader = new IntegrationDescriptorSeedLoader(
      dir,
      store,
      newEncryption(),
      credentials({ github: { clientId: 'x', clientSecret: 'y' } }),
    );

    const result = await loader.loadSeeds();
    expect(result.loaded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await store.findVisibleByProvider(VISIBLE_USER, 'github')).toBeNull();
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
      { now: () => FIXED_NOW },
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
    );

    const result = await loader.loadSeeds();
    expect(result.loaded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.descriptors).toHaveLength(0);
  });
});
