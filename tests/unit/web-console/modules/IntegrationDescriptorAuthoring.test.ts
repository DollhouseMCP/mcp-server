import { describe, expect, it } from '@jest/globals';

import {
  AeadSecretEncryptionService,
  createIntegrationModule,
  InMemoryIntegrationDescriptorStore,
  InMemoryIntegrationOpenApiSpecStore,
  InMemoryUserIntegrationStore,
  type ConsoleRequest,
  type IntegrationDescriptorRecord,
} from '../../../../src/web-console/index.js';
import { IntegrationDescriptorAuthoringService } from '../../../../src/web-console/modules/integrations/IntegrationDescriptorAuthoringService.js';
import { integrationDescriptorClientSecretContext } from '../../../../src/web-console/modules/integrations/IntegrationSecretContext.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const OTHER_USER_ID = '118f3d47-73ae-7f10-a0de-0742618d4fb2';
const UNKNOWN_ID = '00000000-0000-4000-8000-0000000000aa';
const NOW = new Date('2026-07-02T10:00:00.000Z');
const PRIMARY_SUB = 'github_user-7';
const SELF_CAPABILITY = 'console:self';
const MYCRM = 'mycrm';
const CLIENT_SECRET = 'super-secret-client-credential';
const DESCRIPTORS_PATH = '/api/v1/me/integrations/descriptors';

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
} = {}) {
  const descriptorStore = new InMemoryIntegrationDescriptorStore(options.descriptors ?? []);
  const specStore = new InMemoryIntegrationOpenApiSpecStore();
  const secretEncryption = options.withEncryption === false ? null : encryption();
  const service = new IntegrationDescriptorAuthoringService({
    descriptorStore,
    specStore,
    secretEncryption,
    now: () => NOW,
  });
  return { service, descriptorStore, specStore, secretEncryption };
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

  it('rejects provider ids colliding with any visible descriptor', async () => {
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

  it('fails closed when a client secret is supplied without encryption configured', async () => {
    const { service, descriptorStore } = fixture({ withEncryption: false });

    const result = await service.create(consoleRequest({ body: oauthBody() }));

    expect(result.status).toBe(503);
    await expect(descriptorStore.listVisible(USER_ID)).resolves.toHaveLength(0);
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
      `PATCH ${DESCRIPTORS_PATH}/:id`,
      `POST ${DESCRIPTORS_PATH}`,
      `PUT ${DESCRIPTORS_PATH}/:id/spec`,
    ]);

    const withoutStores = createIntegrationModule({
      integrationStore: new InMemoryUserIntegrationStore(),
    });
    expect(withoutStores.routes.some(route => route.path.startsWith(DESCRIPTORS_PATH))).toBe(false);
  });
});
