import { describe, expect, it, jest } from '@jest/globals';

import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';

import {
  AeadSecretEncryptionService,
  CONSOLE_INTEGRATION_STATE_COOKIE,
  createIntegrationModule,
  HmacConsoleOpaqueValueService,
  InMemoryIntegrationDescriptorStore,
  InMemoryIntegrationOpenApiSpecStore,
  InMemoryLoginTransactionStore,
  InMemoryUserIntegrationStore,
  IntegrationProviderRegistry,
  IntegrationTokenRefreshService,
  type ConsoleRequest,
  type ConsoleRouteDefinition,
  type IntegrationDescriptorRecord,
} from '../../../../src/web-console/index.js';
import { IntegrationDescriptorAuthoringService } from '../../../../src/web-console/modules/integrations/IntegrationDescriptorAuthoringService.js';
import { createStoreIntegrationProviderResolver } from '../../../../src/web-console/modules/integrations/CuratedIntegrationProviders.js';
import { integrationDescriptorClientSecretContext, integrationSecretContext } from '../../../../src/web-console/modules/integrations/IntegrationSecretContext.js';
import type { ISecretEncryptionService } from '../../../../src/web-console/security/SecretEncryption.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const OTHER_USER_ID = '118f3d47-73ae-7f10-a0de-0742618d4fb2';
const UNKNOWN_ID = '00000000-0000-4000-8000-0000000000aa';
const NOW = new Date('2026-07-02T10:00:00.000Z');
const PRIMARY_SUB = 'github_user-7';
const SELF_CAPABILITY = 'console:self';
const MYCRM = 'mycrm';
const CLIENT_SECRET = 'super-secret-client-credential';
const DESCRIPTORS_PATH = '/api/v1/me/integrations/descriptors';
const TWILIO_LIKE = 'twilio-like';

function authenticatedContext(userId = USER_ID): NonNullable<ConsoleRequest['consoleAuthentication']> {
  return {
    sessionIdHash: Buffer.alloc(32, 7),
    userId,
    authSub: PRIMARY_SUB,
    authzVersion: 3,
    grantedCapabilities: [SELF_CAPABILITY],
    elevation: null,
  };
}

function consoleRequest(overrides: Partial<ConsoleRequest> = {}): ConsoleRequest {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    consoleAuthentication: authenticatedContext(),
    ...overrides,
  } as ConsoleRequest;
}

function encryption(): AeadSecretEncryptionService {
  return new AeadSecretEncryptionService({
    keyId: 'descriptor-authoring-test',
    key: Buffer.alloc(32, 41),
  });
}

function oauthBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    provider: MYCRM,
    display_name: 'My CRM',
    category: 'crm',
    auth_strategy: 'oauth2_authorization_code',
    api_hosts: ['api.mycrm.example'],
    oauth: {
      client_id: 'mycrm-client',
      authorization_url: 'https://auth.mycrm.example/authorize',
      token_url: 'https://auth.mycrm.example/token',
      scopes: ['crm.read'],
      pkce: 'required',
      refresh: 'rotating',
      client_secret: CLIENT_SECRET,
    },
    ...overrides,
  };
}

function staticKeyBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    provider: 'airtable',
    display_name: 'Airtable',
    category: 'database',
    auth_strategy: 'static_api_key',
    api_hosts: ['api.airtable.example'],
    static_api_key: {
      injection: { location: 'header', name: 'Authorization', value_prefix: 'Bearer ' },
    },
    ...overrides,
  };
}

function fixture(options: {
  readonly descriptors?: readonly IntegrationDescriptorRecord[];
  readonly withEncryption?: boolean;
  readonly reservedProviderIds?: ReadonlySet<string>;
  readonly secretEncryption?: ISecretEncryptionService;
} = {}) {
  const descriptorStore = new InMemoryIntegrationDescriptorStore(options.descriptors ?? []);
  const specStore = new InMemoryIntegrationOpenApiSpecStore();
  const integrationStore = new InMemoryUserIntegrationStore();
  const secretEncryption = options.withEncryption === false
    ? null
    : options.secretEncryption ?? encryption();
  const service = new IntegrationDescriptorAuthoringService({
    descriptorStore,
    specStore,
    integrationStore,
    secretEncryption,
    ...(options.reservedProviderIds ? { reservedProviderIds: options.reservedProviderIds } : {}),
    now: () => NOW,
  });
  return { service, descriptorStore, specStore, integrationStore, secretEncryption };
}

