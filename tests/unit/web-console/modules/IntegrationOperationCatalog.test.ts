import { describe, expect, it } from '@jest/globals';

import { ContextTracker } from '../../../../src/security/encryption/ContextTracker.js';
import {
  InMemoryIntegrationDescriptorStore,
  InMemoryIntegrationOpenApiSpecStore,
  InMemoryPortfolioElementStore,
  InMemoryUserIntegrationStore,
  type IntegrationDescriptorRecord,
  type UserIntegrationRecord,
} from '../../../../src/web-console/stores/index.js';
import {
  IntegrationOperationCatalog,
  type IntegrationOperationCatalogError,
} from '../../../../src/web-console/modules/integrations/IntegrationOperationCatalog.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const DESCRIPTOR_ID = '00000000-0000-4000-8000-000000000002';
const INTEGRATION_ID = '00000000-0000-4000-8000-000000000003';
const SPEC_ID = '00000000-0000-4000-8000-000000000004';
const SPEC_HASH = 'a'.repeat(64);
const GMAIL_READONLY = 'gmail.readonly';
const GMAIL_SEND = 'gmail.send';
const GENERATED_SKILL_NAME = 'using-gmail-integration';
const TIMESTAMP = '2026-06-18T00:00:00Z';

describe('IntegrationOperationCatalog', () => {
  it('derives scope-aware operation availability from the stored OpenAPI spec', async () => {
    const { catalog, contextTracker } = createCatalog({ scopes: [GMAIL_READONLY] });

    const result = await runAsUser(contextTracker, () => catalog.listOperations({
      provider: 'gmail',
      includeUnavailable: true,
      includeSkill: true,
    }));

    expect(result).toMatchObject({
      provider: 'gmail',
      descriptorId: DESCRIPTOR_ID,
      specHash: SPEC_HASH,
      scopeAvailability: {
        enforcement: 'advisory_upstream_oauth_token',
      },
    });
    expect(result.operations.map(operation => ({
      id: operation.operationId,
      available: operation.available,
      requiredScopes: operation.requiredScopes,
    }))).toEqual([
      { id: 'listMessages', available: true, requiredScopes: [GMAIL_READONLY] },
      { id: 'sendMessage', available: false, requiredScopes: [GMAIL_SEND] },
      { id: 'getProfile', available: true, requiredScopes: [] },
    ]);
    expect(result.generatedSkill).toMatchObject({
      name: GENERATED_SKILL_NAME,
      regeneration: {
        source: 'openapi_spec',
        specHash: SPEC_HASH,
        scopeFingerprint: GMAIL_READONLY,
      },
    });
    expect(result.generatedSkill?.byteLength).toBeLessThanOrEqual(12 * 1024);
    expect(result.generatedSkill?.content).toContain('All calls go through integration_request');
    expect(result.generatedSkill?.content).toContain('upstream API enforces OAuth scopes');
    expect(result.generatedSkill?.content).not.toContain('sendMessage');
  });

  it('filters unavailable operations by default', async () => {
    const { catalog, contextTracker } = createCatalog({ scopes: [GMAIL_READONLY] });

    const result = await runAsUser(contextTracker, () => catalog.listOperations({ provider: 'gmail' }));

    expect(result.operations.map(operation => operation.operationId)).toEqual(['listMessages', 'getProfile']);
  });

  it('lists only allowlisted available promoted operations for the current session', async () => {
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({
        operationPromotion: { operations: ['listMessages', 'sendMessage'] },
      }),
      scopes: [GMAIL_READONLY],
    });

    const result = await runAsUser(contextTracker, () => catalog.listPromotedOperations());

    expect(result.map(operation => operation.operationId)).toEqual(['listMessages']);
    expect(result[0]).toMatchObject({
      gatewayRequest: {
        provider: 'gmail',
        method: 'GET',
        pathTemplate: '/gmail/v1/users/{userId}/messages',
      },
      specContract: {
        descriptorId: DESCRIPTOR_ID,
        specHash: SPEC_HASH,
      },
      scopeAvailability: {
        enforcement: 'advisory_upstream_oauth_token',
      },
    });
  });

  it('treats OpenAPI security requirements as alternatives', async () => {
    const { catalog, contextTracker } = createCatalog({ scopes: ['gmail.metadata'] });

    const result = await runAsUser(contextTracker, () => catalog.listOperations({
      provider: 'gmail',
      includeUnavailable: true,
    }));

    expect(result.operations.find(operation => operation.operationId === 'listMessages')).toMatchObject({
      available: true,
      requiredScopes: ['gmail.metadata'],
    });
  });

  it('describes an operation with gateway request metadata and spec contract', async () => {
    const { catalog, contextTracker } = createCatalog({ scopes: [GMAIL_READONLY] });

    const result = await runAsUser(contextTracker, () => catalog.describeOperation({
      provider: 'gmail',
      operationId: 'sendMessage',
    }));

    expect(result).toMatchObject({
      operationId: 'sendMessage',
      method: 'POST',
      path: '/gmail/v1/users/{userId}/messages',
      readWriteClass: 'write',
      available: false,
      unavailableReason: 'missing_required_scope',
      requestBody: {
        required: true,
        contentTypes: ['application/json'],
      },
      gatewayRequest: {
        tool: 'integration_request',
        provider: 'gmail',
        method: 'POST',
        pathTemplate: '/gmail/v1/users/{userId}/messages',
      },
      specContract: {
        descriptorId: DESCRIPTOR_ID,
        specHash: SPEC_HASH,
      },
      scopeAvailability: {
        enforcement: 'advisory_upstream_oauth_token',
      },
    });
    expect(result.parameters).toEqual([
      expect.objectContaining({ name: 'userId', in: 'path', required: true }),
    ]);
    expect(result.responses).toEqual([
      expect.objectContaining({ status: '200', contentTypes: ['application/json'] }),
    ]);
  });

  it('resolves local OpenAPI refs for parameters, request bodies, and responses', async () => {
    const { catalog, contextTracker } = createCatalog({
      scopes: [GMAIL_SEND],
      spec: {
        ...openApiSpec(),
        components: {
          parameters: {
            UserId: {
              name: 'userId',
              in: 'path',
              required: true,
              description: 'User id',
              schema: { type: 'string' },
            },
          },
          requestBodies: {
            MessageBody: {
              required: true,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Message' } } },
            },
          },
          responses: {
            Message: {
              description: 'Message response',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
          schemas: {
            Message: { type: 'object' },
          },
        },
        paths: {
          '/gmail/v1/users/{userId}/messages': {
            parameters: [{ $ref: '#/components/parameters/UserId' }],
            post: {
              operationId: 'sendMessage',
              security: [{ oauth: [GMAIL_SEND] }],
              requestBody: { $ref: '#/components/requestBodies/MessageBody' },
              responses: {
                200: { $ref: '#/components/responses/Message' },
              },
            },
          },
        },
      },
    });

    const result = await runAsUser(contextTracker, () => catalog.describeOperation({
      provider: 'gmail',
      operationId: 'sendMessage',
    }));

    expect(result.parameters).toEqual([
      expect.objectContaining({
        name: 'userId',
        in: 'path',
        required: true,
        description: 'User id',
      }),
    ]);
    expect(result.requestBody).toEqual({
      required: true,
      contentTypes: ['application/json'],
    });
    expect(result.responses).toEqual([
      {
        status: '200',
        description: 'Message response',
        contentTypes: ['application/json'],
      },
    ]);
  });

  it('fails closed without an authenticated session', async () => {
    const { catalog } = createCatalog({ scopes: [GMAIL_READONLY] });

    await expect(catalog.listOperations({ provider: 'gmail' })).rejects.toMatchObject({
      code: 'integration_operation_session_required',
      status: 401,
    } satisfies Partial<IntegrationOperationCatalogError>);
  });

  it('ingests, normalizes, stores, and hashes a BYO OpenAPI spec', async () => {
    const { catalog, contextTracker, specStore } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
    });

    const result = await runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        ...openApiSpec(),
        paths: {
          '/gmail/v1/users/me/profile': {
            get: { operationId: 'duplicate', responses: { 200: { description: 'ok' } } },
            post: { operationId: 'duplicate', responses: { 200: { description: 'ok' } } },
            trace: { operationId: 'ignoredTrace', responses: { 200: { description: 'ok' } } },
          },
        },
      },
      sourceUrl: 'https://gmail.googleapis.com/openapi.json',
    }));

    expect(result).toMatchObject({
      provider: 'gmail',
      descriptorId: DESCRIPTOR_ID,
      operationCount: 2,
      specHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const stored = await specStore.findByDescriptorId(DESCRIPTOR_ID);
    const paths = stored?.spec.paths as Record<string, Record<string, { operationId: string }>>;
    const pathItem = paths['/gmail/v1/users/me/profile'];
    expect(Object.keys(pathItem).sort()).toEqual(['get', 'post']);
    expect(pathItem.get.operationId).toBe('duplicate');
    expect(pathItem.post.operationId).toBe('duplicate_2');
  });

  it('rejects curated spec ingestion through the self-service path', async () => {
    const { catalog, contextTracker } = createCatalog({ scopes: [GMAIL_READONLY] });

    await expect(runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: openApiSpec(),
    }))).rejects.toMatchObject({
      code: 'integration_openapi_ingest_forbidden',
      status: 403,
    });
  });

  it('rejects non-local refs and server hosts outside descriptor apiHosts', async () => {
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
    });

    await expect(runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        ...openApiSpec(),
        components: { schemas: { External: { $ref: 'schemas.yaml#/External' } } },
      },
    }))).rejects.toMatchObject({ code: 'invalid_openapi_spec' });

    await expect(runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        ...openApiSpec(),
        servers: [{ url: 'https://evil.example.com' }],
      },
    }))).rejects.toMatchObject({ code: 'invalid_openapi_spec' });
  });

  it('regenerates skill helpers while preserving user edits as a new revision', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore([{
      userId: USER_ID,
      type: 'skills',
      name: GENERATED_SKILL_NAME,
      canonicalName: GENERATED_SKILL_NAME,
      displayName: 'User edited Gmail helper',
      version: 1,
      updatedAt: new Date('2026-06-17T00:00:00Z'),
      validationStatus: 'valid',
      tags: [],
      metadata: { name: GENERATED_SKILL_NAME, source: 'user' },
      content: 'my custom instructions',
    }]);
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
      portfolioStore,
    });

    const result = await runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: openApiSpec(),
      regenerateSkill: true,
    }));

    expect(result.generatedSkill).toMatchObject({
      written: true,
      portfolioAction: 'created_revision',
      portfolioName: `using-gmail-integration-${result.specHash.slice(0, 8)}`,
    });
    await expect(portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME))
      .resolves.toMatchObject({ content: 'my custom instructions' });
    await expect(portfolioStore.findByName(USER_ID, 'skills', result.generatedSkill?.portfolioName ?? ''))
      .resolves.toMatchObject({
        metadata: expect.objectContaining({ source: 'integration_openapi_spec' }),
        tags: expect.arrayContaining(['integration-generated', 'integration:gmail']),
      });
  });

  it('regenerates the stored-spec skill after granted scopes change', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore();
    const { catalog, contextTracker } = createCatalog({
      scopes: [GMAIL_READONLY, GMAIL_SEND],
      portfolioStore,
    });

    const result = await runAsUser(contextTracker, () => catalog.regenerateSkill({ provider: 'gmail' }));

    expect(result).toMatchObject({
      written: true,
      portfolioAction: 'created',
      portfolioName: GENERATED_SKILL_NAME,
      regeneration: {
        scopeFingerprint: 'gmail.readonly gmail.send',
      },
    });
    await expect(portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME))
      .resolves.toMatchObject({
        content: expect.stringContaining('sendMessage'),
      });
  });
});

