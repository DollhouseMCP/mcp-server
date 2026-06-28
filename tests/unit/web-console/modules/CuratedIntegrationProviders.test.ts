import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildConfiguredIntegrationProviders,
  createEnvIntegrationDescriptorCredentialResolver,
  loadCuratedIntegrationProviders,
} from '../../../../src/web-console/modules/integrations/CuratedIntegrationProviders.js';
import { integrationDescriptorClientSecretContext } from '../../../../src/web-console/modules/integrations/IntegrationSecretContext.js';
import { AeadSecretEncryptionService } from '../../../../src/web-console/security/SecretEncryption.js';
import {
  type IntegrationDescriptorCreateInput,
} from '../../../../src/web-console/stores/IIntegrationDescriptorStore.js';
import { InMemoryIntegrationDescriptorStore } from '../../../../src/web-console/stores/InMemoryIntegrationDescriptorStore.js';

const VISIBLE_USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-06-24T00:00:00.000Z');

function newEncryption(): AeadSecretEncryptionService {
  return new AeadSecretEncryptionService({ keyId: 'test-key', key: Buffer.alloc(32, 7) });
}

function oauthInput(enc: AeadSecretEncryptionService, secret: string): IntegrationDescriptorCreateInput {
  return {
    provider: 'examplecorp',
    ownership: 'curated',
    ownerUserId: null,
    displayName: 'Example Corp',
    category: 'Productivity',
    authStrategy: 'oauth2_authorization_code',
    apiHosts: ['api.examplecorp.test'],
    oauth: {
      clientId: 'deployment-client-id',
      authorizationUrl: 'https://auth.examplecorp.test/authorize',
      tokenUrl: 'https://auth.examplecorp.test/token',
      scopes: ['read'],
      pkce: 'required',
      refresh: 'rotating',
      tokenExchange: {},
      accountLabel: {},
    },
    clientSecretCiphertext: enc.encrypt(
      Buffer.from(secret, 'utf8'),
      integrationDescriptorClientSecretContext({ provider: 'examplecorp', ownerUserId: null }),
    ),
    credentialKeyVersion: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const STATIC_INPUT: IntegrationDescriptorCreateInput = {
  provider: 'examplekey',
  ownership: 'curated',
  ownerUserId: null,
  displayName: 'Example Key',
  category: 'Data',
  authStrategy: 'static_api_key',
  apiHosts: ['api.examplekey.test'],
  staticApiKey: { injection: { location: 'header', name: 'X-Api-Key', valuePrefix: null } },
  createdAt: NOW,
  updatedAt: NOW,
};

const CODED_INPUT: IntegrationDescriptorCreateInput = {
  provider: 'codedprovider',
  ownership: 'curated',
  ownerUserId: null,
  displayName: 'Coded',
  category: 'Other',
  authStrategy: 'coded',
  apiHosts: ['api.coded.test'],
  createdAt: NOW,
  updatedAt: NOW,
};

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
    tokenExchange: {},
    accountLabel: {},
  },
};

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('buildConfiguredIntegrationProviders', () => {
  it('builds OAuth and static providers and skips coded descriptors', async () => {
    const enc = newEncryption();
    const store = new InMemoryIntegrationDescriptorStore();
    await store.upsert(oauthInput(enc, 'the-secret'));
    await store.upsert(STATIC_INPUT);
    await store.upsert(CODED_INPUT);
    const descriptors = await store.listVisible(VISIBLE_USER);

    const providers = buildConfiguredIntegrationProviders(descriptors, enc);

    const byId = new Map(providers.map(p => [p.descriptor.id, p]));
    expect(byId.get('examplecorp')?.credentialStrategy).toBe('oauth2_authorization_code');
    expect(byId.get('examplekey')?.credentialStrategy).toBe('static_api_key');
    expect(byId.has('codedprovider')).toBe(false);
    expect(providers).toHaveLength(2);
  });

  it('skips a descriptor whose client secret cannot be decrypted (wrong key)', async () => {
    const store = new InMemoryIntegrationDescriptorStore();
    await store.upsert(oauthInput(newEncryption(), 'the-secret'));
    const descriptors = await store.listVisible(VISIBLE_USER);

    // A different key cannot decrypt the stored ciphertext → provider build fails, descriptor skipped.
    const otherKey = new AeadSecretEncryptionService({ keyId: 'other', key: Buffer.alloc(32, 9) });
    const providers = buildConfiguredIntegrationProviders(descriptors, otherKey);
    expect(providers).toHaveLength(0);
  });
});

describe('loadCuratedIntegrationProviders', () => {
  it('returns [] when no seed directory is configured', async () => {
    const providers = await loadCuratedIntegrationProviders({
      seedDir: undefined,
      descriptorStore: new InMemoryIntegrationDescriptorStore(),
      secretEncryption: newEncryption(),
    });
    expect(providers).toEqual([]);
  });

  it('loads seed files and returns built providers', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'curated-providers-'));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, 'examplecorp.json'), JSON.stringify(OAUTH_SEED), 'utf8');

    const providers = await loadCuratedIntegrationProviders({
      seedDir: dir,
      descriptorStore: new InMemoryIntegrationDescriptorStore(),
      secretEncryption: newEncryption(),
      now: () => NOW,
      credentialResolver: () => ({ clientId: 'cid', clientSecret: 'csecret' }),
    });

    expect(providers).toHaveLength(1);
    expect(providers[0]?.descriptor.id).toBe('examplecorp');
    expect(providers[0]?.credentialStrategy).toBe('oauth2_authorization_code');
  });
});

describe('createEnvIntegrationDescriptorCredentialResolver', () => {
  it('reads per-provider credentials from env by convention', () => {
    const resolve = createEnvIntegrationDescriptorCredentialResolver({
      DOLLHOUSE_INTEGRATION_EXAMPLECORP_CLIENT_ID: 'env-id',
      DOLLHOUSE_INTEGRATION_EXAMPLECORP_CLIENT_SECRET: 'env-secret',
    });
    expect(resolve('examplecorp')).toEqual({ clientId: 'env-id', clientSecret: 'env-secret' });
    expect(resolve('unknown')).toEqual({ clientId: null, clientSecret: null });
  });
});