function curatedRecord(provider: string, id: string): IntegrationDescriptorRecord {
  return {
    id,
    provider,
    ownership: 'curated',
    ownerUserId: null,
    displayName: `Curated ${provider}`,
    category: 'crm',
    authStrategy: 'oauth2_authorization_code',
    apiHosts: [`api.${provider}.example`],
    oauth: {
      clientId: 'curated-client',
      authorizationUrl: `https://auth.${provider}.example/authorize`,
      tokenUrl: `https://auth.${provider}.example/token`,
      scopes: [],
      pkce: 'required',
      refresh: 'none',
      tokenExchange: {},
      accountLabel: {},
    },
    staticApiKey: null,
    clientSecretCiphertext: null,
    credentialKeyVersion: null,
    operationPromotion: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function connectFixtureIntegration(
  store: InMemoryUserIntegrationStore,
  provider: string,
  integrationDescriptorId: string,
): Promise<void> {
  await store.connect({
    userId: USER_ID,
    provider,
    integrationDescriptorId,
    externalAccountLabel: 'test account',
    externalInstallationId: null,
    authorizedPermissions: { scopes: [] },
    accessTokenCiphertext: Buffer.from('encrypted-test-token'),
    refreshTokenCiphertext: null,
    connectedAt: NOW,
  });
}

function bodyOf(result: { body?: unknown }): Record<string, unknown> {
  return result.body as Record<string, unknown>;
}

describe('IntegrationDescriptorAuthoringService', () => {
  it('creates a BYO descriptor owned by the caller with the client secret encrypted and never returned', async () => {
    const { service, descriptorStore, secretEncryption } = fixture();

    const result = await service.create(consoleRequest({ body: oauthBody() }));

    expect(result.status).toBe(201);
    const body = bodyOf(result);
    expect(body).toMatchObject({
      provider: MYCRM,
      ownership: 'byo',
      auth_strategy: 'oauth2_authorization_code',
      has_client_secret: true,
    });
    expect(JSON.stringify(body)).not.toContain(CLIENT_SECRET);
    expect(body.client_secret).toBeUndefined();
    expect(body.clientSecretCiphertext).toBeUndefined();
    expect(body.credential_key_version).toBeUndefined();
    expect(body.owner_user_id).toBeUndefined();

    const stored = await descriptorStore.findById(body.id as string, USER_ID);
    expect(stored?.ownerUserId).toBe(USER_ID);
    const ciphertext = stored?.clientSecretCiphertext;
    if (!ciphertext) throw new Error('expected stored client secret ciphertext');
    const decrypted = secretEncryption?.decrypt(
      ciphertext,
      integrationDescriptorClientSecretContext({ provider: MYCRM, ownerUserId: USER_ID }),
    );
    expect(decrypted?.toString('utf8')).toBe(CLIENT_SECRET);
  });

  it('creates static-key descriptors without any secret material', async () => {
    const { service } = fixture();

    const result = await service.create(consoleRequest({ body: staticKeyBody() }));

    expect(result.status).toBe(201);
    expect(bodyOf(result)).toMatchObject({
      provider: 'airtable',
      auth_strategy: 'static_api_key',
      has_client_secret: false,
      static_api_key: { injection: { location: 'header', name: 'Authorization', value_prefix: 'Bearer ' } },
    });
  });

  it.each(['\ud800', '\udc00'])('rejects malformed Unicode in static-key injection descriptors', async malformed => {
    const { service } = fixture();
    const malformedName = await service.create(consoleRequest({
      body: staticKeyBody({
        static_api_key: { injection: { location: 'query', name: `key${malformed}`, value_prefix: null } },
      }),
    }));
    const malformedPrefix = await service.create(consoleRequest({
      body: staticKeyBody({
        static_api_key: { injection: { location: 'header', name: 'Authorization', value_prefix: `Bearer ${malformed}` } },
      }),
    }));

    expect(malformedName.status).toBe(422);
    expect(String(bodyOf(malformedName).detail)).toContain('well-formed Unicode');
    expect(malformedPrefix.status).toBe(422);
    expect(String(bodyOf(malformedPrefix).detail)).toContain('well-formed Unicode');
  });

  it('accepts valid surrogate pairs in static-key value prefixes', async () => {
    const { service } = fixture();
    const result = await service.create(consoleRequest({
      body: staticKeyBody({
        static_api_key: { injection: { location: 'header', name: 'Authorization', value_prefix: 'Key \u{1F511} ' } },
      }),
    }));

    expect(result.status).toBe(201);
  });

  it('persists and returns canonical de-duplicated API hosts', async () => {
    const { service, descriptorStore } = fixture();

    const result = await service.create(consoleRequest({
      body: oauthBody({
        api_hosts: [
          'API.MyCRM.Example',
          'api.mycrm.example.',
          'bücher.example',
          'xn--bcher-kva.example',
        ],
      }),
    }));

    expect(result.status).toBe(201);
    expect(bodyOf(result).api_hosts).toEqual(['api.mycrm.example', 'xn--bcher-kva.example']);
    const stored = await descriptorStore.findById(bodyOf(result).id as string, USER_ID);
    expect(stored?.apiHosts).toEqual(['api.mycrm.example', 'xn--bcher-kva.example']);
  });

  it.each([
    'https://api.mycrm.example',
    'user@api.mycrm.example',
    'api.mycrm.example:443',
    'api.mycrm.example/path',
    'api\u200B.mycrm.example',
  ])('rejects API host syntax that is not a bare hostname: %s', async apiHost => {
    const { service } = fixture();

    const result = await service.create(consoleRequest({ body: oauthBody({ api_hosts: [apiHost] }) }));

    expect(result.status).toBe(422);
    expect(String(bodyOf(result).detail)).toContain('must be a hostname');
  });

  it('rejects provider ids colliding with any visible descriptor', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    const { service } = fixture();
    await service.create(consoleRequest({ body: oauthBody() }));

    const duplicate = await service.create(consoleRequest({ body: oauthBody() }));
    expect(duplicate.status).toBe(409);

    // A curated descriptor with the same provider id also collides.
    const { service: curatedService } = fixture({
      descriptors: [{
        id: UNKNOWN_ID,
        provider: MYCRM,
        ownership: 'curated',
        ownerUserId: null,
        displayName: 'Curated CRM',
        category: 'crm',
        authStrategy: 'oauth2_authorization_code',
        apiHosts: ['api.mycrm.example'],
        oauth: {
          clientId: 'curated-client',
          authorizationUrl: 'https://auth.mycrm.example/authorize',
          tokenUrl: 'https://auth.mycrm.example/token',
          scopes: [],
          pkce: 'required',
          refresh: 'none',
          tokenExchange: {},
          accountLabel: {},
        },
        staticApiKey: null,
        clientSecretCiphertext: null,
        credentialKeyVersion: null,
        operationPromotion: {},
        createdAt: NOW,
        updatedAt: NOW,
      }],
    });
    const shadowing = await curatedService.create(consoleRequest({ body: oauthBody() }));
    expect(shadowing.status).toBe(409);
    expect(SecurityMonitor.getRecentEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'IntegrationDescriptorAuthoringService',
        details: expect.stringContaining('created denied_conflict for provider mycrm'),
      }),
    ]));
  });

  it('rejects coded strategies, reserved provider ids, and store-invalid descriptors with 422', async () => {
    const { service } = fixture();

    const coded = await service.create(consoleRequest({ body: oauthBody({ auth_strategy: 'coded' }) }));
    expect(coded.status).toBe(422);

    const reserved = await service.create(consoleRequest({ body: oauthBody({ provider: 'descriptors' }) }));
    expect(reserved.status).toBe(422);

    const privateHost = await service.create(consoleRequest({ body: oauthBody({ api_hosts: ['localhost'] }) }));
    expect(privateHost.status).toBe(422);

    const missingProvider = await service.create(consoleRequest({ body: oauthBody({ provider: '' }) }));
    expect(missingProvider.status).toBe(422);
  });

  it.each([
    ['display_name', { display_name: 'Trusted\u202E CRM' }],
    ['category', { category: 'crm\u200B' }],
    ['display_name', { display_name: 'Trusted\u2063 CRM' }],
    ['category', { category: 'crm\u061C' }],
    ['display_name', { display_name: 'Trusted\u034F CRM' }],
    ['category', { category: 'crm\uFE00' }],
    ['display_name', { display_name: 'Trusted\u009C CRM' }],
    ['category', { category: 'crm\u2029' }],
  ])('rejects unsafe Unicode in human-visible descriptor %s', async (_field, override) => {
    const { service } = fixture();

    const result = await service.create(consoleRequest({ body: oauthBody(override) }));

    expect(result.status).toBe(422);
    expect(String(bodyOf(result).detail)).toContain('directional or zero-width characters');
  });

  it('NFC-normalizes international descriptor display values without folding scripts', async () => {
    const { service } = fixture();

    const result = await service.create(consoleRequest({
      body: oauthBody({ display_name: 'Cafe\u0301 Δοκιμή', category: '統合' }),
    }));

    expect(result.status).toBe(201);
    expect(bodyOf(result)).toMatchObject({ display_name: 'Café Δοκιμή', category: '統合' });
  });

  it('rejects provider ids reserved by a built-in or curated boot-registry provider', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    // github is a bespoke registry provider with no descriptor; a BYO github
    // would route the deployment-brokered GitHub token to a chosen host.
    const { service } = fixture({ reservedProviderIds: new Set(['github', 'gmail']) });

    const github = await service.create(consoleRequest({
      body: staticKeyBody({ provider: 'github' }),
    }));
    expect(github.status).toBe(409);
    expect(bodyOf(github)).toMatchObject({ code: 'integration_descriptor_conflict' });

    const curated = await service.create(consoleRequest({ body: oauthBody({ provider: 'gmail' }) }));
    expect(curated.status).toBe(409);

    // The store also refuses github directly (belt), independent of the registry.
    const storeReserved = await service.create(consoleRequest({ body: oauthBody({ provider: 'github' }) }));
    expect([409, 422]).toContain(storeReserved.status);
    expect(SecurityMonitor.getRecentEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'IntegrationDescriptorAuthoringService',
        details: expect.stringContaining('created denied_reserved for provider github'),
      }),
    ]));
  });

  it('stores a rotated client secret when the PATCH body omits provider', async () => {
    const { service, descriptorStore, secretEncryption } = fixture();
    const created = bodyOf(await service.create(consoleRequest({ body: oauthBody() })));

    const oauthWithNewSecret = { ...(oauthBody().oauth as Record<string, unknown>), client_secret: 'rotated-secret-value' };
    const updated = await service.update(consoleRequest({
      params: { id: created.id as string },
      body: { oauth: oauthWithNewSecret }, // no `provider` key — the natural rotation call
    }));

    expect(updated.status).toBe(200);
    expect(bodyOf(updated)).toMatchObject({ has_client_secret: true });
    expect(JSON.stringify(bodyOf(updated))).not.toContain('rotated-secret-value');

    const stored = await descriptorStore.findById(created.id as string, USER_ID);
    const ciphertext = stored?.clientSecretCiphertext;
    if (!ciphertext) throw new Error('expected rotated ciphertext to persist');
    expect(secretEncryption?.decrypt(
      ciphertext,
      integrationDescriptorClientSecretContext({ provider: MYCRM, ownerUserId: USER_ID }),
    ).toString('utf8')).toBe('rotated-secret-value');
  });

  it('requires disconnect before credential-routing changes or descriptor deletion', async () => {
    const { service, integrationStore } = fixture();
    const created = bodyOf(await service.create(consoleRequest({ body: staticKeyBody() })));
    const descriptorId = created.id as string;
    await connectFixtureIntegration(integrationStore, 'airtable', descriptorId);

    await expect(service.update(consoleRequest({
      params: { id: descriptorId },
      body: { display_name: 'Airtable Workspace' },
    }))).resolves.toMatchObject({ status: 200 });

    await expect(service.update(consoleRequest({
      params: { id: descriptorId },
      body: { api_hosts: ['api2.airtable.example'] },
    }))).resolves.toMatchObject({
      status: 409,
      body: { code: 'integration_descriptor_conflict' },
    });
    await expect(service.update(consoleRequest({
      params: { id: descriptorId },
      body: { operation_promotion: { operations: ['records.list'] } },
    }))).resolves.toMatchObject({
      status: 409,
      body: { code: 'integration_descriptor_conflict' },
    });
    await expect(service.remove(consoleRequest({ params: { id: descriptorId } })))
      .resolves.toMatchObject({ status: 409, body: { code: 'integration_descriptor_conflict' } });

    await integrationStore.disconnect({ userId: USER_ID, provider: 'airtable', revokedAt: NOW });
    await expect(service.update(consoleRequest({
      params: { id: descriptorId },
      body: { api_hosts: ['api2.airtable.example'] },
    }))).resolves.toMatchObject({ status: 200 });
    await expect(service.remove(consoleRequest({ params: { id: descriptorId } })))
      .resolves.toMatchObject({ status: 204 });
  });

  it('allows descriptor maintenance when the provider has no usable credential', async () => {
    const { service, integrationStore } = fixture();
    const created = bodyOf(await service.create(consoleRequest({ body: oauthBody() })));
    const descriptorId = created.id as string;
    await integrationStore.recordError({
      userId: USER_ID,
      provider: MYCRM,
      integrationDescriptorId: descriptorId,
      errorReason: 'provider_unavailable',
      occurredAt: NOW,
    });

    await expect(service.update(consoleRequest({
      params: { id: descriptorId },
      body: { api_hosts: ['api2.mycrm.example'] },
    }))).resolves.toMatchObject({ status: 200 });
    await expect(service.remove(consoleRequest({ params: { id: descriptorId } })))
      .resolves.toMatchObject({ status: 204 });
  });

  it('blocks descriptor changes when refresh failed but encrypted credentials remain', async () => {
    const { service, integrationStore } = fixture();
    const created = bodyOf(await service.create(consoleRequest({ body: oauthBody() })));
    const descriptorId = created.id as string;
    await connectFixtureIntegration(integrationStore, MYCRM, descriptorId);
    await integrationStore.refresh({
      userId: USER_ID,
      provider: MYCRM,
      integrationDescriptorId: descriptorId,
      staleAccessTokenCiphertext: Buffer.from('encrypted-test-token'),
      refreshedAt: NOW,
      refresh: () => Promise.resolve({ kind: 'failed', errorReason: 'token_refresh_failed' }),
    });

    await expect(service.update(consoleRequest({
      params: { id: descriptorId },
      body: { api_hosts: ['api2.mycrm.example'] },
    }))).resolves.toMatchObject({ status: 409, body: { code: 'integration_descriptor_conflict' } });
    await expect(service.remove(consoleRequest({ params: { id: descriptorId } })))
      .resolves.toMatchObject({ status: 409, body: { code: 'integration_descriptor_conflict' } });
  });

  it('rejects PATCH and DELETE by non-owner and on curated descriptors', async () => {
    const curated = curatedRecord('shared-crm', '00000000-0000-4000-8000-0000000000c1');
    const { service } = fixture({ descriptors: [curated] });
    const created = bodyOf(await service.create(consoleRequest({ body: oauthBody() })));
    const ownedId = created.id as string;

    // Non-owner cannot mutate or delete the owner's descriptor.
    await expect(service.update(consoleRequest({
      params: { id: ownedId },
      body: { display_name: 'hijacked' },
      consoleAuthentication: authenticatedContext(OTHER_USER_ID),
    }))).resolves.toMatchObject({ status: 404 });
    await expect(service.remove(consoleRequest({
      params: { id: ownedId },
      consoleAuthentication: authenticatedContext(OTHER_USER_ID),
    }))).resolves.toMatchObject({ status: 404 });

    // A curated descriptor (visible via list) is not mutable or deletable by id.
    await expect(service.update(consoleRequest({
      params: { id: curated.id },
      body: { display_name: 'hijacked' },
    }))).resolves.toMatchObject({ status: 404 });
    await expect(service.remove(consoleRequest({ params: { id: curated.id } })))
      .resolves.toMatchObject({ status: 404 });
  });

  it('never serializes the client secret on list responses', async () => {
    const { service } = fixture();
    await service.create(consoleRequest({ body: oauthBody() }));

    const listed = await service.list(consoleRequest());
    expect(JSON.stringify(bodyOf(listed))).not.toContain(CLIENT_SECRET);
    const first = (bodyOf(listed).descriptors as Array<Record<string, unknown>>)[0];
    expect(first.has_client_secret).toBe(true);
    expect(first.client_secret).toBeUndefined();
    expect(first.clientSecretCiphertext).toBeUndefined();
  });

  it('fails closed when a client secret is supplied without encryption configured', async () => {
    const { service, descriptorStore } = fixture({ withEncryption: false });

    const result = await service.create(consoleRequest({ body: oauthBody() }));

    expect(result.status).toBe(503);
    await expect(descriptorStore.listVisible(USER_ID)).resolves.toHaveLength(0);
  });

  it('audits create and update failures when client-secret encryption throws', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    const encryptionFailure = new Error('test encryption failure');
    const throwingEncryption: ISecretEncryptionService = {
      encrypt: () => { throw encryptionFailure; },
      decrypt: () => { throw new Error('not used'); },
    };
    const { service: createService, descriptorStore } = fixture({ secretEncryption: throwingEncryption });

    await expect(createService.create(consoleRequest({ body: oauthBody() }))).rejects.toBe(encryptionFailure);
    await expect(descriptorStore.listVisible(USER_ID)).resolves.toHaveLength(0);

    const seeded = fixture();
    const created = bodyOf(await seeded.service.create(consoleRequest({ body: oauthBody() })));
    const failingUpdateService = new IntegrationDescriptorAuthoringService({
      descriptorStore: seeded.descriptorStore,
      specStore: seeded.specStore,
      integrationStore: seeded.integrationStore,
      secretEncryption: throwingEncryption,
      now: () => NOW,
    });
    await expect(failingUpdateService.update(consoleRequest({
      params: { id: created.id as string },
      body: { oauth: { ...(oauthBody().oauth as Record<string, unknown>), client_secret: 'rotated-secret' } },
    }))).rejects.toBe(encryptionFailure);

    const events = SecurityMonitor.getRecentEvents();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'IntegrationDescriptorAuthoringService',
        details: expect.stringContaining('created failed for provider mycrm'),
      }),
      expect.objectContaining({
        source: 'IntegrationDescriptorAuthoringService',
        details: expect.stringContaining('updated failed for provider mycrm'),
      }),
    ]));
  });

  it('audits descriptor lookup failures for every mutation route before propagating', async () => {
    SecurityMonitor.clearAllEventsForTesting();
    const lookupFailure = new Error('test descriptor lookup failure');
    const { service, descriptorStore } = fixture();
    jest.spyOn(descriptorStore, 'findById').mockRejectedValue(lookupFailure);

    await expect(service.update(consoleRequest({
      params: { id: UNKNOWN_ID },
      body: { display_name: 'Renamed' },
    }))).rejects.toBe(lookupFailure);
    await expect(service.remove(consoleRequest({ params: { id: UNKNOWN_ID } }))).rejects.toBe(lookupFailure);
    await expect(service.putSpec(consoleRequest({
      params: { id: UNKNOWN_ID },
      body: { spec: { openapi: '3.0.0', paths: {} } },
    }))).rejects.toBe(lookupFailure);

    const events = SecurityMonitor.getRecentEvents()
      .filter(event => event.source === 'IntegrationDescriptorAuthoringService');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ details: 'Integration descriptor updated failed for provider <invalid>' }),
      expect.objectContaining({ details: 'Integration descriptor deleted failed for provider <invalid>' }),
      expect.objectContaining({ details: 'Integration descriptor spec_updated failed for provider <invalid>' }),
    ]));
    expect(JSON.stringify(events)).not.toContain(lookupFailure.message);
  });

  it('reads descriptors by id only for the owner', async () => {
    const { service } = fixture();
    const created = bodyOf(await service.create(consoleRequest({ body: oauthBody() })));

    const owned = await service.get(consoleRequest({ params: { id: created.id as string } }));
    expect(owned.status).toBe(200);

    const foreign = await service.get(consoleRequest({
      params: { id: created.id as string },
      consoleAuthentication: authenticatedContext(OTHER_USER_ID),
    }));
    expect(foreign.status).toBe(404);

    const malformed = await service.get(consoleRequest({ params: { id: 'not-a-uuid' } }));
    expect(malformed.status).toBe(404);
  });

  it('lists visible descriptors with pagination and rejects invalid limits', async () => {
    const { service } = fixture();
    await service.create(consoleRequest({ body: oauthBody() }));
    await service.create(consoleRequest({ body: staticKeyBody() }));

    const first = await service.list(consoleRequest({ query: { limit: '1' } }));
    expect(first.status).toBe(200);
    const firstBody = bodyOf(first);
    expect(firstBody.descriptors).toHaveLength(1);
    expect(firstBody.next_cursor).not.toBeNull();

    const second = await service.list(consoleRequest({
      query: { limit: '1', cursor: firstBody.next_cursor as string },
    }));
    const secondBody = bodyOf(second);
    expect(secondBody.descriptors).toHaveLength(1);
    expect(secondBody.next_cursor).toBeNull();

    const invalid = await service.list(consoleRequest({ query: { limit: 'zero' } }));
    expect(invalid.status).toBe(422);
    const overCap = await service.list(consoleRequest({ query: { limit: '101' } }));
    expect(overCap.status).toBe(422);
  });

  it('updates fields while preserving a stored client secret the caller did not touch', async () => {
    const { service } = fixture();
    const created = bodyOf(await service.create(consoleRequest({ body: oauthBody() })));

    const updated = await service.update(consoleRequest({
      params: { id: created.id as string },
      body: { display_name: 'Renamed CRM' },
    }));

    expect(updated.status).toBe(200);
    expect(bodyOf(updated)).toMatchObject({
      display_name: 'Renamed CRM',
      has_client_secret: true,
      created_at: created.created_at,
    });
    expect(JSON.stringify(bodyOf(updated))).not.toContain(CLIENT_SECRET);
  });

  it('rejects a supplied non-Authorization name for basic injection in the parser (422)', async () => {
    const { service } = fixture();

    const created = await service.create(consoleRequest({
      body: staticKeyBody({
        provider: 'twilio-basic',
        static_api_key: { injection: { location: 'basic', name: 'X-Custom-Auth' } },
      }),
    }));
    expect(created.status).toBe(422);
    expect(bodyOf(created)).toMatchObject({ code: 'invalid_integration_descriptor' });
    expect(String(bodyOf(created).detail)).toContain('Authorization');
  });

  it('maps a concurrent-create unique violation to 409 rather than surfacing a 500', async () => {
    // Two simultaneous creates for the same provider both pass the pre-check
    // under READ COMMITTED; the loser trips the Postgres unique constraint.
    const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
    const store = new InMemoryIntegrationDescriptorStore();
    const racingStore = {
      ...store,
      findVisibleByProvider: () => Promise.resolve(null),
      findById: store.findById.bind(store),
      listVisible: store.listVisible.bind(store),
      listVisiblePage: store.listVisiblePage.bind(store),
      delete: store.delete.bind(store),
      deleteCurated: store.deleteCurated.bind(store),
      upsert: () => Promise.reject(uniqueViolation),
    } as unknown as InMemoryIntegrationDescriptorStore;
    const service = new IntegrationDescriptorAuthoringService({
      descriptorStore: racingStore,
      specStore: new InMemoryIntegrationOpenApiSpecStore(),
      integrationStore: new InMemoryUserIntegrationStore(),
      secretEncryption: encryption(),
      now: () => NOW,
    });

    const result = await service.create(consoleRequest({ body: oauthBody() }));
    expect(result.status).toBe(409);
    expect(bodyOf(result)).toMatchObject({ code: 'integration_descriptor_conflict' });
  });

  it('switches an existing header-injection descriptor to basic, defaulting the header name', async () => {
    const { service } = fixture();
    const created = bodyOf(await service.create(consoleRequest({ body: staticKeyBody() })));

    const switched = await service.update(consoleRequest({
      params: { id: created.id as string },
      body: { static_api_key: { injection: { location: 'basic' } } },
    }));

    expect(switched.status).toBe(200);
    expect(bodyOf(switched)).toMatchObject({
      auth_strategy: 'static_api_key',
      static_api_key: { injection: { location: 'basic', name: 'Authorization', value_prefix: null } },
    });
  });

  it('rejects provider renames and applies explicit secret removal', async () => {
    const { service } = fixture();
    const created = bodyOf(await service.create(consoleRequest({ body: oauthBody() })));

    const renamed = await service.update(consoleRequest({
      params: { id: created.id as string },
      body: { provider: 'other-crm' },
    }));
    expect(renamed.status).toBe(422);

    const oauthWithoutSecret = { ...oauthBody().oauth as Record<string, unknown> };
    delete oauthWithoutSecret.client_secret;
    const removed = await service.update(consoleRequest({
      params: { id: created.id as string },
      body: { oauth: { ...oauthWithoutSecret, client_secret: null } },
    }));
    expect(removed.status).toBe(200);
    expect(bodyOf(removed)).toMatchObject({ has_client_secret: false });
  });

  it('drops the stored secret when switching strategy away from OAuth', async () => {
    const { service } = fixture();
    const created = bodyOf(await service.create(consoleRequest({ body: oauthBody() })));

    const switched = await service.update(consoleRequest({
      params: { id: created.id as string },
      body: {
        auth_strategy: 'static_api_key',
        static_api_key: staticKeyBody().static_api_key,
      },
    }));

    expect(switched.status).toBe(200);
    expect(bodyOf(switched)).toMatchObject({
      auth_strategy: 'static_api_key',
      oauth: null,
      has_client_secret: false,
    });
  });

  it('deletes owned descriptors together with their stored spec, owner-scoped', async () => {
    const { service, specStore } = fixture();
    const created = bodyOf(await service.create(consoleRequest({ body: oauthBody() })));
    const descriptorId = created.id as string;
    await specStore.upsert({
      descriptorId,
      spec: { openapi: '3.1.0', paths: {} },
      sourceUrl: null,
      specHash: 'a'.repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
    });

    const foreign = await service.remove(consoleRequest({
      params: { id: descriptorId },
      consoleAuthentication: authenticatedContext(OTHER_USER_ID),
    }));
    expect(foreign.status).toBe(404);
    await expect(specStore.findByDescriptorId(descriptorId)).resolves.not.toBeNull();

    const removed = await service.remove(consoleRequest({ params: { id: descriptorId } }));
    expect(removed.status).toBe(204);
    expect(removed.body).toBeUndefined();
    await expect(specStore.findByDescriptorId(descriptorId)).resolves.toBeNull();

    const again = await service.remove(consoleRequest({ params: { id: descriptorId } }));
    expect(again.status).toBe(404);
  });
});