function createCatalog(options: {
  readonly scopes: readonly string[];
  readonly descriptor?: IntegrationDescriptorRecord;
  readonly portfolioStore?: InMemoryPortfolioElementStore;
  readonly spec?: Readonly<Record<string, unknown>>;
}) {
  const contextTracker = new ContextTracker();
  const descriptorStore = new InMemoryIntegrationDescriptorStore([options.descriptor ?? descriptor()]);
  const specStore = new InMemoryIntegrationOpenApiSpecStore([{
    id: SPEC_ID,
    descriptorId: DESCRIPTOR_ID,
    spec: options.spec ?? openApiSpec(),
    sourceUrl: 'https://gmail.googleapis.com/openapi.json',
    specHash: SPEC_HASH,
    createdAt: new Date(TIMESTAMP),
    updatedAt: new Date(TIMESTAMP),
  }]);
  const integrationStore = new InMemoryUserIntegrationStore([integration(options.scopes)]);
  return {
    contextTracker,
    catalog: new IntegrationOperationCatalog({
      descriptorStore,
      specStore,
      integrationStore,
      contextTracker,
      portfolioStore: options.portfolioStore ?? new InMemoryPortfolioElementStore(),
      now: () => new Date(TIMESTAMP),
    }),
    specStore,
  };
}

