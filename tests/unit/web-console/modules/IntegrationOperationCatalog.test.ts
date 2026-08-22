import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { ContextTracker } from '../../../../src/security/encryption/ContextTracker.js';
import {
  InMemoryIntegrationDescriptorStore,
  InMemoryIntegrationOpenApiSpecStore,
  InMemoryPortfolioElementStore,
  InMemoryUserIntegrationStore,
  ManagerBackedPortfolioElementStore,
  type IntegrationDescriptorRecord,
  type IPortfolioElementStore,
  type UserIntegrationRecord,
} from '../../../../src/web-console/stores/index.js';
import {
  IntegrationOperationCatalog,
  type IntegrationOperationCatalogError,
} from '../../../../src/web-console/modules/integrations/IntegrationOperationCatalog.js';
import { createRealManagerSuite } from '../../../helpers/di-mocks.js';

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

  it('blocks operation discovery after a curated provider is durably disabled', async () => {
    const { catalog, contextTracker, descriptorStore } = createCatalog({ scopes: [GMAIL_READONLY] });
    await descriptorStore.reconcileCuratedSeed({
      provider: 'gmail',
      seedRevision: 1,
      enabled: false,
      updatedAt: new Date(TIMESTAMP),
    });

    await expect(runAsUser(contextTracker, () => catalog.listOperations({
      provider: 'gmail',
      includeUnavailable: true,
    }))).rejects.toMatchObject({
      code: 'integration_operation_provider_not_found',
      status: 404,
    });
    await expect(runAsUser(contextTracker, () => catalog.listPromotedOperations({ provider: 'gmail' })))
      .resolves.toEqual([]);
  });

  it('truncates generated skill content to the UTF-8 byte ceiling without splitting code points', async () => {
    const spec = openApiSpec();
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const profile = paths['/gmail/v1/users/me/profile'];
    const { catalog, contextTracker } = createCatalog({
      scopes: [GMAIL_READONLY],
      spec: {
        ...spec,
        paths: {
          ...paths,
          '/gmail/v1/users/me/profile': {
            ...profile,
            get: { ...profile?.get, summary: '🧠'.repeat(8_000) },
          },
        },
      },
    });

    const result = await runAsUser(contextTracker, () => catalog.listOperations({
      provider: 'gmail',
      includeSkill: true,
    }));

    expect(result.generatedSkill?.truncated).toBe(true);
    expect(result.generatedSkill?.byteLength).toBeLessThanOrEqual(12 * 1024);
    expect(result.generatedSkill?.content).not.toContain('\uFFFD');
    expect(result.generatedSkill?.content.endsWith(
      '[Truncated. Use list_operations and describe_operation for details.]',
    )).toBe(true);
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

  it('does not treat an unsupported API-key requirement as an empty-scope OAuth alternative', async () => {
    const spec = openApiSpec();
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const securedPath = paths['/gmail/v1/users/{userId}/messages'];
    const get = securedPath?.get;
    const catalogFixture = createCatalog({
      scopes: [GMAIL_READONLY],
      spec: {
        ...spec,
        components: {
          securitySchemes: {
            oauth: { type: 'oauth2', flows: {} },
            apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
          },
        },
        paths: {
          ...paths,
          '/gmail/v1/users/{userId}/messages': {
            ...securedPath,
            get: { ...get, security: [{ apiKey: [] }] },
          },
        },
      },
    });

    const result = await runAsUser(catalogFixture.contextTracker, () => catalogFixture.catalog.listOperations({
      provider: 'gmail',
      includeUnavailable: true,
    }));

    expect(result.operations.find(operation => operation.operationId === 'listMessages')).toMatchObject({
      available: false,
      requiredScopes: [],
      unavailableReason: 'unsupported_security_scheme',
    });
  });

  it('does not advertise an operation whose security requirement needs multiple credentials', async () => {
    const spec = openApiSpec();
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const securedPath = paths['/gmail/v1/users/{userId}/messages'];
    const fixture = createCatalog({
      scopes: [GMAIL_READONLY],
      spec: {
        ...spec,
        components: {
          securitySchemes: {
            oauth: { type: 'oauth2', flows: {} },
            apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
          },
        },
        paths: {
          ...paths,
          '/gmail/v1/users/{userId}/messages': {
            ...securedPath,
            get: {
              ...securedPath?.get,
              security: [{ oauth: [GMAIL_READONLY], apiKey: [] }],
            },
          },
        },
      },
    });

    const result = await runAsUser(fixture.contextTracker, () => fixture.catalog.listOperations({
      provider: 'gmail',
      includeUnavailable: true,
    }));

    expect(result.operations.find(operation => operation.operationId === 'listMessages'))
      .toMatchObject({ available: false, unavailableReason: 'unsupported_security_scheme' });
  });

  it('rejects malformed non-object OpenAPI security requirements instead of treating them as anonymous', async () => {
    const spec = openApiSpec();
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const securedPath = paths['/gmail/v1/users/{userId}/messages'];
    const fixture = createCatalog({
      scopes: [GMAIL_READONLY],
      spec: {
        ...spec,
        paths: {
          ...paths,
          '/gmail/v1/users/{userId}/messages': {
            ...securedPath,
            get: { ...securedPath?.get, security: [null] },
          },
        },
      },
    });

    await expect(runAsUser(fixture.contextTracker, () => fixture.catalog.listOperations({
      provider: 'gmail',
      includeUnavailable: true,
    }))).rejects.toMatchObject({ code: 'invalid_openapi_spec', status: 400 });
  });

  it.each([
    ['non-array root security', { rootSecurity: { oauth: [GMAIL_READONLY] } }],
    ['non-array operation security', { operationSecurity: { oauth: [GMAIL_READONLY] } }],
    ['non-array scope declaration', { operationSecurity: [{ oauth: GMAIL_READONLY }] }],
    ['non-string scope declaration', { operationSecurity: [{ oauth: [GMAIL_READONLY, 7] }] }],
  ] as const)('rejects %s instead of weakening authentication', async (_label, malformed) => {
    const spec = openApiSpec();
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const securedPath = paths['/gmail/v1/users/{userId}/messages'];
    const fixture = createCatalog({
      scopes: [GMAIL_READONLY],
      spec: {
        ...spec,
        ...(malformed.rootSecurity === undefined ? {} : { security: malformed.rootSecurity }),
        paths: {
          ...paths,
          '/gmail/v1/users/{userId}/messages': {
            ...securedPath,
            get: {
              ...securedPath?.get,
              ...(malformed.operationSecurity === undefined
                ? {}
                : { security: malformed.operationSecurity }),
            },
          },
        },
      },
    });

    await expect(runAsUser(fixture.contextTracker, () => fixture.catalog.listOperations({
      provider: 'gmail',
      includeUnavailable: true,
    }))).rejects.toMatchObject({ code: 'invalid_openapi_spec', status: 400 });
  });

  it('marks an explicit empty security alternative as anonymous', async () => {
    const spec = openApiSpec();
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const securedPath = paths['/gmail/v1/users/{userId}/messages'];
    const fixture = createCatalog({
      scopes: [GMAIL_READONLY],
      spec: {
        ...spec,
        paths: {
          ...paths,
          '/gmail/v1/users/{userId}/messages': {
            ...securedPath,
            get: { ...securedPath?.get, security: [{}] },
          },
        },
      },
    });
    const result = await runAsUser(fixture.contextTracker, () => fixture.catalog.listOperations({
      provider: 'gmail',
      includeUnavailable: true,
    }));

    expect(result.operations.find(operation => operation.operationId === 'listMessages'))
      .toMatchObject({ available: true, authMode: 'anonymous' });
  });

  it('prefers an explicit anonymous alternative over an equivalent credentialed alternative', async () => {
    const spec = openApiSpec();
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const securedPath = paths['/gmail/v1/users/{userId}/messages'];
    const fixture = createCatalog({
      scopes: [GMAIL_READONLY],
      spec: {
        ...spec,
        paths: {
          ...paths,
          '/gmail/v1/users/{userId}/messages': {
            ...securedPath,
            get: { ...securedPath?.get, security: [{ oauth: [] }, {}] },
          },
        },
      },
    });

    const result = await runAsUser(fixture.contextTracker, () => fixture.catalog.listOperations({
      provider: 'gmail',
      includeUnavailable: true,
    }));

    expect(result.operations.find(operation => operation.operationId === 'listMessages'))
      .toMatchObject({ available: true, requiredScopes: [], authMode: 'anonymous' });
  });

  it('does not let a prototype-shaped security scheme collapse into an anonymous alternative', async () => {
    const spec = openApiSpec();
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const securedPath = paths['/gmail/v1/users/{userId}/messages'];
    const requirement = Object.fromEntries([['__proto__', []]]);
    const fixture = createCatalog({
      scopes: [GMAIL_READONLY],
      spec: {
        ...spec,
        paths: {
          ...paths,
          '/gmail/v1/users/{userId}/messages': {
            ...securedPath,
            get: { ...securedPath?.get, security: [requirement] },
          },
        },
      },
    });

    const result = await runAsUser(fixture.contextTracker, () => fixture.catalog.listOperations({
      provider: 'gmail',
      includeUnavailable: true,
    }));

    expect(result.operations.find(operation => operation.operationId === 'listMessages'))
      .toMatchObject({ available: false, authMode: 'credentialed', unavailableReason: 'unsupported_security_scheme' });
  });

  it('does not case-fold query API-key names', async () => {
    const spec = openApiSpec();
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const securedPath = paths['/gmail/v1/users/{userId}/messages'];
    const fixture = createCatalog({
      scopes: [],
      descriptor: descriptor({
        authStrategy: 'static_api_key',
        oauth: null,
        staticApiKey: { injection: { location: 'query', name: 'api_key', valuePrefix: null } },
      }),
      spec: {
        ...spec,
        components: { securitySchemes: { key: { type: 'apiKey', in: 'query', name: 'API_KEY' } } },
        paths: {
          ...paths,
          '/gmail/v1/users/{userId}/messages': {
            ...securedPath,
            get: { ...securedPath?.get, security: [{ key: [] }] },
          },
        },
      },
    });
    const result = await runAsUser(fixture.contextTracker, () => fixture.catalog.listOperations({
      provider: 'gmail',
      includeUnavailable: true,
    }));

    expect(result.operations.find(operation => operation.operationId === 'listMessages'))
      .toMatchObject({ available: false, unavailableReason: 'unsupported_security_scheme' });
  });

  it('does not promote request bodies the gateway cannot serialize', async () => {
    const spec = openApiSpec();
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const securedPath = paths['/gmail/v1/users/{userId}/messages'];
    const fixture = createCatalog({
      scopes: [GMAIL_READONLY],
      spec: {
        ...spec,
        paths: {
          ...paths,
          '/gmail/v1/users/{userId}/messages': {
            ...securedPath,
            post: {
              operationId: 'uploadRaw',
              security: [{}],
              requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } },
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      },
    });
    const result = await runAsUser(fixture.contextTracker, () => fixture.catalog.listOperations({
      provider: 'gmail',
      includeUnavailable: true,
    }));

    expect(result.operations.find(operation => operation.operationId === 'uploadRaw'))
      .toMatchObject({ available: false, unavailableReason: 'unsupported_request_content_type' });
  });

  it('marks header, cookie, and DELETE-body operations unavailable to promoted tools', async () => {
    const spec = openApiSpec();
    const fixture = createCatalog({
      scopes: [GMAIL_READONLY],
      spec: {
        ...spec,
        paths: {
          '/header': {
            get: {
              operationId: 'requiresHeader',
              security: [{}],
              parameters: [{ name: 'X-Request-Id', in: 'header', required: true }],
              responses: { '200': { description: 'ok' } },
            },
          },
          '/cookie': {
            get: {
              operationId: 'requiresCookie',
              security: [{}],
              parameters: [{ name: 'session', in: 'cookie', required: true }],
              responses: { '200': { description: 'ok' } },
            },
          },
          '/delete-body': {
            delete: {
              operationId: 'deleteWithBody',
              security: [{}],
              requestBody: {
                required: true,
                content: { 'application/json': { schema: { type: 'object' } } },
              },
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      },
    });

    const result = await runAsUser(fixture.contextTracker, () => fixture.catalog.listOperations({
      provider: 'gmail',
      includeUnavailable: true,
    }));

    expect(result.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'requiresHeader', available: false, unavailableReason: 'unsupported_parameter_location' }),
      expect.objectContaining({ operationId: 'requiresCookie', available: false, unavailableReason: 'unsupported_parameter_location' }),
      expect.objectContaining({ operationId: 'deleteWithBody', available: false, unavailableReason: 'unsupported_request_method_body' }),
    ]));
  });

  it('does not advertise parameters whose OpenAPI serialization the gateway cannot reproduce', async () => {
    const fixture = createCatalog({
      scopes: [],
      spec: {
        openapi: '3.1.0',
        info: { title: 'Serialization fixture', version: '1.0.0' },
        paths: {
          '/deep-object': {
            get: {
              operationId: 'deepObjectQuery',
              security: [{}],
              parameters: [{
                name: 'filter',
                in: 'query',
                style: 'deepObject',
                explode: true,
                schema: { type: 'object' },
              }],
              responses: { '200': { description: 'ok' } },
            },
          },
          '/delimited-array': {
            get: {
              operationId: 'delimitedArrayQuery',
              security: [{}],
              parameters: [{
                name: 'ids',
                in: 'query',
                style: 'form',
                explode: false,
                schema: { type: 'array', items: { type: 'string' } },
              }],
              responses: { '200': { description: 'ok' } },
            },
          },
          '/segments/{parts}': {
            get: {
              operationId: 'arrayPath',
              security: [{}],
              parameters: [{
                name: 'parts',
                in: 'path',
                required: true,
                style: 'simple',
                explode: false,
                schema: { type: 'array', items: { type: 'string' } },
              }],
              responses: { '200': { description: 'ok' } },
            },
          },
          '/repeated-array': {
            get: {
              operationId: 'repeatedArrayQuery',
              security: [{}],
              parameters: [{
                name: 'ids',
                in: 'query',
                style: 'form',
                explode: true,
                schema: { type: 'array', items: { type: 'string' } },
              }],
              responses: { '200': { description: 'ok' } },
            },
          },
          '/object-array': {
            get: {
              operationId: 'objectArrayQuery',
              security: [{}],
              parameters: [{
                name: 'filters',
                in: 'query',
                style: 'form',
                explode: true,
                schema: { type: 'array', items: { type: 'object' } },
              }],
              responses: { '200': { description: 'ok' } },
            },
          },
          '/untyped-query': {
            get: {
              operationId: 'untypedQuery',
              security: [{}],
              parameters: [{ name: 'value', in: 'query', schema: {} }],
              responses: { '200': { description: 'ok' } },
            },
          },
          '/composite-query': {
            get: {
              operationId: 'compositeQuery',
              security: [{}],
              parameters: [{
                name: 'value',
                in: 'query',
                schema: { oneOf: [{ type: 'string' }, { type: 'object' }] },
              }],
              responses: { '200': { description: 'ok' } },
            },
          },
          '/type-array-query': {
            get: {
              operationId: 'typeArrayQuery',
              security: [{}],
              parameters: [{ name: 'value', in: 'query', schema: { type: ['string', 'null'] } }],
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      },
    });

    const result = await runAsUser(fixture.contextTracker, () => fixture.catalog.listOperations({
      provider: 'gmail',
      includeUnavailable: true,
    }));

    expect(result.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operationId: 'deepObjectQuery',
        available: false,
        unavailableReason: 'unsupported_parameter_serialization',
      }),
      expect.objectContaining({
        operationId: 'delimitedArrayQuery',
        available: false,
        unavailableReason: 'unsupported_parameter_serialization',
      }),
      expect.objectContaining({
        operationId: 'arrayPath',
        available: false,
        unavailableReason: 'unsupported_parameter_serialization',
      }),
      expect.objectContaining({
        operationId: 'untypedQuery',
        available: false,
        unavailableReason: 'unsupported_parameter_serialization',
      }),
      expect.objectContaining({
        operationId: 'compositeQuery',
        available: false,
        unavailableReason: 'unsupported_parameter_serialization',
      }),
      expect.objectContaining({
        operationId: 'typeArrayQuery',
        available: false,
        unavailableReason: 'unsupported_parameter_serialization',
      }),
      expect.objectContaining({
        operationId: 'objectArrayQuery',
        available: false,
        unavailableReason: 'unsupported_parameter_serialization',
      }),
      expect.objectContaining({ operationId: 'repeatedArrayQuery', available: true }),
    ]));
  });

  it('accepts an internally referenced API-key scheme that matches the descriptor injection', async () => {
    const spec = openApiSpec();
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const securedPath = paths['/gmail/v1/users/{userId}/messages'];
    const get = securedPath?.get;
    const catalogFixture = createCatalog({
      descriptor: descriptor({
        authStrategy: 'static_api_key',
        oauth: null,
        staticApiKey: {
          injection: { location: 'header', name: 'X-Api-Key', valuePrefix: null },
        },
        clientSecretCiphertext: null,
        clientSecretRevision: null,
        credentialKeyVersion: null,
      }),
      scopes: [],
      spec: {
        ...spec,
        components: {
          securitySchemes: {
            apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
            selectedApiKey: { $ref: '#/components/securitySchemes/apiKey' },
          },
        },
        security: [{ selectedApiKey: [] }],
        paths: {
          ...paths,
          '/gmail/v1/users/{userId}/messages': {
            ...securedPath,
            get: { ...get, security: [{ selectedApiKey: [] }] },
          },
        },
      },
    });

    const result = await runAsUser(catalogFixture.contextTracker, () => catalogFixture.catalog.listOperations({
      provider: 'gmail',
      includeUnavailable: true,
    }));

    expect(result.operations.find(operation => operation.operationId === 'listMessages')).toMatchObject({
      available: true,
      requiredScopes: [],
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
    expect(Object.keys(pathItem).sort((left, right) => left.localeCompare(right))).toEqual(['get', 'post']);
    expect(pathItem.get.operationId).toBe('duplicate');
    expect(pathItem.post.operationId).toBe('duplicate_2');
  });

  it('resolves reusable local Path Item refs before normalization', async () => {
    const { catalog, contextTracker, specStore } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
    });
    const base = openApiSpec();

    const result = await runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        ...base,
        components: {
          ...base.components as Record<string, unknown>,
          pathItems: {
            ReusableProfile: {
              get: {
                operationId: 'reusedProfile',
                responses: { 200: { description: 'ok' } },
              },
            },
          },
        },
        paths: {
          '/gmail/v1/profile/primary': { $ref: '#/components/pathItems/ReusableProfile' },
          '/gmail/v1/profile/secondary': { $ref: '#/components/pathItems/ReusableProfile' },
        },
      },
    }));

    expect(result.operationCount).toBe(2);
    const stored = await specStore.findByDescriptorId(DESCRIPTOR_ID);
    const paths = stored?.spec.paths as Record<string, Record<string, { operationId: string }>>;
    expect(paths['/gmail/v1/profile/primary'].get.operationId).toBe('reusedProfile');
    expect(paths['/gmail/v1/profile/secondary'].get.operationId).toBe('reusedProfile_2');
  });

  it('dereferences operation-level local refs before assigning unique operation ids', async () => {
    const { catalog, contextTracker, specStore } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
    });
    const base = openApiSpec();

    await runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        ...base,
        components: {
          ...base.components as Record<string, unknown>,
          operations: {
            SharedProfile: {
              operationId: 'sharedProfile',
              responses: { 200: { description: 'ok' } },
            },
          },
        },
        paths: {
          '/gmail/v1/profile/primary': { get: { $ref: '#/components/operations/SharedProfile' } },
          '/gmail/v1/profile/secondary': { get: { $ref: '#/components/operations/SharedProfile' } },
        },
      },
    }));

    const stored = await specStore.findByDescriptorId(DESCRIPTOR_ID);
    const paths = stored?.spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths['/gmail/v1/profile/primary'].get).toMatchObject({ operationId: 'sharedProfile' });
    expect(paths['/gmail/v1/profile/secondary'].get).toMatchObject({ operationId: 'sharedProfile_2' });
    expect(paths['/gmail/v1/profile/primary'].get).not.toHaveProperty('$ref');
    await expect(runAsUser(contextTracker, () => catalog.describeOperation({
      provider: 'gmail',
      operationId: 'sharedProfile_2',
    }))).resolves.toMatchObject({
      path: '/gmail/v1/profile/secondary',
      gatewayRequest: { pathTemplate: '/gmail/v1/profile/secondary' },
    });
  });

  it('rejects circular local Path Item refs during normalization', async () => {
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
    });
    const base = openApiSpec();

    await expect(runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        ...base,
        components: {
          ...base.components as Record<string, unknown>,
          pathItems: { Loop: { $ref: '#/components/pathItems/Loop' } },
        },
        paths: { '/loop': { $ref: '#/components/pathItems/Loop' } },
      },
    }))).rejects.toMatchObject({
      code: 'invalid_openapi_spec',
      message: expect.stringContaining('circular local $ref'),
    });
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

  it.each([
    ['protocol-relative', '//evil.example.com/messages'],
    ['backslash-bearing', '/gmail\\v1/messages'],
  ])('rejects %s OpenAPI operation paths during ingestion', async (_label, unsafePath) => {
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
    });

    await expect(runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        ...openApiSpec(),
        paths: {
          [unsafePath]: {
            get: { operationId: 'unsafe', responses: { 200: { description: 'ok' } } },
          },
        },
      },
    }))).rejects.toMatchObject({
      code: 'invalid_openapi_spec',
      message: expect.stringContaining('absolute paths'),
    });
  });

  it('accepts an equivalent canonical spelling of an allowlisted OpenAPI server host', async () => {
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({
        ownership: 'byo',
        ownerUserId: USER_ID,
        apiHosts: ['gmail.googleapis.com'],
      }),
      scopes: [GMAIL_READONLY],
    });

    const result = await runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        ...openApiSpec(),
        servers: [{ url: 'https://GMAIL.GOOGLEAPIS.COM./' }],
      },
    }));

    expect(result.operationCount).toBeGreaterThan(0);
  });

  it('resolves declared OpenAPI server variables from their defaults before routing', async () => {
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({
        ownership: 'byo',
        ownerUserId: USER_ID,
        apiHosts: ['gmail.googleapis.com'],
      }),
      scopes: [GMAIL_READONLY],
      spec: {
        ...openApiSpec(),
        servers: [{
          url: 'https://{host}/api/{version}',
          variables: {
            host: { default: 'gmail.googleapis.com' },
            version: { default: 'v1', enum: ['v1', 'v2'] },
          },
        }],
      },
    });

    const operation = await runAsUser(contextTracker, () => catalog.describeOperation({
      provider: 'gmail',
      operationId: 'getProfile',
    }));

    expect(operation.gatewayRequest.baseUrl).toBe('https://gmail.googleapis.com/api/v1');
  });

  it('resolves a relative OpenAPI server against the descriptor origin and preserves its query', async () => {
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({
        ownership: 'byo',
        ownerUserId: USER_ID,
        apiHosts: ['gmail.googleapis.com'],
      }),
      scopes: [GMAIL_READONLY],
      spec: {
        ...openApiSpec(),
        servers: [{ url: '/api/v2?tenant=alpha' }],
      },
    });

    const operation = await runAsUser(contextTracker, () => catalog.describeOperation({
      provider: 'gmail',
      operationId: 'getProfile',
    }));

    expect(operation.gatewayRequest.baseUrl).toBe('https://gmail.googleapis.com/api/v2?tenant=alpha');
  });

  it.each([
    ['undeclared variable', { url: 'https://gmail.googleapis.com/{version}' }],
    ['missing default', {
      url: 'https://gmail.googleapis.com/{version}',
      variables: { version: { enum: ['v1'] } },
    }],
    ['malformed variable', {
      url: 'https://gmail.googleapis.com/{version',
      variables: { version: { default: 'v1' } },
    }],
  ])('rejects an OpenAPI server with an %s', async (_label, server) => {
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
    });

    await expect(runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: { ...openApiSpec(), servers: [server] },
    }))).rejects.toMatchObject({ code: 'invalid_openapi_spec' });
  });

  it.each([
    ['missing declaration', [], '/users/{userId}'],
    ['optional declaration', [{ name: 'userId', in: 'path', required: false }], '/users/{userId}'],
    ['unmatched declaration', [{ name: 'otherId', in: 'path', required: true }], '/users/{userId}'],
    ['extra declaration', [{ name: 'userId', in: 'path', required: true }], '/users'],
    ['malformed placeholder', [], '/users/{userId'],
  ])('rejects an OpenAPI path contract with a %s', async (_label, parameters, path) => {
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
    });

    await expect(runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        ...openApiSpec(),
        paths: {
          [path]: {
            parameters,
            get: { operationId: 'invalidPathContract', responses: { 200: { description: 'ok' } } },
          },
        },
      },
    }))).rejects.toMatchObject({ code: 'invalid_openapi_spec' });
  });

  it('rejects specs nested past the external-ref scan depth instead of skipping the check', async () => {
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
    });

    // An external $ref buried under 45 allOf wrappers sits past the scanner's
    // depth limit of 40; the spec must be rejected outright, not silently pass.
    let nested: Record<string, unknown> = { $ref: 'https://evil.example.com/schema.json#/External' };
    for (let wrap = 0; wrap < 45; wrap += 1) {
      nested = { allOf: [nested] };
    }

    await expect(runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: {
        ...openApiSpec(),
        components: { schemas: { Deep: nested } },
      },
    }))).rejects.toMatchObject({
      code: 'invalid_openapi_spec',
      message: expect.stringContaining('nesting depth'),
    });
  });

  it('regenerates skill helpers while preserving user edits as a new revision', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore();
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
      portfolioStore,
    });

    await runAsUser(contextTracker, () => catalog.regenerateSkill({ provider: 'gmail' }));
    const generated = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
    if (!generated) throw new Error('expected generated skill');
    expect(generated.metadata).toMatchObject({
      source: 'integration_openapi_spec',
      integration: {
        generatedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        generatedPersistedBaselineHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    await portfolioStore.update({
      userId: USER_ID,
      type: 'skills',
      canonicalName: GENERATED_SKILL_NAME,
      expectedVersion: generated.version,
      expectedContentHash: generated.contentHash,
      displayName: 'User edited Gmail helper',
      metadata: { ...generated.metadata, instructions: 'my custom instructions' },
      content: generated.content,
      tags: generated.tags,
      now: new Date('2026-06-17T00:00:00Z'),
    });

    const result = await runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: { ...openApiSpec(), info: { title: 'Gmail fixture', version: '2.0.0' } },
      regenerateSkill: true,
    }));

    expect(result.generatedSkill).toMatchObject({
      written: true,
      portfolioAction: 'created_revision',
      portfolioName: expect.stringMatching(
        new RegExp(`^using-gmail-integration-${result.specHash.slice(0, 8)}-[a-f0-9]{8}$`),
      ),
    });
    await expect(portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME))
      .resolves.toMatchObject({
        metadata: expect.objectContaining({ instructions: 'my custom instructions' }),
      });
    await expect(portfolioStore.findByName(USER_ID, 'skills', result.generatedSkill?.portfolioName ?? ''))
      .resolves.toMatchObject({
        metadata: expect.objectContaining({
          source: 'integration_openapi_spec',
          integration: expect.objectContaining({ generatedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        }),
        tags: expect.arrayContaining(['integration-generated', 'integration:gmail']),
      });
  });

  it.each(['content', 'tags', 'displayName', 'metadata description'] as const)(
    'preserves an isolated user edit to generated skill %s',
    async editedField => {
      const portfolioStore = new InMemoryPortfolioElementStore();
      const { catalog, contextTracker } = createCatalog({
        descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
        scopes: [GMAIL_READONLY],
        portfolioStore,
      });
      await runAsUser(contextTracker, () => catalog.regenerateSkill({ provider: 'gmail' }));
      const generated = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
      if (!generated) throw new Error('expected generated skill');

      let displayName = generated.displayName;
      let metadata = generated.metadata;
      let content = generated.content;
      let tags = generated.tags;
      if (editedField === 'content') content = `${content}\nUser-owned content.`;
      if (editedField === 'tags') tags = [...tags, 'user-owned'];
      if (editedField === 'displayName') displayName = 'User-owned display name';
      if (editedField === 'metadata description') {
        metadata = { ...metadata, description: 'User-owned description' };
      }
      await portfolioStore.update({
        userId: USER_ID,
        type: 'skills',
        canonicalName: GENERATED_SKILL_NAME,
        expectedVersion: generated.version,
        expectedContentHash: generated.contentHash,
        displayName,
        metadata,
        content,
        tags,
        now: new Date('2026-06-17T00:00:00Z'),
      });

      const result = await runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
        provider: 'gmail',
        spec: { ...openApiSpec(), info: { title: 'Gmail fixture', version: '2.0.0' } },
        regenerateSkill: true,
      }));

      expect(result.generatedSkill?.portfolioAction).toBe('created_revision');
      await expect(portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME)).resolves.toMatchObject({
        displayName,
        metadata,
        content,
        tags,
      });
    },
  );

  it('ignores and preserves store-owned metadata while updating a generated skill in place', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore();
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
      portfolioStore,
    });
    await runAsUser(contextTracker, () => catalog.regenerateSkill({ provider: 'gmail' }));
    const generated = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
    if (!generated) throw new Error('expected generated skill');
    await portfolioStore.update({
      userId: USER_ID,
      type: 'skills',
      canonicalName: GENERATED_SKILL_NAME,
      expectedVersion: generated.version,
      expectedContentHash: generated.contentHash,
      displayName: generated.displayName,
      metadata: {
        ...generated.metadata,
        storeRevision: 'opaque-store-value',
        integration: {
          ...generated.metadata.integration as Record<string, unknown>,
          storeLease: 'opaque-integration-value',
        },
      },
      content: generated.content,
      tags: [...generated.tags].reverse(),
      now: new Date('2026-06-17T00:00:00Z'),
    });

    const result = await runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: { ...openApiSpec(), info: { title: 'Gmail fixture', version: '2.0.0' } },
      regenerateSkill: true,
    }));

    expect(result.generatedSkill?.portfolioAction).toBe('updated');
    await expect(portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME)).resolves.toMatchObject({
      metadata: {
        storeRevision: 'opaque-store-value',
        integration: { storeLease: 'opaque-integration-value' },
      },
    });
  });

  it('fails honestly when a generated skill disappears during an update', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore();
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
      portfolioStore,
    });
    await runAsUser(contextTracker, () => catalog.regenerateSkill({ provider: 'gmail' }));
    jest.spyOn(portfolioStore, 'update').mockResolvedValueOnce(null);

    await expect(runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: { ...openApiSpec(), info: { title: 'Gmail fixture', version: '2.0.0' } },
      regenerateSkill: true,
    }))).rejects.toMatchObject({
      code: 'integration_generated_skill_conflict',
      status: 409,
    });
  });

  it('updates an unedited generated skill in place when its stored baseline still matches', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore();
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
      portfolioStore,
    });
    await runAsUser(contextTracker, () => catalog.regenerateSkill({ provider: 'gmail' }));

    const result = await runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: { ...openApiSpec(), info: { title: 'Gmail fixture', version: '2.0.0' } },
      regenerateSkill: true,
    }));

    expect(result.generatedSkill).toMatchObject({
      written: true,
      portfolioAction: 'updated',
      portfolioName: GENERATED_SKILL_NAME,
    });
    await expect(portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME))
      .resolves.toMatchObject({
        version: 2,
        metadata: expect.objectContaining({
          integration: expect.objectContaining({
            specHash: result.specHash,
            generatedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            generatedPersistedBaselineHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        }),
      });
  });

  it('records the generated baseline from the Skill manager persisted normalization', async () => {
    const portfolioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-generated-skill-'));
    try {
      const suite = createRealManagerSuite(portfolioDir);
      const portfolioStore = new ManagerBackedPortfolioElementStore({
        managers: {
          personas: suite.personaManager,
          skills: suite.skillManager,
          templates: suite.templateManager,
          agents: suite.agentManager,
          memories: suite.memoryManager,
          ensembles: suite.ensembleManager,
        },
        getCurrentUserId: () => USER_ID,
      });
      const { catalog, contextTracker } = createCatalog({
        descriptor: descriptor({
          ownership: 'byo',
          ownerUserId: USER_ID,
          displayName: `Gmail's "Workspace"`,
        }),
        scopes: [GMAIL_READONLY],
        portfolioStore,
      });

      await runAsUser(contextTracker, () => catalog.regenerateSkill({ provider: 'gmail' }));
      const persisted = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
      expect(persisted?.metadata.description).toBe('Generated helper for Gmails Workspace integration');

      await expect(runAsUser(contextTracker, () => catalog.regenerateSkill({ provider: 'gmail' })))
        .resolves.toMatchObject({ portfolioAction: 'skipped', portfolioName: GENERATED_SKILL_NAME });
      await expect(portfolioStore.listByUser(USER_ID, { type: 'skills' })).resolves.toHaveLength(1);
    } finally {
      fs.rmSync(portfolioDir, { recursive: true, force: true });
    }
  });

  it('verifies deterministic revision collisions and allocates a unique fallback', async () => {
    const portfolioStore = new InMemoryPortfolioElementStore();
    const { catalog, contextTracker } = createCatalog({
      descriptor: descriptor({ ownership: 'byo', ownerUserId: USER_ID }),
      scopes: [GMAIL_READONLY],
      portfolioStore,
    });
    await runAsUser(contextTracker, () => catalog.regenerateSkill({ provider: 'gmail' }));
    const generated = await portfolioStore.findByName(USER_ID, 'skills', GENERATED_SKILL_NAME);
    if (!generated) throw new Error('expected generated skill');
    await portfolioStore.update({
      userId: USER_ID,
      type: 'skills',
      canonicalName: GENERATED_SKILL_NAME,
      expectedVersion: generated.version,
      expectedContentHash: generated.contentHash,
      metadata: { ...generated.metadata, instructions: 'user-owned instructions' },
      now: new Date(TIMESTAMP),
    });

    const ingested = await runAsUser(contextTracker, () => catalog.ingestOpenApiSpec({
      provider: 'gmail',
      spec: { ...openApiSpec(), info: { title: 'Gmail fixture', version: '2.0.0' } },
    }));
    const discovery = await runAsUser(contextTracker, () => catalog.listOperations({
      provider: 'gmail',
      includeSkill: true,
    }));
    const generatedContent = discovery.generatedSkill?.content;
    if (!generatedContent) throw new Error('expected generated skill content');
    const revisionBase = `${GENERATED_SKILL_NAME}-${ingested.specHash.slice(0, 8)}-${createHash('sha256').update(generatedContent).digest('hex').slice(0, 8)}`;
    await portfolioStore.create({
      userId: USER_ID,
      type: 'skills',
      name: revisionBase,
      displayName: 'Unrelated user skill',
      metadata: { name: revisionBase, description: 'User-owned collision' },
      content: 'unrelated content',
      tags: ['user-owned'],
      now: new Date(TIMESTAMP),
    });

    await expect(runAsUser(contextTracker, () => catalog.regenerateSkill({ provider: 'gmail' })))
      .resolves.toMatchObject({
        written: true,
        portfolioAction: 'created_revision',
        portfolioName: `${revisionBase}-2`,
      });
    await expect(runAsUser(contextTracker, () => catalog.regenerateSkill({ provider: 'gmail' })))
      .resolves.toMatchObject({
        written: false,
        portfolioAction: 'skipped',
        portfolioName: `${revisionBase}-2`,
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
  readonly portfolioStore?: IPortfolioElementStore;
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
    descriptorStore,
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
    clientSecretRevision: '00000000-0000-4000-8000-000000000201',
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
    integrationDescriptorId: DESCRIPTOR_ID,
    externalAccountLabel: 'alice@example.com',
    externalInstallationId: null,
    authorizedPermissions: { scopes },
    accessTokenCiphertext: Buffer.from('encrypted-access-token'),
    refreshTokenCiphertext: Buffer.from('encrypted-refresh-token'),
    credentialKeyVersion: 'v1',
    credentialGeneration: 0,
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
    components: {
      securitySchemes: {
        oauth: { type: 'oauth2', flows: {} },
      },
    },
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