describe('IntegrationDescriptorAuthoringService spec management', () => {
  function openApiSpec(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      openapi: '3.1.0',
      servers: [{ url: 'https://api.mycrm.example' }],
      paths: {
        '/contacts': {
          get: {
            operationId: 'listContacts',
            responses: { 200: { description: 'ok' } },
          },
        },
      },
      ...overrides,
    };
  }

  it('ingests a spec for an owned descriptor and returns metadata only', async () => {
    const { service, specStore } = fixture();
    const created = bodyOf(await service.create(consoleRequest({ body: oauthBody() })));
    const descriptorId = created.id as string;

    const result = await service.putSpec(consoleRequest({
      params: { id: descriptorId },
      body: { spec: openApiSpec(), source_url: 'https://api.mycrm.example/openapi.json' },
    }));

    expect(result.status).toBe(200);
    const body = bodyOf(result);
    expect(body).toMatchObject({
      descriptor_id: descriptorId,
      provider: MYCRM,
      source_url: 'https://api.mycrm.example/openapi.json',
      operation_count: 1,
    });
    expect(body.spec_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof body.spec_bytes).toBe('number');
    // Metadata only — the stored document itself is never in the response.
    expect(body.spec).toBeUndefined();
    expect(body.paths).toBeUndefined();

    await expect(specStore.findByDescriptorId(descriptorId)).resolves.toMatchObject({
      descriptorId,
      specHash: body.spec_hash,
    });
  });

  it('rejects specs that fail the shared ingestion validation', async () => {
    const { service } = fixture();
    const created = bodyOf(await service.create(consoleRequest({ body: oauthBody() })));
    const descriptorId = created.id as string;

    const foreignHost = await service.putSpec(consoleRequest({
      params: { id: descriptorId },
      body: { spec: openApiSpec({ servers: [{ url: 'https://evil.example.com' }] }) },
    }));
    expect(foreignHost.status).toBe(400);
    expect(bodyOf(foreignHost)).toMatchObject({ code: 'invalid_openapi_spec' });

    const externalRef = await service.putSpec(consoleRequest({
      params: { id: descriptorId },
      body: {
        spec: openApiSpec({
          components: { schemas: { External: { $ref: 'https://evil.example.com/schema.json#/X' } } },
        }),
      },
    }));
    expect(externalRef.status).toBe(400);

    const notAnObject = await service.putSpec(consoleRequest({
      params: { id: descriptorId },
      body: { spec: 'not-an-object' },
    }));
    expect(notAnObject.status).toBe(422);
  });

  it('scopes spec reads and writes to the descriptor owner', async () => {
    const { service } = fixture();
    const created = bodyOf(await service.create(consoleRequest({ body: oauthBody() })));
    const descriptorId = created.id as string;
    await service.putSpec(consoleRequest({
      params: { id: descriptorId },
      body: { spec: openApiSpec() },
    }));

    const foreignPut = await service.putSpec(consoleRequest({
      params: { id: descriptorId },
      body: { spec: openApiSpec() },
      consoleAuthentication: authenticatedContext(OTHER_USER_ID),
    }));
    expect(foreignPut.status).toBe(404);

    const foreignGet = await service.getSpec(consoleRequest({
      params: { id: descriptorId },
      consoleAuthentication: authenticatedContext(OTHER_USER_ID),
    }));
    expect(foreignGet.status).toBe(404);

    const owned = await service.getSpec(consoleRequest({ params: { id: descriptorId } }));
    expect(owned.status).toBe(200);
    expect(bodyOf(owned)).toMatchObject({ descriptor_id: descriptorId, operation_count: 1 });
  });

  it('distinguishes a missing spec from a missing descriptor', async () => {
    const { service } = fixture();
    const created = bodyOf(await service.create(consoleRequest({ body: oauthBody() })));

    const noSpec = await service.getSpec(consoleRequest({ params: { id: created.id as string } }));
    expect(noSpec.status).toBe(404);
    expect(bodyOf(noSpec)).toMatchObject({ code: 'integration_spec_not_found' });

    const noDescriptor = await service.getSpec(consoleRequest({ params: { id: UNKNOWN_ID } }));
    expect(noDescriptor.status).toBe(404);
    expect(bodyOf(noDescriptor)).toMatchObject({ code: 'integration_descriptor_not_found' });
  });

  it('lists the operations exposed by an owned descriptor spec', async () => {
    const { service } = fixture();
    const created = bodyOf(await service.create(consoleRequest({ body: oauthBody() })));
    const descriptorId = created.id as string;

    const beforeIngest = await service.listSpecOperations(consoleRequest({ params: { id: descriptorId } }));
    expect(beforeIngest.status).toBe(404);
    expect(bodyOf(beforeIngest)).toMatchObject({ code: 'integration_spec_not_found' });

    const putResult = await service.putSpec(consoleRequest({
      params: { id: descriptorId },
      body: { spec: openApiSpec() },
    }));
    const specHash = bodyOf(putResult).spec_hash as string;

    const result = await service.listSpecOperations(consoleRequest({ params: { id: descriptorId } }));
    expect(result.status).toBe(200);
    expect(bodyOf(result)).toEqual({
      descriptor_id: descriptorId,
      spec_hash: specHash,
      operations: [expect.objectContaining({
        operation_id: 'listContacts',
        method: 'GET',
        path: '/contacts',
        read_write_class: 'read',
      })],
    });
  });

  it('scopes spec operation listing to the descriptor owner and 404s an unknown descriptor', async () => {
    const { service } = fixture();
    const created = bodyOf(await service.create(consoleRequest({ body: oauthBody() })));
    const descriptorId = created.id as string;
    await service.putSpec(consoleRequest({
      params: { id: descriptorId },
      body: { spec: openApiSpec() },
    }));

    const foreign = await service.listSpecOperations(consoleRequest({
      params: { id: descriptorId },
      consoleAuthentication: authenticatedContext(OTHER_USER_ID),
    }));
    expect(foreign.status).toBe(404);
    expect(bodyOf(foreign)).toMatchObject({ code: 'integration_descriptor_not_found' });

    const unknown = await service.listSpecOperations(consoleRequest({ params: { id: UNKNOWN_ID } }));
    expect(unknown.status).toBe(404);
  });
});