function descriptor(overrides: Partial<IntegrationDescriptorRecord> = {}): IntegrationDescriptorRecord {
  return {
    id: DESCRIPTOR_ID,
    provider: 'gmail',
    ownership: 'curated',
    ownerUserId: null,
    displayName: 'Gmail',
    category: 'email',
    authStrategy: 'oauth2_authorization_code',
    apiHosts: ['gmail.googleapis.com'],
    oauth: {
      clientId: 'gmail-client',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: [GMAIL_READONLY, GMAIL_SEND],
      pkce: 'required',
      refresh: 'rotating',
      tokenExchange: {},
      accountLabel: {},
    },
    staticApiKey: null,
    clientSecretCiphertext: Buffer.from('encrypted-client-secret'),
    credentialKeyVersion: 'v1',
    operationPromotion: {},
    createdAt: new Date(TIMESTAMP),
    updatedAt: new Date(TIMESTAMP),
    ...overrides,
  };
}

function integration(scopes: readonly string[]): UserIntegrationRecord {
  return {
    id: INTEGRATION_ID,
    userId: USER_ID,
    provider: 'gmail',
    externalAccountLabel: 'alice@example.com',
    externalInstallationId: null,
    authorizedPermissions: { scopes },
    accessTokenCiphertext: Buffer.from('encrypted-access-token'),
    refreshTokenCiphertext: Buffer.from('encrypted-refresh-token'),
    credentialKeyVersion: 'v1',
    status: 'connected',
    errorReason: null,
    connectedAt: new Date(TIMESTAMP),
    lastSyncAt: null,
    revokedAt: null,
  };
}

function openApiSpec(): Readonly<Record<string, unknown>> {
  return {
    openapi: '3.1.0',
    info: { title: 'Gmail fixture', version: '1.0.0' },
    security: [{ oauth: [GMAIL_READONLY] }],
    paths: {
      '/gmail/v1/users/{userId}/messages': {
        parameters: [{
          name: 'userId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        }],
        get: {
          operationId: 'listMessages',
          summary: 'List messages',
          security: [
            { oauth: [GMAIL_READONLY] },
            { oauth: ['gmail.metadata'] },
          ],
          responses: {
            200: {
              description: 'Message list',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
        post: {
          operationId: 'sendMessage',
          summary: 'Send a message',
          security: [{ oauth: [GMAIL_SEND] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            200: {
              description: 'Sent message',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/gmail/v1/users/me/profile': {
        get: {
          operationId: 'getProfile',
          summary: 'Get profile',
          security: [],
          responses: { 200: { description: 'Profile' } },
        },
      },
    },
  };
}

function runAsUser<T>(contextTracker: ContextTracker, fn: () => Promise<T>): Promise<T> {
  return contextTracker.runAsync({
    type: 'test',
    requestId: 'req-1',
    timestamp: Date.now(),
    session: {
      userId: USER_ID,
      sessionId: 'session-1',
      tenantId: null,
      transport: 'http',
      createdAt: Date.now(),
      roles: [],
    },
  }, fn);
}