describe('IntegrationModule per-request provider routes', () => {
  const PUBLIC_BASE_URL = 'https://console.example';
  const PUBLIC_TEST_ADDRESS = [8, 8, 8, 8].join('.');

  function findRoute(
    routes: readonly ConsoleRouteDefinition[],
    path: string,
    method = 'GET',
  ): ConsoleRouteDefinition {
    const route = routes.find(candidate => candidate.path === path && candidate.method === method);
    if (!route) throw new Error(`missing route ${method} ${path}`);
    return route;
  }

  function cookieValue(result: Awaited<ReturnType<ConsoleRouteDefinition['handler']>>, name: string): string | null {
    const cookie = result.cookies?.find(candidate => candidate.operation === 'set' && candidate.name === name);
    return cookie?.operation === 'set' ? cookie.value : null;
  }

  function moduleFixture(fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>) {
    const integrationStore = new InMemoryUserIntegrationStore();
    const descriptorStore = new InMemoryIntegrationDescriptorStore();
    const secretEncryption = encryption();
    const module = createIntegrationModule({
      integrationStore,
      descriptorStore,
      openApiSpecStore: new InMemoryIntegrationOpenApiSpecStore(),
      loginTransactions: new InMemoryLoginTransactionStore(),
      opaqueValues: new HmacConsoleOpaqueValueService(Buffer.alloc(32, 8)),
      secretEncryption,
      publicBaseUrl: PUBLIC_BASE_URL,
      ...(fetchImpl
        ? {
          providerOutbound: {
            pinnedOutbound: () => ({ fetch: fetchImpl, close: () => Promise.resolve() }),
            dnsLookup: () => Promise.resolve([{ address: PUBLIC_TEST_ADDRESS, family: 4 }]),
          },
        }
        : {}),
      now: () => NOW,
    });
    return { module, integrationStore, secretEncryption };
  }

  async function authorDescriptor(module: ReturnType<typeof createIntegrationModule>, body: Record<string, unknown>) {
    const create = findRoute(module.routes, DESCRIPTORS_PATH, 'POST');
    const result = await create.handler(consoleRequest({ body }));
    expect(result.status).toBe(201);
    return bodyOf(result);
  }

  it('connects a runtime-authored BYO static-key descriptor without a restart', async () => {
    const { module, secretEncryption, integrationStore } = moduleFixture();
    await authorDescriptor(module, staticKeyBody());

    const connect = findRoute(module.routes, '/api/v1/me/integrations/:provider/connect', 'POST');
    const connected = await connect.handler(consoleRequest({
      params: { provider: 'airtable' },
      body: { api_key: 'airtable-api-key-secret', account_label: 'Alice Airtable' },
    }));
    expect(connected).toMatchObject({
      status: 200,
      body: { provider: 'airtable', status: 'connected', account_label: 'Alice Airtable' },
    });
    expect(JSON.stringify(connected.body)).not.toContain('airtable-api-key-secret');
    const stored = await integrationStore.findByProvider(USER_ID, 'airtable');
    expect(secretEncryption.decrypt(stored?.accessTokenCiphertext ?? Buffer.alloc(0), integrationSecretContext('access_token', USER_ID, 'airtable')).toString('utf8'))
      .toBe('airtable-api-key-secret');

    const status = findRoute(module.routes, '/api/v1/me/integrations/:provider');
    await expect(status.handler(consoleRequest({ params: { provider: 'airtable' } }))).resolves.toMatchObject({
      status: 200,
      body: { provider: 'airtable', status: 'connected' },
    });

    const disconnect = findRoute(module.routes, '/api/v1/me/integrations/:provider', 'DELETE');
    await expect(disconnect.handler(consoleRequest({ params: { provider: 'airtable' } }))).resolves.toMatchObject({
      status: 200,
      body: { provider: 'airtable', status: 'disconnected' },
    });
  });

  it('runs the full OAuth flow for a runtime-authored BYO descriptor', async () => {
    const fetchCalls: Array<{ url: string }> = [];
    const fetchImpl = (input: string | URL) => {
      fetchCalls.push({ url: String(input) });
      return Promise.resolve(new Response(JSON.stringify({
        access_token: 'mycrm-access-token-secret',
        refresh_token: 'mycrm-refresh-token-secret',
        email: 'alice@example.com',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    };
    const { module, integrationStore, secretEncryption } = moduleFixture(fetchImpl);
    await authorDescriptor(module, oauthBody({
      oauth: {
        ...(oauthBody().oauth as Record<string, unknown>),
        account_label: { field: 'email' },
      },
    }));

    const connect = findRoute(module.routes, '/api/v1/me/integrations/:provider/connect', 'POST');
    const started = await connect.handler(consoleRequest({
      params: { provider: MYCRM },
      body: {},
    }));
    expect(started.status).toBe(200);
    const transactionId = cookieValue(started, CONSOLE_INTEGRATION_STATE_COOKIE);
    const authorizeUrl = new URL(String((started.body as { authorize_url: string }).authorize_url));
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://auth.mycrm.example/authorize');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`${PUBLIC_BASE_URL}/api/v1/me/integrations/${MYCRM}/callback`);
    const state = authorizeUrl.searchParams.get('state');
    if (!transactionId || !state) throw new Error('connect did not start a transaction');

    const callback = findRoute(module.routes, '/api/v1/me/integrations/:provider/callback');
    const result = await callback.handler(consoleRequest({
      params: { provider: MYCRM },
      headers: { cookie: `${CONSOLE_INTEGRATION_STATE_COOKIE}=${encodeURIComponent(transactionId)}` },
      query: { code: 'provider-code', state },
    }));
    expect(result).toMatchObject({ status: 302 });
    expect(fetchCalls[0]?.url).toBe('https://auth.mycrm.example/token');

    const stored = await integrationStore.findByProvider(USER_ID, MYCRM);
    expect(stored?.externalAccountLabel).toBe('alice@example.com');
    expect(secretEncryption.decrypt(stored?.accessTokenCiphertext ?? Buffer.alloc(0), integrationSecretContext('access_token', USER_ID, MYCRM)).toString('utf8'))
      .toBe('mycrm-access-token-secret');
  });

  it('captures Basic username/password credentials for basic-injection descriptors', async () => {
    const { module, integrationStore, secretEncryption } = moduleFixture();
    await authorDescriptor(module, staticKeyBody({
      provider: TWILIO_LIKE,
      static_api_key: { injection: { location: 'basic' } },
    }));

    const connect = findRoute(module.routes, '/api/v1/me/integrations/:provider/connect', 'POST');

    // Missing password and colon-bearing usernames fail closed before storage.
    await expect(connect.handler(consoleRequest({
      params: { provider: TWILIO_LIKE },
      body: { username: 'account-sid' },
    }))).resolves.toMatchObject({ status: 400, body: { code: 'invalid_basic_credential' } });
    await expect(connect.handler(consoleRequest({
      params: { provider: TWILIO_LIKE },
      body: { username: 'account:sid', password: 'secret' },
    }))).resolves.toMatchObject({ status: 400, body: { code: 'invalid_basic_credential' } });

    const connected = await connect.handler(consoleRequest({
      params: { provider: TWILIO_LIKE },
      body: { username: 'account-sid', password: 'auth-token-secret' },
    }));
    expect(connected).toMatchObject({
      status: 200,
      body: { provider: TWILIO_LIKE, status: 'connected', account_label: 'account-sid' },
    });
    expect(JSON.stringify(connected.body)).not.toContain('auth-token-secret');

    const stored = await integrationStore.findByProvider(USER_ID, TWILIO_LIKE);
    expect(secretEncryption.decrypt(
      stored?.accessTokenCiphertext ?? Buffer.alloc(0),
      integrationSecretContext('access_token', USER_ID, TWILIO_LIKE),
    ).toString('utf8')).toBe('account-sid:auth-token-secret');
  });

  it('fails closed for BYO OAuth descriptors without a stored client secret', async () => {
    const { module } = moduleFixture();
    const oauthWithoutSecret = { ...(oauthBody().oauth as Record<string, unknown>) };
    delete oauthWithoutSecret.client_secret;
    await authorDescriptor(module, oauthBody({ oauth: oauthWithoutSecret }));

    const connect = findRoute(module.routes, '/api/v1/me/integrations/:provider/connect', 'POST');
    await expect(connect.handler(consoleRequest({
      params: { provider: MYCRM },
      body: {},
    }))).resolves.toMatchObject({ status: 404 });
  });

  it('refuses reserved, malformed, and unknown provider ids on the parameterized routes', async () => {
    const { module } = moduleFixture();
    const status = findRoute(module.routes, '/api/v1/me/integrations/:provider');

    // The guard path returns synchronously; unknown-but-well-formed ids go
    // through async store resolution. Await both shapes uniformly.
    for (const provider of ['descriptors', 'github', 'NOT-LOWER', 'x', 'unknown-svc']) {
      const result = await status.handler(consoleRequest({ params: { provider } }));
      expect(result).toMatchObject({
        status: 404,
        body: { code: 'integration_provider_not_found' },
      });
    }
  });
});

describe('IntegrationTokenRefreshService per-request resolution', () => {
  it('refreshes through a store-resolved provider absent from the boot registry', async () => {
    const secretEncryption = encryption();
    const descriptorStore = new InMemoryIntegrationDescriptorStore();
    const integrationStore = new InMemoryUserIntegrationStore();
    const authoring = new IntegrationDescriptorAuthoringService({
      descriptorStore,
      specStore: new InMemoryIntegrationOpenApiSpecStore(),
      integrationStore,
      secretEncryption,
      now: () => NOW,
    });
    const created = bodyOf(await authoring.create(consoleRequest({ body: oauthBody() })));
    expect(created.provider).toBe(MYCRM);

    integrationStore.set({
      id: '35e22a52-dc56-4cd0-9d13-b2802524fbd3',
      userId: USER_ID,
      provider: MYCRM,
      integrationDescriptorId: created.id as string,
      externalAccountLabel: 'alice',
      externalInstallationId: null,
      authorizedPermissions: { scopes: ['crm.read'] },
      accessTokenCiphertext: secretEncryption.encrypt(Buffer.from('stale-access', 'utf8'), integrationSecretContext('access_token', USER_ID, MYCRM)),
      refreshTokenCiphertext: secretEncryption.encrypt(Buffer.from('mycrm-refresh-token', 'utf8'), integrationSecretContext('refresh_token', USER_ID, MYCRM)),
      credentialKeyVersion: null,
      status: 'connected',
      errorReason: null,
      connectedAt: NOW,
      lastSyncAt: null,
      revokedAt: null,
    });
    const record = await integrationStore.findByProvider(USER_ID, MYCRM);
    if (!record?.accessTokenCiphertext) throw new Error('fixture integration missing');

    const refresh = new IntegrationTokenRefreshService({
      store: integrationStore,
      providers: new IntegrationProviderRegistry([]),
      resolveProvider: createStoreIntegrationProviderResolver({
        descriptorStore,
        secretEncryption,
        outbound: {
          pinnedOutbound: () => ({
            fetch: () => Promise.resolve(new Response(JSON.stringify({
              access_token: 'fresh-access-token',
              refresh_token: 'fresh-refresh-token',
            }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
            close: () => Promise.resolve(),
          }),
          dnsLookup: () => Promise.resolve([{ address: [8, 8, 8, 8].join('.'), family: 4 }]),
        },
      }),
      secretEncryption,
      now: () => NOW,
    });

    const result = await refresh.refreshOnDemand({
      userId: USER_ID,
      provider: MYCRM,
      integrationDescriptorId: created.id as string,
      staleAccessTokenCiphertext: record.accessTokenCiphertext,
    });

    expect(result.kind).toBe('refreshed');
    if (result.kind !== 'refreshed') throw new Error('expected refreshed result');
    expect(secretEncryption.decrypt(
      result.record.accessTokenCiphertext ?? Buffer.alloc(0),
      integrationSecretContext('access_token', USER_ID, MYCRM),
    ).toString('utf8')).toBe('fresh-access-token');
  });
});

describe('IntegrationModule descriptor routes', () => {
  it('registers the authoring routes only when both descriptor and spec stores are present', () => {
    const withStores = createIntegrationModule({
      integrationStore: new InMemoryUserIntegrationStore(),
      descriptorStore: new InMemoryIntegrationDescriptorStore(),
      openApiSpecStore: new InMemoryIntegrationOpenApiSpecStore(),
    });
    const authoringRoutes = withStores.routes
      .filter(route => route.path.startsWith(DESCRIPTORS_PATH))
      .map(route => `${route.method} ${route.path}`);
    expect(authoringRoutes.sort((a, b) => a.localeCompare(b))).toEqual([
      `DELETE ${DESCRIPTORS_PATH}/:id`,
      `GET ${DESCRIPTORS_PATH}`,
      `GET ${DESCRIPTORS_PATH}/:id`,
      `GET ${DESCRIPTORS_PATH}/:id/spec`,
      `GET ${DESCRIPTORS_PATH}/:id/spec/operations`,
      `PATCH ${DESCRIPTORS_PATH}/:id`,
      `POST ${DESCRIPTORS_PATH}`,
      `PUT ${DESCRIPTORS_PATH}/:id/spec`,
    ]);

    const withoutStores = createIntegrationModule({
      integrationStore: new InMemoryUserIntegrationStore(),
    });
    expect(withoutStores.routes.some(route => route.path.startsWith(DESCRIPTORS_PATH))).toBe(false);
  });

  it('registers every parameterized :provider route after all literal routes', () => {
    const module = createIntegrationModule({
      integrationStore: new InMemoryUserIntegrationStore(),
      descriptorStore: new InMemoryIntegrationDescriptorStore(),
      openApiSpecStore: new InMemoryIntegrationOpenApiSpecStore(),
      secretEncryption: encryption(),
    });
    const paths = module.routes.map(route => route.path);
    // A first-match router depends on literals (github, descriptors) preceding
    // the :provider fallback — otherwise the fallback's reserved-id guard would
    // shadow them (404) and silently break GitHub/descriptor routes.
    const firstParamIndex = paths.findIndex(path => path.includes('/:provider'));
    const lastLiteralIndex = Math.max(
      ...paths.map((path, index) => (path.includes('/:provider') ? -1 : index)),
    );
    expect(firstParamIndex).toBeGreaterThan(-1);
    expect(firstParamIndex).toBeGreaterThan(lastLiteralIndex);
  });
});
